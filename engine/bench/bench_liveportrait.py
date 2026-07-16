# -*- coding: utf-8 -*-
"""
OneLive V2 M0 spike - Task 4: LivePortrait 推理基准（决策门核心数据）。

用途：在 Intel Arc 核显混合执行路径（DML + OpenVINO-GPU + torch CPU GridSample）上
实测 1/2/3 路数字人渲染吞吐。

设计要点（依据 Task 3 实测结论）：
- 每路（source）一个独立 FasterLivePortraitPipeline 实例：pipeline 持有逐帧平滑状态
  （OneEuroFilter、R_d_0 等），多路必须隔离；ONNX session 按 model_path 单例缓存，
  多实例不会重复加载权重。
- prepare_source() 每次调用会清空重建 src_imgs/src_infos，因此 prepare 后立即快照。
- 多路按"同一驱动帧轮询各路"顺序执行（round-robin）。不用多线程：切分后的
  warping_spade predictor 是按 model_path 共享的单例且 predict() 内部持锁
  （OV InferRequest 非线程安全），并发流会在占 >85% 耗时的 warping_spade 上串行化，
  线程只会增加调度开销、不会提升吞吐。
- realtime=True + flag_pasteback=False：只出 512 crop，跳过 pasteback（贴回原图属
  后处理，不在决策门口径内）。
- 前 --warmup 帧照常执行但不计入统计（EP 编译/缓存预热）。

运行（在 engine/.venv 下）：
  python engine/bench/bench_liveportrait.py --sources 1 --frames 300
  python engine/bench/bench_liveportrait.py --sources 3 --frames 150
"""
import argparse
import os
import sys
import time

import numpy as np

BENCH_DIR = os.path.dirname(os.path.abspath(__file__))
ENGINE_DIR = os.path.dirname(BENCH_DIR)
FLP_DIR = os.path.join(ENGINE_DIR, "FasterLivePortrait")

# pipeline 代码用 `from src....` 导入，且 mask_crop_path 等相对路径以 clone 根为基准
sys.path.insert(0, FLP_DIR)
os.chdir(FLP_DIR)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def parse_args():
    p = argparse.ArgumentParser(description="LivePortrait multi-stream benchmark (M0 spike Task 4)")
    p.add_argument("--cfg", default=os.path.join(FLP_DIR, "configs", "onnx_infer.yaml"))
    p.add_argument("--src_dir", default=os.path.join(FLP_DIR, "assets", "examples", "source"))
    p.add_argument("--driving", default=os.path.join(FLP_DIR, "assets", "examples", "driving", "d14.mp4"))
    p.add_argument("--frames", type=int, default=300, help="计入统计的驱动帧数")
    p.add_argument("--sources", type=int, default=1, choices=[1, 2, 3], help="并行路数（round-robin）")
    p.add_argument("--warmup", type=int, default=30, help="预热驱动帧数（执行但不计入统计）")
    return p.parse_args()


def main():
    args = parse_args()
    import cv2
    from omegaconf import OmegaConf
    from src.pipelines.faster_live_portrait_pipeline import FasterLivePortraitPipeline

    cfg = OmegaConf.load(args.cfg)
    cfg.infer_params.flag_pasteback = False  # 决策门口径：512 crop 输出，无 pasteback

    src_paths = sorted(
        os.path.join(args.src_dir, f) for f in os.listdir(args.src_dir)
        if f.lower().endswith((".jpg", ".jpeg", ".png"))
    )[: args.sources]
    if len(src_paths) < args.sources:
        print(f"ERROR: 源图不足 {args.sources} 张（{args.src_dir}）")
        sys.exit(1)

    print(f"[bench] cfg={args.cfg}")
    print(f"[bench] driving={args.driving}")
    print(f"[bench] sources={args.sources} warmup={args.warmup} frames={args.frames}")

    # 每路一个 pipeline 实例，prepare 后立即快照 (src_img, src_info)
    streams = []  # (name, pipe, img_src, src_info)
    for sp in src_paths:
        t0 = time.perf_counter()
        pipe = FasterLivePortraitPipeline(cfg=cfg, is_animal=False)
        t1 = time.perf_counter()
        ok = pipe.prepare_source(sp, realtime=True)
        t2 = time.perf_counter()
        if not ok:
            print(f"ERROR: prepare_source 未检出人脸: {sp}")
            sys.exit(1)
        img_src, src_info = pipe.src_imgs[0], pipe.src_infos[0]  # 立即快照
        name = os.path.basename(sp)
        streams.append((name, pipe, img_src, src_info))
        print(f"[prepare] {name}: pipeline init {(t1 - t0) * 1000:.0f} ms, "
              f"prepare_source {(t2 - t1) * 1000:.0f} ms (一次性成本)")

    vcap = cv2.VideoCapture(args.driving)
    if not vcap.isOpened():
        print(f"ERROR: 打不开驱动视频 {args.driving}")
        sys.exit(1)

    total_needed = args.warmup + args.frames
    frame_times_ms = []                     # 计入统计的每驱动帧总耗时（所有路）
    per_src_ms = [[] for _ in streams]      # 计入统计的每路单帧耗时
    no_face = 0
    frame_idx = 0                           # 全局驱动帧序号（含预热）
    t_bench0 = time.perf_counter()

    while frame_idx < total_needed:
        ret, dri_frame = vcap.read()
        if not ret:  # 视频比 --frames 短则循环
            vcap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ret, dri_frame = vcap.read()
            if not ret:
                print("ERROR: 驱动视频循环读取失败")
                sys.exit(1)

        first = frame_idx == 0
        measured = frame_idx >= args.warmup
        tf0 = time.perf_counter()
        for si, (name, pipe, img_src, src_info) in enumerate(streams):
            ts0 = time.perf_counter()
            dri_crop, out_crop, out_org, dri_motion_info = pipe.run(
                dri_frame, img_src, src_info, first_frame=first)
            ts1 = time.perf_counter()
            if out_crop is None:
                no_face += 1
                continue
            if measured:
                per_src_ms[si].append((ts1 - ts0) * 1000)
        tf1 = time.perf_counter()
        if measured:
            frame_times_ms.append((tf1 - tf0) * 1000)
        frame_idx += 1
        if frame_idx % 50 == 0:
            print(f"[progress] {frame_idx}/{total_needed} driving frames "
                  f"({'warmup' if frame_idx <= args.warmup else 'measure'}), "
                  f"last frame {(tf1 - tf0) * 1000:.0f} ms")

    vcap.release()
    wall_s = time.perf_counter() - t_bench0

    ft = np.asarray(frame_times_ms)
    avg, p50, p95 = ft.mean(), np.percentile(ft, 50), np.percentile(ft, 95)
    fps_per_channel = 1000.0 / avg  # 每驱动帧所有路各渲染一次 → 每路 fps 相同

    print()
    print("=" * 72)
    print(f"[result] 路数={args.sources}  计入统计驱动帧={len(ft)}  预热丢弃={args.warmup}  "
          f"无脸帧={no_face}  总墙钟={wall_s:.1f}s")
    print(f"[result] 每驱动帧(全部{args.sources}路)耗时: avg={avg:.1f} ms  p50={p50:.1f} ms  p95={p95:.1f} ms")
    print(f"[result] 每路有效 fps = 1000/avg = {fps_per_channel:.2f}")
    for si, (name, _, _, _) in enumerate(streams):
        arr = np.asarray(per_src_ms[si])
        print(f"[result]   路{si + 1} ({name}): avg={arr.mean():.1f} ms  "
              f"p50={np.percentile(arr, 50):.1f} ms  n={len(arr)}")
    print("=" * 72)

    # spike-results.md §1 现成表行
    ep = "混合: DML(metacmd off)+OV-GPU fp16+torch CPU GridSample(split)"
    cfg_desc = (f"{args.sources}路 round-robin（{'+'.join(n for n, _, _, _ in streams)} + d14.mp4，"
                f"realtime，pasteback 关）")
    if args.sources == 1:
        single = f"**{fps_per_channel:.2f}**"
        triple = "见三路行"
    else:
        single = "见单路行"
        triple = f"**{fps_per_channel:.2f}**"
    note = (f"{len(ft)} 帧计入统计（预热 {args.warmup} 帧丢弃），"
            f"每驱动帧 avg {avg:.0f}/p50 {p50:.0f}/p95 {p95:.0f} ms")
    print("[markdown]")
    print(f"| {cfg_desc} | {ep} | 512 crop | {single} | {triple} | {note} |")


if __name__ == "__main__":
    main()
