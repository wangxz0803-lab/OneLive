# OneLive 领导演示版轻量去 AI 味设计

**日期：** 2026-08-09
**状态：** 已批准方向，待实施
**依据：** `artifacts/design-audit-ai-feel/report.md`

## 目标

降低当前控制台的通用生成式 Dashboard 气质，让领导在 1440 × 900 屏幕上先看到“原视频如何变成多个市场版本”，再看到网络、Edge 和 QoD 的差异。保留现有演示主链路和技术可信度，不做品牌重塑或信息架构重写。

## 已选方向

采用**定向演进**：调整字体、层级、表面和重复状态，不推倒双视频骨架。

不采用以下方向：

- 不做浅色商务后台，会削弱直播控制室语义。
- 不做营销落地页风格，无法承载六步实时演示。
- 不换组件库或引入新运行时依赖，避免破坏离线 Mock Demo。

## 设计原则

### 1. 视频优先

- 左侧原始录屏、右侧当前市场版本继续占据首屏主体。
- 三市场切换位置和点击逻辑保持不变。
- 网络路径仍只在开始演示后揭示。
- 不新增装饰图、背景图或无业务含义的动画。

### 2. 字体分工

定义两套本地字体角色，不依赖网络字体：

- 界面字体：`Segoe UI Variable Text`、`Segoe UI`、`PingFang SC`、`Microsoft YaHei UI`、sans-serif。
- 数据字体：`ui-monospace`、`SFMono-Regular`、`Consolas`、monospace。

界面字体用于中文标题、说明、按钮、状态和市场名称；数据字体仅用于 `RTT`、`ms`、`Mbps`、`fps`、`kbps`、timecode、locale 等真正需要对齐的字段。

桌面字号下限：

- 主体正文与关键状态：13px。
- 辅助标签：11–12px。
- 仅允许数据路径中的非关键紧凑数值降到 10px；不得继续使用 7–9px 作为常规可读文本。

### 3. 表面和边框

- 保留顶层面板、视频容器和抽屉的边界。
- 内层指标不再全部做成独立卡片，改用留白或单线分隔。
- 移除顶层面板的通用斜向高光覆层，减少模板化玻璃质感。
- 去掉非语义发光；青色只强调主操作与实时路径，橙色只表示退化/警告，紫色只表示 Edge。
- 保留现有近黑背景和冷灰表面，不切换主题。

### 4. Provenance 收敛

LIVE / EMULATED 真实性规则保持不变，但减少重复展示：

- 顶部系统状态保留一次全局 `演示数据 · 模拟 EMULATED`。
- 来源视频保留 `本地素材`，真实回退时继续明确显示 `原片回退 · 模拟 EMULATED`。
- 网络路径保留 LIVE / EMULATED 图例，因为该区域可能混合来源。
- 观看人数、普通码率和重复市场计数不再逐条追加 `模拟 EMULATED`。
- DOM 的 `data-provenance` 和 Provider 结果不变，只调整面向领导的可见重复文案。

### 5. 对比页降噪

- 保留云端与边缘的左右视频对照。
- 中央改善列从“独立发光仪表卡”降为开放式结果摘要，只突出三个差值：时延、帧率、音画偏移。
- 底部频道状态保留，但使用分隔线而不是三个完整描边卡片。
- 一屏只保留一个明确结论：边缘保障后，核心体验恢复。

### 6. 交互和可访问性

- 不改变按钮名称、快捷键、路由、Director 状态机或媒体播放逻辑。
- 保留可见焦点环和至少 44 × 44px 的主要点击目标。
- 状态变化继续同时使用文字、图标/形状和颜色。
- `prefers-reduced-motion` 行为不变，不新增持续动画。

## 影响文件

- `src/styles/index.css`：全局字体 token、面板表面、顶部状态、网络路径、Director、对比页。
- `src/styles/four-video-demo.css`：双视频区、市场切换、字幕和遥测的字体与边界。
- `src/features/control-room/SourcePanel.tsx`：移除重复 provenance 文案。
- `src/features/control-room/LocalizedStage.tsx`：简化市场计数文案。
- `src/features/control-room/MarketCard.tsx`：简化观看人数 provenance。
- `src/features/comparison/ComparisonView.tsx`：把中央结果列改为领导可读的结论摘要。
- 对应 Vitest、Playwright 和视觉截图。

## 验收标准

1. 1440 × 900 无垂直页面滚动，双视频和导演控制完整可见。
2. 常规中文正文与关键状态不小于 13px，辅助标签不小于 11px。
3. 等宽字体只用于数据/locale/timecode，不用于中文标题、状态或按钮。
4. 初始页可见 `EMULATED` 不再在每个指标重复；顶部和混合来源区域仍清楚标注 provenance。
5. 对比页中央摘要无需阅读微型标签即可理解 Edge 改善。
6. Connect → Congestion → Latency → Edge → QoD → Business 六步和所有既有快捷键不变。
7. lint、build、unit/component tests、15 项 Edge E2E 全部通过。
8. 重新捕获并人工检查 1440 × 900 的控制室、高时延和对比页截图。

## 非目标

- 不修改 Logo、品牌名称、路由或导航标签。
- 不引入数据库、账户、真实 AI 服务或新依赖。
- 不改变 1000ms / 100ms 音画延迟逻辑。
- 不删除 LIVE / EMULATED provenance 模型。
- 不制作 Figma 审计板。
