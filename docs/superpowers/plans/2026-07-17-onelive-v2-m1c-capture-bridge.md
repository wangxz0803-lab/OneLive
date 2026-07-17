# OneLive V2 — M1c 采集桥接 + 服务加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消化 M1a 遗留的服务加固待办（真实 E2E 时延、多频道、协议健壮性、连接清理），并打通"浏览器/手机摄像头 → 引擎 → 数字人"的采集链路；用 Playwright 假摄像头（喂含人脸的 d14 视频）完成全自主 E2E 验证。真机 iPhone 验证留给项目所有者。

**Architecture:** 服务侧在 `engine/service/` 原地演进：Subscriber 契约加 ts_ms、JPEG 解码移入 worker、/ingest 支持 JSON 文本控制帧、/out 空闲断连清理、多频道 worker 注册表（协议 channel 字节已预留）。采集侧新增 `capture.html`：getUserMedia → canvas 抽帧 → JS 侧按 20 字节协议封包 → WS /ingest（手机需 HTTPS：uvicorn 挂载仓库 certs/ 的自签证书）。E2E 用 Playwright fake-device 把 d14.mp4 转 y4m 当假摄像头，浏览器真实走完采集→推理→预览全链路。

**Tech Stack:** Python 3.12（M0 venv）、FastAPI、Playwright（仓库 Node devDeps 已有）、ffmpeg（y4m 转换）。

**执行前提：**
- Worktree：`.worktrees/v2-m1c`，分支 `feature/v2-m1c-capture-bridge`，基于 master（≥5b1e559）。
- M0 资产照旧经 `ONELIVE_M0_ENGINE` 引用 `.worktrees/v2-m0-spike/engine`；M0 venv python 同前。
- 本地推理 ~534ms/帧；无脸→skipped 仅限首检前（中途丢脸是上游局限，见 m1a-results.md）。
- ffmpeg 完整路径见 spike-results.md（不在会话 PATH）。
- pytest：worktree `engine/` 下 `PYTHONPATH=.`；当前基线 16 passed。
- 真机 iPhone 验证 = OWNER 项，本计划只做到 Playwright 假摄像头 + 桌面浏览器层面。

---

### Task 1: Subscriber 契约加 ts_ms（真实 E2E 时延）

**Files:** Modify `engine/service/worker.py`, `engine/service/app.py`; Test `engine/tests/test_worker.py`, `engine/tests/test_app_integration.py`

- Subscriber 签名 `(seq, jpeg)` → `(seq, ts_ms, jpeg)`；`submit(frame, seq)` → `submit(frame, seq, ts_ms)`；worker 全程透传。
- app.py：/ingest 把 header.ts_ms 传入 submit；/out 的 on_frame 用真实 ts_ms 封包（替换现在的 0）。
- TDD：先改测试（现有 worker/app 测试的回调与断言加 ts_ms；新增断言：/out 收到的 header.ts_ms == 发送值），红→绿。
- Commit: `feat(m1c): plumb ts_ms through worker to /out for real e2e latency`

### Task 2: JPEG 解码移入 worker + /ingest 文本帧守卫

**Files:** Modify `engine/service/worker.py`, `engine/service/app.py`; Tests 同步调整

- `submit(jpeg_bytes, seq, ts_ms)` 收字节而非 ndarray；解码移到 `_loop`（被 latest-wins 丢掉的帧不再白解码——15fps 入 1.9fps 出时省 ~87% 解码）；解码失败计入 errors。FakePipeline 测试改喂真实小 JPEG。
- /ingest 改 `ws.receive()` 手工分发：bytes → 协议解包+submit；text → JSON 解析，未知类型忽略并 log（协议 docstring 承诺的控制帧通道从此真实存在；本任务只需处理 `{"type":"ping"}` → 文本回 `{"type":"pong"}`，为 M2 casting 预留分发点）；坏 JSON/坏帧不断连接（现测试 test_bad_frame 语义保持）。
- 新测试：文本 ping→pong；garbage 文本不断连。
- Commit: `feat(m1c): decode-in-worker and text control frames on /ingest`

### Task 3: /out 空闲断连清理

**Files:** Modify `engine/service/app.py`; Test `engine/tests/test_app_integration.py`

- /out 循环改为 `asyncio.wait` 同时竞速 `queue.get()` 与 `ws.receive()`（FIRST_COMPLETED）：客户端断开（receive 抛 WebSocketDisconnect 或返回 disconnect 消息）时即刻退订，不再等下一帧才发现。取消未完成的 pending task。
- 测试：worker 暴露订阅者计数（`subscriber_count()` 一行方法）；连接 /out → 计数 1 → 客户端主动断开 → 轮询断言计数归 0（无需发任何帧）。
- Commit: `feat(m1c): immediate /out unsubscribe on idle disconnect`

### Task 4: 多频道 worker 注册表

**Files:** Modify `engine/service/app.py`, `engine/service/run_local.py`; Test `engine/tests/test_app_integration.py`

- `create_app(pipeline)` → `create_app(pipeline_factory, channels=[0])`：按频道号建 worker（`dict[int, ChannelWorker]`），/ingest 按 header.channel 路由（未知频道帧忽略+log）；/out 加查询参数 `?channel=0`（缺省 0，未知频道 4400 关闭）；/status 返回 `{"channels": {"0": {...}, ...}}`（保留顶层 "channel" 别名指向频道 0，兼容现有测试与工具）。
- run_local：`--channels 1`（本地 Arc 默认 1 路；工厂为每频道建独立 LivePortraitPipeline——ONNX session 单例缓存权重不翻倍，M0 已证）。out_probe/viewer 加 `?channel=` 支持（viewer 读 URL 参数）。
- 测试：两频道 echo 工厂——频道 0 的帧只到 ?channel=0 订阅者；/status 两频道独立计数。
- Commit: `feat(m1c): multi-channel worker registry`

### Task 5: capture.html 采集页 + HTTPS

**Files:** Create `engine/service/capture.html`; Modify `engine/service/app.py`（GET /capture）, `engine/service/run_local.py`（--https）

- capture.html：getUserMedia（前摄优先 facingMode:user）→ video → canvas 按 `?fps=10` 抽帧 → `canvas.toBlob('image/jpeg', 0.85)` → JS 封包（DataView：setUint16(0,0x4F4C,true)、setUint8(2,1)、setUint8(3,channel)、setBigUint64(4,seq,true)、setBigUint64(12,BigInt(Date.now()),true)）→ WS `/ingest`。UI：开始/停止按钮（iOS 需用户手势触发摄像头）、本地预览 video 元素、已发帧数/目标 fps 显示、连接状态。断线自动重连（保留 seq 递增不归零）。
- run_local `--https`：uvicorn `ssl_certfile`/`ssl_keyfile` 指向仓库根 `certs/onelive-cert.pem`/`onelive-key.pem`（存在性检查，缺失时报错并提示先跑一次 Node demo 生成或用 openssl 生成）；`--host 0.0.0.0` 同时加上（手机要连）。顺手加 `--cfg` 透传给适配器（M1b 待办 #5 的一半）。
- 手工验证（无浏览器环境的执行者：用 Task 6 的 Playwright 验证代替；HTTPS 启动日志 + curl -k /capture 200 即可）。
- Commit: `feat(m1c): browser capture page and https serving`

### Task 6: Playwright 假摄像头全链路 E2E

**Files:** Create `engine/e2e/capture-e2e.mjs`（Node 脚本，用仓库根 node_modules 的 playwright）; Create `docs/superpowers/m1c-results.md`

- 准备：ffmpeg 把 d14.mp4 前 20s 转 `engine/out/d14.y4m`（`-pix_fmt yuv420p`；y4m 体积大，gitignored）。
- 脚本：启动 chromium `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-video-capture=<d14.y4m>`；页面 A 开 `http://127.0.0.1:<port>/capture?fps=10`（HTTP+localhost = 安全上下文，无需 HTTPS）点开始；页面 B 开 `/?channel=0`（viewer）；跑 60s；从页面 B 用 `page.evaluate` 读 viewer 的帧计数/最新 seq，同时 out_probe 并行收帧存 PNG。
- 断言与记录（写入 m1c-results.md）：/out 到达 fps ≈1.9；E2E 延迟（现在 ts_ms 真实透传：probe 直接 header.ts_ms 对比本机时钟，不再要 CSV 旁路——记录并与 M1a 的 CSV 法对比）；/status errors==0、processed>0（**人脸来自 d14 → 必须有产出**，这是与 M1a 摄像头挡板运行的本质区别）；保存首末帧 PNG 并目检数字人姿态随驱动变化。
- m1c-results.md 还需：加固项逐条验证记录（ts_ms/解码位置/文本帧/断连清理/多频道）、遗留 OWNER 项（iPhone Safari 真机走 HTTPS capture 页 + 真人入镜）、M1b 剩余待办（网络化：auth/max-size/keepalive、cb_errors、chdir 移除、上游 4-tuple 复核——逐条从 m1a 清单滚动过来标注状态）。
- Commit: `feat(m1c): playwright fake-camera e2e, measured full capture chain`

### Task 7: 文档收尾

**Files:** Modify `README.md`（引擎服务节补 capture/HTTPS/多频道用法）, `docs/superpowers/m1c-results.md`（终稿）

- README 引擎服务节更新：capture 页用法（桌面 + 手机 HTTPS 路径引用现有"手机首次连接与自签 HTTPS"一节）、--channels/--https/--cfg 参数、E2E 数据指针。
- 全量测试回归（Python 全绿 + Node 32）。
- Commit: `docs(m1c): capture bridge results and readme`

---

## Self-Review 记录

- 覆盖：M1a 待办 #1(断连清理)#2(解码)#3(文本帧)#4(ts_ms)#5(--host/--cfg)在 Task 1-5；#10 高帧率乱序守卫复核落在 Task 6 的 10fps 采集流中自然覆盖；多频道为 M2 铺路。未覆盖并明确滚动到 M1b：auth/max-size/keepalive、cb_errors 拆分、chdir 移除、上游 4-tuple 复核（需无补丁 clone，属边缘部署任务）。
- 无占位符：集成型任务给的是行为规格+验证方式（与 M1a 执行模式一致，实现者按现有代码上下文落地）；纯逻辑改动沿用现有测试文件演进。
- 一致性：`submit(jpeg_bytes, seq, ts_ms)`（Task 2 定稿签名）与 Task 1 的 ts_ms 增补按任务顺序演进；capture.html 的 JS 封包字节布局与 protocol.py `<HBBQQ` 及 viewer 的 slice(20)/getBigUint64(4) 一致。
