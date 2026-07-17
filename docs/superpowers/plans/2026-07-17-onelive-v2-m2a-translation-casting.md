# OneLive V2 — M2a 实时翻译链路组件 + Casting 控制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建实时翻译链路的本地可跑组件（流式 ASR → 可插拔翻译 Provider → 流式 TTS → 嘴型曲线），并实现频道 casting 控制（JSON 控制帧热切换频道底图）。LLM 翻译 API key 是 OWNER 项：无 key 时链路如实降级为"仅字幕 + 翻译不可用"状态（spec §7 禁止预置文案回退），架构与测试先行，key 到位即通。

**Architecture:** 新增 `engine/translate/` 包：`asr.py`（faster-whisper 流式分段转写中文）、`providers.py`（翻译 Provider 协议 + OpenAI-compatible HTTP 实现 + 显式 Unavailable 状态）、`tts.py`（edge-tts 流式合成 + 复用 M0 `lipsync.audio_lip` 生成嘴型曲线）、`pipeline.py`（编排：音频段 → 字幕事件 → 翻译事件 → TTS 音频+lip curve 事件，全部走 asyncio 事件流）。服务侧扩展：/ingest JSON 控制帧新增 `casting` 命令（频道热切换 source 底图，经 worker 线程串行执行）；新增 WS `/events` 推送字幕/翻译/管线状态给控制台。音频上行暂用 capture 页 MediaRecorder 音频块（细节 Task 5 定），真实推理管线不动。

**Tech Stack:** faster-whisper（CPU int8）、edge-tts、httpx（翻译 HTTP）、现有 FastAPI/worker 体系、pytest + pytest-asyncio。

**执行前提：**
- Worktree：`.worktrees/v2-m2a`，分支 `feature/v2-m2a-translation-casting`，基于 master（≥17dbe83）。
- M0 venv 照旧；**任何 pip install 后必须复验 `ort.get_available_providers()` 仍含 DmlExecutionProvider**（faster-whisper 拉 ctranslate2/av/tokenizers，不碰 onnxruntime，但要验证）。whisper 模型下载（small，~460MB int8）到 gitignored `engine/models/whisper/`（加 gitignore 条目——engine/.gitignore 的 `models/` 已覆盖）。
- 嘴型曲线：复用 `engine/lipsync/audio_lip.py`（M0 成品，注意其 peak 归一化是整段离线设计——本里程碑 TTS 是整段短句合成后处理，恰好适用；流式化仍留 M1b/M2b）。
- LLM 翻译无 key：`.env` 无 AI_API_KEY 时 Provider 返回明确 `unavailable` 状态，事件流带 `translation_status: "unavailable"`，禁止假翻译。单测用 mock HTTP。
- OWNER 项（结果文档记录）：AI_API_URL/KEY 配置后的真实翻译联调；三语音色选型确认。

---

### Task 1: 翻译 Provider 协议（TDD，mock HTTP）

**Files:** Create `engine/translate/__init__.py`, `engine/translate/providers.py`; Test `engine/tests/test_translate_providers.py`

- Provider 协议：`async translate(text: str, target_lang: str) -> TranslateResult`；`TranslateResult` dataclass：`ok: bool, text: str | None, status: "ok"|"unavailable"|"error", detail: str | None`。
- `OpenAICompatProvider(base_url, api_key, model, timeout_s=8)`：httpx POST chat/completions，system prompt 固定为直播口语翻译（简洁、保留数字与商品名），失败/超时 → `status="error"` 带原因；`api_key` 为空 → 构造即 `available=False`，translate 直接返回 `unavailable`。
- `from_env()` 工厂读 AI_API_URL/AI_API_KEY/AI_MODEL。
- 测试（pytest + respx 或 httpx MockTransport）：成功路径解析；HTTP 500 → error；超时 → error；无 key → unavailable 且不发请求。禁止真实外呼。
- Commit: `feat(m2a): translation provider protocol with honest unavailable state`

### Task 2: 流式 ASR 组件（faster-whisper）

**Files:** Create `engine/translate/asr.py`; Test `engine/tests/test_asr.py`; Modify `engine/requirements.txt`（faster-whisper）

- 安装 faster-whisper 到 M0 venv；下载 small int8 模型到 `engine/models/whisper/`（首次运行自动下载，指定 download_root）；装后复验 DirectML providers。
- `SegmentTranscriber(model_dir, lang="zh")`：`feed(pcm16_bytes, sr)` 累积音频，静音断句（能量阈值 + 0.6s 静音）或 5s 上限触发 `transcribe` → 产出 `TranscriptSegment(text, t0, t1)`（asyncio 队列吐出）。CPU int8，线程池跑推理不卡事件循环。
- 测试：用 edge-tts 生成两句中文 wav（联网，生成后缓存到 engine/out/ 供重跑）作为固定输入，断言转写文本含关键词（模糊匹配，如"欢迎"/"直播"），断言静音切分产生 ≥2 段；无语音输入 10s 不产段。真实推理，标注运行耗时。
- Commit: `feat(m2a): streaming segment ASR with faster-whisper`

### Task 3: 流式 TTS + 嘴型曲线

**Files:** Create `engine/translate/tts.py`; Test `engine/tests/test_tts.py`

- `synthesize(text, voice) -> TTSResult(audio_pcm16: bytes, sr: int, lip_curve: np.ndarray, duration_s: float)`：edge-tts 合成 mp3 → ffmpeg（完整路径，spike-results 有）转 16k mono pcm → `lipsync.audio_lip.audio_to_lip_curve(fps=25)`。
- 音色表：`VOICES = {"en": "en-US-JennyNeural", "ja": "ja-JP-NanamiNeural", "es": "es-MX-DaliaNeural"}`（女声先行，男声 M2b casting 联动）。
- 测试：真实 edge-tts 合成一句英文（联网），断言 pcm 非空、duration 1-10s、lip_curve 长度 == duration*25±1、curve 峰值 >0.3；无网/失败 → 明确异常类型（调用方决定降级）。
- Commit: `feat(m2a): tts synthesis with lip curve extraction`

### Task 4: 翻译管线编排

**Files:** Create `engine/translate/pipeline.py`; Test `engine/tests/test_translate_pipeline.py`

- `TranslationPipeline(transcriber, provider, tts_langs=["en"], voices=VOICES)`：输入 `feed_audio(pcm, sr)`；输出 asyncio 事件流（`subtitle`（原文段）→ 每语言 `translation`（ok/unavailable/error + 文本）→ ok 时 `tts_ready`（音频+lip curve 引用））。事件 dataclass 带 segment id 关联。Provider unavailable 时事件流照常出 subtitle + `translation(status=unavailable)`，不出 tts。
- 各段独立 task，异常隔离（一段失败不断流），管线 stats（segments/translated/tts_ok/errors）。
- 测试：FakeTranscriber（直接注段）+ mock Provider + FakeTTS，断言事件顺序、id 关联、unavailable 降级路径、单段异常不影响后段。纯逻辑无外呼。
- Commit: `feat(m2a): translation pipeline orchestration with per-segment isolation`

### Task 5: 服务集成——/events 推送 + 音频上行

**Files:** Modify `engine/service/app.py`, `engine/service/capture.html`; Test `engine/tests/test_app_integration.py`

- app.py：`create_app(..., translation_pipeline=None)` 可选注入；新增 WS `/events`（JSON 文本事件广播：订阅者集合、断连清理复用 /out 的竞速模式抽成小助手或直接复制并注明）；/ingest 新增二进制音频帧路径——协议 version 字节复用：新 magic 不动、header channel 字节高位？**不要发明花样**：音频走独立 WS `/audio`（binary pcm16 chunk + 4 字节 sr 前缀，简单直接），feed 给 pipeline。
- capture.html：AudioContext + ScriptProcessor/AudioWorklet 采 16k pcm16（getUserMedia audio:true），每 250ms 块发 /audio；UI 加音频开关。
- 测试：TestClient 注入 FakePipeline（翻译链路 fake）：/audio 收块 → pipeline.feed 被调；/events 订阅者收到 pipeline 事件广播；无 pipeline 注入时 /audio 与 /events 返回明确关闭（4403 或消息）。
- Commit: `feat(m2a): audio uplink and events broadcast in engine service`

### Task 6: Casting 控制

**Files:** Modify `engine/service/app.py`, `engine/service/worker.py`, `engine/service/liveportrait_pipeline.py`; Test 相应文件

- liveportrait_pipeline：`set_source(image_path)` 方法（prepare_source + 重新快照；必须在 worker 推理线程执行以串行化——通过 worker 的命令注入）。
- worker：`post_command(fn)` —— 命令进独立单槽（不与帧槽竞争），`_loop` 每轮帧间检查执行（在锁外、infer 前），异常计 errors 不杀线程。
- app.py /ingest 控制帧：`{"type":"casting","channel":0,"source":"<name>"}` —— source 名映射到 `engine/avatars/` 下白名单文件（**防路径穿越**：仅允许无路径分隔符的文件名，实际文件存在性检查），回执 `{"type":"casting_ack","ok":...}`。`engine/avatars/` 放 2-3 张 M0 示例人像的拷贝（小 jpg 入库可接受，<500KB 总量；或引用 M0 assets 路径白名单——选后者免入库二进制，document）。
- 测试：EchoPipeline 加 set_source 记录；casting 命令 → ack + worker 执行记录；非法 source（路径穿越/不存在）→ ack ok=false；真实管线烟测：run_local 起 1 频道，发 casting 切换 s10→s1（M0 assets），/out 帧确实变脸（保存前后 PNG 目检）。
- Commit: `feat(m2a): channel casting via control frames with source whitelist`

### Task 7: E2E + 结果文档

**Files:** Create `docs/superpowers/m2a-results.md`; Modify `README.md`

- 组件级真实 E2E（无 LLM key 的诚实版本）：起服务（真实推理管线 + 翻译管线：真实 whisper + unavailable Provider + 真实 TTS 旁路验证）；用 Task 2 缓存的中文 wav 经 /audio 灌入；断言 /events 出 subtitle 事件（真实转写）+ translation(unavailable)；单独跑 Task 3 的 TTS+lip curve 真实样例并保存音频/曲线；casting 烟测结果汇入。
- m2a-results.md：各组件实测（ASR 延迟/准确观感、TTS 合成耗时、casting 切换耗时）、事件流样例原文、OWNER 项（API key 联调、真机、音色确认）、滚动待办（自 m1c 13 条 + 新增）。
- README：引擎服务节补翻译链路与 casting 用法。全量回归（Python + Node）。
- Commit: `docs(m2a): translation and casting results`

---

## Self-Review 记录

- 覆盖：spec §4.4 翻译链路的本地可执行部分全覆盖（ASR/TTS/编排/事件下发）；LLM 翻译留 OWNER（无 key 不可测真值，unavailable 状态如实）；casting 是 spec §4.2 的引擎侧一半（控制台 UI 属 M3）。嘴型曲线与 LivePortrait 嘴型 retarget 的驱动集成（M0 已验证机制）属 M2b——本里程碑先把"音频→曲线"产出打通。
- 无占位符：Task 5 的音频传输方案已定（独立 /audio WS + pcm16）；Task 6 的 avatars 方案二选一给了决策依据（选白名单引用免二进制入库）。
- 一致性：`TranslateResult.status` 三态与 pipeline 事件 `translation_status` 一致；lip curve fps=25 与 M0 实验一致；worker `post_command` 不与帧槽竞争的设计与既有 latest-wins 语义正交。
