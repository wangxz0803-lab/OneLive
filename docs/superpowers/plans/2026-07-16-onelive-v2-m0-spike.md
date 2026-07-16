# OneLive V2 — M0 Spike（算力决策周）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Intel Arc 核显上实测 LivePortrait 实时推理性能、验证 TTS→嘴型驱动与浏览器预览通路，产出"本地 vs 边缘 GPU"算力分配决策（spec §4.3 决策门）。

**Architecture:** 复用 FasterLivePortrait（LivePortrait 的 ONNX 移植）作为推理管线，将执行后端切换为 onnxruntime DirectML EP（Arc 核显），失败则回退 OpenVINO EP，再失败回退 CPU 记录基线。基准脚本、口型实验、WS 预览服务全部放在新的 `engine/` 目录，与现有 Node/React 代码隔离。

**Tech Stack:** Python 3.12、onnxruntime-directml（备选 onnxruntime-openvino）、FasterLivePortrait（ONNX 模型）、edge-tts、FastAPI + WebSocket、pytest。

**上下文（执行者必读）：**
- 本机无 NVIDIA 独显，GPU 为 Intel(R) Arc(TM) Graphics（核显），32GB 内存，Windows 11。
- `python`（3.12.10）与 `hf` CLI 已在 PATH；`ffmpeg`、`uv` 未安装。
- Spike 性质：部分任务的"测试"是**记录到结果文档里的实测指标**，不是常规单元测试。凡是写"记录到 spike-results.md"的步骤，必须写真实测量值，禁止编造。
- 所有 spike 产物（脚本、结果）都要提交 git；模型文件和 venv 不提交。
- 决策门标准（来自 spec §4.3）：单路 ≥15fps → 本地方案；<15fps → 三路常驻边缘 GPU。

---

### Task 1: engine 目录与 Python 环境

**Files:**
- Create: `engine/.gitignore`
- Create: `engine/requirements.txt`
- Create: `docs/superpowers/spike-results.md`（结果文档骨架）

- [ ] **Step 1: 创建目录与 .gitignore**

```bash
mkdir -p engine/bench engine/preview engine/lipsync engine/tests
```

`engine/.gitignore` 内容：

```gitignore
.venv/
models/
FasterLivePortrait/
out/
__pycache__/
*.wav
*.mp4
```

- [ ] **Step 2: 写 requirements.txt**

`engine/requirements.txt` 内容：

```txt
onnxruntime-directml>=1.20
opencv-python
numpy
soundfile
edge-tts
fastapi
uvicorn[standard]
websockets
pytest
huggingface_hub
omegaconf
```

- [ ] **Step 3: 建 venv 并安装**

```powershell
cd C:\Users\76475\Documents\OneLive\engine
python -m venv .venv
.venv\Scripts\python -m pip install -U pip
.venv\Scripts\pip install -r requirements.txt
```

预期：安装成功无冲突。后续所有 Python 命令统一用 `engine\.venv\Scripts\python`。

- [ ] **Step 4: 验证 DirectML EP 可见**

```powershell
.venv\Scripts\python -c "import onnxruntime as ort; print(ort.get_available_providers())"
```

预期输出包含 `DmlExecutionProvider`。若没有，停下排查（onnxruntime-directml 是否装错成 onnxruntime）。

- [ ] **Step 5: 安装 ffmpeg**

```powershell
winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
```

新开终端验证 `ffmpeg -version` 输出版本号。若 winget 不可用，从 https://www.gyan.dev/ffmpeg/builds/ 手动下载 release-full 并加入 PATH。

- [ ] **Step 6: 创建结果文档骨架**

`docs/superpowers/spike-results.md` 内容：

```markdown
# M0 Spike 结果（真实测量，禁止编造）

日期：
执行环境：Intel Arc 核显 / 32GB / Windows 11 / Python 3.12

## 1. LivePortrait 推理基准
| 配置 | EP | 分辨率 | 单路 fps | 三路每路 fps | 备注 |
| --- | --- | --- | --- | --- | --- |
| （待填） | | | | | |

## 2. TTS→嘴型驱动
- 生成语言/音色：
- 口型与音频包络主观同步性（好/可接受/差）：
- 与头部动作迁移叠加是否冲突：
- 结论：

## 3. 浏览器预览通路
- 传输方式：WS + JPEG
- 端到端显示 fps（单路 512px）：
- 显著延迟（主观，ms 级估计）：

## 4. 决策门结论
- 单路 fps 是否 ≥15：
- 决策（本地三路 / 本地一路+边缘两路 / 三路常驻边缘）：
- 依据：
```

- [ ] **Step 7: Commit**

```bash
cd /c/Users/76475/Documents/OneLive
git add engine/.gitignore engine/requirements.txt docs/superpowers/spike-results.md
git commit -m "chore(m0): engine scaffold and spike results skeleton"
```

---

### Task 2: 获取 FasterLivePortrait 代码与 ONNX 模型

**Files:**
- Create: `engine/FasterLivePortrait/`（git clone，不入库）
- Create: `engine/models/`（模型下载，不入库）

- [ ] **Step 1: Clone 仓库**

```bash
git clone --depth 1 https://github.com/warmshao/FasterLivePortrait /c/Users/76475/Documents/OneLive/engine/FasterLivePortrait
```

- [ ] **Step 2: 下载 ONNX 模型包**

```powershell
cd C:\Users\76475\Documents\OneLive\engine
.venv\Scripts\hf download warmshao/FasterLivePortrait --local-dir models\liveportrait
```

（若 venv 里没有 hf 可执行文件，用系统 `hf` 同样命令。国内网络慢时设 `$env:HF_ENDPOINT="https://hf-mirror.com"` 重试。）

- [ ] **Step 3: 核对模型文件**

```bash
find /c/Users/76475/Documents/OneLive/engine/models/liveportrait -name "*.onnx" | head -30
```

预期看到 LivePortrait 各阶段模型（motion extractor、appearance/feature extractor、warping、stitching、landmark、人脸检测等 onnx 文件）。把实际文件清单粘贴到 spike-results.md 备注区。

- [ ] **Step 4: 安装 FasterLivePortrait 自身依赖（最小集）**

先看它要什么：

```bash
cat /c/Users/76475/Documents/OneLive/engine/FasterLivePortrait/requirements.txt
```

只安装推理必需项（跳过 tensorrt、torch-cuda 相关）。凡 requirements 里出现 `onnxruntime-gpu`，**不要安装**（会覆盖 directml 版本）；其余（如 scikit-image、pyyaml、omegaconf 等）按需装：

```powershell
.venv\Scripts\pip install scikit-image pyyaml
```

- [ ] **Step 5: 确认管线入口与配置结构**

```bash
ls /c/Users/76475/Documents/OneLive/engine/FasterLivePortrait/src/pipelines/ /c/Users/76475/Documents/OneLive/engine/FasterLivePortrait/configs/
grep -rn "ExecutionProvider\|providers" /c/Users/76475/Documents/OneLive/engine/FasterLivePortrait/src --include="*.py" | head -20
```

记录：管线类的 import 路径、onnx 配置文件名（预期是 `configs/onnx_infer.yaml` 一类）、session 创建代码位置。后续任务要用。

---

### Task 3: DirectML 后端跑通离线推理

**Files:**
- Modify: `engine/FasterLivePortrait/configs/*.yaml`（模型路径 + EP 配置）
- Modify: FasterLivePortrait 内创建 onnx session 的源文件（Task 2 Step 5 定位到的位置）

- [ ] **Step 1: 把 session provider 改为 DirectML**

在定位到的 session 创建处，将 providers 改为：

```python
providers = [("DmlExecutionProvider", {"device_id": 0}), "CPUExecutionProvider"]
session = ort.InferenceSession(model_path, providers=providers)
```

同时把 onnx 配置 yaml 里的模型路径指向 `../models/liveportrait/...` 的实际路径。

- [ ] **Step 2: 用仓库自带示例素材跑离线 demo**

FasterLivePortrait 自带 `assets/examples`（源人像 + 驱动视频）。按其 README 的 onnx 推理命令运行（通常形如）：

```powershell
cd C:\Users\76475\Documents\OneLive\engine\FasterLivePortrait
..\..\engine\.venv\Scripts\python run.py --src_image assets/examples/source/s10.jpg --dri_video assets/examples/driving/d14.mp4 --cfg configs/onnx_infer.yaml
```

（实际参数名以 `python run.py --help` 为准。）

预期：生成结果视频，人像跟随驱动视频做表情/头部运动。

- [ ] **Step 3: 处理 DirectML 已知风险点**

LivePortrait 的 warping 模块含 5D GridSample，DirectML 可能不支持该算子。现象：报错 `GridSample` 相关，或该节点自动回退 CPU 导致极慢。处理顺序：

1. 保持 `CPUExecutionProvider` 兜底在 providers 列表里，先让它跑通（混合执行）；
2. 若整体不可用或 <3fps，安装 OpenVINO EP 重测：

```powershell
.venv\Scripts\pip uninstall -y onnxruntime-directml
.venv\Scripts\pip install onnxruntime-openvino
```

providers 改为：

```python
providers = [("OpenVINOExecutionProvider", {"device_type": "GPU"}), "CPUExecutionProvider"]
```

3. 两者都不行 → 纯 CPU 跑通记录基线（决策门直接输给边缘方案，但数据要留）。

- [ ] **Step 4: 记录**

把"最终采用的 EP + 是否有算子回退 + 离线 demo 是否出片"写入 spike-results.md §1 备注。

- [ ] **Step 5: Commit（只提交我们自己的改动说明）**

FasterLivePortrait 是 gitignore 的 clone，对它的 patch 用 diff 文件留档：

```bash
cd /c/Users/76475/Documents/OneLive/engine/FasterLivePortrait
git diff > ../patches/faster-live-portrait-dml.patch
cd /c/Users/76475/Documents/OneLive
git add engine/patches/faster-live-portrait-dml.patch docs/superpowers/spike-results.md
git commit -m "feat(m0): run LivePortrait offline on Intel Arc, record backend findings"
```

---

### Task 4: 推理基准脚本（决策门核心数据）

**Files:**
- Create: `engine/bench/bench_liveportrait.py`
- Test: 运行输出的实测指标（记录到 spike-results.md）

- [ ] **Step 1: 写基准脚本**

`engine/bench/bench_liveportrait.py`：

```python
"""LivePortrait 推理基准：单路与三路交错，输出各阶段耗时与 fps。

用法:
  python bench/bench_liveportrait.py --frames 300 --sources 1
  python bench/bench_liveportrait.py --frames 300 --sources 3
"""

import argparse
import sys
import time
from pathlib import Path

import cv2

REPO = Path(__file__).resolve().parents[1] / "FasterLivePortrait"
sys.path.insert(0, str(REPO))

# import 路径以 Task 2 Step 5 确认的为准，预期如下：
from src.pipelines.faster_live_portrait_pipeline import FasterLivePortraitPipeline  # noqa: E402
from omegaconf import OmegaConf  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cfg", default=str(REPO / "configs" / "onnx_infer.yaml"))
    ap.add_argument("--src_dir", default=str(REPO / "assets" / "examples" / "source"))
    ap.add_argument("--driving", default=str(REPO / "assets" / "examples" / "driving" / "d14.mp4"))
    ap.add_argument("--frames", type=int, default=300)
    ap.add_argument("--sources", type=int, default=1, choices=[1, 2, 3])
    args = ap.parse_args()

    cfg = OmegaConf.load(args.cfg)
    pipe = FasterLivePortraitPipeline(cfg=cfg)

    src_images = sorted(Path(args.src_dir).glob("*.jpg"))[: args.sources]
    assert len(src_images) == args.sources, f"need {args.sources} source images"
    # 逐个源做一次 prepare（含外观特征提取，属一次性成本）
    prepared = []
    for p in src_images:
        t0 = time.perf_counter()
        prepared.append(pipe.prepare_source(str(p)))  # 方法名以实际 API 为准
        print(f"prepare {p.name}: {(time.perf_counter() - t0) * 1000:.0f} ms")

    cap = cv2.VideoCapture(args.driving)
    per_frame_ms: list[float] = []
    n = 0
    while n < args.frames:
        ok, frame = cap.read()
        if not ok:
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            continue
        t0 = time.perf_counter()
        for i in range(args.sources):  # 三路 = 同一驱动帧渲染三个源
            pipe.run(frame, source_index=i)  # 调用形式以实际 API 为准
        per_frame_ms.append((time.perf_counter() - t0) * 1000)
        n += 1

    warm = per_frame_ms[30:]  # 去掉预热
    avg = sum(warm) / len(warm)
    print(f"sources={args.sources} frames={len(warm)}")
    print(f"avg {avg:.1f} ms/driving-frame -> {1000 / avg:.1f} fps (每路同步)")
    p95 = sorted(warm)[int(len(warm) * 0.95)]
    print(f"p95 {p95:.1f} ms")


if __name__ == "__main__":
    main()
```

注意：`prepare_source` / `run(frame, source_index=...)` 两处调用形式必须先对照 FasterLivePortrait 实际 API（Task 2 Step 5 的记录）调整后再跑；如果它的 pipeline 是"单源"设计，就实例化 3 个 pipeline 对象共享 session 或各自建 session，如实测哪种可行。

- [ ] **Step 2: 跑单路基准**

```powershell
cd C:\Users\76475\Documents\OneLive\engine
.venv\Scripts\python bench\bench_liveportrait.py --frames 300 --sources 1
```

记录 avg/p95/fps 到 spike-results.md §1。

- [ ] **Step 3: 跑三路基准**

```powershell
.venv\Scripts\python bench\bench_liveportrait.py --frames 300 --sources 3
```

记录到 spike-results.md §1。

- [ ] **Step 4: Commit**

```bash
cd /c/Users/76475/Documents/OneLive
git add engine/bench/bench_liveportrait.py docs/superpowers/spike-results.md
git commit -m "feat(m0): LivePortrait benchmark on Arc, record 1/3-stream fps"
```

---

### Task 5: TTS→嘴型驱动可行性

**Files:**
- Create: `engine/lipsync/audio_lip.py`
- Create: `engine/tests/test_audio_lip.py`
- Create: `engine/lipsync/experiment_lip_drive.py`

- [ ] **Step 1: 写失败测试（音频包络→口型曲线）**

`engine/tests/test_audio_lip.py`：

```python
import numpy as np

from lipsync.audio_lip import audio_to_lip_curve


def test_lip_curve_range_and_length():
    sr = 16000
    t = np.linspace(0, 2.0, sr * 2, endpoint=False)
    # 1Hz 开合的正弦调制噪声，模拟说话节奏
    audio = (np.random.randn(sr * 2) * 0.1 * (0.5 + 0.5 * np.sin(2 * np.pi * 1.0 * t))).astype(np.float32)
    curve = audio_to_lip_curve(audio, sr, fps=25)
    assert len(curve) == 50  # 2s * 25fps
    assert float(curve.min()) >= 0.0 and float(curve.max()) <= 1.0
    assert float(curve.max()) > 0.3  # 有声段要张嘴


def test_silence_keeps_mouth_closed():
    sr = 16000
    curve = audio_to_lip_curve(np.zeros(sr, dtype=np.float32), sr, fps=25)
    assert float(curve.max()) < 0.05
```

- [ ] **Step 2: 运行确认失败**

```powershell
cd C:\Users\76475\Documents\OneLive\engine
.venv\Scripts\python -m pytest tests\test_audio_lip.py -v
```

预期：FAIL（模块不存在）。

- [ ] **Step 3: 最小实现**

`engine/lipsync/__init__.py`（空文件）与 `engine/lipsync/audio_lip.py`：

```python
"""音频包络 -> 口型开合曲线（0..1），用于 LivePortrait lip retarget。"""

import numpy as np


def audio_to_lip_curve(audio: np.ndarray, sr: int, fps: int = 25,
                        attack: float = 0.55, release: float = 0.25) -> np.ndarray:
    """按视频帧粒度计算 RMS 包络，归一化到 0..1，并做不对称平滑（张嘴快、闭嘴慢）。"""
    hop = sr // fps
    n_frames = len(audio) // hop
    rms = np.array([
        float(np.sqrt(np.mean(np.square(audio[i * hop:(i + 1) * hop]))))
        for i in range(n_frames)
    ])
    peak = float(rms.max())
    if peak < 1e-4:  # 静音
        return np.zeros(n_frames, dtype=np.float32)
    norm = np.clip(rms / peak, 0.0, 1.0)
    out = np.zeros_like(norm)
    prev = 0.0
    for i, v in enumerate(norm):
        alpha = attack if v > prev else release
        prev = prev + alpha * (v - prev)
        out[i] = prev
    return np.clip(out, 0.0, 1.0).astype(np.float32)
```

- [ ] **Step 4: 测试通过**

```powershell
.venv\Scripts\python -m pytest tests\test_audio_lip.py -v
```

预期：2 passed。

- [ ] **Step 5: 生成 TTS 音频**

```powershell
.venv\Scripts\edge-tts --voice en-US-JennyNeural --text "Hello everyone, welcome to my live stream. Today I will show you three amazing products." --write-media out\tts_en.mp3
ffmpeg -y -i out\tts_en.mp3 -ar 16000 -ac 1 out\tts_en.wav
```

- [ ] **Step 6: 口型驱动实验脚本**

`engine/lipsync/experiment_lip_drive.py`：

```python
"""实验：TTS 音频驱动嘴型 + 驱动视频驱动头部/表情，验证两者叠加。

产出 out/lip_drive_test.mp4，人工检查：
1) 嘴巴开合是否跟 TTS 节奏一致；2) 头部/眉眼是否仍跟驱动视频；3) 有无撕裂伪影。
"""

import sys
from pathlib import Path

import cv2
import numpy as np
import soundfile as sf

REPO = Path(__file__).resolve().parents[1] / "FasterLivePortrait"
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from omegaconf import OmegaConf  # noqa: E402
from src.pipelines.faster_live_portrait_pipeline import FasterLivePortraitPipeline  # noqa: E402
from lipsync.audio_lip import audio_to_lip_curve  # noqa: E402

FPS = 25

cfg = OmegaConf.load(REPO / "configs" / "onnx_infer.yaml")
pipe = FasterLivePortraitPipeline(cfg=cfg)
pipe.prepare_source(str(REPO / "assets/examples/source/s10.jpg"))  # API 名以实际为准

audio, sr = sf.read(Path(__file__).resolve().parents[1] / "out" / "tts_en.wav", dtype="float32")
lip = audio_to_lip_curve(audio, sr, fps=FPS)

cap = cv2.VideoCapture(str(REPO / "assets/examples/driving/d14.mp4"))
writer = None
for i in range(len(lip)):
    ok, frame = cap.read()
    if not ok:
        break
    # 关键验证点：向管线传入外部 lip ratio 覆盖驱动帧的嘴型。
    # FasterLivePortrait 的 lip retarget 入口以源码为准（stitching_lip / retarget_lip 相关方法），
    # 若 run() 不暴露参数，则直接调用其内部 retarget 函数注入 lip[i]。
    out = pipe.run(frame, lip_ratio=float(lip[i]))
    if writer is None:
        h, w = out.shape[:2]
        writer = cv2.VideoWriter("out/lip_drive_test_raw.mp4", cv2.VideoWriter_fourcc(*"mp4v"), FPS, (w, h))
    writer.write(out)
writer.release()
print("wrote out/lip_drive_test_raw.mp4")
```

合成音轨方便人工检查：

```powershell
ffmpeg -y -i out\lip_drive_test_raw.mp4 -i out\tts_en.wav -c:v copy -c:a aac -shortest out\lip_drive_test.mp4
```

- [ ] **Step 7: 人工评审并记录**

播放 `out/lip_drive_test.mp4`，把三个检查点结论（同步性/头部表情保持/伪影）如实写入 spike-results.md §2。若 lip retarget 注入点在源码里走不通，如实记录"口型驱动需要的改造量"作为决策输入。

- [ ] **Step 8: Commit**

```bash
cd /c/Users/76475/Documents/OneLive
git add engine/lipsync engine/tests/test_audio_lip.py docs/superpowers/spike-results.md
git commit -m "feat(m0): TTS-driven lip curve with tests, record lip retarget feasibility"
```

---

### Task 6: 浏览器实时预览通路

**Files:**
- Create: `engine/preview/server.py`
- Create: `engine/preview/index.html`

- [ ] **Step 1: 写 WS 预览服务**

`engine/preview/server.py`：

```python
"""WS + JPEG 帧预览服务：/ 提供页面，/ws 推帧。

--synthetic 模式推合成帧（测通路本身）；--pipeline 模式接 LivePortrait 输出。
"""

import argparse
import asyncio
import time
from pathlib import Path

import cv2
import numpy as np
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse

app = FastAPI()
ARGS = None


def synthetic_frame(i: int) -> np.ndarray:
    img = np.zeros((512, 512, 3), np.uint8)
    cv2.circle(img, (256 + int(180 * np.cos(i / 15)), 256 + int(180 * np.sin(i / 15))), 40, (0, 200, 255), -1)
    cv2.putText(img, f"frame {i}", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
    return img


@app.get("/")
async def page() -> HTMLResponse:
    return HTMLResponse((Path(__file__).parent / "index.html").read_text(encoding="utf-8"))


@app.websocket("/ws")
async def ws(sock: WebSocket) -> None:
    await sock.accept()
    i = 0
    try:
        while True:
            t0 = time.perf_counter()
            frame = synthetic_frame(i)  # --pipeline 模式在 Task 6 Step 4 替换此行
            ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            await sock.send_bytes(jpg.tobytes())
            i += 1
            await asyncio.sleep(max(0.0, 1 / 25 - (time.perf_counter() - t0)))
    except WebSocketDisconnect:
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["synthetic", "pipeline"], default="synthetic")
    ARGS = ap.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=8891)
```

`engine/preview/index.html`：

```html
<title>OneLive engine preview</title>
<canvas id="c" width="512" height="512" style="border:1px solid #444"></canvas>
<div id="fps"></div>
<script>
  const ctx = document.getElementById('c').getContext('2d');
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  let n = 0, t0 = performance.now();
  ws.onmessage = async (ev) => {
    const bmp = await createImageBitmap(new Blob([ev.data], {type: 'image/jpeg'}));
    ctx.drawImage(bmp, 0, 0);
    if (++n % 25 === 0) {
      const now = performance.now();
      document.getElementById('fps').textContent = `client fps: ${(25000 / (now - t0)).toFixed(1)}`;
      t0 = now;
    }
  };
</script>
```

- [ ] **Step 2: 合成模式验证通路**

```powershell
cd C:\Users\76475\Documents\OneLive\engine
.venv\Scripts\python preview\server.py --mode synthetic
```

浏览器打开 http://127.0.0.1:8891 ，预期看到运动圆点，client fps ≈ 25。

- [ ] **Step 3: 接入 pipeline 输出**

把 `ws()` 中 `synthetic_frame(i)` 替换为：driving 视频逐帧 → `pipe.run(...)` 输出帧（复用 Task 4 已调通的调用形式，模块级初始化 pipeline，`--mode pipeline` 时启用）。

- [ ] **Step 4: 实测并记录**

pipeline 模式下浏览器观察 client fps 与主观延迟，写入 spike-results.md §3。

- [ ] **Step 5: Commit**

```bash
cd /c/Users/76475/Documents/OneLive
git add engine/preview docs/superpowers/spike-results.md
git commit -m "feat(m0): WS browser preview path with measured fps"
```

---

### Task 7: 决策门结论

**Files:**
- Modify: `docs/superpowers/spike-results.md`（§4）
- Modify: `docs/superpowers/specs/2026-07-16-onelive-v2-redesign-design.md`（§4.3 决策落地为事实）

- [ ] **Step 1: 汇总填写决策矩阵**

按 spec §4.3 规则对照实测：单路 ≥15fps → 本地三路或本地一路+边缘两路；<15fps → 三路常驻边缘。把决策和依据写入 spike-results.md §4。

- [ ] **Step 2: 回写 spec**

在 spec §4.3 决策门条目下追加一行：`（2026-07-XX M0 实测结论：<决策>，数据见 spike-results.md）`。

- [ ] **Step 3: Commit**

```bash
cd /c/Users/76475/Documents/OneLive
git add docs/superpowers/spike-results.md docs/superpowers/specs/2026-07-16-onelive-v2-redesign-design.md
git commit -m "docs(m0): record spike decision on local vs edge GPU allocation"
```

- [ ] **Step 4: 触发 M1 计划编写**

M0 完成后回到主会话，基于决策结果编写 M1（单频道端到端）实现计划。

---

## Self-Review 记录

- Spec 覆盖：本计划只覆盖 spec §9 M0 的四项产出（基准/口型/预览/决策），符合"一里程碑一计划"的拆分决定；M1–M4 由后续计划覆盖。
- 无占位符：所有代码块完整；两处"以实际 API 为准"是 spike 固有的环境探索点，均配有对应的探索命令（Task 2 Step 5）与如实记录要求，不是留白。
- 类型/命名一致性：`audio_to_lip_curve` 在测试与实现、实验脚本中签名一致；`pipe.prepare_source`/`pipe.run` 的调整规则在 Task 4 与 Task 5 中说明一致。
