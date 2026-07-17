# M2a 实测结果：翻译 + 转播

日期：2026-07-17　|　分支：`feature/v2-m2a-translation-casting`　|　状态：**全 7 Task 完成**（Python 88 passed / Node 32 passed）

## Task 1：翻译 Provider（已完成）

- OpenAI 兼容 /chat/completions Provider，never-raises 契约，无 key 诚实 unavailable（绝不伪造译文）。
- 评审 ride-along：LANG_NAMES 代码→语言名映射（en/ja/es）、temperature=0.3、unavailable 提示同时点名 AI_API_KEY 与 AI_API_URL。

## Task 2：流式分段 ASR（已完成）

- `engine/translate/asr.py`：能量静音切分（20ms RMS 窗，≥0.4s 语音后 ≥0.6s 静音闭合，5s 硬上限）→ faster-whisper small int8 CPU 线程池转写 → 有序 `segments()` 异步迭代。
- 实测（edge-tts 中文 fixtures，已入库可离线跑）：两句 + 1s 静音 → 恰好 2 段，逐字正确：
  - `('大家好,欢迎来到我的直播间。', 0.18s–2.56s)`
  - `('今天给大家介绍三款产品。', 4.34s–6.58s)`
- 转写延迟：~2.6s / 2.2s 音频段（首次调用含 warmup ~4.4s）。
- 模型缓存：`engine/models/whisper`（462MB，gitignore）；加载 offline-first，首次下载走网络（国内设 `HF_ENDPOINT=https://hf-mirror.com`，注意 hub 对镜像的元数据校验可能要求手工补 config.json/tokenizer.json/vocabulary.txt）。

## 已知风险（Task 2 评审记录）

1. **`_audio` 无界累积 + O(n²) 拼接**：SegmentTranscriber 全量保留喂入的 PCM（16k int16 ≈ 115MB/小时），worker 里 `np.concatenate` 随流长线性变贵。分钟级 demo 无碍；**M2b/M3 长跑前必须改环形缓冲**（段闭合后即可丢弃已转写前缀）。Task 5 后 /audio 已接通，长跑限制现已生效（真实音频会持续喂入转写器）。
2. **§4.4 ≤3s 延迟预算风险**：ASR 单独已 ~3.2s（0.6s 静音确认 + ~2.6s 转写），叠加翻译（~1-2s）+ TTS 后端到端实际预计 **4.5-6s**，超 spec 预算。可调旋钮：`beam_size=5→1`（约 2-3x 提速）、模型档位（small→base/tiny）、分段策略（更短硬上限/更激进闭合）。**Task 7 E2E 必须实测端到端延迟并回写 PRODUCT_SPEC 风险表**。
3. **faster-whisper 依赖会顶掉 DirectML**：pip 解析 faster-whisper 依赖时会安装 plain `onnxruntime`，覆盖 `onnxruntime-directml` 的 DmlExecutionProvider（本次实测已发生一次，已修复）。处置：装完重执行 `pip uninstall -y onnxruntime onnxruntime-directml && pip install onnxruntime-directml` 并验证 providers；requirements.txt 已加注释。`pip check` 报 faster-whisper 缺 onnxruntime 为已知误报（directml 包提供同名模块）。
4. **麦克风底噪 vs 固定 0.01 阈值**：静音检测阈值按 edge-tts 数字静音（真零）标定；真实麦克风有底噪/空调声/键盘声，固定归一化 RMS 0.01 可能永不静音（切不开段）或误切。构造器已支持 `rms_threshold` 等透传。Task 5 采集端已显式声明 `echoCancellation/noiseSuppression/autoGainControl`——部分依赖浏览器降噪（已显式声明），**实际底噪标定移交 Task 7 E2E 与 OWNER 真机验证**（备选方案：取前 N 秒噪声 RMS 的 k 倍作自适应阈值）。

## Backlog（Task 3 评审记录）

- **TTS 流式首块可行**：当前 synthesize 整句离线（收全 mp3 → 转码 → 曲线），
  首音频约 ~2.4s。管线中唯一非因果环节是嘴型曲线的峰值归一化（要看到全句
  峰值才能归一），改为 running-max 或固定标定值即可流式化；事件结构需从
  单个 TTSResult 改为 async generator 逐块产出。预期首音频可从 ~2.4s 降到
  <1s。M2a 不做，延迟预算吃紧时（见 Task 2 风险 2）优先启用。
- **/events 满队丢最旧的语义问题**（Task 5 评审记录）：订阅队列 maxsize=32
  latest-wins 对可再生的渲染帧无损，但 subtitle/translation 等事件不可再生——
  慢消费者会静默漏事件。M3 控制台若要可靠展示需在 wire 上带 seq（消费端可
  检测缺口）或提供快照/重放接口。M2a 接受（demo 消费者就在本机）。

## Task 5：/audio 上行 + /events 广播（服务集成，已完成）

- `create_app(..., translation_pipeline=None)` 可选注入；未配时 /audio、/events
  accept 后 close(4404)，/status 无 translation 键——既有视频路径行为完全不变。
- **/audio**：二进制帧 = 4 字节 LE u32 采样率前缀 + pcm16 → `feed_audio`。
  短帧/sr=0/文本帧记日志丢弃、连接不死；采样率中途变化（转写器契约 raise）
  → 发一次性 error 说明帧后 close(4409)，capture 端据码停止重连（4404 同）。
- **/events**：管线 events() 单消费者契约 → 服务层唯一广播任务扇出，
  per-订阅者 Queue(maxsize=32) latest-wins；坏事件映射失败 log+skip 不死。
- **wire 格式**（`event_to_wire`，JSON 元数据 only）：`subtitle{segment_id,text,t0,t1}` /
  `translation{segment_id,lang,status,text,detail}` /
  `tts_ready{segment_id,lang,voice,duration_s,synth_ms,has_audio:true}`
  （pcm/嘴型曲线不上 wire，进程内留给 M2b）/ `pipeline_error{segment_id,lang,stage,detail}`。
- **capture.html**：Audio 开关独立于视频 Start；`getUserMedia` 显式三件套
  （echoCancellation/noiseSuppression/autoGainControl）→ AudioContext 16k
  （不支持则默认率，帧头带实际值）→ ScriptProcessor(4096) f32→i16 累积
  ~250ms 发送；断线 1s 重连，4404/4409 停止重连并明示原因。
- lifespan：startup `await tp.start()`（失败时先停已启动的 worker 再抛）；
  shutdown `wait_for(close(), 30)` + 广播任务限时收割。
- 测试：14 项新增（wire 映射×5、上行解析、坏帧鲁棒、4409、广播全类型、
  坏事件跳过、4404×2、status、capture 页），全量 77 passed。

## Task 3：TTS + 嘴型曲线（已完成）

- `engine/translate/tts.py`：edge-tts 流式收 mp3 → ffmpeg 管道转 16k mono pcm16（不落盘）→ `audio_to_lip_curve` 25fps 口型曲线。错误契约与 Provider 相反：失败抛 `TTSError`（TTS 无有意义的部分结果），整体 `wait_for(timeout_s)` 包裹。
- 实测（真实 edge-tts，需网络）：en 整句 ~3.5s 音频 synth_ms ≈ 2300-2500；音色表 en/ja/es（女声，男声待 casting 按角色选）。

## Task 4：翻译管线编排（已完成）

- `engine/translate/pipeline.py`：segments() 单 consumer → 字幕先行 → 每 (段, 语言) 独立任务 translate → TranslationEvent →（仅 ok）TTS → TTSReadyEvent。隔离契约：单 (段, 语言) 失败只产出一条 PipelineErrorEvent，不影响其他段/语言。
- 两级超时：translate `wait_for(12s)` 防不守约 Provider；TTS 组件自身超时 + 兜底（+2s，让组件更丰富的 TTSError 先赢）。close() 限时收割全部任务 + 事件哨兵，events() 消费者必然终结。
- 评审 ride-along：tts_langs 漏配音色构造期 fail-fast；unavailable/error 不做 TTS。

## Task 6：casting 控制（已完成）

- worker 命令队列：`post_command(fn, on_done)` 与帧槽分离（命令不能 latest-wins），每轮取帧前清空、锁外执行、与 infer 天然串行（pipeline 状态操作无需自带锁）；有界 8，溢出即拒绝（on_done 收 RuntimeError）。
- `/ingest` 文本帧 `{"type":"casting","channel":N,"source":"s1.jpg"}`：source 白名单正则（纯文件名 + jpg/jpeg/png，容不下任何路径分隔符），目录 `ONELIVE_AVATAR_DIR`（默认 M0 clone examples/source）；校验同步 nack、执行与 ack 异步（真 prepare_source 1-2s 不阻塞接收循环）。
- 评审 ride-along（Task 7 落地，commit `fix(m2a): casting channel type guard, command stop drain`）：
  - channel 非 int（list/dict 等不可哈希类型直接进 `workers.get` 会 TypeError 杀死 /ingest 循环）→ nack "invalid channel"，连接存活；
  - `worker.stop()` drain 未执行命令，逐条 `on_done(RuntimeError("worker stopped"))`——已受理命令绝不静默消失；溢出拒绝路径对齐（锁外回调 + try/except）。

## Task 7：E2E 实测（真实服务 + 真实组件）

环境：本机 Arc（DML），`run_local --port 8912 --translate`，真实 LivePortrait 管线（1 频道）+ 真实 faster-whisper small + `from_env()` Provider（**AI_API_KEY 未配置——诚实无 key 链路**）+ en TTS。客户端 `engine/e2e/translate_e2e.py`：/audio 实时节奏（250ms 块）喂 2 句中文 fixture（句间 1s 静音、尾部 1.6s），/events 订阅，喂音频期间向 /ingest 发 casting。

### 事件流（verbatim）

```
[casting] ack: {"type": "casting_ack", "ok": true, "channel": 0, "source": "s1.jpg", "ms": 240.8}
[feed] speech1 sent (3.14s audio)
[feed] gap sent (1.00s audio)
[event] {"type": "subtitle", "segment_id": 1, "text": "大家好,欢迎来到我的直播间。", "t0": 0.18, "t1": 2.56}
[event] {"type": "translation", "segment_id": 1, "lang": "en", "status": "unavailable", "text": null, "detail": "not configured (set AI_API_KEY and AI_API_URL); refusing to fake translations"}
[feed] speech2 sent (3.00s audio)
[event] {"type": "subtitle", "segment_id": 2, "text": "今天给大家介绍三款产品。", "t0": 4.34, "t1": 6.58}
[event] {"type": "translation", "segment_id": 2, "lang": "en", "status": "unavailable", "text": null, "detail": "not configured (set AI_API_KEY and AI_API_URL); refusing to fake translations"}
```

- 字幕逐字正确（与 Task 2 离线测一致）；每字幕恰一条 `status="unavailable"` 翻译事件；**无 tts_ready、无 pipeline_error**——无 key 诚实降级全链路成立。
- casting 与音频上行同连接周期并发：ack ok（真 prepare_source 240.8ms，首次换角、模型已热）——帧/音频/控制三路复用共存验证通过。

### /status（verbatim）

```json
{"engine": "ok",
 "channels": {"0": {"processed": 0, "dropped": 0, "skipped": 0, "errors": 0, "last_infer_ms": 0.0}},
 "channel": {"processed": 0, "dropped": 0, "skipped": 0, "errors": 0, "last_infer_ms": 0.0},
 "translation": {"segments": 2, "translated_ok": 0, "translations_unavailable": 2, "tts_ok": 0, "errors": 0}}
```

### 延迟（语音喂完 → 字幕事件到达，实时喂入节奏）

| 段 | 实测 lag | 组成 |
|---|---|---|
| seg 1（3.14s 语音） | **1.70s** | 0.6s 静音确认（实时流内等待）+ whisper ~1.1s |
| seg 2（3.00s 语音） | **1.81s** | 同上 |

好于 Task 2 风险预估（当时按 ~3.2s 估）：静音确认与转写在实时流里部分重叠，且服务已热（无 warmup）。**外推完整链路**（字幕 1.7-1.8s + 翻译 ~1-2s + TTS ~2.3-2.5s）：首配音预计 **5-6s**，字幕本身在 §4.4 ≤3s 预算内，配音超预算——降配音延迟的旋钮见已知风险 2 与 backlog（TTS 流式首块）。

### stub Provider + 真实 TTS 腿（证明 key 一到位全链路即通）

真 whisper ASR + stub Provider（返回固定英文）+ **真实 edge-tts synthesize**（`--leg stub`，进程内）：

```
SubtitleEvent: {'segment_id': 1, 'text': '大家好,欢迎来到我的直播间。', 't0': 0.18, 't1': 2.56}
TranslationEvent: {'segment_id': 1, 'lang': 'en', 'status': 'ok', 'text': 'Hello everyone, welcome to my live stream.', ...}
TTSReadyEvent: {'segment_id': 1, 'lang': 'en', 'voice': 'en-US-JennyNeural', 'duration_s': 3.456, 'synth_ms': 2506}
[stub-tts] REAL edge-tts audio: 3.46s pcm16, lip_curve 86 frames (max=0.745), synth_ms=2506
[stub-stats] {'segments': 1, 'translated_ok': 1, 'translations_unavailable': 0, 'tts_ok': 1, 'errors': 0}
```

→ subtitle → translation(ok) → tts_ready 全链路一次通过：唯一缺口就是真实 API key。

### 回归

- Python 全量：**88 passed**（Task 6 收尾 85 + Task 7 评审 ride-along 新增 3：worker stop-drain / 命令队列溢出 / casting channel 类型守卫；e2e 两腿为独立脚本不进 suite）。
- Node（主 checkout `npm test`）：**32 passed**。

### OWNER 项（M2a 收尾移交）

1. **API key 联调**：配 `AI_API_URL/AI_API_KEY/AI_MODEL` 环境变量后重跑 `e2e/translate_e2e.py --leg server`——预期 translation status=ok + tts_ready 出现（stub 腿已证明该路径可用）。
2. **翻译 prompt 迭代**：`providers.py` `_SYSTEM_PROMPT_TEMPLATE`（直播带货口播风格、数字/价格/品名保真）需真 key 下用实际话术评估调优。
3. **音色确认**：VOICES 当前 en-US-Jenny / ja-JP-Nanami / es-MX-Dalia（全女声）；男声与角色绑定策略待定。
4. **真机验证**：手机采集页（--https）真实麦克风底噪 vs 0.01 静音阈值（已知风险 4）；casting 在真驱动帧流下的视觉验收。

## Backlog（滚动）

- **TTS 流式首块**（Task 3 记录，优先级升高）：E2E 外推首配音 5-6s 超 §4.4 预算，synthesize 流式化（running-max 归一）预期首音频 <1s，是最大单点收益。
- **ASR `_audio` 无界累积 + O(n²) 拼接**（风险 1）：M2b/M3 长跑前必须改环形缓冲。
- **/events 满队丢最旧**（Task 5 记录）：事件不可再生，M3 控制台需 wire seq 或快照/重放。
- **whisper 降延迟旋钮**（风险 2）：beam_size 5→1、small→base；字幕已达标，配音链达标后再动。
- **麦克风自适应静音阈值**（风险 4）：前 N 秒噪声 RMS 的 k 倍；移交 OWNER 真机数据标定。
- **/audio 奇数字节帧误诊为 4409**（终审记录）：`feed_audio` 路径的
  `except ValueError` 会同时捕获 `np.frombuffer` 对奇数长度 payload 抛的
  ValueError——本应按"坏帧丢弃、连接存活"处理的输入被误当 sr-conflict
  关闭（4409）并停止重连。官方客户端整样本发送不会触发；M2b 在 /audio
  入口加 `len(pcm) % 2` 丢弃守卫。
- **M2b 数字人嘴型集成点**（终审记录）：`TranslationPipeline.events()` 是
  单消费者契约，当前唯一消费者是 `app._broadcast_events`（wire 映射后即
  丢弃 TTSResult 进程内的 pcm + 嘴型曲线）。M2b 集成必须**扩展这个消费者
  做 tee**（把音频/曲线注入 worker 驱动路径），不能开第二个 events()
  迭代器（会互相抢事件）；且 worker 命令队列 bounded-8 是按 casting 频率
  定的，per-segment 嘴型注入若走命令队列需重估容量。
