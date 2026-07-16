# OneLive V2 — M1a 引擎服务化 + 本地单频道闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 M0 验证过的推理管线封装成"数字人引擎服务"（WS 协议、每频道常驻 producer + 订阅者扇出、最新帧优先丢弃策略），并在本地 Arc 上跑通单频道端到端闭环：驱动源（视频/摄像头）→ 引擎服务 → 浏览器实时预览。

**Architecture:** `engine/service/` 新增三层——`protocol.py`（帧封包/控制消息，纯逻辑可测）、`worker.py`（频道 worker：latest-wins 队列 + 推理线程 + 订阅者扇出，管线可注入 fake 做测试）、`app.py`（FastAPI：/ingest 收驱动帧、/out 扇出渲染帧、/status 状态）。真实管线适配器复用 M0 的 split/DML 配置。M1b 边缘部署时**这套代码原样上 GPU 机**，只换管线 provider 配置。

**Tech Stack:** Python 3.12（engine/.venv）、FastAPI + WebSocket、M0 的 FasterLivePortrait patched clone、pytest。

**执行前提（执行者必读）：**
- Worktree：在 `C:\Users\76475\Documents\OneLive` 新建 worktree（`.worktrees/v2-m1a`，分支 `feature/v2-m1a-engine-service`）。**注意**：M0 的模型/克隆/venv 在 `.worktrees/v2-m0-spike/engine/` 下且不入库。M1a 直接引用该路径运行（环境变量 `ONELIVE_M0_ENGINE=C:\Users\76475\Documents\OneLive\.worktrees\v2-m0-spike\engine`），不要复制 2.9GB 资产。
- M0 关键事实（详见 docs/superpowers/spike-results.md）：本地推理 ~660ms/帧（1.5fps）——M1a 验收标准是**架构与协议正确 + 端到端可视**，不是帧率；DML session 必须 `disable_metacommands`（已在 patch 内）；`prepare_source` 后必须立即快照；`run()` 输出 RGB；split predictor 单例内部持锁；预览服务的"连接驱动推理"模式必须反转为"producer 常驻 + 订阅者扇出"。
- pytest 从 `engine/` 运行需要 `PYTHONPATH=.`（M0 的 conftest.py 已处理 tests/ 目录）。
- 服务代码放主 worktree 的 `engine/service/`（入库）；运行时依赖 M0 worktree 的资产（不入库）。

---

### Task 1: 协议模块（TDD）

**Files:**
- Create: `engine/service/__init__.py`（空）
- Create: `engine/service/protocol.py`
- Test: `engine/tests/test_protocol.py`

- [ ] **Step 1: 写失败测试**

`engine/tests/test_protocol.py`：

```python
import numpy as np
import pytest

from service.protocol import FrameHeader, pack_frame, unpack_frame


def test_frame_roundtrip():
    payload = b"\xff\xd8fakejpeg"
    header = FrameHeader(seq=42, ts_ms=1234567890123, channel=0)
    blob = pack_frame(header, payload)
    h2, p2 = unpack_frame(blob)
    assert h2 == header
    assert p2 == payload


def test_unpack_rejects_short_blob():
    with pytest.raises(ValueError):
        unpack_frame(b"tiny")


def test_seq_and_ts_ranges():
    h = FrameHeader(seq=2**31, ts_ms=2**52, channel=255)
    h2, _ = unpack_frame(pack_frame(h, b"x"))
    assert h2.seq == 2**31 and h2.ts_ms == 2**52 and h2.channel == 255
```

- [ ] **Step 2: 运行确认失败**

```powershell
cd <m1a-worktree>\engine
$env:PYTHONPATH="."; ..\..\v2-m0-spike\engine\.venv\Scripts\python -m pytest tests\test_protocol.py -v
```

预期：ModuleNotFoundError。

- [ ] **Step 3: 最小实现**

`engine/service/protocol.py`：

```python
"""引擎服务二进制帧协议：20 字节定长头 + JPEG payload。

头部布局（little-endian）：magic u16 = 0x4F4C ("OL") | version u8 | channel u8 |
seq u64 | ts_ms u64（发送方 epoch 毫秒）。控制消息走 JSON 文本帧，不经此模块。
"""

import struct
from dataclasses import dataclass

_MAGIC = 0x4F4C
_VERSION = 1
_FMT = "<HBBQQ"
_HEADER_LEN = struct.calcsize(_FMT)  # 20


@dataclass(frozen=True)
class FrameHeader:
    seq: int
    ts_ms: int
    channel: int = 0


def pack_frame(header: FrameHeader, payload: bytes) -> bytes:
    return struct.pack(_FMT, _MAGIC, _VERSION, header.channel,
                       header.seq, header.ts_ms) + payload


def unpack_frame(blob: bytes) -> tuple[FrameHeader, bytes]:
    if len(blob) < _HEADER_LEN:
        raise ValueError(f"frame blob too short: {len(blob)} < {_HEADER_LEN}")
    magic, version, channel, seq, ts_ms = struct.unpack_from(_FMT, blob)
    if magic != _MAGIC or version != _VERSION:
        raise ValueError(f"bad magic/version: {magic:#x}/{version}")
    return FrameHeader(seq=seq, ts_ms=ts_ms, channel=channel), blob[_HEADER_LEN:]
```

- [ ] **Step 4: 测试通过**（同 Step 2 命令，预期 3 passed）

- [ ] **Step 5: Commit**

```bash
git add engine/service/__init__.py engine/service/protocol.py engine/tests/test_protocol.py
git commit -m "feat(m1a): engine service frame protocol with tests"
```

---

### Task 2: 频道 worker（TDD，fake 管线注入）

**Files:**
- Create: `engine/service/worker.py`
- Test: `engine/tests/test_worker.py`

- [ ] **Step 1: 写失败测试**

`engine/tests/test_worker.py`：

```python
import threading
import time

import numpy as np

from service.worker import ChannelWorker


class FakePipeline:
    """可控耗时的假管线：返回输入帧的副本并记录调用序号。"""

    def __init__(self, cost_s: float = 0.0):
        self.cost_s = cost_s
        self.calls: list[int] = []

    def infer(self, frame_bgr: np.ndarray, seq: int) -> np.ndarray:
        self.calls.append(seq)
        if self.cost_s:
            time.sleep(self.cost_s)
        return frame_bgr.copy()


def _frame(v: int) -> np.ndarray:
    return np.full((8, 8, 3), v, np.uint8)


def test_latest_wins_drops_stale_frames():
    fake = FakePipeline(cost_s=0.05)
    w = ChannelWorker(pipeline=fake, name="t")
    w.start()
    try:
        for i in range(10):  # 提交快于消费，中间帧应被丢弃
            w.submit(_frame(i), seq=i)
            time.sleep(0.01)
        deadline = time.time() + 2.0
        while time.time() < deadline and (not fake.calls or fake.calls[-1] != 9):
            time.sleep(0.01)
        assert fake.calls[-1] == 9          # 最新帧必被处理
        assert len(fake.calls) < 10         # 有丢帧（latest-wins）
        assert fake.calls == sorted(fake.calls)  # 不回退
    finally:
        w.stop()


def test_subscribers_receive_rendered_frames():
    fake = FakePipeline()
    w = ChannelWorker(pipeline=fake, name="t")
    got: list[int] = []
    unsub = w.subscribe(lambda seq, jpeg: got.append(seq))
    w.start()
    try:
        w.submit(_frame(1), seq=1)
        deadline = time.time() + 2.0
        while time.time() < deadline and not got:
            time.sleep(0.01)
        assert got == [1]
        unsub()
        w.submit(_frame(2), seq=2)
        time.sleep(0.2)
        assert got == [1]                   # 退订后不再收到
    finally:
        w.stop()


def test_stats_report_processed_and_dropped():
    fake = FakePipeline(cost_s=0.05)
    w = ChannelWorker(pipeline=fake, name="t")
    w.start()
    try:
        for i in range(6):
            w.submit(_frame(i), seq=i)
        time.sleep(0.5)
        s = w.stats()
        assert s["processed"] >= 1
        assert s["processed"] + s["dropped"] == 6
        assert s["last_infer_ms"] >= 40
    finally:
        w.stop()
```

- [ ] **Step 2: 运行确认失败**（ModuleNotFoundError）

- [ ] **Step 3: 实现**

`engine/service/worker.py`：

```python
"""频道 worker：常驻推理线程 + latest-wins 单槽队列 + 订阅者扇出。

设计约束（来自 M0 结论）：推理 0.5-0.7s/帧且底层 split predictor 串行，
排队旧帧只会放大延迟——slot 里永远只保留最新一帧，被覆盖即计 dropped。
订阅者回调收到 (seq, jpeg_bytes)；回调在 worker 线程执行，必须非阻塞。
"""

import threading
import time
from typing import Callable, Optional

import cv2
import numpy as np

Subscriber = Callable[[int, bytes], None]


class ChannelWorker:
    def __init__(self, pipeline, name: str = "ch0", jpeg_quality: int = 80):
        self._pipeline = pipeline
        self._name = name
        self._quality = jpeg_quality
        self._slot: Optional[tuple[np.ndarray, int]] = None
        self._slot_lock = threading.Condition()
        self._subs: dict[int, Subscriber] = {}
        self._subs_lock = threading.Lock()
        self._next_sub_id = 0
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._stats = {"processed": 0, "dropped": 0, "last_infer_ms": 0.0}

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name=f"worker-{self._name}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        with self._slot_lock:
            self._slot_lock.notify_all()
        if self._thread:
            self._thread.join(timeout=5)

    def submit(self, frame_bgr: np.ndarray, seq: int) -> None:
        with self._slot_lock:
            if self._slot is not None:
                self._stats["dropped"] += 1
            self._slot = (frame_bgr, seq)
            self._slot_lock.notify()

    def subscribe(self, cb: Subscriber) -> Callable[[], None]:
        with self._subs_lock:
            sid = self._next_sub_id
            self._next_sub_id += 1
            self._subs[sid] = cb

        def unsubscribe() -> None:
            with self._subs_lock:
                self._subs.pop(sid, None)

        return unsubscribe

    def stats(self) -> dict:
        return dict(self._stats)

    def _loop(self) -> None:
        while not self._stop.is_set():
            with self._slot_lock:
                while self._slot is None and not self._stop.is_set():
                    self._slot_lock.wait(timeout=0.1)
                if self._stop.is_set():
                    return
                frame, seq = self._slot
                self._slot = None
            t0 = time.perf_counter()
            out_bgr = self._pipeline.infer(frame, seq)
            self._stats["last_infer_ms"] = (time.perf_counter() - t0) * 1000
            if out_bgr is None:  # 管线可返回 None 表示本帧无输出（如无脸）
                continue
            self._stats["processed"] += 1
            ok, jpg = cv2.imencode(".jpg", out_bgr, [cv2.IMWRITE_JPEG_QUALITY, self._quality])
            if not ok:
                continue
            payload = jpg.tobytes()
            with self._subs_lock:
                subs = list(self._subs.values())
            for cb in subs:
                cb(seq, payload)
```

- [ ] **Step 4: 测试通过**（3 passed；如时序断言在慢机器上抖动，放宽等待上限而不是删断言）

- [ ] **Step 5: Commit**

```bash
git add engine/service/worker.py engine/tests/test_worker.py
git commit -m "feat(m1a): channel worker with latest-wins queue and fan-out"
```

---

### Task 3: FastAPI 服务组装（fake 管线集成测试）

**Files:**
- Create: `engine/service/app.py`
- Test: `engine/tests/test_app_integration.py`

- [ ] **Step 1: 写失败测试**

`engine/tests/test_app_integration.py`：

```python
import numpy as np
import cv2
from fastapi.testclient import TestClient

from service.app import create_app
from service.protocol import FrameHeader, pack_frame, unpack_frame


class EchoPipeline:
    def infer(self, frame_bgr, seq):
        return frame_bgr


def _jpeg(v: int) -> bytes:
    ok, jpg = cv2.imencode(".jpg", np.full((16, 16, 3), v, np.uint8))
    assert ok
    return jpg.tobytes()


def test_ingest_to_out_roundtrip():
    app = create_app(pipeline=EchoPipeline())
    client = TestClient(app)
    with client.websocket_connect("/out") as out_ws:
        with client.websocket_connect("/ingest") as in_ws:
            in_ws.send_bytes(pack_frame(FrameHeader(seq=7, ts_ms=123, channel=0), _jpeg(9)))
            blob = out_ws.receive_bytes()
    header, payload = unpack_frame(blob)
    assert header.seq == 7
    img = cv2.imdecode(np.frombuffer(payload, np.uint8), cv2.IMREAD_COLOR)
    assert img.shape == (16, 16, 3)


def test_status_endpoint():
    app = create_app(pipeline=EchoPipeline())
    client = TestClient(app)
    r = client.get("/status")
    assert r.status_code == 200
    body = r.json()
    assert {"processed", "dropped", "last_infer_ms"} <= set(body["channel"])
    assert body["engine"] == "ok"


def test_bad_frame_does_not_kill_ingest():
    app = create_app(pipeline=EchoPipeline())
    client = TestClient(app)
    with client.websocket_connect("/out") as out_ws:
        with client.websocket_connect("/ingest") as in_ws:
            in_ws.send_bytes(b"garbage")  # 坏帧 → 忽略并继续
            in_ws.send_bytes(pack_frame(FrameHeader(seq=1, ts_ms=1, channel=0), _jpeg(3)))
            blob = out_ws.receive_bytes()
    assert unpack_frame(blob)[0].seq == 1
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

`engine/service/app.py`：

```python
"""数字人引擎服务：/ingest 收驱动帧（producer），/out 扇出渲染帧，/status 状态。

与 M0 preview server 的关键区别：推理由常驻 ChannelWorker 驱动，
WS 连接只是数据的进出口——多个 /out 订阅者共享同一路渲染结果，
新订阅者不会触发新推理，/ingest 断开重连不重置管线状态。
"""

import asyncio
import logging
from typing import Optional

import cv2
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from service.protocol import FrameHeader, pack_frame, unpack_frame
from service.worker import ChannelWorker

log = logging.getLogger("engine.service")


def create_app(pipeline) -> FastAPI:
    app = FastAPI()
    worker = ChannelWorker(pipeline=pipeline, name="ch0")
    worker.start()

    @app.get("/status")
    async def status() -> dict:
        return {"engine": "ok", "channel": worker.stats()}

    @app.websocket("/ingest")
    async def ingest(ws: WebSocket) -> None:
        await ws.accept()
        try:
            while True:
                blob = await ws.receive_bytes()
                try:
                    header, payload = unpack_frame(blob)
                    frame = cv2.imdecode(np.frombuffer(payload, np.uint8), cv2.IMREAD_COLOR)
                    if frame is None:
                        raise ValueError("jpeg decode failed")
                except ValueError as e:
                    log.warning("ingest: bad frame dropped: %s", e)
                    continue
                worker.submit(frame, seq=header.seq)
        except WebSocketDisconnect:
            log.info("ingest disconnected")

    @app.websocket("/out")
    async def out(ws: WebSocket) -> None:
        await ws.accept()
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=4)

        def on_frame(seq: int, jpeg: bytes) -> None:  # worker 线程回调 → 事件循环
            blob = pack_frame(FrameHeader(seq=seq, ts_ms=0, channel=0), jpeg)
            def _put() -> None:
                if queue.full():
                    queue.get_nowait()  # 订阅端也是 latest-wins
                queue.put_nowait(blob)
            loop.call_soon_threadsafe(_put)

        unsubscribe = worker.subscribe(on_frame)
        try:
            while True:
                await ws.send_bytes(await queue.get())
        except WebSocketDisconnect:
            pass
        finally:
            unsubscribe()

    @app.on_event("shutdown")
    def shutdown() -> None:
        worker.stop()

    return app
```

- [ ] **Step 4: 测试通过**（3 passed。TestClient 的 WS 是同步桥接，若 roundtrip 测试偶发超时，在 send 后轮询 receive 带超时重试一次并如实记录）

- [ ] **Step 5: Commit**

```bash
git add engine/service/app.py engine/tests/test_app_integration.py
git commit -m "feat(m1a): engine service app wiring ingest->worker->fanout"
```

---

### Task 4: 真实管线适配器 + 本地冒烟

**Files:**
- Create: `engine/service/liveportrait_pipeline.py`
- Create: `engine/service/run_local.py`

- [ ] **Step 1: 适配器实现**

`engine/service/liveportrait_pipeline.py`：

```python
"""把 M0 的 FasterLivePortrait patched clone 适配成 ChannelWorker 的 pipeline 接口。

依赖 M0 资产目录（环境变量 ONELIVE_M0_ENGINE 指向 .worktrees/v2-m0-spike/engine）。
遵守 M0 API 地图：chdir 到 clone 目录、prepare_source 后立即快照、
run() 输出 RGB、首次成功推理前每次传 first_frame=True（无脸首帧不能吞掉初始化）。
"""

import os
import sys
from pathlib import Path

import cv2

_M0 = Path(os.environ.get(
    "ONELIVE_M0_ENGINE",
    r"C:\Users\76475\Documents\OneLive\.worktrees\v2-m0-spike\engine",
))
_CLONE = _M0 / "FasterLivePortrait"


class LivePortraitPipeline:
    def __init__(self, source_image: str | None = None, cfg_name: str = "onnx_infer.yaml"):
        assert _CLONE.is_dir(), f"M0 engine assets not found: {_CLONE}"
        os.chdir(_CLONE)  # clone 内相对路径（模型/依赖资源）要求
        sys.path.insert(0, str(_CLONE))
        from omegaconf import OmegaConf
        from src.pipelines.faster_live_portrait_pipeline import FasterLivePortraitPipeline
        cfg = OmegaConf.load(str(_CLONE / "configs" / cfg_name))
        self._pipe = FasterLivePortraitPipeline(cfg=cfg)
        src = source_image or str(_CLONE / "assets/examples/source/s10.jpg")
        self._pipe.prepare_source(src, realtime=True)
        self._img_src = self._pipe.src_imgs[0]
        self._src_info = self._pipe.src_infos[0]
        self._initialized = False  # 首次成功推理前保持 first_frame=True

    def infer(self, frame_bgr, seq: int):
        ret = self._pipe.run(frame_bgr, self._img_src, self._src_info,
                             first_frame=not self._initialized)
        if ret is None:
            return None
        _, out_crop, _, _ = ret
        if out_crop is None:
            return None
        self._initialized = True
        return cv2.cvtColor(out_crop, cv2.COLOR_RGB2BGR)
```

（若 `run()` 对无脸帧的返回形态与上述不符——M0 记录的是 4-tuple 中 `out_crop is None`——以实测为准调整并在提交信息里说明。）

- [ ] **Step 2: 启动入口**

`engine/service/run_local.py`：

```python
"""本地启动引擎服务（Arc 慢速链路）。用法：
  <m0-venv-python> -m service.run_local [--port 8900] [--source <img>]
"""

import argparse
import logging

import uvicorn

from service.app import create_app
from service.liveportrait_pipeline import LivePortraitPipeline

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8900)
    ap.add_argument("--source", default=None)
    args = ap.parse_args()
    app = create_app(pipeline=LivePortraitPipeline(source_image=args.source))
    uvicorn.run(app, host="127.0.0.1", port=args.port)
```

- [ ] **Step 3: 冒烟验证**

启动服务（后台），用 Python WS 客户端从 d14.mp4 抽 10 帧发 /ingest，从 /out 收帧并解码断言 512x512 портrait、记录收帧间隔（预期 ~600-750ms）。`GET /status` 断言 processed>0。杀进程、确认端口清。实测输出原文记录到报告。

- [ ] **Step 4: Commit**

```bash
git add engine/service/liveportrait_pipeline.py engine/service/run_local.py
git commit -m "feat(m1a): real LivePortrait pipeline adapter and local runner"
```

---

### Task 5: 驱动源 feeder + E2E 闭环实测

**Files:**
- Create: `engine/service/feeder.py`
- Create: `engine/service/viewer.html`
- Create: `docs/superpowers/m1a-results.md`

- [ ] **Step 1: feeder 实现**

`engine/service/feeder.py`：

```python
"""驱动源 feeder：视频文件或摄像头 → JPEG → /ingest。用法：
  python -m service.feeder --url ws://127.0.0.1:8900/ingest --video <path> [--fps 15]
  python -m service.feeder --url ... --camera 0 --fps 15
按目标 fps 节拍发送（绝对时钟防漂移）；服务端 latest-wins 自然适配慢推理。
"""

import argparse
import asyncio
import time

import cv2
import websockets

from service.protocol import FrameHeader, pack_frame


async def run(url: str, cap: cv2.VideoCapture, fps: float, max_frames: int | None) -> None:
    async with websockets.connect(url, max_size=None) as ws:
        seq = 0
        t0 = time.perf_counter()
        while max_frames is None or seq < max_frames:
            ok, frame = cap.read()
            if not ok:
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                continue
            ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            if ok:
                header = FrameHeader(seq=seq, ts_ms=int(time.time() * 1000))
                await ws.send(pack_frame(header, jpg.tobytes()))
            seq += 1
            await asyncio.sleep(max(0.0, t0 + seq / fps - time.perf_counter()))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--video")
    ap.add_argument("--camera", type=int)
    ap.add_argument("--fps", type=float, default=15)
    ap.add_argument("--max-frames", type=int, default=None)
    args = ap.parse_args()
    assert (args.video is None) != (args.camera is None), "指定 --video 或 --camera 之一"
    cap = cv2.VideoCapture(args.video if args.video else args.camera)
    assert cap.isOpened(), "驱动源打开失败"
    asyncio.run(run(args.url, cap, args.fps, args.max_frames))
```

- [ ] **Step 2: viewer 页面**

`engine/service/viewer.html`：复用 M0 `engine/preview/index.html` 的 canvas + createImageBitmap 客户端，两处修改：WS 地址连 `/out`；收到的是 20 字节头 + JPEG（`ev.data.slice(20)` 取 payload），另加 seq 显示（`new DataView(ev.data).getBigUint64(4, true)`）。在 app.py 加 `GET /` 返回该页面。

- [ ] **Step 3: E2E 实测**

三进程同跑：run_local（服务）+ feeder（d14.mp4 @15fps，200 帧）+ WS probe 客户端（复用 M0 `ws_probe` 模式改 /out 协议）。测量并记录到 `docs/superpowers/m1a-results.md`：
- /out 收帧 fps（预期 ≈ 推理速度 ~1.5）
- 端到端延迟：feeder 发送 ts_ms → probe 收到时刻（同机时钟可直接减；预期 ≈ 1 帧推理时间 + 队列，<1.5s）
- /status 的 processed/dropped（dropped 应占大头——feeder 15fps vs 推理 1.5fps，丢帧率 ~90% 是**设计正确**的证据）
- 保存首/末两帧 PNG，目检 portrait 正常、颜色正确、动作随驱动变化

- [ ] **Step 4: 全量测试回归**

```powershell
cd <m1a-worktree>\engine
$env:PYTHONPATH="."; <m0-venv-python> -m pytest tests -v
```

预期：M0 的 2 个 + M1a 的 9 个全过。

- [ ] **Step 5: Commit**

```bash
git add engine/service/feeder.py engine/service/viewer.html engine/service/app.py docs/superpowers/m1a-results.md
git commit -m "feat(m1a): driving feeder, viewer page, e2e loop measured"
```

---

### Task 6: 摄像头实测 + 文档收尾

**Files:**
- Modify: `docs/superpowers/m1a-results.md`
- Modify: `README.md`（追加 engine 服务一节）

- [ ] **Step 1: 本机摄像头 E2E**

feeder 用 `--camera 0`（本机有摄像头）跑 60 秒，viewer 目检数字人是否跟随真人动作（这是 M1"实时复刻动作"的第一次真人验证）。无法目检的执行环境：保存 3 个时间点的输入帧+输出帧对照 PNG，人工比对头部姿态一致性，结果如实记录（含"未做人工目检"声明，留给验收者）。

- [ ] **Step 2: README 追加**

README.md 末尾"文档"节前追加一节（~10 行）：引擎服务简介、启动命令（依赖 M0 资产的说明 + ONELIVE_M0_ENGINE）、viewer 地址、当前性能（本地 ~1.5fps，边缘部署见 M1b）。

- [ ] **Step 3: 最终提交**

```bash
git add docs/superpowers/m1a-results.md README.md
git commit -m "docs(m1a): camera e2e results and engine service readme"
```

---

## 后续计划（不在本计划内，M1a 完成后另写）

- **M1b：边缘 GPU 部署**——AutoDL 4090（需用户开通账号并提供 SSH），上游 CUDA/TensorRT 路径（无需 split），同一 service 代码，公网 WS + 端口映射，3 路 ≥15fps 决策确认。
- **M1c：手机采集桥接**——复用 codex/iphone-live-avatar-mvp 分支的 HTTPS + WebRTC 上行，PC Node 侧抽帧转发 /ingest。

## Self-Review 记录

- Spec 覆盖：本计划覆盖 spec §9 M1 中"引擎 → 1 个数字人实时复刻动作 → 控制台预览"的服务化与本地闭环；"手机（先网页）采集"拆到 M1c（依赖旧分支复用评估），边缘算力拆到 M1b（依赖用户账号）——拆分符合 writing-plans 的独立可交付原则。
- 无占位符：所有代码块完整可用；Task 4 Step 1 对无脸返回形态的"以实测为准"是 M0 已记录事实的边界确认，附了预期形态。
- 一致性：`ChannelWorker(pipeline, name)` / `pipeline.infer(frame_bgr, seq)` / `create_app(pipeline)` 三处接口在 Task 2/3/4/5 中签名一致；协议头 20 字节在 Task 1 与 Task 5 viewer 的 slice(20) 一致。
