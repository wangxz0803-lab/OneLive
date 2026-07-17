# OneLive V2 — M2b 数字人嘴型集成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 M2a 产出的 TTS 音频与嘴型曲线接进实时渲染：数字人头部/表情继续跟随驱动视频，嘴部改由该频道 TTS 音频驱动（M0 已验证的 `flag_lip_retarget_keep_motion` 机制的实时化）；viewer 同时播放 TTS 音频。这是"数字人开口说外语"的第一次端到端。

**Architecture:** ① clone 补丁：`run()` 接受 `lip_ratio_override` kwarg（**必须 pop 后再转发**——M0 已踩过 realtime kwargs 重复传参的坑）。② 纯逻辑 SpeechSchedule：每频道 FIFO 语音队列，`lip_at(now)` 按曲线时间轴给出 0..1 或 None。③ worker/adapter：渲染循环每帧查询 lip 值，经标定映射（0→close_ratio，1→open_ratio，常量可配）传入管线。④ app：`_broadcast_events` 消费者 tee——TTSReadyEvent 的 curve 推给对应频道 worker、pcm 经新 WS `/speech?channel=` 二进制广播。⑤ viewer WebAudio 播放。本地 1.9fps 下嘴型欠采样是已知现实（边缘 GPU 后才充分），验收标准是**机制正确 + 帧证据可辨嘴型变化**。

**Tech Stack:** 现有全套（M0 patched clone、M2a translate、service），无新依赖。

**执行前提：**
- Worktree `.worktrees/v2-m2b`，分支 `feature/v2-m2b-lip-integration`，基于 master（≥9136ae4）。M0 venv 照旧。
- M0 关键事实（spike-results.md §2 + M1 附注）：lip ratio 是 close-ratio 非开合度（d14 标定 p05=0.00071/p95=0.18153）；实时标定用固定常量（默认 closed=0.001/open=0.18，可配）；`flag_lip_retarget_keep_motion` patch 已在 clone（默认关）；大幅转头+音频嘴型属未测区域（出伪影则 delta 随 R_new 旋转——本里程碑如实记录观察即可）。
- m2a-results backlog 两条本里程碑顺带修：/audio 奇数字节守卫；（app.py 拆模块留 M3，除非本里程碑改动使 app.py 明显失衡）。
- OWNER 项不变；无 LLM key 时 E2E 用 stub provider（ok 翻译）驱动真 TTS——这不违反"禁止假翻译"（stub 仅测试脚手架，服务默认仍 unavailable，文档写明）。

---

### Task 1: clone 补丁——run() 支持 lip_ratio_override

**Files:** Modify clone（补丁再生成 `engine/patches/faster-live-portrait-dml.patch`）; Create `engine/lipsync/verify_live_injection.py`（验证脚本，复用 M0 实验模式）

- clone `run()`：`lip_ratio_override = kwargs.pop("lip_ratio_override", None)`（**pop！**）；非 None 时替换传给 `_run` 的驱动 lip ratio（同 M0 pkl 实验对 `dri_motion_info[2]` 的替换点，live 路径等价位置），依赖既有 `flag_lip_retargeting + flag_lip_retarget_keep_motion` 开关。config yaml 不改（运行时经 OmegaConf 设 flag）。
- 验证脚本：source s10 + d14 视频逐帧 live `run()`，注入正弦 lip 曲线（0.5Hz），保存 3 个高/低点帧；断言高点帧与低点帧嘴部区域像素差异显著（数值断言 + 人工 Read 目检）；对照组（不注入）同帧位嘴部差异小。运行 ~40 帧（~25s 本地）。
- patch 再生成 + M0 worktree 侧 `git diff` 与 patch 文件一致；3 帧 pkl 回放确认既有路径无回归。
- Commit: `feat(m2b): live lip ratio override in clone run path`

### Task 2: SpeechSchedule（纯逻辑 TDD）

**Files:** Create `engine/service/speech.py`; Test `engine/tests/test_speech.py`

- `SpeechClip(segment_id, lang, curve: np.ndarray, fps: float, duration_s)`；`SpeechSchedule`：`enqueue(clip)`（FIFO）、`lip_at(now_monotonic) -> float | None`（当前 clip 按 `(now - start)*fps` 索引曲线；clip 播完自动切下一条并以切换时刻为新 start；队列空 → None）、`current() -> (segment_id, lang) | None`、`drop_all()`、stats（queued/played）。线程安全（渲染线程调 lip_at，事件循环线程 enqueue——单锁足够）。
- 测试：单 clip 时间轴索引正确（含首尾边界）；FIFO 顺序与自动接续；播完返回 None；drop_all；跨线程 smoke（渲染线程 poll + 主线程 enqueue）。
- Commit: `feat(m2b): per-channel speech schedule with tests`

### Task 3: worker/adapter 集成

**Files:** Modify `engine/service/worker.py`, `engine/service/liveportrait_pipeline.py`; Tests 对应文件

- adapter：`infer(frame_bgr, seq, lip_ratio: float | None = None)` —— 非 None 时映射 `closed + lip*(open-closed)`（常量 ctor 参数 `lip_closed=0.001, lip_open=0.18`）传 `run(..., lip_ratio_override=...)`，并在构造时把两个 flag 设进 cfg（`flag_lip_retargeting=True, flag_lip_retarget_keep_motion=True`——仅当 `enable_lip=True` ctor 参数，默认 True 但 run_local 加 `--no-lip` 关闭开关）。
- worker：持有 `SpeechSchedule`（ctor 注入或默认实例，`worker.speech` 暴露）；`_loop` 每帧渲染前 `lip = self.speech.lip_at(time.monotonic())`，传给 `pipeline.infer(frame, seq, lip_ratio=lip)`。EchoPipeline/Fake 系测试适配（infer 签名向后兼容：lip_ratio 有默认值，旧测试不动应仍绿——验证）。
- 测试：fake pipeline 记录收到的 lip_ratio 序列（schedule 注入已知曲线 → 断言随时间单调变化且与曲线吻合）；schedule 空时恒 None；worker 既有 12 测试零回归。
- Commit: `feat(m2b): worker renders with speech-driven lip ratio`

### Task 4: app tee + /speech 广播

**Files:** Modify `engine/service/app.py`; Test `engine/tests/test_app_integration.py`

- `_broadcast_events` tee：TTSReadyEvent → ① `lang→channel` 映射（ctor 参数 `lang_channels: dict[str,int] | None`，默认 `{"en": 0}`；未映射语言仅广播不注入）：`workers[ch].speech.enqueue(SpeechClip(...))`；② `/speech` 订阅者广播二进制帧 `[u8 channel][u32 LE segment_id][u32 LE sr][pcm16...]`（复用既有订阅者集合模式——这是竞速循环第 3 份副本，按 m1c 终审"三次法则"**提取共享助手** `_ws_subscriber_loop(ws, queue, send)` 供 /out /events /speech 共用，行为不变，既有测试作回归网）。wire 的 tts_ready 事件加 `"channel": <int|null>` 字段。
- /audio 奇数字节守卫顺带修（backlog 项）：`if len(pcm) % 2: log+continue`＋测试。
- 测试：TTSReadyEvent 注入 fake → 对应频道 worker.speech 收到 clip、/speech 订阅者收到正确封包（header 解析 + pcm 完整）、未映射语言不注入不广播 crash；共享助手重构后 /out /events 全部既有测试绿；奇数字节帧丢弃连接存活。
- Commit: `feat(m2b): tts tee to speech schedule and /speech broadcast`

### Task 5: viewer 播放 + E2E

**Files:** Modify `engine/service/viewer.html`; Create/extend `engine/e2e/lip_e2e.py`; Modify `docs/superpowers/m2b-results.md`（新建）

- viewer：`/speech?channel=` WS + WebAudio（pcm16→AudioBuffer→即播），"speaking" 状态行（segment/lang）；断连重连与 /out 同模式。
- E2E（真服务 8914：真管线 + 真转写 + **stub ok-provider（--translate-stub 开发 flag，README 写明仅测试）** + 真 TTS + lip 注入开）：feeder 喂 d14 驱动帧（5fps）+ /audio 喂 zh fixture → 断言链路：subtitle → translation(ok, stub) → tts_ready(channel=0) → /speech 收到 pcm → 在 TTS 播放窗口内抓 /out 帧若干 + 窗口外对照帧；嘴部区域帧间差异断言 + 保存 PNG 人工 Read 目检（嘴开/闭可辨）；/status 全链路计数一致。记录：注入生效延迟、本地 1.9fps 下的欠采样观察、大幅转头伪影观察（如有）。
- m2b-results.md：全部实测 + OWNER 项滚动 + backlog 滚动（含 A/V 精确同步属 M3 推流合成、字幕烧录、三频道三语并行实测待边缘 GPU）。
- Commit: `feat(m2b): viewer speech playback and lip e2e`

### Task 6: 文档收尾

README 引擎节更新（嘴型集成、--no-lip、--translate-stub、/speech）；全量回归（Python + Node）；终审 → 合并。
Commit: `docs(m2b): lip integration results and readme`

---

## Self-Review 记录

- 覆盖：spec §4.3 "TTS 音频→嘴型驱动" 的实时化 + §4.4 音频下发到观看端。A/V 帧级同步、推流合成属 M3；三语三频道并行实测待 M1b 边缘算力。
- 无占位符：注入点、标定常量、封包格式、tee 映射均已定；Task 1 的"等价位置"由 M0 spike-results §2 的 L537/L454-457 记录支撑，执行者按源码落地。
- 一致性：`lip_ratio` 0..1 语义贯穿 schedule→worker→adapter，close-ratio 映射只在 adapter 一处；`SpeechClip.fps` 与 TTS lip curve fps=25 一致；/speech 头部字段与 protocol.py 风格一致（LE、显式宽度）。
