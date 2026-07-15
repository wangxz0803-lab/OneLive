# OneLive iPhone 实时数字分身首版设计

日期：2026-07-15  
目标交付：2026-07-17 比赛首版  
状态：依据原始 Brief 的“中间 checkpoint 均视为批准”条款，自动批准进入实施

## 1. 目标与成功标准

本轮不推翻 OneLive 已经稳定的六步比赛演示，而是替换最缺乏可信度的一段：让 iPhone 主播的真实表情和头部动作进入电脑端，并同时驱动三个市场化数字分身。首版必须在没有独立 GPU、没有外部 AI Key、没有直播平台账号时仍能完整演示。

现场成功标准：

1. iPhone Safari 扫码进入专用主播端，授权摄像头和麦克风后建立 WebRTC 视频与 Socket.IO 状态链路。
2. 主播眨眼、张嘴、微笑、左右转头后，电脑上的三个数字分身在可感知时延内同步响应。
3. 电脑端可切换女性/男性与至少两套着装；三个市场始终保持不同的舞台、配色和本地化包装。
4. 手机端和电脑端都展示来自当前 WebRTC 会话的真实可用指标；尚无样本时显示“等待采样”，绝不以模拟值冒充 LIVE。
5. Congested、Weak Coverage、High Latency 会实际改变 WebRTC sender constraints，并通过可配置队列真实改变姿态消息的延迟、抖动和丢弃结果。
6. Edge 缩短姿态/字幕处理队列，QoD 在有限预算下优先保障主播流和主市场；两者不伪造物理带宽。
7. 手机断线、面捕模型失败、WebGL 不可用或现场无网络时，六步 Mock Demo 仍可一键恢复。

不把“电影级 MetaHuman”“真实运营商 MEC/QoD”“已经推到 TikTok/YouTube/Twitch”作为 7 月 17 日首版声明。它们需要 GPU、平台资质、账号密钥和更长集成周期。

## 2. 方案选择

### 方案 A：iPhone 本地面捕 + 2.5D 真人肖像 + 轻量 3D 舞台（采用）

iPhone 用 MediaPipe Face Landmarker 从相机帧提取面部 blendshape 和人脸变换矩阵，只发送压缩后的姿态状态。电脑将高质量、本地打包的授权虚拟人肖像作为视觉主体，用 Canvas/CSS 做头部透视、眼睑、嘴部、呼吸和光照响应，保留 Three.js 作为舞台、空间光效和 2D 安全回退。

优点是无需独显、外观上限明显高于基础几何人、动作来源真实、可离线运行。代价是首版属于高质量 2.5D 半写实数字人，不宣称自由视角 3D 或电影级皮肤渲染。

### 方案 B：继续升级程序化 Three.js 几何人（不采用）

运行最稳定，服装和材质参数化最容易，但在两天内无法跨越“球体与胶囊拼成的模型”所造成的玩具感，不能解决用户指出的核心问题。

### 方案 C：云端实时数字人或远程 GPU（不采用首版）

理论上可获得更写实的视频输出，但依赖供应商账号、计费、网络、审核、SDK 稳定性和端到端时延。现场失败面大，且当前没有可用凭据和 GPU，不适合作为比赛主链路。

## 3. 系统架构

首版继续采用“手机采集端 + 电脑控制端 + 同一会话服务端”三部分结构。手机和电脑不是同一套压缩布局，而是共享协议和会话 ID 的两个独立路由体验。

```text
iPhone Safari /broadcast/:session
  ├─ getUserMedia 摄像头/麦克风
  ├─ MediaPipe Face Landmarker（本地模型、CPU/WASM、限频）
  ├─ WebRTC 音视频 ─────────────────────────┐
  └─ Socket.IO AvatarPose（15 Hz 上限） ────┤
                                             ▼
                                   OneLive Node Session Relay
                                             │
                                             ▼
Desktop Control Room
  ├─ WebRTC 视频预览 + getStats LIVE 指标
  ├─ Pose Experience Queue（延迟/抖动/丢弃/优先级）
  ├─ 三路 Avatar Renderer（同源姿态、不同市场形象）
  ├─ Network / Edge / QoD 控制
  └─ Demo Director + Mock fallback
```

Socket.IO 只传递信令和每帧不足 1 KB 的姿态状态，不传视频帧；视频和音频继续由 WebRTC 承载。服务端验证 session、角色、序号、时间戳、数值范围和消息大小，并限制广播端姿态事件频率。

## 4. 姿态模型与实时数据流

新建版本化的 `AvatarPoseFrame`：

- `schemaVersion`、`sessionId`、`sequence`、`capturedAt`
- `headYaw`、`headPitch`、`headRoll`
- `blinkLeft`、`blinkRight`
- `jawOpen`、`mouthSmile`、`mouthPucker`
- `browUp`、`eyeLookX`、`eyeLookY`
- `audioLevel`
- `facePresent`、`trackingFps`
- `provenance: LIVE | EMULATED`

所有连续值在进入协议前归一化并限制在约定范围，桌面端对网络输入再次校验。MediaPipe 输出的 52 个 blendshape 不原样广播，只映射为渲染需要的十余个稳定参数，从而减少带宽、抖动和 UI 更新成本。

手机端仅在摄像头启动后加载本地模型。检测按设备能力限制在约 12–15 Hz；视频仍可按 WebRTC 自身帧率发送。检测失败或连续未检测到人脸时，保持视频 LIVE，但姿态来源切为 EMULATED idle，不把整屏误标为 LIVE。

桌面端维护最新原始姿态和三个市场各自的输出队列。队列依据当前 profile、deployment、QoD 和频道优先级计算：

- 基础传输延迟与 jitter；
- 可重复测试的 seeded drop；
- 最大排队长度与过期帧淘汰；
- Edge 的处理延迟缩短；
- QoD 对主频道的优先级和有限预算保障。

Avatar Renderer 只消费队列输出，不在组件中重新实现网络分配逻辑。

## 5. 数字人视觉与切换

数字人采用“真人质感肖像主体 + 程序化舞台”混合方案：

- 本地打包三市场 × 两种性别 × 两套服装的授权 AI 生成半身形象；
- 同一市场的四个变体保持相同构图、灯位和镜头，切换时用 250–350 ms 锁定扫描与交叉淡化；
- 北美、日本和西语市场分别使用不同的现代直播布景、服装轮廓、色温和 UI 语言，不使用夸张文化符号；
- 表情通过眼睑遮罩、嘴部形变/口型层、面部轻微透视、头肩位移、呼吸和高光变化表现；
- Three.js 只负责低复杂度灯光、粒子、景深层和全息路径，避免三份高多边形人物占用集成显卡；
- WebGL 失败时完整保留肖像、表情和字幕，仅关闭空间粒子。

首版提供一个全局 Persona 控件：女性/男性与 Studio/Executive 两套衣橱。每个市场从自身配置中解析对应资产，因此切换不会让三个市场变成同一外观。

所有画面继续显示 `AI GENERATED / AUTHORIZED AVATAR`。形象模板由用户选择，系统不根据主播外貌推断性别、国籍或文化身份。

## 6. 网络、Edge 与 QoD 的真实边界

首版将“真实测量”和“受控注入”同时展示但严格分栏：

### LIVE

- 摄像头/麦克风 track 状态；
- Socket.IO / WebRTC 连接状态；
- 成功 `RTCPeerConnection.getStats()` 后得到的发送/接收码率、帧率、分辨率、丢帧、RTT、jitter、loss；
- 成功运行的人脸检测 FPS、face presence 与姿态帧到达年龄；
- 当前浏览器实际播放的本地 TTS 状态。

### EMULATED / CONTROLLED LAB

- Network Profile 的带宽、RTT、jitter、loss 目标值；
- 姿态/字幕/TTS 队列注入；
- Edge/Cloud processing profile；
- QoD 有限预算重新分配；
- 虚拟平台、观众和体验分数。

Network Profile 切换继续调用 `RTCRtpSender.setParameters()`；只有调用成功且后续 stats 可观察时才称视频约束已应用。姿态队列的延迟和丢弃是应用内真实发生的受控实验，但不是运营商网络测量。

iPhone 主播端新增“上行遥测”区域，仅在有样本时显示 LIVE 数值；无法获得某字段时显示 `N/A`，不回填模板数据。

## 7. 平台发布边界

比赛首版新增 `DestinationProvider` 接口和清晰的目的地状态模型，但不实现未经授权的真实平台推流。三个市场卡代表三个本地生成输出，不代表已经与外部平台建立 RTMP/WHIP 会话。

后续真实发布路径为：每个市场渲染结果 `captureStream()` → 编码/合成节点 → 平台允许的 RTMP(S)、SRT 或 WHIP 入口 → 平台账号授权与健康回调。该路径需要凭据、FFmpeg/媒体服务器、CPU/GPU 容量与平台审核，独立于本轮可信面捕闭环。

## 8. 容错与恢复

1. MediaPipe 包、WASM 和模型均随项目本地提供，不依赖比赛现场 CDN。
2. 模型初始化设置超时；失败后手机仍发送 WebRTC，桌面切到 SeededPoseProvider，并明确显示姿态为 EMULATED。
3. iPhone 页面被切到后台或相机轨道中断时，停止推理和姿态发送，恢复前不占用资源。
4. Socket 重连后使用最新 epoch 重新协商媒体；旧姿态 sequence 不得覆盖新状态。
5. 姿态队列设定长度上限，只保留最新可播放帧，避免网络恢复后“追赶几秒前的脸”。
6. Avatar 资产失败时显示现有高级 SVG 安全渲染器，不出现空白卡片。
7. `?mock=1`、电脑本机摄像头和 Mock Source 三条回退链路继续保留。
8. Reset 必须释放 MediaStream、MediaPipe task、计时器、监听器和队列。

## 9. 测试与验收

严格按 TDD 增加以下覆盖：

### 单元/集成测试

- blendshape 到 `AvatarPoseFrame` 的映射、clamp、缺失字段和无脸状态；
- 服务端姿态消息的 session/role/schema/范围/大小/序号验证；
- profile 下姿态队列的延迟、seeded loss、过期淘汰；
- Edge 延迟小于 Cloud；QoD 只优先恢复主频道而非全部变完美；
- LIVE/EMULATED provenance 切换；
- avatar gender/wardrobe/market 资产解析；
- 面捕初始化失败与 Mock fallback。

### Playwright / 浏览器验收

- Mock 主链路与原 12 项 E2E 不回归；
- 模拟姿态 socket 帧可同时改变三个 Avatar DOM/Canvas 的可观测状态；
- latency profile 产生可测量的姿态滞后，Edge 后恢复；
- gender/wardrobe 切换后三个市场使用各自资产；
- 手机 390 × 844 无横向溢出，主按钮保持 44 px 以上；
- 1440 × 900 与 1920 × 1080 首屏无滚动/重叠；
- WebGL 关闭、MediaPipe 失败、断线重连均可回退；
- 控制台无持续错误和未处理 Promise rejection。

### 真机验收

在实际 iPhone Safari 上完成一次：扫码、证书确认、相机授权、开始、眨眼/张嘴/转头、切后台再返回、停止。电脑同时记录 WebRTC stats 与姿态到达状态。真机未执行前不得声称 iPhone 已验证，只能声称实现了 iOS Web 路径。

## 10. 两天范围与实施顺序

P0（先形成真实闭环）：协议与验证 → 手机本地面捕 → 桌面接收 → 三路共同响应 → 手机/电脑 LIVE 遥测 → 回退。

P1（比赛观感）：本地真人质感资产 → 性别/衣橱切换 → 市场舞台差异 → 弱网/Edge/QoD 对真实姿态队列的可见影响。

P2（有余量再做）：更细口型、眼球方向、音频 RMS、更多服装、真机性能调参和视觉抛光。

明确延后：云端电影级数字人、声音克隆、原生 iOS App、SFU、多租户、真实三平台发布、生产 TURN、真实 MEC/QoD API。

## 11. 依据与假设

- Google 官方 Web Face Landmarker 可输出 3D landmarks、52 个 blendshape 与人脸变换矩阵；其同步视频检测会阻塞主线程，因此首版必须限频并允许降级：<https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js>
- WebRTC stats 中的 inbound/outbound RTP、remote inbound RTT、media source FPS/分辨率等字段只在浏览器实际产生对应对象/报告后可用：<https://www.w3.org/TR/webrtc-stats/>
- 假设比赛 iPhone 使用仍受支持的 Safari 版本并可接受本地 HTTPS 证书；具体机型和 iOS 版本未知，因此 CPU 推理频率采用自适应上限而不是固定承诺 30 FPS。
- 没有用户提供的外部平台账号、推流地址或 AI 服务凭据；首版不伪造这些外部连接。
