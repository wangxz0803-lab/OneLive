# M2b 实测结果：语音驱动嘴型（TTS → 渲染循环）

日期：2026-07-18　|　分支：`feature/v2-m2b-lip-integration`　|　状态：**进行中**（Task 1-3 完成，105 passed）

## Task 1：clone 嘴型覆写补丁（已完成）

- `run(..., lip_ratio_override=...)`：close-ratio 单位（实测值域 ~0.001 闭合 .. 0.18+ 张开；d14 驱动视频观测最大 0.216）。
- 依赖 cfg 开关 `infer_params.flag_lip_retargeting=True` + `flag_lip_retarget_keep_motion=True`，须在管线构造前置好。

## Task 2：SpeechSchedule 口型调度器（已完成）

- `service/speech.py`：线程安全 FIFO；`lip_at(now)` 返回 0..1 或 None；溢出丢最老排队段。
- 评审 ride-along（Task 3 落地）：SpeechClip 拒绝 NaN/inf 曲线（ValueError），有限越界值 clip 到 [0,1]。

## Task 3：worker/adapter 集成（已完成）

- 管线协议：`infer(frame_bgr, seq, lip_ratio=None)`；worker 每帧 `speech.lip_at(clock())` → `lip_ratio` kwarg；时钟可注入（测试确定性）。
- 适配器：`map_lip_ratio(lip, closed, open_)` 线性映射（前置条件 lip∈[0,1]，上游 SpeechClip 已 clip）；None/enable_lip=False 时完全不带 kwarg。
- `run_local --no-lip`：逃生开关，`enable_lip=False` → 构造期不置嘴型 flag，渲染路径与 M1a 基线逐字节等价；启动 banner 打印 lip 状态。

## 已知语义变化（Task 3 评审记录）

**enable_lip=True（默认）即使无语音也改变每帧渲染语义**——不只是"有语音时才不同"：

- 构造期 flag `flag_lip_retarget_keep_motion` 无条件把驱动帧的嘴部表情增量替换为源图的，再由 retarget 通路按驱动帧的 close-ratio 重新驱动嘴部开合。
- 效果：嘴部仍跟随驱动视频，但只保留**开合度**这一个自由度，丢失微笑、音素形状等细节口型。
- `lip_ratio=None`（空闲/无语音）帧同样走该通路——与 M1a 基线（flag 全关）**不逐帧等价**。
- 逃生：`run_local --no-lip`（或构造 `LivePortraitPipeline(enable_lip=False)`）恢复 M1a 渲染路径。

### Task 5 E2E 必做

- [ ] 对比一张 **idle 帧**（无语音、enable_lip=True）与 M1a 基线帧，目检/记录嘴部差异幅度（预期：中性表情下差异应很小，但必须实测确认，不能只靠推断）。
- [ ] 真实模型下嘴型驱动全链路（TTS 曲线 → 渲染），录屏留档。

### Task 4 注意事项

- [ ] app 侧把 TTSReadyEvent 的曲线 tee 进 `worker.speech` 时，SpeechClip 构造必须 try/except——上游特征 bug 产生 NaN 曲线会 raise ValueError，**不能让它杀死 `_broadcast_events`**（记 log + 丢该段，字幕/翻译事件照常广播）。

## 待办（滚动）

- Task 4：app 集成（TTSReadyEvent → SpeechClip → worker.speech）。
- Task 5：E2E（含上面两项必做）。
- M2a 滚动项仍开放：SegmentTranscriber 环形缓冲（长跑前必改）、延迟预算实测回写。
