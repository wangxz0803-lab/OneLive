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

1. **`_audio` 无界累积 + O(n²) 拼接**：SegmentTranscriber 全量保留喂入的 PCM（16k int16 ≈ 115MB/小时），worker 里 `np.concatenate` 随流长线性变贵。分钟级 demo 无碍；**M2b/M3 长跑前必须改环形缓冲**（段闭合后即可丢弃已转写前缀）。
2. **§4.4 ≤3s 延迟预算风险**：ASR 单独已 ~3.2s（0.6s 静音确认 + ~2.6s 转写），叠加翻译（~1-2s）+ TTS 后端到端实际预计 **4.5-6s**，超 spec 预算。可调旋钮：`beam_size=5→1`（约 2-3x 提速）、模型档位（small→base/tiny）、分段策略（更短硬上限/更激进闭合）。**Task 7 E2E 必须实测端到端延迟并回写 PRODUCT_SPEC 风险表**。
3. **faster-whisper 依赖会顶掉 DirectML**：pip 解析 faster-whisper 依赖时会安装 plain `onnxruntime`，覆盖 `onnxruntime-directml` 的 DmlExecutionProvider（本次实测已发生一次，已修复）。处置：装完重执行 `pip uninstall -y onnxruntime onnxruntime-directml && pip install onnxruntime-directml` 并验证 providers；requirements.txt 已加注释。`pip check` 报 faster-whisper 缺 onnxruntime 为已知误报（directml 包提供同名模块）。
4. **麦克风底噪 vs 固定 0.01 阈值**：静音检测阈值按 edge-tts 数字静音（真零）标定；真实麦克风有底噪/空调声/键盘声，固定归一化 RMS 0.01 可能永不静音（切不开段）或误切。构造器已支持 `rms_threshold` 等透传，**Task 5 接真实音频时需做底噪标定**（如取前 N 秒噪声 RMS 的 k 倍作自适应阈值）。

## Backlog（Task 3 评审记录）

- **TTS 流式首块可行**：当前 synthesize 整句离线（收全 mp3 → 转码 → 曲线），
  首音频约 ~2.4s。管线中唯一非因果环节是嘴型曲线的峰值归一化（要看到全句
  峰值才能归一），改为 running-max 或固定标定值即可流式化；事件结构需从
  单个 TTSResult 改为 async generator 逐块产出。预期首音频可从 ~2.4s 降到
  <1s。M2a 不做，延迟预算吃紧时（见 Task 2 风险 2）优先启用。

## Task 3+：待回填
