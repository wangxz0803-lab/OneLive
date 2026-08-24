# OneLive 中文优先与网络渐进揭示设计

## 目标

让中文领导在前十秒先理解“一段中文直播对应三个海外市场版本”，再通过演示操作理解 5G、Edge AI 与 QoD 对交付体验的作用。预生成视频作为最终效果样例，界面不主动展开能力免责声明；演示者在开场口头说明最终目标是实时转化。

本轮不增加实时 AI、推流或新页面，只调整现有 Demo 的叙事顺序、界面语言与状态呈现。

## 叙事结构

### 阶段一：内容本地化

初始首屏突出左右双舞台：

- 左侧为原始中文录屏。
- 右侧为日本、拉美、印度三个可点击市场入口，一次展示一个版本。
- Network Path 不渲染，也不保留空白占位。
- 顶部保留必要的紧凑状态，但不让网络指标成为视觉中心。
- 输入源工具、手机采集和其他旧能力保留在次级入口。

演示者先播放原片，再逐个点击三个市场，用口头说明交代“当前为稳定演示使用的预生成样例，最终目标是接入直播流进行实时转化”。界面不增加显眼免责声明。

### 阶段二：网络保障

以下任一行为永久揭示本轮演示中的 Network Path：

- 点击“开始演示”。
- 按 Space 或 Backspace 推进/回退导演步骤。
- 使用 `1–4`、`E`、`Q` 等网络快捷键。
- 在网络抽屉中更改 Profile、Edge 或 QoD。
- 打开 Comparison。

Network Path 从底部以一次性的 150–300ms 位移与透明度过渡进入。主舞台在同一布局系统内让出空间，不覆盖视频、不产生页面滚动。暂停导演后路径继续可见，避免界面来回跳变。

按 `R` 执行完整重置：恢复 Japan、Premium、Cloud、QoD Off 和初始内容阶段，并再次隐藏 Network Path。

## 中文优先语言策略

所有操作、标题、状态解释和演示结论使用中文。只保留有识别价值的技术缩写和品牌词：5G、Edge AI、QoD、RTT、A/V Sync、LIVE、EMULATED。

LIVE / EMULATED 采用双语小字，保持来源语义：

- `实时 LIVE`
- `模拟 EMULATED`

核心词汇映射：

| 现有英文 | 中文优先版本 |
| --- | --- |
| RUN DEMO | 开始演示 |
| Pause demo | 暂停演示 |
| Next / Back / Reset | 下一步 / 上一步 / 重置 |
| Source tools | 输入源工具 |
| Original Chinese recording | 原始中文录屏 |
| Localized output | 本地化市场版本 |
| One market at a time | 点击查看不同市场版本 |
| Cloud + Best Effort | 云端处理 · 普通网络 |
| Edge AI + QoD | 边缘 AI · QoD 保障 |
| Low res / Buffering / Locked | 低清 / 缓冲中 / 已保障 |
| AI Generated / Authorized | AI 生成 / 已授权 |

市场入口使用“中文市场名 + 目标语言”：日本 · 日语、拉美 · 西班牙语、印度 · 英语。指标单位、语言代码与必要的技术缩写继续使用原格式。

## 组件与状态

Zustand Store 新增一个单一布尔状态 `networkStoryRevealed`，避免多个组件分别推断是否进入网络阶段。

- 初始值：`false`。
- `revealNetworkStory()`：幂等地设为 `true`。
- 现有 `reset()`：同时恢复为 `false`。

触发逻辑放在现有 Store action 与导演入口中，UI 只消费派生状态，不自行复制快捷键判断。

`App` 根据该状态控制 Network Path 是否挂载，并为主舞台添加布局状态类。`TopBar`、`DirectorHud`、`NetworkDrawer`、`ComparisonView` 和 `BusinessView` 沿用现有职责，不创建第二套演示状态机。

## 兼容与恢复

- 六步顺序保持 Connect → Congestion → Latency → Edge → QoD → Business。
- Space / Backspace / R / F / E / Q / 1–4 / C / M 保持可用。
- 缺失视频继续显示明确 fallback，不伪装成本地化成片。
- 来源标签继续可见，但改为中文优先、视觉降级的小标签。
- Broadcaster 移动页只做必要的关键操作中文化，不重新设计采集流程。
- prefers-reduced-motion 下跳过位移动画，直接展示稳定布局。

## 测试与视觉验收

单元/组件测试覆盖：

- 初始 `networkStoryRevealed` 为 false。
- 开始导演、导演快捷键和网络操作将其设为 true。
- 暂停导演不会隐藏路径。
- reset 将其恢复为 false。
- 核心按钮和标题显示中文文案。

Playwright 覆盖：

- 初始 1440×900 看不到 Network Path，双舞台完整。
- 点击“开始演示”后 Network Path 可见，且首屏无纵向滚动。
- Space、网络快捷键和 Comparison 均能揭示网络阶段。
- `R` 后 Network Path 隐藏。
- 1920×1080 与 390×844 无水平溢出。
- 关键按钮具有中文 accessible name。

视觉产物保留内容阶段、拥塞阶段、恢复阶段、Comparison、Business 和移动 Broadcaster 六类截图。

## 明确不做

- 不在首屏增加 `DEMO NOW / PRODUCT VISION` 模式。
- 不增加显眼的“预生成样例”免责声明。
- 不实现实时翻译、声音克隆、人脸替换或视频生成。
- 不删除 WebRTC、Provider、Source Tools、Comparison、Business 或网络抽屉。
- 不改变 Edge 与 QoD 的领域模型和来源语义。
