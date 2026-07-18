# OneLive V2 — M3a 真实 RTMP 推流 + 网络损伤脚本化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把数字人频道真实推成一路 RTMP 直播流（视频=渲染帧、音频=连续音轨含 TTS 语音），推到自建 RTMP 收流端并用 ffprobe/拉流验证；clumsy 网络损伤脚本化（真实注入，管理员权限不可得则如实标 OWNER-RUN-REQUIRED）。公开平台推流只差换 URL+key（用户账号，OWNER 项）。

**Architecture:** 避开 Windows 多管道坑，**ffmpeg 从服务拉流**：新增 `GET /stream.mjpeg?channel=`（multipart/x-mixed-replace，worker 订阅者）与 `GET /stream.wav?channel=`（无限 WAV：AudioMixer 实时节拍产出连续 pcm16——静音填充 + TTSReady 语音拼接，与 /speech 同源 tee）。每频道一个 ffmpeg：`-i http://…/stream.mjpeg -i http://…/stream.wav -use_wallclock_as_timestamps 1 -c:v libx264 -preset veryfast -tune zerolatency -r 15 -c:a aac -f flv rtmp://…`，由 StreamerManager 管理（启停/重连退避/stderr 采集/状态入 /status）。收流端 Node-Media-Server（npm，Windows 原生，RTMP 收 + HTTP-FLV 播），独立 `engine/rtmp-sink/`。验证探针 ffprobe 流参数 + 拉 FLV 若干秒断言可解码帧与语音窗口非静音。

**Tech Stack:** 现有全套 + node-media-server（rtmp-sink 独立 package.json）+ clumsy（GitHub release 二进制，WinDivert 需管理员）。

**执行前提：**
- Worktree `.worktrees/v2-m3a`，分支 `feature/v2-m3a-rtmp`，基于 master（≥9306e65）。M0 venv；基线 118 passed（首跑 whisper 模型下载暂态失败属已知，重跑即绿）。
- ffmpeg 完整路径见 spike-results；libx264/aac 在 gyan full build 里有（验证 `-encoders`）。
- AudioMixer 节拍是**真实时钟**（RTMP 需要恒定音轨）；语音拼接语义与 SpeechSchedule 对齐（FIFO、来了就接尾），A/V 同步精度沿用 M2b 契约（≤1 渲染周期 + 混流器粒度，如实测量记录）。
- clumsy 需要管理员：先探测当前进程是否 elevated（`net session` 试探）；不行则脚本+文档完备并标 OWNER。
- 公开平台推流 = OWNER 项（YouTube/B站/Twitch 账号与串流码）；本里程碑推自建 sink，URL 可配（`--rtmp-url` 直接可指向公开平台）。

---

### Task 1: AudioMixer（TDD，可注入时钟）

**Files:** Create `engine/service/audio_mixer.py`; Test `engine/tests/test_audio_mixer.py`

- `AudioMixer(sr=16000, chunk_ms=100, clock=time.monotonic)`：常驻 asyncio task，按真实节拍产出 pcm16 chunk（无语音=静音零）；`splice(pcm16, segment_id)` 把语音接到时间线尾（FIFO，与 SpeechSchedule 语义一致：排队播放不重叠）；订阅者模式 `subscribe() -> asyncio.Queue`（有界丢最旧）+ unsubscribe；stats（chunks/spliced/queued_speech_s）。测试用注入时钟驱动确定性：静音填充字节全零、splice 后 chunk 序列包含语音字节、两段 FIFO 顺序、订阅退订、慢消费者丢块不阻塞。
- Commit: `feat(m3a): real-time audio mixer with silence padding`

### Task 2: /stream.mjpeg + /stream.wav 端点

**Files:** Modify `engine/service/app.py`; Test `engine/tests/test_app_integration.py`

- `/stream.mjpeg?channel=`：StreamingResponse multipart/x-mixed-replace，worker 订阅者队列（Queue(4) 丢最旧），每帧 `--frame\r\nContent-Type: image/jpeg\r\n\r\n<jpeg>\r\n`；断连清理复用既有模式（HTTP streaming 的取消处理：CancelledError → unsubscribe，注意 StreamingResponse 生成器 finally）。
- `/stream.wav?channel=`：44 字节 RIFF 头（size 字段填 0xFFFFFFFF 无限流惯例）+ AudioMixer 订阅 chunk 流。AudioMixer 每频道一个（`app.state.mixers`），TTSReady tee 增加 `mixer.splice(...)`（与 /speech 广播并列）。
- 测试：TestClient 流式读 mjpeg N 帧边界解析 + JPEG 解码；wav 头解析（sr/ch/bits）+ 静音块全零 + splice 后含语音；tee 三路（schedule/speech/mixer）并行断言；无翻译管线时 mixer 仍存在（纯静音直播也要有音轨——mixer 不依赖 translation_pipeline，构造于 create_app）。
- Commit: `feat(m3a): mjpeg and infinite wav streaming endpoints`

### Task 3: StreamerManager + run_local --rtmp

**Files:** Create `engine/service/streamer.py`; Modify `engine/service/run_local.py`, `engine/service/app.py`（/status streams 块）; Tests

- `StreamerManager(ffmpeg_path, base_url, rtmp_url_template, channels, fps=15)`：每频道 ffmpeg 子进程（cmd 如架构节），异步监管：崩溃→指数退避重启（1/2/4…封顶 30s）、stderr 环形缓冲（最近 50 行）、`status()`（running/restarts/last_error）；`start_all/stop_all`（terminate→kill）。/status 加 `"streams"` 块。run_local `--rtmp <url-template>`（如 `rtmp://127.0.0.1:1935/live/ch{ch}`）启用。
- 测试：fake ffmpeg（用 python -c 脚本模拟：正常驻留/立即退出）驱动 manager 的重启退避与 stderr 采集、stop 终止；真实 ffmpeg 存在性与 libx264/aac encoder 探测测试（跳过如缺失——不应缺失）。
- Commit: `feat(m3a): per-channel ffmpeg rtmp streamer with supervision`

### Task 4: rtmp-sink + 推流 E2E

**Files:** Create `engine/rtmp-sink/{package.json,server.mjs,README.md}`; Create `engine/e2e/rtmp_e2e.py`; `docs/superpowers/m3a-results.md`

- rtmp-sink：node-media-server 最小配置（RTMP 1935 + HTTP-FLV 8000），`npm install`（独立 lockfile 入库；node_modules gitignore），start 脚本。
- E2E（真实全链）：sink + 服务（真管线 + `--translate-stub` + `--rtmp`）+ feeder（d14 @5fps）+ /audio 喂 zh fixture → 验证：① ffprobe `http://127.0.0.1:8000/live/ch0.flv`：h264+aac、宽高 512、r_frame_rate≈15；② 拉 10s FLV 存盘，ffmpeg 解出若干帧 PNG（目检数字人）+ 抽音轨 wav：语音窗口段非全零且 RMS 明显高于静音段（数值断言）；③ /status streams.running=true、restarts 计数、全链错误 0；④ 杀 sink → manager 退避重启观察（restarts 增长）→ sink 重启 → 恢复推流。全程 verbatim 记录。
- Commit: `feat(m3a): self-hosted rtmp sink and streaming e2e`

### Task 5: clumsy 网络损伤脚本化

**Files:** Create `engine/netlab/{get-clumsy.ps1,profiles.ps1,README.md}`; `docs/superpowers/m3a-results.md` 补充

- get-clumsy.ps1：下载 clumsy 1.4.x release zip（github jagt/clumsy）解压到 `engine/netlab/clumsy/`（gitignore 二进制）。profiles.ps1：`-Profile congested|weak|latency -Ports 8900`（filter 按端口，lag/drop/throttle 参数对应 spec §4.6 三档）+ stop。探测 elevated（`net session`）：是→真实跑一轮 latency profile 对 /out WS 实测（out_probe 到达间隔变化对比基线，verbatim 记录）；否→脚本自检 dry-run + 文档写明 OWNER-RUN-REQUIRED（管理员 PowerShell 运行命令一行）。
- Commit: `feat(m3a): clumsy impairment profiles and lab scripts`

### Task 6: 文档收尾 + 合并

- README：引擎节补推流用法（--rtmp、sink 启动、公开平台=换 URL+串流码 OWNER）、netlab 用法；m3a-results 终稿（OWNER 项滚动：公开平台账号、clumsy 管理员运行（如未跑成）、A/V 同步实测观感）；全量回归（Python + Node + capture-e2e 浏览器回归）；终审 → 合并 master。
- Commit: `docs(m3a): rtmp and netlab results and readme`

---

## Self-Review 记录

- 覆盖：spec §4.5 推流（自建收流全链真实，公开平台仅差 URL/key=OWNER）+ §4.6 损伤注入的脚本化与（权限允许时的）真实运行。QoS 提权、双端 HUD、控制台 UI 属 M3b。
- 无占位符：ffmpeg 命令形态、WAV 无限流头、退避参数、NMS 端口、clumsy 三档均已定。
- 一致性：AudioMixer 的 FIFO 拼接语义与 SpeechSchedule 一致（同一 TTSReady tee 源）；/stream.* 订阅者与 /out //speech 同为丢最旧有界队列；`--rtmp` URL 模板 `{ch}` 与频道号一致。
