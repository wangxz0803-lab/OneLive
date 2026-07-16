"""M0 Task5 实验：TTS 音频包络驱动嘴型，头部/表情沿用 d14 动作模板（pkl 回放）。

注入机制：run_with_pkl 的 dri_motion_info[2] 就是驱动 lip close-ratio（1x1），
逐帧替换为音频曲线映射出的 ratio；配合 clone 新增的
infer_params.flag_lip_retarget_keep_motion（保留驱动头姿/表情、抑制驱动视频自身嘴型、
在动画后 keypoints 上叠加 retarget_lip delta）。

用法（在 engine/FasterLivePortrait 下、或任意 cwd 直接跑，脚本自行 chdir）：
    ..\\.venv\\Scripts\\python ..\\lipsync\\experiment_lip_drive.py
输出：
    engine/out/lip_drive_raw.mp4      注入视频（无音轨）
    engine/out/lip_drive_test.mp4     注入视频 + TTS 音轨
    engine/out/lip_drive_control.mp4  对照组（lip retargeting 关，同帧序列）
    engine/out/lip_curve.npz          曲线 + 标定范围（供帧对比取点）
"""

import copy
import os
import pickle
import sys
import subprocess
import time

import cv2
import numpy as np
import soundfile as sf
from omegaconf import OmegaConf

ENGINE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLONE_DIR = os.path.join(ENGINE_ROOT, "FasterLivePortrait")
sys.path.insert(0, ENGINE_ROOT)
sys.path.insert(0, CLONE_DIR)
os.chdir(CLONE_DIR)  # 配置里 mask_crop_path 等是相对 clone 根的路径

from lipsync.audio_lip import audio_to_lip_curve  # noqa: E402
from src.pipelines.faster_live_portrait_pipeline import FasterLivePortraitPipeline  # noqa: E402

FFMPEG = (r"C:\Users\76475\AppData\Local\Microsoft\WinGet\Packages"
          r"\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
          r"\ffmpeg-8.1.2-full_build\bin\ffmpeg.exe")
FPS = 25
SRC_IMAGE = os.path.join(CLONE_DIR, "assets", "examples", "source", "s10.jpg")
PKL_PATH = os.path.join(CLONE_DIR, "results", "2026-07-16-212842", "d14.mp4.pkl")
WAV_PATH = os.path.join(ENGINE_ROOT, "out", "tts_en.wav")
OUT_DIR = os.path.join(ENGINE_ROOT, "out")


def build_pipe(lip_retarget: bool) -> FasterLivePortraitPipeline:
    cfg = OmegaConf.load(os.path.join(CLONE_DIR, "configs", "onnx_infer.yaml"))
    cfg.infer_params.flag_pasteback = False
    cfg.infer_params.flag_lip_retargeting = lip_retarget
    cfg.infer_params.flag_lip_retarget_keep_motion = lip_retarget
    pipe = FasterLivePortraitPipeline(cfg=cfg, is_animal=False)
    ok = pipe.prepare_source(SRC_IMAGE, realtime=True)
    assert ok, f"prepare_source failed: {SRC_IMAGE}"
    return pipe


def render(pipe, motions, c_eyes, c_lips, out_path: str) -> float:
    """逐帧 run_with_pkl 渲染 512 crop 到 out_path，返回平均毫秒/帧。"""
    n = len(motions)
    vout = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (512, 512))
    img_src, src_info = pipe.src_imgs[0], pipe.src_infos[0]
    times = []
    for i in range(n):
        t0 = time.time()
        dri = [motions[i], c_eyes[i], c_lips[i]]
        # 注意：不能传 realtime kwarg（run_with_pkl 会再positional 传给 _run 冲突）；
        # flag_pasteback=False 时 realtime 只影响 pasteback 分支，无需开启。
        out_crop, _ = pipe.run_with_pkl(dri, img_src, src_info, first_frame=(i == 0))
        times.append(time.time() - t0)
        vout.write(cv2.cvtColor(out_crop, cv2.COLOR_RGB2BGR))  # 输出是 RGB
    vout.release()
    avg_ms = float(np.mean(times) * 1000)
    print(f"{out_path}: {n} frames, avg {avg_ms:.1f} ms/frame")
    return avg_ms


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    # 1) 音频 -> 曲线
    audio, sr = sf.read(WAV_PATH, dtype="float32")
    curve = audio_to_lip_curve(audio, sr, fps=FPS)
    print(f"audio {len(audio) / sr:.2f}s @{sr}Hz -> curve {len(curve)} frames @{FPS}fps")

    # 2) 驱动动作模板 + lip ratio 标定
    with open(PKL_PATH, "rb") as f:
        tpl = pickle.load(f)
    motions, c_eyes, c_lips_dri = tpl["motion"], tpl["c_eyes_lst"], tpl["c_lip_lst"]
    dri_ratios = np.array([float(np.array(c).reshape(-1)[0]) for c in c_lips_dri])
    ratio_closed = float(np.percentile(dri_ratios, 5))
    ratio_open = float(np.percentile(dri_ratios, 95))
    print(f"calibrated lip close-ratio: closed(p05)={ratio_closed:.5f} "
          f"open(p95)={ratio_open:.5f} (min={dri_ratios.min():.5f} max={dri_ratios.max():.5f})")

    n = min(len(curve), len(motions))
    curve = curve[:n]
    # 曲线 0..1 -> 标定后的 close-ratio；注入到 dri_motion_info[2]
    c_lips_audio = [np.array([[ratio_closed + float(c) * (ratio_open - ratio_closed)]],
                             dtype=np.float32) for c in curve]

    np.savez(os.path.join(OUT_DIR, "lip_curve.npz"), curve=curve,
             ratio_closed=ratio_closed, ratio_open=ratio_open)
    quiet = [i for i in range(n) if curve[i] < 0.05]
    loud = [i for i in range(n) if curve[i] > 0.9]
    print(f"quiet frames (curve<0.05): {quiet[:20]}{'...' if len(quiet) > 20 else ''}")
    print(f"loud frames (curve>0.9): {loud[:20]}{'...' if len(loud) > 20 else ''}")

    # 3) 注入渲染（lip retargeting ON + keep_motion，嘴由音频接管）
    pipe = build_pipe(lip_retarget=True)
    raw_path = os.path.join(OUT_DIR, "lip_drive_raw.mp4")
    render(pipe, motions[:n], c_eyes[:n], c_lips_audio, raw_path)

    # 4) 对照渲染（retargeting OFF，嘴跟随 d14 原始动作；同帧序列逐帧可比）
    pipe_ctrl = build_pipe(lip_retarget=False)
    ctrl_path = os.path.join(OUT_DIR, "lip_drive_control.mp4")
    render(pipe_ctrl, motions[:n], c_eyes[:n], c_lips_dri[:n], ctrl_path)

    # 5) 注入视频混入 TTS 音轨
    final_path = os.path.join(OUT_DIR, "lip_drive_test.mp4")
    subprocess.run([FFMPEG, "-y", "-i", raw_path, "-i", WAV_PATH,
                    "-c:v", "copy", "-c:a", "aac", "-shortest", final_path], check=True)
    print(f"final: {final_path}")


if __name__ == "__main__":
    main()
