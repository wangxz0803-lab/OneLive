# OneLive

> ONE SOURCE. MANY MARKETS. LIVE.

OneLive 是一个面向现场演示的实时数字分身直播 MVP：一名主播提供一次中文信号，控制台同时呈现北美、日本和西语市场的本地化数字分身直播体验，并通过可复现的网络实验展示拥塞、高时延、Edge AI 和 QoD 对体验的影响。

本项目优先保证离线可演示、状态可解释和失败可恢复。Mock Demo 不依赖手机、外部 AI API 或互联网。

## 能力边界

OneLive 在界面和文档中区分两类数据：

| 标记     | 含义                           | 当前示例                                                                                               |
| -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| LIVE     | 来自当前设备或实时会话的事实   | 已授权的摄像头/麦克风画面、WebRTC 连接状态、浏览器实际支持时的本地语音合成、已接入时的 WebRTC stats    |
| EMULATED | 为可复现演示而由应用注入或预置 | 网络 Profile、RTT/抖动/丢包、Edge/Cloud 处理时延、QoD 资源分配、预置翻译、程序化姿态、观众数和体验评分 |

需要特别说明：

- 当前 QoD 与 Edge AI 是 Deployment Profile / Network Capability Simulation，不是运营商商用 API 或真实 MEC 调度。
- 网络实验器改变应用内的处理队列、频道状态和视觉质量；它不是操作系统级网络整形工具，也不代表当前局域网的真实蜂窝质量。
- Socket.IO 只负责会话存在状态与 WebRTC 信令，不承担媒体转发。
- 项目不向真实直播平台推流，不包含账号、支付、数据库、多租户或生产级 TURN 部署。
- Real AI 环境变量是可扩展接口。未配置或调用失败时，演示回退到预置多语言文本；不要把预置文本描述为实时 AI 翻译。

更完整的边界与假设见 [docs/DECISIONS.md](docs/DECISIONS.md)。

## 环境要求

- Node.js 20 LTS 或更新版本
- npm 10 或更新版本
- 推荐桌面浏览器：最新版 Chrome 或 Edge
- 手机采集：支持 getUserMedia 和 WebRTC 的现代 Safari/Chrome
- 手机与电脑处于同一局域网；电脑防火墙允许所选端口

## 安装

在项目根目录执行：

    npm install

不要把真实 API Key 提交到仓库。服务会按 Vite 规则加载本地 `.env` / `.env.development` / `.env.production`，并由进程环境中的同名变量覆盖；`.env.example` 只用于说明变量。

## 启动

### 推荐：Mock Demo

Mock 模式不需要手机、摄像头、API Key 或外网，是现场演示的保底路径。

Windows PowerShell：

    powershell -ExecutionPolicy Bypass -File .\scripts\start-demo.ps1 mock

macOS / Linux：

    bash scripts/start-demo.sh mock

也可以直接执行：

    npm run demo:mock

### HTTPS 手机联机 Demo

Windows PowerShell：

    powershell -ExecutionPolicy Bypass -File .\scripts\start-demo.ps1 demo

macOS / Linux：

    bash scripts/start-demo.sh demo

也可以直接执行：

    npm run demo

demo 命令会先构建项目，再以 HTTPS 方式监听 0.0.0.0。默认会话为 ONE-DEMO，终端会打印桌面入口 /?session=ONE-DEMO 和每个可用局域网 IP 的 /broadcast/ONE-DEMO；控制台二维码使用同一手机地址。

### 开发模式

    npm run dev

开发模式用于本机迭代。跨设备摄像头采集仍需要安全上下文，手机联调应使用 demo 的 HTTPS 入口。

### 启动脚本参数

PowerShell：

    .\scripts\start-demo.ps1 [demo|mock|dev] [-Port 5173] [-SkipInstall]

Shell：

    PORT=5173 bash scripts/start-demo.sh [demo|mock|dev]

如果已经安装依赖，可设置 SKIP_INSTALL=1 跳过脚本的依赖检查：

    SKIP_INSTALL=1 bash scripts/start-demo.sh demo

## 手机首次连接与自签 HTTPS

手机摄像头 API 需要安全上下文。现场 HTTPS 服务会在 certs/ 下生成带 localhost、主机名和当前局域网 IP SAN 的自签证书，因此首次打开局域网地址时浏览器通常会显示证书警告。certs/ 已被 Git 忽略；局域网 IP 变化后服务会重新生成证书。

1. 电脑和手机连接同一 Wi-Fi，关闭会强制分流的 VPN 或访客网络隔离。
2. 在电脑运行 demo，记录终端显示的局域网 HTTPS 地址。
3. 先在手机浏览器直接打开该 HTTPS 地址。
4. 在证书警告页选择“高级/显示详细信息”，确认访问当前局域网 IP。
5. 回到电脑控制台扫描二维码，进入 broadcaster 会话。
6. 只在浏览器提示时授权摄像头与麦克风。OneLive 默认不录制、不持久化媒体。

iOS Safari 通常需要“显示详细信息 → 访问此网站”；Android Chrome 通常需要“高级 → 继续访问”。不同系统策略可能禁止绕过未受信任证书。若没有继续入口，不要在现场排查过久，立即切换桌面本机摄像头或 Mock Source。

自签证书只适合受控局域网演示，不适合公网或生产部署。生产环境必须使用受信任 CA 证书，并配置 TURN、访问控制和隐私合规措施。

## Demo 操作

完整的 3–5 分钟讲解脚本见 [docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md)。

常用快捷键：

| 键        | 操作                                      |
| --------- | ----------------------------------------- |
| Space     | 下一演示步骤                              |
| Backspace | 上一演示步骤                              |
| R         | 重置到演示初始状态                        |
| F         | 切换全屏                                  |
| E         | Edge / Cloud                              |
| Q         | QoD                                       |
| 1–4       | Premium / Congested / Weak / High Latency |
| C         | 体验对比模式                              |
| M         | Mock Source                               |

演示前必须实际试按一遍快捷键；浏览器焦点位于输入框时，快捷键可能被输入行为拦截。

## 测试与质量检查

    npm run build
    npm run lint
    npm run test
    npm run test:e2e

这些命令的存在不等于本机已经通过验证。最终交付状态应以本次执行日志为准，不在文档中伪造测试结果。

推荐视觉检查尺寸：

- 1440 × 900：控制台首屏
- 1920 × 1080：大屏控制台
- 390 × 844：手机主播端

## 可选 AI 配置

.env.example 提供基础占位配置，服务端还支持会话和 ICE 配置：

- AI_API_URL
- AI_API_KEY
- AI_MODEL
- PORT
- DEMO_HTTPS
- DEMO_MOCK
- DEMO_SESSION_ID
- ICE_SERVERS_JSON

API Key 只能由服务端读取，不得注入前端 bundle。server/translation.ts 提供 OpenAI-compatible 翻译代理和 8 秒超时，但只有前端实际调用该路由并收到成功响应时，翻译才能标记为 LIVE；默认 DemoTranslationProvider 仍使用预置文本。

Windows PowerShell 示例：

    $env:AI_API_URL = "https://api.example.com/v1/chat/completions"
    $env:AI_API_KEY = "<local-only-key>"
    $env:AI_MODEL = "<model-name>"
    npm run demo

macOS / Linux 示例：

    AI_API_URL="https://api.example.com/v1/chat/completions" \
    AI_API_KEY="<local-only-key>" \
    AI_MODEL="<model-name>" \
    npm run demo

默认没有 STUN/TURN。受控同一局域网通常可依赖 host candidate；如需自定义 ICE server，可通过 ICE_SERVERS_JSON 传入标准 RTCIceServer 数组。不要把长期 TURN credential 写入仓库。

## 常见问题

### 手机打不开电脑地址

- 确认两端在同一局域网且没有 AP isolation。
- 使用终端显示的局域网 IP，不要在手机使用 localhost。
- 放行 Windows Defender Firewall 或 macOS 防火墙中的 Node.js 入站连接。
- 确认端口未被其他进程占用，可用 PORT 环境变量更换。
- 仍失败时切换本机摄像头或 Mock Source。

### 摄像头或麦克风被拒绝

- 检查地址是否为 HTTPS。
- 在浏览器站点设置和系统隐私设置中重新授权。
- 关闭占用摄像头的会议软件。
- 刷新 broadcaster 页面并重新加入原会话。

### 页面有画面但没有目标语言声音

浏览器或操作系统可能没有对应的 TTS voice。字幕和程序化口型仍可演示；不要临时安装未知语音包影响现场稳定性。

### WebGL 不可用或性能过低

关闭其他 GPU 密集应用，使用最新版 Chrome/Edge，并优先启用应用提供的 2D Avatar fallback。若当前构建没有显示 fallback，使用 Mock Demo 并避免声称三维渲染可用。

### 外部 AI 请求失败

演示主链路不依赖外部 AI。切换到预置台词和 Demo Translation Provider，确认界面标记为 EMULATED。

## 数字人引擎服务（V2 M1a–M3b）

LivePortrait 实时驱动的数字人引擎服务原型：WebSocket `/ingest` 收驱动帧（摄像头/视频/浏览器采集页），每频道一个常驻 worker 以 latest-wins 策略推理，`/out` 按频道扇出渲染帧给多个订阅者，`/status` 报统计。运行需要 M0 spike 的引擎资产（模型 + patched FasterLivePortrait clone）：

```bash
# 服务（在 engine/ 目录，用 M0 venv 的 python）
export ONELIVE_M0_ENGINE=<repo>/.worktrees/v2-m0-spike/engine   # 默认即此路径
<m0-venv-python> -m service.run_local --port 8900 [--source <肖像图>] \
    [--channels N] [--https] [--host H] [--cfg onnx_infer.yaml]
```

- `--channels N`：起 N 个频道（0..N-1），每频道一条独立管线（ONNX 权重单例缓存共享）；本地 Arc 上多频道均分 ~1.9fps 推理算力，仅作功能验证。
- `--https`：TLS 服务，证书取 `<repo-root>/certs/onelive-{cert,key}.pem`（缺证书时带生成指引退出）；`--https` 时 `--host` 默认 `0.0.0.0`。
- `--cfg`：LivePortrait 配置名（clone `configs/` 下的 yaml）。

**驱动源**（任选其一，另开终端）：

```bash
# A. 浏览器采集页（推荐）：桌面 Chrome/Edge 打开
#    http://127.0.0.1:8900/capture?fps=10&channel=0 ，点 Start 授权摄像头
# B. Python feeder：摄像头或视频文件
<m0-venv-python> -m service.feeder --url ws://127.0.0.1:8900/ingest --camera 0 --fps 10
```

手机采集：手机 getUserMedia 需要安全上下文，用 `--https` 启动后手机浏览器访问 `https://<电脑局域网IP>:8900/capture`；首次会遇到自签证书警告，处理步骤同上文「手机首次连接与自签 HTTPS」一节（证书同为 `certs/` 下自签，wss 自动跟随页面协议）。

**观看**：浏览器打开 `http://127.0.0.1:8900/?channel=0` 实时目检（viewer 页，`?channel=` 选频道）；量化测量用 `tools/out_probe.py`。

### 翻译链路（V2 M2a）

`--translate` 启用翻译链路：faster-whisper small 中文 ASR（首跑自动下载 ~460MB 到 `engine/models/whisper`）+ OpenAI 兼容翻译 Provider + edge-tts 英文配音（嘴型曲线随配音产出，进程内供 M2b 数字人消费）。

```bash
# 翻译 Provider 凭据（可选）。未配置时链路诚实降级：
# 字幕照常产出，翻译事件 status="unavailable"，不做 TTS——绝不伪造译文。
export AI_API_URL=https://<openai兼容端点>/v1  AI_API_KEY=sk-...  AI_MODEL=<模型名>
<m0-venv-python> -m service.run_local --port 8900 --translate
```

- **`/audio` 音频上行**（WS 二进制帧）：`[4 字节 LE u32 采样率][pcm16 mono]`，~250ms/帧；采集页 Audio 开关即走此路。采样率会话内必须恒定（中途变化 → error 说明帧 + close 4409）。
- **`/events` 事件广播**（WS JSON，多订阅者）：`subtitle{segment_id,text,t0,t1}` → `translation{segment_id,lang,status,text,detail}` → `tts_ready{segment_id,lang,voice,duration_s,synth_ms,has_audio,channel}`（音频/嘴型曲线不上 wire；`channel` 为 M2b 分流的目标频道，未命中 lang_channels 时为 null）→ `pipeline_error{...}`。
- **casting 换角**（`/ingest` 文本帧）：`{"type":"casting","channel":0,"source":"s1.jpg"}` → `casting_ack{ok,ms|detail}`；source 白名单限 `ONELIVE_AVATAR_DIR`（默认 M0 clone `assets/examples/source/`）下的纯文件名。
- `/status` 增加 `translation` 节（segments/translated_ok/translations_unavailable/tts_ok/errors）。
- E2E 复验：`<m0-venv-python> -m e2e.translate_e2e --leg all`（stub 腿进程内自足；server 腿需 8912 端口起 `--translate` 服务）。实测数据：[M2a 实测结果](docs/superpowers/m2a-results.md)。

### 语音驱动嘴型（V2 M2b）

`tts_ready` 到达时服务把嘴型曲线送进对应频道的口型调度器（渲染循环按时间线驱动数字人嘴部开合），音频以二进制帧广播到 **`/speech?channel=N`**（`[u8 ch][u32 LE seg][u32 LE sr][pcm16]`）。viewer 页内置 WebAudio 播放（FIFO 链式排播）+ `speaking: seg N (lang)` 状态行——浏览器自动播放策略所限，需点页面「开启声音」按钮后才有声。`/status` 每频道增加 `speech` 节（queued/played/dropped）。A/V 同步契约（音频即收即播、嘴型晚 ≤1 渲染周期、积压时两端各自丢段）见 `service/app.py` 模块 docstring；精确对齐是 M3 范畴。

- `--no-lip`：关闭嘴型驱动的逃生开关（默认开启的 lip retarget 通路即使无语音也轻微改变唇形细节，见 [M2b 实测结果](docs/superpowers/m2b-results.md)）。
- `--translate-stub`：**测试脚手架，绝非默认、不是翻译**——翻译 Provider 换成 stub（返回 `"EN: "+原文` 假装成功，事件 detail 自我声明 test-only），唯一用途是无 API key 环境跑通 翻译ok→TTS→嘴型 全链路。与 `--translate` 互斥；真翻译的诚实契约（无 key 绝不伪造译文）不受影响。
- E2E 复验：`<m0-venv-python> -m e2e.lip_e2e`（自起 8915 真服务 + feeder，事件链/嘴型/计数断言，证据落 `engine/out/lip_e2e/`）。实测数据：[M2b 实测结果](docs/superpowers/m2b-results.md)。

### RTMP 推流（V2 M3a）

`--rtmp <模板>` 为每频道起一个受监督 ffmpeg（崩溃指数退避重启），把渲染帧（`/stream.mjpeg`）+ 连续音轨（`/stream.wav`，静音打底 + TTS 语音拼接，纯静音也不断流）合成 flv 推向 RTMP 地址；`{ch}` 为频道占位，与 `--https` 不兼容：

```bash
# 本地收流端（自建 node-media-server，另开终端）：
cd engine/rtmp-sink && npm ci && node server.mjs
# 服务 + 推流（每频道一路）：
<m0-venv-python> -m service.run_local --port 8900 --translate \
    --rtmp rtmp://127.0.0.1:1935/live/ch{ch}
# 观看：VLC / ffplay / ffprobe 打开 http://127.0.0.1:8000/live/ch0.flv
```

- 推公开平台（YouTube/B站/Twitch）＝把 `--rtmp` 换成平台推流地址+串流码（账号归 OWNER）；注意两点：推流音轨当前 16k 而主流平台推荐 44.1k/48k（ffmpeg 侧一处 `-ar` 改动即可），YouTube 现推荐 rtmps 入口（ffmpeg TLS 推流转公网时需验证）。详见 [M3a 实测结果](docs/superpowers/m3a-results.md)。
- `/status` 增 `streams` 节（running/pid/restarts/last_exit_code/stderr_tail；stderr 里的串流码已脱敏，但 run_local 启动日志含未脱敏 URL，用真实串流码时勿外传日志）。
- E2E 复验：`<m0-venv-python> -m e2e.rtmp_e2e`（自起 sink+服务+feeder，端口 8917，含弹性断言）。

### 网络损伤实验（V2 M3a netlab）

`engine/netlab/` 用 [clumsy](https://github.com/jagt/clumsy)（WinDivert 内核驱动）对真实流量做损伤，支撑 demo 网络场景：`congested`（限速 120KB/s + 丢包 5%）/ `weak`（丢包 15% + 乱序 25%）/ `latency`（双向 lag 300ms）/ `off`（恢复）。**需管理员 PowerShell**（装驱动；非管理员会拒绝并打印可复制的提权命令），OWNER 一行命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File engine\netlab\profiles.ps1 -Profile latency -Ports 8900
```

首次先跑 `get-clumsy.ps1` 下载（SHA256 pin）；`-DryRun` 只打印命令不需管理员；端口选择（8900=WS 媒体路径 / 1935=RTMP）、loopback 双倍效应与完整实测步骤见 [engine/netlab/README.md](engine/netlab/README.md)。

### 导播控制台（V2 M3b）

服务内置一个单文件、无构建步骤的导播控制台，桌面浏览器打开即用（数据源来自服务真实运行状态，非独立后端）：

```bash
# 浏览器打开（服务已在 8900 监听时）：
http://127.0.0.1:8900/console
```

- **`GET /console`**：自包含 HTML 导播台——按频道渲染卡片（预览屏 = `/out` 渲染帧、语言标签取自 `lang_channels`、ON AIR/推流徽标取自 `streams` 块）、字幕流面板（消费 `/events`）、casting 换角下拉，以及右侧遥测 HUD。未配置的频道槽诚实显示斜纹占位（"该市场频道未启用"），不伪造数据。
- **`GET /avatars`** → `{"avatars": [...]}`：casting 底图白名单枚举，列 `ONELIVE_AVATAR_DIR`（默认 M0 clone `assets/examples/source/`）下通过 `_AVATAR_NAME_RE` 校验的纯文件名。与 `/ingest` casting 帧用**同一份目录逻辑 + 同一条正则**——下拉里能选到的正是服务端会接受的，不给前后端白名单漂移留缝；目录缺失时诚实返回空列表（不 500）。
- **上行统计 HUD**：采集页（`/capture`）每 2s 通过 `/ingest` 文本控制帧上报一次窗口 `uplink_stats{channel,fps_sent,skipped,rtt_ms}`，并同步发 `ping{t}` 探测（服务原样回显 `pong{t}`）；`/status` 汇总成每频道 `uplink` 块 `{fps_sent,skipped,rtt_ms,age_s,stale}`——`age_s = now - received_at`（monotonic 差值），`age_s ≥ 5s` 记 `stale=true`（HUD 据此置灰）。**`rtt_ms` 是 WS 传输层链路往返（loopback ~0ms、LAN 是局域网时延），HUD 与采集页均如实标注为 `链路RTT(ws)`，绝非蜂窝/RAN 上行 RTT。**
- **Edge⇄Local 段选是占位**：Local 为当前唯一实态，Edge 按钮灰置禁用（tooltip「边缘节点待 M1b」），待 M1b 边缘节点落地后接线。
- E2E 复验：`node engine/e2e/console_e2e.mjs`（自起 console 启动器 + 驱 chromium，5 项断言，产物落 `engine/out/console_e2e/`）。实测数据：[M3b 实测结果](docs/superpowers/m3b-results.md)。

当前性能（本地 Arc，DML，512 crop）：空载 ~1.9fps / 单帧推理 ~534ms / E2E 延迟中位 566ms（M1a，Python feeder）；浏览器同机全链路（假摄像头 E2E，chromium 双页面同机争抢）1.63fps / E2E 延迟 mean 678ms。高帧率输入靠 latest-wins 丢帧适配（by design）。实测数据与已知问题：[M1a 实测结果](docs/superpowers/m1a-results.md)、[M1c 实测结果（浏览器采集桥 + 全链路 E2E）](docs/superpowers/m1c-results.md)。

## 文档

- [产品规格](docs/PRODUCT_SPEC.md)
- [系统架构](docs/ARCHITECTURE.md)
- [演示手册](docs/DEMO_RUNBOOK.md)
- [决策与能力边界](docs/DECISIONS.md)
- [协作与维护约束](AGENTS.md)

## 隐私与安全

- 摄像头和麦克风默认不录制、不写入数据库。
- 会话 ID 只用于短期设备配对，不是身份认证。
- 自签 HTTPS、局域网信令和无鉴权会话只适合受控演示环境。
- 展示 AI GENERATED / AUTHORIZED AVATAR 标识，禁止未经授权采集或冒用真人形象。
