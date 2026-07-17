# M2b 实测结果：语音驱动嘴型（TTS → 渲染循环）

日期：2026-07-18　|　分支：`feature/v2-m2b-lip-integration`　|　状态：**Task 1-5 完成**（118 passed + lip E2E PASS）

## Task 1：clone 嘴型覆写补丁（已完成）

- `run(..., lip_ratio_override=...)`：close-ratio 单位（实测值域 ~0.001 闭合 .. 0.18+ 张开；d14 驱动视频观测最大 0.216）。
- 依赖 cfg 开关 `infer_params.flag_lip_retargeting=True` + `flag_lip_retarget_keep_motion=True`，须在管线构造前置好。
- 评审补记（Task 5 落地）：替换发生在 `calc_lip_close_ratio` 之后——**覆写值会一并落进录制的 dri_motion_info**，带 override 录制的 pkl 回放的是注入嘴型而非驱动视频原嘴型（补丁内已注释；补丁重生成后与 clone `git diff` 逐字节一致）。

## Task 2：SpeechSchedule 口型调度器（已完成）

- `service/speech.py`：线程安全 FIFO；`lip_at(now)` 返回 0..1 或 None；溢出丢最老排队段。
- 评审 ride-along（Task 3 落地）：SpeechClip 拒绝 NaN/inf 曲线（ValueError），有限越界值 clip 到 [0,1]。

## Task 3：worker/adapter 集成（已完成）

- 管线协议：`infer(frame_bgr, seq, lip_ratio=None)`；worker 每帧 `speech.lip_at(clock())` → `lip_ratio` kwarg；时钟可注入（测试确定性）。
- 适配器：`map_lip_ratio(lip, closed, open_)` 线性映射（前置条件 lip∈[0,1]，上游 SpeechClip 已 clip）；None/enable_lip=False 时完全不带 kwarg。
- `run_local --no-lip`：逃生开关，`enable_lip=False` → 构造期不置嘴型 flag，渲染路径与 M1a 基线逐字节等价；启动 banner 打印 lip 状态。
- Task 5 补充：worker 渲染循环在 lip 非 None 时打 INFO 日志 `speech lip=<v> on seq=<n>`（语音期观测锚点，E2E 机制证据；空闲期零输出）。

## Task 4：app tee + /speech 广播（已完成）

- `_broadcast_events` 在 TTSReadyEvent 上分流：lang_channels 命中 → SpeechClip 入对应 worker 的 SpeechSchedule + 音频二进制帧广播 `/speech?channel=N`（`[u8 ch][u32 LE seg][u32 LE sr][pcm16]`）；wire 事件新增 `channel` 字段（int 或 null）。
- 坏曲线（NaN）SpeechClip 构造 raise → 只记日志跳过入队，广播任务不死；音频广播独立 try（struct.pack/扇出失败同样不杀消费者，评审 ride-along）。
- `/status` 每频道新增 `speech` 块（queued/played/dropped，来自 worker.stats()）。

### A/V 同步契约（写死在 app.py 模块 docstring + /speech 端点注释）

- 音频：viewer 收到 /speech 帧即以 **FIFO 链式排播**（`AudioContext.currentTime` 上段接段，镜像 SpeechSchedule 语义）；
- 嘴型：worker **下一次渲染轮询**才开始消费（≤1 渲染周期，本地 ~1.7-1.9fps 即 ~500ms 级），25fps 曲线被渲染帧率欠采样；
- 已知分歧源：/speech 订阅队列 Queue(8) 丢最旧 vs SpeechSchedule maxlen=16——严重积压时两端各自丢段，嘴型可能"念"到 viewer 没听到的段；
- 精确 A/V 对齐 = M3 范畴；M2b 达标线是机制正确性。

## Task 5：viewer 播放 + E2E（已完成）

### viewer.html

- `/speech?channel=` WebSocket + WebAudio：pcm16 → AudioBuffer（按帧内 sr），FIFO 链式排播（契约见上）；`/events` 订阅（端上按 channel 过滤 tts_ready）驱动 `speaking: seg N (lang)` 状态行 + 字幕行。
- 浏览器 autoplay 策略：页面提供「开启声音」按钮（用户手势内创建/resume AudioContext），开启前到达的段**丢弃不补播**（与服务端丢最旧的直播语义一致），页面有说明文字。
- 重连沿用 /out 模式（1s 重试）；close code 4404/4400（未配翻译/未知频道）不重连，状态行说明。

### run_local --translate-stub（测试脚手架）

- stub Provider 返回 `status=ok` + `"EN: "+原文`，detail 自我声明 `stub provider (--translate-stub, test-only)`；与 `--translate` 互斥，**绝非默认**，唯一用途是无 API key 环境的全链路 E2E。真翻译的诚实契约（无 key 绝不伪造）不受影响。

### E2E：`engine/e2e/lip_e2e.py`（真实服务，端口 8915）

组合：真 uvicorn 服务（`--translate-stub`）+ feeder d14.mp4 @5fps → /ingest + `/audio` 实时喂 2 句中文 fixture + 真 whisper ASR + stub 翻译 + 真 edge-tts + lip 开。脚本自起自杀两个子进程，结束后端口 8915 实测归还。

事件链 verbatim（out/lip_e2e/events.jsonl，控制台 GBK 乱码仅显示问题，文件 UTF-8 正常）：

```
{"type": "subtitle", "segment_id": 1, "text": "大家好,欢迎来到我的直播间。", "t0": 0.18, "t1": 2.56}
{"type": "translation", "segment_id": 1, "lang": "en", "status": "ok", "text": "EN: 大家好,欢迎来到我的直播间。", "detail": "stub provider (--translate-stub, test-only)"}
{"type": "tts_ready", "segment_id": 1, "lang": "en", "voice": "en-US-JennyNeural", "duration_s": 1.392, "synth_ms": 2492, "has_audio": true, "channel": 0}
{"type": "subtitle", "segment_id": 2, "text": "今天给大家介绍三款产品。", "t0": 4.34, "t1": 6.58}
{"type": "translation", "segment_id": 2, "lang": "en", "status": "ok", "text": "EN: 今天给大家介绍三款产品。", "detail": "stub provider (--translate-stub, test-only)"}
{"type": "tts_ready", "segment_id": 2, "lang": "en", "voice": "en-US-JennyNeural", "duration_s": 1.416, "synth_ms": 1355, "has_audio": true, "channel": 0}
```

/speech 二进制帧：`channel=0 segment=1 sr=16000 pcm=44544B (1.39s)`、`channel=0 segment=2 sr=16000 pcm=45312B (1.42s)`（头字段正确、pcm 非空、段号与 tts_ready 一一对应）。

/status 收尾（out/lip_e2e/status.json）：

```json
{"engine": "ok",
 "channels": {"0": {"processed": 44, "dropped": 92, "skipped": 0, "errors": 0,
                    "last_infer_ms": 637.2,
                    "speech": {"queued": 0, "played": 2, "dropped": 0}}},
 "translation": {"segments": 2, "translated_ok": 2,
                 "translations_unavailable": 0, "tts_ok": 2, "errors": 0}}
```

延迟（语音喂完 → tts_ready 到达，含 1.0/1.6s 静音确认 + whisper + edge-tts）：seg1 5.75s、seg2 5.01s。synth_ms：2492 / 1355。

### 嘴型证据（如实报告）

- **机制硬证据**：worker 日志显示 5 帧以非 None lip_ratio 渲染——`{seq89: 0.000, seq93: 0.059, seq107: 0.000, seq110: 0.101, seq114: 0.001}`，与存档 PNG 的 seq 相互印证；`speech.played=2`（两段曲线被渲染循环完整消费）；`errors=0`。
- **数值软断言（本轮 PASS，但波动敏感）**：播放窗内嘴部区域（下 1/3、水平中段）帧间平均绝对差 mean=5.36 var=10.66 vs 空闲基线 mean=3.38 var=3.20。同一脚本前一轮（窗口采样偏晚）曾测得 in-window var 4.15 < idle 5.72（WEAK）——d14 头动本身贡献 2-7 灰阶的帧间差，样本仅 5 对，该数值证据**不稳定，只作旁证**。
- **目检**：inwin PNG 中 seq93（lip=0.059）/seq110（lip=0.101）嘴唇微启，幅度小——本轮欠采样恰好落在包络低值处（见下）。对照 `out/lip_live/static_open_0.18.png`（曲线满值对应的张嘴幅度，清晰可见）。
- **欠采样观测（接受项）**：渲染 ~1.7fps 对 25fps 曲线欠采样 ~15:1；1.4s 短音频仅 2-3 个渲染帧，采样落点随机——本轮 5 个采样值最大仅 0.101（RMS 包络的低值时刻），故视觉张嘴幅度小。机制正确性（值按时间线正确流到管线）由 lip-log + 静止头姿门共同证明；观感上限受本地帧率制约，非机制缺陷。
- **头动伪影**：未见新增伪影；嘴部区域帧间差主导项仍是 d14 头动（与 verify_live_injection 诊断量结论一致）。

### 静止头姿门（回归复跑，--gate-only 新增）

补丁注释重生成后复跑：`override 0.18-vs-0.001 = 4.20，无 override 抖动基线 0.40，ratio 10.53x（要求 ≥2x 且绝对值 ≥1.0）→ PASS`。

### idle 语义对比（Task 3 已知语义变化的实测确认）

同源图 s10 + 同驱动帧（d14 第 0 帧）各 settle 6 帧：`enable_lip=True` 空闲帧（lip_ratio=None） vs `enable_lip=False`（Task 3 已证与 M1a 渲染路径逐字节等价）：

- 嘴部区域平均绝对差 **2.03**（重复渲染抖动基线 0.40，约 5x）；全帧 0.82。
- 目检（`out/lip_e2e/idle_semantic_lip_on.png` / `idle_semantic_lip_off_m1a.png`）：两者均闭嘴、近乎一致，差异集中在唇形细节（keep_motion 通路丢失微笑/音素细节、只保留开合度所致），**中性表情下差异很小**——与 Task 3 预期一致，实测确认。
- 另存 `idle_for_m1a_compare.png`（E2E 运行中的真实空闲帧）；历史 M1a-era PNG（`.worktrees/v2-m1a/engine/out/e2e_last_seq199.png`、`v2-m1c/.../probe_seq0.png`，同为 s10 源）可作跨里程碑目检参照，但驱动帧时刻不同，只能定性比对。

### 证据文件清单（engine/out/lip_e2e/，gitignored）

`events.jsonl`、`status.json`、`service.log`（含 lip-log 行）、`feeder.log`、空闲 PNG x2 + `idle_for_m1a_compare.png`、播放窗 PNG x7（seq89-114）、`idle_semantic_lip_on/off_m1a.png`。

## 评审 ride-along 完成记录（Task 5 随车）

- [x] A/V 同步契约写死在 tee/端点处（app.py 模块 docstring + /speech 注释）。
- [x] `_tee_tts` 音频广播独立 try（struct.pack + 扇出兜底，广播任务不死）。
- [x] 测试夹具 `_tts_ready()` duration 0.5 → 0.32（此前凡经 tee 的用例都在走 SpeechClip 校验异常路径而非快乐路径）。
- [x] `worker.stats()` 增加 `speech` 块 → /status 每频道透出；测试同步调整 + 新增。
- [x] app.py 注释笔误 `//events //speech` → `/events /speech`。
- [x] 补丁注释（覆写落进录制 pkl 的语义）+ 补丁重生成逐字节一致；`--gate-only` 快速门 + 绝对下限 `inj_static >= 1.0`；门复跑 PASS（10.53x）。

## OWNER 项（滚动）

- [ ] **AI_API_KEY / AI_API_URL / AI_MODEL**：真翻译 Provider 待配 key 后用 `--translate` 复跑 E2E（stub 只证链路机制）。
- [ ] **真机验收**：手机浏览器打开 viewer（HTTPS），点「开启声音」，确认音频播放 + speaking 状态行 +（网速允许时）嘴型动。
- [ ] **idle 语义视觉验收**：目检 `idle_semantic_lip_on.png` vs `idle_semantic_lip_off_m1a.png`（数值 2.03/抖动 0.40 已录），确认默认 enable_lip 的唇形变化可接受；不可接受则演示用 `--no-lip`。
- [ ] 录屏留档：真实模型嘴型驱动全链路（E2E PNG 序列已留档，动态录屏待 OWNER 演示时补）。

## 待办（滚动）

- M2a 滚动项仍开放：SegmentTranscriber 环形缓冲（长跑前必改）、延迟预算实测回写。
- 嘴型观感增强（后续里程碑可选）：渲染帧率提升后欠采样自然缓解；或 lip_open 上限上调（`LivePortraitPipeline(lip_open=...)`）放大开合幅度。
- /speech 队列 (8) 与 SpeechSchedule (16) 的积压分歧统一（M3 精确 A/V 对齐时一并处理）。
