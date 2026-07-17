"""M2b Task 1 验证：live run() 路径的 lip_ratio_override 注入。

与 M0 的 pkl 回放实验不同，这里走 run()（真实视频帧逐帧推理，含人脸检测/
landmark/motion extractor），驱动视频 d14 提供头姿/表情，嘴型由注入的正弦
close-ratio 曲线接管（clone 补丁：run() kwargs.pop("lip_ratio_override")）。

正弦 0.5 Hz（25fps 名义时基 -> 周期 50 帧）；覆盖 2 个波峰 + 2 个波谷需要
76 帧（计划里写的 ~40 帧在 0.5 Hz 下放不下 2+2 极值点，故取 76）。

对照组（无 override）：同一 R_d_0 锚点（先喂第 0 帧 first_frame=True），再在
每个极值帧索引处喂 [k-1, k] 两帧（跳帧前重置 src_lmk_pre 让人脸重新检测），
共 <=10 次推理，只取 k 帧参与数值对比。

数值判据（两部分）：
1) 诊断量（计划原判据，仅报告不作为退出条件）：嘴部区域峰-谷帧平均绝对差，
   注入组 vs 对照组。实测发现该判据被 d14 头动混淆——峰谷相隔 25 帧，头姿
   变化带来的嘴部区域基线差 ~13（灰度级），而 retarget_lip 只依赖源关键点与
   ratio（0.001..0.18 标定范围本身对应 d14 的 p05..p95，嘴型变化幅度有限，
   增量 ~1.7），任何裁剪框都到不了 2x。
2) 退出判据（头动受控）：静止驱动帧（重复喂 d14 第 0 帧），override 在
   0.001 与 0.18 之间切换，嘴部区域平均绝对差 必须 >= 2x 无 override 时
   同样重复帧的抖动基线。这才是"注入本身改变了嘴型"的干净证明。

用法：
    <m0-venv-python> engine/lipsync/verify_live_injection.py [--gate-only]
--gate-only：跳过 76 帧正弦注入 + 对照组（约 2 分钟），只跑退出判据的
静止头姿门（~15s + 模型加载），作为补丁回归检查的快速通道。
输出：engine/out/lip_live/ 下的 peak/trough PNG（注入组 + 对照组）。
"""

import argparse
import os
import sys
import time

import cv2
import numpy as np
from omegaconf import OmegaConf

ENGINE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# clone 在共享的 M0 worktree 里（gitignored；补丁以 engine/patches/*.patch 入库）
CLONE_DIR = os.path.normpath(os.path.join(
    ENGINE_ROOT, "..", "..", "v2-m0-spike", "engine", "FasterLivePortrait"))
if not os.path.isdir(CLONE_DIR):
    CLONE_DIR = os.path.join(ENGINE_ROOT, "FasterLivePortrait")  # 本 worktree 兜底
sys.path.insert(0, CLONE_DIR)
os.chdir(CLONE_DIR)  # 配置里 mask_crop_path 等是相对 clone 根的路径

from src.pipelines.faster_live_portrait_pipeline import FasterLivePortraitPipeline  # noqa: E402

SRC_IMAGE = os.path.join(CLONE_DIR, "assets", "examples", "source", "s10.jpg")
DRI_VIDEO = os.path.join(CLONE_DIR, "assets", "examples", "driving", "d14.mp4")
OUT_DIR = os.path.join(ENGINE_ROOT, "out", "lip_live")

FPS_NOMINAL = 25.0
FREQ_HZ = 0.5
RATIO_CLOSED = 0.001
RATIO_OPEN = 0.18
N_FRAMES = 76
TROUGH_IDXS = [0, 50]   # cos 型曲线：谷在 0、50
PEAK_IDXS = [25, 75]    # 峰在 25、75
KEY_IDXS = sorted(TROUGH_IDXS + PEAK_IDXS)


def build_pipe() -> FasterLivePortraitPipeline:
    cfg = OmegaConf.load(os.path.join(CLONE_DIR, "configs", "onnx_infer.yaml"))
    cfg.infer_params.flag_pasteback = False
    cfg.infer_params.flag_lip_retargeting = True
    cfg.infer_params.flag_lip_retarget_keep_motion = True
    pipe = FasterLivePortraitPipeline(cfg=cfg, is_animal=False)
    ok = pipe.prepare_source(SRC_IMAGE, realtime=True)
    assert ok, f"prepare_source failed: {SRC_IMAGE}"
    return pipe


def load_frames(n: int) -> list:
    cap = cv2.VideoCapture(DRI_VIDEO)
    frames = []
    while len(frames) < n:
        ok, frame = cap.read()
        if not ok:
            break
        frames.append(frame)
    cap.release()
    assert len(frames) == n, f"d14 only yielded {len(frames)}/{n} frames"
    return frames


def curve_value(i: int) -> float:
    # 0..1，谷在 t=0：0.5 - 0.5*cos(2*pi*f*t)
    t = i / FPS_NOMINAL
    return 0.5 - 0.5 * float(np.cos(2 * np.pi * FREQ_HZ * t))


def mouth_crop(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    return img[2 * h // 3:, w // 4: 3 * w // 4]


def mean_abs_diff(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.mean(np.abs(a.astype(np.float32) - b.astype(np.float32))))


def main(gate_only: bool = False) -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    frames = load_frames(1 if gate_only else N_FRAMES)
    if gate_only:
        return run_gate(frames)

    # ---- 注入组：全 76 帧 live run()，override = 正弦 close-ratio ----
    pipe = build_pipe()
    img_src, src_info = pipe.src_imgs[0], pipe.src_infos[0]
    injected = {}
    times = []
    for i, frame in enumerate(frames):
        ratio = RATIO_CLOSED + curve_value(i) * (RATIO_OPEN - RATIO_CLOSED)
        t0 = time.time()
        _, out_crop, _, _ = pipe.run(frame, img_src, src_info,
                                     first_frame=(i == 0),
                                     lip_ratio_override=ratio)
        times.append(time.time() - t0)
        assert out_crop is not None, f"run() returned None at frame {i}"
        if i in KEY_IDXS:
            injected[i] = out_crop.copy()
            kind = "peak" if i in PEAK_IDXS else "trough"
            cv2.imwrite(os.path.join(OUT_DIR, f"inject_{kind}_f{i:03d}.png"),
                        cv2.cvtColor(out_crop, cv2.COLOR_RGB2BGR))
    print(f"injected pass: {len(frames)} frames, avg {np.mean(times) * 1000:.1f} ms/frame "
          f"({1.0 / np.mean(times):.1f} fps)")

    # ---- 对照组：无 override，同 R_d_0 锚点，只在极值索引附近推理（<=10 帧）----
    pipe_ctrl = build_pipe()
    img_src_c, src_info_c = pipe_ctrl.src_imgs[0], pipe_ctrl.src_infos[0]
    control = {}
    n_ctrl = 0
    _, out0, _, _ = pipe_ctrl.run(frames[0], img_src_c, src_info_c, first_frame=True)
    n_ctrl += 1
    assert out0 is not None
    control[0] = out0.copy()
    for k in KEY_IDXS:
        if k == 0:
            continue
        pipe_ctrl.src_lmk_pre = None  # 跳帧后重新做人脸检测，避免 landmark 跟踪漂移
        for j in (k - 1, k):
            _, out_crop, _, _ = pipe_ctrl.run(frames[j], img_src_c, src_info_c)
            n_ctrl += 1
            assert out_crop is not None, f"control run() returned None at frame {j}"
        control[k] = out_crop.copy()
    for k, img in control.items():
        kind = "peak" if k in PEAK_IDXS else "trough"
        cv2.imwrite(os.path.join(OUT_DIR, f"control_{kind}_f{k:03d}.png"),
                    cv2.cvtColor(img, cv2.COLOR_RGB2BGR))
    print(f"control pass: {n_ctrl} frames inferred")

    # ---- 诊断量：峰 x 谷 全组合的嘴部区域平均绝对差（受 d14 头动混淆，仅报告）----
    inj_diffs, ctrl_diffs = [], []
    for p in PEAK_IDXS:
        for t in TROUGH_IDXS:
            inj_diffs.append(mean_abs_diff(mouth_crop(injected[p]), mouth_crop(injected[t])))
            ctrl_diffs.append(mean_abs_diff(mouth_crop(control[p]), mouth_crop(control[t])))
    inj_mean = float(np.mean(inj_diffs))
    ctrl_mean = float(np.mean(ctrl_diffs))
    print(f"[diagnostic] moving-head mouth-region mean abs diff (peak vs trough), per-pair "
          f"injected={['%.2f' % d for d in inj_diffs]} control={['%.2f' % d for d in ctrl_diffs]}")
    print(f"[diagnostic] injected mean={inj_mean:.2f}  control mean={ctrl_mean:.2f}  "
          f"ratio={inj_mean / max(ctrl_mean, 1e-6):.2f}x (head-motion confounded, informational)")

    # ---- 退出判据：静止驱动帧上切换 override，剔除头动混淆 ----
    return run_gate(frames)


def run_gate(frames) -> int:
    """静止头姿门（退出判据）：重复喂 d14 第 0 帧，override 在闭合/张开间切换，
    嘴部区域平均绝对差须 >= 2x 无 override 抖动基线，且 >= 1.0 绝对下限
    （防基线塌缩到 ~0 时比值虚高——比值判据在近零基线下毫无区分力）。"""

    def run_static(pipe_s, overrides):
        """重复喂 d14 第 0 帧；overrides: 每帧的 override 值（None=不注入）。
        返回最后一帧输出。"""
        img_s, info_s = pipe_s.src_imgs[0], pipe_s.src_infos[0]
        out = None
        for j, ov in enumerate(overrides):
            kw = {"first_frame": j == 0}
            if ov is not None:
                kw["lip_ratio_override"] = ov
            _, out, _, _ = pipe_s.run(frames[0], img_s, info_s, **kw)
            assert out is not None
        return out.copy()

    settle = 6
    pipe_st = build_pipe()
    closed_img = run_static(pipe_st, [RATIO_CLOSED] * settle)
    open_img = run_static(pipe_st, [RATIO_OPEN] * settle)  # 同一 pipe 续跑，头姿不变
    pipe_st2 = build_pipe()
    base_a = run_static(pipe_st2, [None] * settle)
    base_b = run_static(pipe_st2, [None] * settle)
    cv2.imwrite(os.path.join(OUT_DIR, "static_closed_0.001.png"),
                cv2.cvtColor(closed_img, cv2.COLOR_RGB2BGR))
    cv2.imwrite(os.path.join(OUT_DIR, "static_open_0.18.png"),
                cv2.cvtColor(open_img, cv2.COLOR_RGB2BGR))
    inj_static = mean_abs_diff(mouth_crop(open_img), mouth_crop(closed_img))
    ctrl_static = mean_abs_diff(mouth_crop(base_a), mouth_crop(base_b))
    print(f"[gate] static-head mouth-region mean abs diff: "
          f"override 0.18-vs-0.001 = {inj_static:.2f}, "
          f"no-override jitter baseline = {ctrl_static:.2f}, "
          f"ratio = {inj_static / max(ctrl_static, 1e-6):.2f}x "
          f"(require >=2x and absolute >=1.0)")
    if inj_static < 2.0 * ctrl_static:
        print("FAIL: static-head override diff < 2x no-override jitter")
        return 1
    if inj_static < 1.0:
        print("FAIL: static-head override diff below absolute floor 1.0")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--gate-only", action="store_true",
                    help="只跑静止头姿门（快速回归检查，跳过 76 帧正弦注入）")
    sys.exit(main(gate_only=ap.parse_args().gate_only))
