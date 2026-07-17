# M2a 实测结果：翻译 + 转播（进行中）

日期：2026-07-17　|　分支：`feature/v2-m2a-translation-casting`

> 骨架文档：各 Task 完成后回填实测数据。已知风险节随评审即时记录。

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

## Task 3/4/6+：待回填
