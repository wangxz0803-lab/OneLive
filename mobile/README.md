# OneLive 手机采集 App（Expo / React Native）

M4 里程碑交付。一个 Expo（managed workflow）原生 iPhone App：一次性输入 PC 局域网
`IP:端口`（默认 `8900`，AsyncStorage 持久化）→ 一个大按钮开播 → 手机摄像头以**与
`engine/service/protocol.py` 逐字节一致的 20 字节协议**、约 10fps 通过
`ws://<pc-ip>:8900/ingest` 上行 JPEG 帧；手机端显示诚实的上行 HUD（fps_sent /
链路RTT(ws) / 连接态），每 2s 上报 `uplink_stats` 控制帧；断线指数退避重连、切后台自动停。

`engine/service/capture.html`（Safari 网页版）作为兜底保留，本 App 不取代它。

---

## 架构

```
SettingsScreen  ──parseEndpoint──►  LiveScreen
 (IP:port 输入)   (校验+持久化)        │
                                     ├── Hud.tsx        诚实 HUD：上行 fps · 链路RTT(ws) · 连接态
                                     └── CaptureWebView 隐藏 WebView（1x1 opacity0）
                                            │              承载 assets/capture-native.html
                                            │              （由 engine/service/capture.html 派生）
                                            ▼
                                     ws://<pc-ip>:<port>/ingest   ← 20 字节头 + JPEG，约 10fps
```

- **原生外壳（Expo/RN）**：一次性设置与持久化、大按钮开播/停播、连接状态机、HUD 显示、
  生命周期（`AppState` 切后台自动停）。
- **取帧热路径 = 隐藏 WebView 复用 `capture.html`**（见「取帧选型」）。WebView↔原生用
  `postMessage`（HUD 上桥）+ `injectJavaScript`（start/stop、注入 host）。
- **纯 TS 传输层（`src/protocol/`、`src/net/`）**：20 字节编码器、指数退避、`uplink_stats`
  构造、参考传输（连接/ping-pong RTT/发帧/退避重连）、endpoint 校验。RN 与 Node 共用，
  jest 全覆盖，且被 Node 环回 E2E（`e2e/loopback.ts`）拿去连真引擎验证。

### 刻意偏离 spec §4.1（记录在案）

spec 原选 **WebRTC**（`react-native-webrtc` + `getStats()`）。M4 **改为复用现有 WS+JPEG
上行链路**：

1. 复用已被 `engine/e2e/capture-e2e.mjs` 端到端验证过的、byte-exact 的成熟管线
   （`/ingest` + 20 字节协议 + `uplink_stats` + ping/pong RTT 全部已在服务端，**引擎零改动**）；
2. 纯 JS 编码器可本地单测、可用 Node 环回连真引擎测，**无需 Mac / 真机即可见进展**；
3.「网差 → 上行帧掉 → 数字人动作差」的真实因果链在 WS+JPEG 下依然成立（出口拥塞跳帧 +
   `skipped` 计数即损伤可观测出口）。

代价与诚实标注：
- **RTT 是 WS 链路 RTT**（ping/pong），**不是蜂窝上行 RTT**。HUD 标签写死为「链路RTT(ws)」。
- 上行码率/抖动/丢包用的是应用层跳帧计数，非 WebRTC `getStats()` 的真实 UDP 指标。
- **WebView 复用 `capture.html`** 而非原生相机取帧：最大化复用已验证的 byte-exact 管线、
  Expo Go 兼容（`react-native-webview` 随 Expo Go 提供）。`expo-camera` 的
  `takePictureAsync` 循环达不到 10fps；`react-native-vision-camera` frame processor
  性能最好但需 dev build（Mac/EAS）且无真机不可测。

WebRTC 真实 `getStats` 与 vision-camera 原生取帧均记为 backlog（见 `docs/superpowers/m4-results.md`）。

---

## 本地开发命令

```bash
cd mobile
npm run start          # expo start（Expo Go 扫码 / 模拟器 i）
npm test               # jest：传输层单测（当前 33 passed）
npm run typecheck      # tsc --noEmit（应 exit 0）
```

Node 环回 E2E（无真机，纯 TS 传输连本地真引擎，断言 /status.uplink 非 stale）：

```bash
# 终端 1（engine/）：起本地引擎
cd engine
PYTHONPATH=. <m0-venv-python> -m service.run_local --port 8930

# 终端 2（worktree 根）：跑环回，等 /status 就绪后连 ws://127.0.0.1:8930/ingest
E2E_PORT=8930 npx tsx mobile/e2e/loopback.ts
```

`ws` / `tsx` 从仓库根 `node_modules` 解析（同 `engine/e2e/capture-e2e.mjs`）。退出码
PASS=0 / FAIL=1 / 引擎不可达=2。

### Safari 兜底

不装 App 也能采集：手机 Safari 打开 `http://<pc-ip>:8900/capture` 即为网页版
`capture.html`。注意 iOS `getUserMedia` 需安全上下文——非 localhost 的 http 可能被拦，
必要时用引擎 `--https` 的 `/capture`。

---

## OWNER 步骤：打包 IPA 并侧载（**勿自动化 · 需 Apple ID**）

以下步骤需要**你本人的 Apple ID 与 EAS 云端凭据**，agent 无法也不应代做：

1. 云端出 IPA（需登录 Expo/EAS 账号，触发 EAS 云构建）：
   ```bash
   cd mobile
   eas build -p ios --profile preview
   ```
2. 构建完成后从 EAS 面板/CLI 链接**下载 IPA**。
3. 用 **Sideloadly** 侧载到 iPhone，登录**你的 Apple ID**签名安装。
   > 免费个人证书签发的 App **仅 7 天有效**，到期需用 Sideloadly 重新签名安装。
4. 首次运行系统会弹相机权限（`NSCameraUsageDescription` 已在 `app.json` 声明）。

诚实提示：本 App 的原生粘合（WKWebView `getUserMedia` 取真相机、iOS 安全上下文、
`AppState` 真机行为、侧载后端到端）**只有真机能最终验证**，本里程碑未做真机验收。
