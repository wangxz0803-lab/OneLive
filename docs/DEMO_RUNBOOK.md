# OneLive Demo Runbook

## 1. 目标

在 3–5 分钟内让评委依次看到：

1. 一名主播同时驱动三个本地化直播间。
2. 无线网络拥塞与高时延造成不同的可见问题。
3. Edge AI 缩短处理路径。
4. QoD 在拥塞下改变资源分配并恢复关键频道。
5. 一次直播覆盖多个市场的商业价值。

全程明确说明 Network、Edge 和 QoD 为演示模拟；真实摄像头与实时会话状态才属于 LIVE。

## 2. 现场配置

推荐：

- 一台接电源的电脑，关闭睡眠、系统更新和通知。
- Chrome 或 Edge 最新稳定版。
- 1440 × 900 或 1920 × 1080 投屏。
- 一部已充电手机，与电脑连接同一 Wi-Fi。
- 有线或稳定 Wi-Fi 网络；Mock Demo 本身不需要互联网。
- 备用鼠标、充电线和本机摄像头。

禁止在正式演示前临时升级浏览器、Node、显卡驱动或安装语音包。

## 3. 提前 30 分钟

1. 在项目根目录安装依赖：

       npm install

2. 执行基础验证：

       npm run build
       npm run lint
       npm run test

3. 如环境允许，执行：

       npm run test:e2e

4. 启动 Mock Demo，完整走一遍六步：

       npm run demo:mock

5. 检查 1440 × 900 首屏：

   - 无纵向滚动。
   - 三市场卡完整。
   - 网络抽屉不遮挡关键画面。
   - 对比和商业收尾可进入。
   - 浏览器控制台没有持续错误。

6. 如计划使用手机，停止 Mock，运行：

       npm run demo

7. 在手机上直接打开终端显示的 HTTPS 地址，提前接受自签证书，再扫描二维码。
8. 完成一次摄像头、麦克风、前后摄像头、断线重连测试。
9. 再次确认 fallback：本机摄像头和 Mock Source 可用。

任何一项手机链路不稳定，都应把正式方案改为 Mock Source；手机可作为加分演示，不得成为主流程单点故障。

## 4. 提前 5 分钟

- 浏览器缩放恢复 100%。
- 关闭 DevTools、下载栏和不相关标签页。
- 进入全屏，确认系统通知已关闭。
- 按 R 回到 Connect 初始状态。
- 确认 Presenter Mode 已开启，非必要设置已隐藏。
- 确认当前来源：LIVE phone / local camera，或 EMULATED mock。
- 如果使用手机，保持屏幕常亮、页面在前台、关闭省电模式。
- 将鼠标停在不遮挡内容的位置。

## 5. 4 分钟标准演示

下面的“讲解”可直接使用。Space 进入下一步，Backspace 返回上一步。

### 0:00–0:35 / Step 1 — Connect

操作：

- 按 R。
- 如使用手机，短暂展示手机摄像头和控制台 source 状态。
- 确认 Premium 5G、Cloud、QoD Off。

讲解：

> 这是 OneLive。一名主播只需要提供一次中文信号，系统就把同一份动作和内容同步到英语、日语和西班牙语三个本地化数字分身直播间。三个市场有独立的形象、舞台、字幕和频道状态。

评委应看到：

- 一个主播源。
- 三个市场频道同时 LIVE。
- 数字分身动作同源但视觉不同。
- 数据路径从 Source 经过网络和处理节点分发到三频道。
- LIVE / EMULATED 标记清楚。

关键说明：

> 当前摄像头画面和连接状态如果来自设备，就是 LIVE；预置翻译、程序化姿态和网络 Profile 是 EMULATED。

### 0:35–1:10 / Step 2 — Congestion

操作：

- 按 Space。

讲解：

> 现在注入拥塞。可用带宽下降，三个频道开始竞争同一份上行预算。请看画面不只是数字变差：频道出现降清晰度、像素化和缓冲，字幕和动作也开始积压。

评委应看到：

- 网络状态变为 Congested Network。
- 至少一个频道 LOW RES 或 BUFFERING。
- 帧率、分辨率或码率下降。
- 路径数据脉冲变慢、聚集或丢失。
- 警告颜色伴随文字/图标，而非只靠颜色。

如果看不到明显变化：

- 按 2 强制 Congested Profile。
- 确认网络抽屉没有手动 override 残留。
- 按 R 后重新推进。

### 1:10–1:45 / Step 3 — Latency

操作：

- 按 Space。

讲解：

> 这一阶段带宽并不低，问题是 RTT 很高。画面仍可能清晰，但数字分身动作、字幕、语音和嘴部时间线发生错位。这说明“带宽够”并不等于实时体验好。

评委应看到：

- High Latency / HIGH RTT。
- 清晰画面与延迟姿态 ghost 同时存在。
- 字幕或嘴部滞后。
- A/V SYNC WARNING。
- E2E latency 和 A/V offset 明显升高。

如果只看到画质下降而没有错位，不要口头声称高时延表现完成；按 4 重置到 High Latency，并确认页面警告与延迟效果实际出现。

### 1:45–2:20 / Step 4 — Edge AI

操作：

- 按 Space，或按 E 切换到 Edge。

讲解：

> 我们把处理节点从远端 Cloud 移到靠近主播的 Edge。路径缩短，姿态、翻译和语音的处理等待下降。注意 Edge 改善的是处理和响应，不会凭空增加无线带宽。

评委应看到：

- Cloud 节点切换为 Edge Simulation。
- 路径节点数和路径长度减少。
- 动作 ghost 收敛、字幕积压减少。
- E2E latency / A/V offset 改善。
- 画面仍明确标记 EMULATED Deployment Profile。

### 2:20–2:55 / Step 5 — QoD Recovery

操作：

- 按 Space，或在 Congested 状态按 Q。

讲解：

> 现在保持背景拥塞，开启会话级 QoD 保障。系统先保证采集和优先市场，再分配剩余带宽。QoD 不是把所有数字变漂亮，而是改变资源分配，让核心频道恢复，同时允许次要频道保持适度降级。

评委应看到：

- 背景 Profile 仍是 Congested。
- QoD 为 On / EMULATED。
- 带宽分配轨发生改变。
- 核心频道从 BUFFERING / LOW RES 恢复为稳定。
- 其他频道按优先级恢复，而不是全部回到 Premium。
- 路径由 stressed 转为 protected。

### 2:55–3:25 / Experience Comparison

操作：

- 按 C 进入对比模式。

讲解：

> 左右使用同一个输入。左侧是 Cloud 加 Best Effort，右侧是 Edge AI 加 QoD。中央直接给出端到端延迟、Avatar FPS、音画偏差和在线频道数的体验差值。这里的网络与能力数据是可复现的 EMULATED 结果。

评委应看到：

- 同源、同构图的左右对照。
- 左侧动作/字幕落后或频道降级。
- 右侧更稳定。
- 中央差值而非两组难以比较的表格。

操作：

- 再按 C 返回控制台，或使用页面返回控件。

### 3:25–4:00 / Step 6 — Business

操作：

- 按 Space 进入 Business。

讲解：

> 最终结果不是多做三场直播，而是一次内容生产，同时进入三个市场：一名主播、三种语言、三个本地化数字分身、三个直播市场。对商家，这是更低的重复组织成本；对运营商，这是蜂窝视频上行、边缘推理和 QoD 会话保障的业务入口。

评委应看到：

- 一次直播，多市场同时开播。
- 1 主播、3 语言、3 数字分身、3 市场、1 次生产。
- 商家价值与运营商价值。
- 无虚构 ROI 或收入数字。

收尾：

> ONE SOURCE. MANY MARKETS. LIVE.

## 6. 快捷键

| 键 | 操作 | 现场用途 |
| --- | --- | --- |
| Space | 下一步 | 主流程推进 |
| Backspace | 上一步 | 讲解回退 |
| R | 重置 | 恢复 Connect 初始状态 |
| F | 全屏 | 投屏 |
| E | Edge / Cloud | 单独解释边缘增益 |
| Q | QoD | 单独解释资源保障 |
| 1 | Premium 5G | 恢复稳定网络 |
| 2 | Congested | 强制拥塞 |
| 3 | Weak Coverage | 展示 AUDIO ONLY / PAUSED |
| 4 | High Latency | 展示时间错位 |
| C | Comparison | 体验差异核心画面 |
| M | Mock Source | 设备失败保底 |

快捷键只在页面焦点不被输入框占用时可靠。每次正式演示前实际验证，不要只依据文档。

## 7. 故障恢复

### A. 手机无法打开 HTTPS

最多排查 30 秒：

1. 确认手机和电脑同一 Wi-Fi。
2. 在手机直接输入终端显示的局域网 HTTPS 地址。
3. 接受自签证书警告。
4. 确认防火墙允许 Node.js 和当前端口。

仍失败：

- 立即切换 Local Camera。
- 本机摄像头也不可用则按 M 使用 Mock Source。
- 对评委说明“现场采集有三层回退，业务演示不依赖单一设备”，不要继续调试网络。

### B. 手机已打开但摄像头无画面

1. 检查浏览器地址栏的摄像头权限。
2. 关闭占用摄像头的其他 App。
3. 刷新 broadcaster 页面并重新加入原 session。
4. 仍失败则切换 Local Camera / Mock Source。

### C. 手机中途断线

1. 等待页面自动重连数秒。
2. 保持相同 session，不重复扫描多个二维码。
3. 若新连接替换旧连接，以最新页面为准。
4. 演示不能等待时按 M，继续当前 Director step。

### D. 没有语音识别或翻译 API

- 使用预置中文台词按钮。
- 确认三语字幕出现并标记 EMULATED。
- 不把预置内容称为实时 API 翻译。

### E. 没有目标语言 TTS voice

- 保留字幕和口型动画。
- 不在现场安装语音包。
- 说明当前设备没有对应系统 voice；声音克隆不属于本 MVP。

### F. WebGL 黑屏或掉帧

1. 退出全屏再进入，确认浏览器硬件加速开启。
2. 关闭其他 GPU 页面。
3. 使用 2D Avatar fallback（如果当前构建提供）。
4. 若没有 fallback，刷新到 Mock Demo 并以静态/程序化画面继续，不声称 WebGL 已恢复。

### G. 页面状态错乱

1. 按 R。
2. 如果无效，刷新控制台并使用 skipIntro 参数快速进入：

       /?skipIntro=1

3. 仍有问题，停止服务后运行：

       npm run demo:mock

4. 从 Step 1 重新开始，跳过手机接入。

### H. 服务端退出或端口占用

Windows：

    powershell -ExecutionPolicy Bypass -File .\scripts\start-demo.ps1 mock -Port 5174

macOS / Linux：

    PORT=5174 bash scripts/start-demo.sh mock

二维码和手机地址必须使用同一个新端口。

## 8. 演示后

- 停止 Node 进程。
- 关闭手机页面，浏览器会释放媒体轨道。
- 不保留摄像头、麦克风或会话数据。
- 如果使用真实 API，撤销临时 Key 或确认其未进入日志和前端 bundle。
- 记录实际测试失败，不把现场 fallback 隐藏为“全部正常”。

## 9. 最终检查单

- [ ] Mock Demo 可独立启动
- [ ] R / Space / C / E / Q / 1–4 / M 可用
- [ ] Congested 有肉眼可见降级
- [ ] High Latency 有 A/V warning 与错位
- [ ] Edge 缩短路径并改善延迟
- [ ] QoD 改变资源分配
- [ ] Business 收尾无虚构财务数据
- [ ] LIVE / EMULATED 标记与实际来源一致
- [ ] 手机失败时能在 30 秒内切换 Mock
- [ ] 1440 × 900 无滚动、无遮挡
- [ ] 浏览器控制台无持续错误
