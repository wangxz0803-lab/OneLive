# OneLive Decisions and Capability Boundaries

本文件记录 MVP 的关键产品与技术决定。它用于防止演示叙事超出实际能力。

## D-001：Demo Safe Mode 是主链路

决定：

- Mock Demo 必须在没有手机、摄像头、API Key 和互联网时完成六步流程。
- 真实设备与外部 Provider 是增强项，不得成为 Demo Director 的前置条件。

原因：

- 现场 Wi-Fi、证书、浏览器权限和第三方 API 都存在不可控因素。
- 大赛更关注体验差异和业务叙事，稳定性优先于集成数量。

影响：

- 模拟网络、程序化姿态和预置翻译必须确定性运行。
- 所有真实链路都有 Local Camera / Mock fallback。

## D-002：LIVE 与 EMULATED 必须按数据来源标记

决定：

- LIVE 仅用于真实设备、实时会话或实际 API/RTC 调用返回的数据。
- EMULATED 用于预置、推导、注入和模拟数据。
- 同一画面可以同时包含 LIVE 视频与 EMULATED 翻译/网络指标。

原因：

- 防止把本地模拟伪装成运营商网络或真实 AI。
- 让评委理解演示目的，同时保留技术可信度。

当前边界：

| 能力                     | 默认来源                           | 标记                                                    |
| ------------------------ | ---------------------------------- | ------------------------------------------------------- |
| 手机/桌面摄像头画面      | 浏览器 getUserMedia 成功时         | LIVE                                                    |
| Socket.IO presence       | 当前本地会话                       | LIVE                                                    |
| WebRTC stats             | 仅实际 getStats 成功时             | LIVE                                                    |
| Network Profile          | 应用配置                           | EMULATED                                                |
| RTT/jitter/loss 手动参数 | Network Emulator                   | EMULATED                                                |
| Edge / Cloud 处理延时    | Deployment Profile                 | EMULATED                                                |
| QoD                      | SimulatedNetworkCapabilityProvider | EMULATED                                                |
| 预置三语翻译             | DemoTranslationProvider            | EMULATED                                                |
| 程序化姿态               | SeededPoseProvider                 | EMULATED                                                |
| 观众数、平台名、体验评分 | 演示配置/推导                      | EMULATED                                                |
| 浏览器 TTS               | 当前设备 speechSynthesis 实际调用  | LIVE local playback；不是声音克隆，是否可听仍需现场确认 |

若对应客户端调用尚未接入，仅有类型或 Provider 接口不能标记为 LIVE。

## D-003：网络模拟必须改变体验，不只改变数字

决定：

- Congested、Weak 和 High Latency 分别改变频道画质、帧率、动作、字幕队列和状态。
- High Latency 保留较高带宽与清晰度，重点表现时间错位。
- Profile 切换后一秒内出现可见变化。

原因：

- 评分要求评委肉眼看到网络差异。
- 单纯修改 RTT 或码率文本无法证明 UC 对蜂窝网络的需求。

限制：

- 当前模型不是 Linux tc、Network Link Conditioner 或真实 RAN。
- 如果 sender constraints 未应用到真实 RTCRtpSender，则真实视频链路没有被实际限速；UI 必须继续标记 Network Emulation。

## D-004：QoD 采用预算守恒的优先级分配

决定：

- 未开启 QoD 时按权重竞争有限预算。
- 开启后先满足各频道最低稳定预算，再分配剩余 headroom。
- 主频道优先，次频道可以保持较低质量。

原因：

- 真实表现“保障”而不是把所有数字无条件变好。
- 保持可解释、可测试、确定性的演示结果。

限制：

- 不是任何具体运营商 QoD 产品的实现或性能承诺。
- 没有真实 API 鉴权、策略下发、计费和 SLA。

## D-005：Edge 使用 Deployment Profile

决定：

- Cloud 与 Edge 使用不同的 pose、translation、voice 延时和 pathNodes。
- Edge 缩短处理路径与响应时间，不改变物理上行带宽。

原因：

- 将计算位置带来的收益与无线容量问题分开。
- 便于未来用真实 MEC Provider 替换。

限制：

- 当前没有真实节点调度、容器部署、边缘发现或远端推理计时。
- UI 必须写 Edge Simulation / Deployment Profile。

## D-006：数字分身采用程序化、共享姿态方案

决定：

- 三个市场共享一套 PoseState。
- 形象通过材质、服装壳、舞台、灯光和市场 UI 区分。
- 默认姿态由 SeededPoseProvider 确定性生成；真实姿态追踪可通过 AvatarProvider 替换。

原因：

- 无付费模型、离线可运行、三路同时渲染可控。
- 保证动作差异和网络退化可稳定演示。

限制：

- 不是写实人脸替换、动作捕捉系统或身份复刻。
- 不根据主播外貌推断国籍、种族或文化。
- 若真实 MediaPipe Provider 未接入，不能声称动作来自摄像头。

## D-007：翻译和语音采用 Provider + fallback

决定：

- Demo Safe Mode 使用预置中文台词与三语翻译。
- 浏览器有合适 voice 时使用 speechSynthesis。
- 无 voice 时保留字幕和程序化口型。
- 真实 AI 必须通过服务端代理，失败后回退。

原因：

- 避免 API Key 暴露和第三方服务中断。
- 保证多语言体验在离线环境仍可展示。

限制：

- 预置翻译不是实时 AI。
- 浏览器 TTS 的语言、音质和 boundary 事件随操作系统变化。
- 不实现声音克隆。

## D-008：Socket.IO 只做信令与会话状态

决定：

- Socket.IO 转发 SDP、ICE、source command/state 和 presence。
- 媒体使用 WebRTC 点对点传输。
- 同一 session 每个角色最多一个活跃 socket，新连接替换旧连接。

原因：

- 避免把高带宽视频塞入 Socket.IO。
- 简化一台电脑加一部手机的现场拓扑。

限制：

- Session ID 不是身份认证。
- SessionRegistry 在内存中，重启即丢失。
- 没有生产 TURN；跨 NAT、企业网络或公网连接不保证成功。

## D-009：自签 HTTPS 用于局域网演示

决定：

- demo 模式监听 0.0.0.0，并为手机 getUserMedia 提供 HTTPS。
- 首次访问由用户在受控局域网内手动接受自签证书。

原因：

- 手机浏览器对摄像头/麦克风要求安全上下文。
- 本地比赛环境通常没有可用公网域名和受信任证书。

限制：

- 部分 iOS/Android/企业策略不允许绕过证书警告。
- 证书信任失败时必须切换 Local Camera 或 Mock Source。
- 自签证书不适合公网、生产或敏感数据。

## D-010：不持久化媒体与会话

决定：

- 默认不录制摄像头或麦克风。
- 不使用数据库。
- 会话状态仅驻留内存和浏览器状态。

原因：

- 降低隐私风险和 MVP 复杂度。
- 符合短时现场演示的需求。

影响：

- 服务重启后需要重新加入会话。
- 未来增加录制必须重新设计授权、保留期和删除机制。

## D-011：市场差异来自用户选择的模板

决定：

- 市场配置定义语言、舞台、字幕、平台外观和数字分身主题。
- 不从主播脸部、姓名或语音推断文化身份。
- 使用现代抽象视觉，避免夸张文化符号。

原因：

- 尊重用户身份并降低刻板印象风险。
- 配置驱动便于增加第四个市场。

## D-012：视觉优先级是舞台而非 dashboard

决定：

- 1440 × 900 首屏固定展示真人源、三市场舞台和数据路径。
- 使用少量语义化遥测，避免普通表格和密集小字。
- 动效只解释连接、退化、恢复和数据流。

性能约束：

- 主要 UI 动效只使用 transform / opacity。
- 三路 Avatar 控制 DPR 和几何复杂度。
- 支持 prefers-reduced-motion。
- WebGL 失败时优先 2D fallback。

## D-013：观众数和平台标识仅用于叙事

决定：

- 使用虚构平台名，避免复制真实商标。
- 观众数是固定演示数据，不参与商业收益计算。

原因：

- 建立直播间语境，同时不暗示真实平台接入。

标记：

- 观众数和平台状态属于 EMULATED。

## 已知限制汇总

- 没有真实运营商 QoD、MEC 或蜂窝网络测量。
- 没有生产直播平台推流。
- 没有生产 TURN、认证、数据库或持久化。
- 预置翻译不是实时 AI；AI 环境变量只有在对应服务端 Provider 落地后才生效。
- 程序化姿态不是摄像头姿态追踪，除非运行时明确使用真实 Avatar Provider。
- 自签证书需要手动接受，并可能被设备策略阻止。
- 浏览器 TTS 和摄像头权限受设备环境影响。
- 当前浏览器 TTS Provider 在 API 存在时返回 LIVE；演示者仍应以实际听到声音为准，不能仅凭 provenance 声称目标 voice 播放成功。
- 真实 WebRTC 限速只有在 sender constraints 成功应用时才成立。
- Experience score 是演示模型，不是行业标准 KPI。
- 虚构平台、观众数和业务画面不代表外部平台数据。

## D-014：比赛主视觉采用预录双舞台

决定：

- Mock Demo 左侧固定原始中文录屏，右侧一次只展示一个 Japan / LATAM / India 本地化视频。
- 市场通过显式 tab 切换；所有三路网络状态仍由同一网络模型计算。
- Comparison 使用当前市场的预录视频，不再在主流程挂载三个 WebGL Avatar Canvas。
- 原视频保留“原始录屏 · 本地素材”；本地化视频只显示市场与 locale，素材性质由演示者口头说明；缺失素材使用明确的原片回退。
- 第 3 步通过浏览器 Web Audio 将本地化视频声音延迟 1000 ms，第 4 步收敛到 100 ms；A/V SYNC 遥测与警告使用相同数值。1000 ms 在领导演示距离下仍能识别错位，同时避免呈现为过度夸张的严重故障。

原因：

- 真实视频比三个相似程序化头像更直接地证明本地化差异。
- 一次只展示一个目标市场，可在 1440 × 900 内保留网络路径和六步 Director，同时提高字号与可读性。
- 移除主流程 WebGL 依赖可降低启动体积和现场 GPU 风险。

限制：

- 预录资产不是实时生成，不得标记 LIVE。
- 1000 ms / 100 ms 音画偏移由导演状态驱动，属于 EMULATED，不是实际网络测量或真实 Edge 推理结果。
- India 成片缺失时只能演示 fallback，不得声称印度版本已经完成。
- 原有 Avatar Provider 与历史能力接口可保留，但不再承担比赛主链路视觉。

## 变更原则

任何新增真实 Provider 都必须：

1. 保留 Demo fallback。
2. 返回明确 provenance。
3. 设置短超时和失败原因。
4. 不把 Key 下发到浏览器。
5. 更新本文件和 README。
6. 增加成功、失败和回退测试。
