# OneLive V2 — M4 Expo 原生手机 App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个 Expo（React Native，managed workflow）原生 iPhone App，取代/补充现有 `capture.html`：一次性输入或扫描 PC 局域网 IP+端口（默认 8900，持久化）→ 一个大按钮开播 → 用手机摄像头以**与 `engine/service/protocol.py` 逐字节一致的 20 字节协议**、约 10fps 通过 `ws://<pc-ip>:8900/ingest` 上行 JPEG 帧；手机端显示诚实的上行 HUD（fps_sent / 链路RTT(ws) / 连接态），每 2s 上报 `uplink_stats` 控制帧；断线指数退避重连、切后台自动停、清晰连接/断开/错误态。`capture.html` 作为 Safari 兜底保留。

**Architecture:**

- **刻意偏离 spec §4.1（记录在案）**：spec 原选 WebRTC（`react-native-webrtc` + `getStats()`）。M4 **改为复用现有 WS+JPEG 上行链路**。理由：(1) 复用已被 `engine/e2e/capture-e2e.mjs` 端到端验证过的、byte-exact 的成熟管线（`/ingest` + 20 字节协议 + `uplink_stats` + ping/pong RTT 全部已在服务端，引擎零改动）；(2) 纯 JS 编码器可本地单测、可用 Node 环回连真引擎测，**无需 Mac / 真机即可见进展**；(3)「网差 → 上行帧掉 → 数字人动作差」的真实因果链在 WS+JPEG 下依然成立（出口拥塞跳帧 + `skipped` 计数即损伤可观测出口）。WebRTC（真实 `getStats` 上行码率/抖动/丢包 + UDP 损伤更贴近真实）记为**未来升级项**。RTT 如实标注 **WS 链路 RTT**，不是蜂窝上行 RTT。
- **取帧方案（关键决策，见 Task 9）**：采用 **(c) 隐藏 WebView 复用 `capture.html`** 作为设备热路径——最大化复用已验证的 byte-exact 管线、Expo Go 兼容（`react-native-webview` 随 Expo Go 提供）、~10fps 已被 capture-e2e 证明。原生外壳（Expo/RN）负责：一次性设置与持久化、大按钮开播、连接状态机、HUD 显示、生命周期（切后台停）。WebView↔原生用 `postMessage`（HUD 上桥）+ `injectJavaScript`（start/stop、注入 host）。`expo-camera` 的 `takePictureAsync` 循环达不到 10fps；`react-native-vision-camera` frame processor 性能最好但需 dev build（Mac/EAS）且无真机不可测——均记为未来原生化升级。
- **纯 TS 传输层（TDD 锚点 + 无真机可测核心）**：`mobile/src/protocol/frame.ts`（20 字节编码器，byte-exact，jest 金样对 `protocol.py`）、`net/backoff.ts`（指数退避+jitter）、`net/uplinkStats.ts`（窗口 fps/skipped 上报体，镜像 capture.html）、`net/uplinkClient.ts`（参考传输：连接/ping-pong RTT/发帧/退避重连/停）、`net/endpoint.ts`（IP:port 校验+URL 构造）。RN 与 Node 都有全局 `WebSocket`/`ArrayBuffer`/`BigInt`/`DataView.setBigUint64`。设备相机走 WebView；**环回 E2E（`mobile/e2e/loopback.ts`）用同一份纯 TS 传输在 Node 连本地真引擎**，断言 `/status.uplink` 出现且非 stale——无真机的可验证闭环。
- **诚实验证分工**：编码器 byte 正确性 = jest 金样（逐字节等于 `struct.pack("<HBBQQ", …)`）；引擎接受真实 JPEG 帧 = 既有 `capture-e2e.mjs`；WS 连通/uplink/RTT/退避对真引擎 = Node 环回 E2E；**只有** RN 粘合（WebView 相机取帧、原生 UI、持久化、AppState、iOS WKWebView getUserMedia 安全上下文）需真机。

**Tech Stack:** Expo SDK（`create-expo-app` blank-typescript 当前稳定版）；`react-native-webview`；`@react-native-async-storage/async-storage`；`expo-camera`（仅申请相机权限，非取帧）；jest + `jest-expo`；TypeScript。引擎侧零改动。

**执行前提：** Worktree `.worktrees/v2-m4`，分支 `feature/v2-m4-expo-app`，基于 master（≥ M3b 合并后 fbd253c）。新目录 `mobile/` 为独立 Expo 工程（自带 node_modules）。M0 venv 起引擎做环回。引擎既有测试为回归网（本里程碑不改引擎，应全绿）。

**权威字节契约（不可偏离）：** 20 字节定长头 = `struct.pack("<HBBQQ", 0x4F4C, 1, channel, seq, ts_ms)` + JPEG payload。金样（channel=7, seq=0x0102030405060708, ts_ms=0x1112131415161718, payload=FF D8 AA）= hex `4c4f010708070605040302011817161514131211ffd8aa`。再生成命令：
```
cd engine && <m0-venv-python> -c "from service.protocol import FrameHeader, pack_frame; print(pack_frame(FrameHeader(seq=0x0102030405060708, ts_ms=0x1112131415161718, channel=7), b'\xff\xd8\xaa').hex())"
```
> 实现前先核对 `engine/service/protocol.py` 里 `pack_frame`/`FrameHeader` 的真实签名与字段序；若与上式不符，以 protocol.py 为准并同步更新金样。

---

### Task 0: Worktree 与分支
```
git -C C:/Users/76475/Documents/OneLive worktree add .worktrees/v2-m4 -b feature/v2-m4-expo-app master
```
后续路径相对该 worktree 根。Commit: 无。

### Task 1: 脚手架 Expo 工程（`mobile/`）
在 worktree 根：`npx create-expo-app@latest mobile -t blank-typescript`，然后 `cd mobile && npx expo install react-native-webview @react-native-async-storage/async-storage expo-camera && npm i -D jest-expo jest @types/jest`。
- `package.json` scripts：`start`=`expo start`，`test`=`jest`，`typecheck`=`tsc --noEmit`；jest preset=`jest-expo`，testMatch `**/*.test.ts(x)`。
- `app.json`：name=OneLive，ios.bundleIdentifier=`com.onelive.capture`，infoPlist.NSCameraUsageDescription（WKWebView getUserMedia 需要），plugins=[expo-camera]。
- 验证：`npm run typecheck` + `npm test -- --passWithNoTests`。
- 若 `create-expo-app` 因网络失败：报告 BLOCKED（记录 verbatim 网络错误），不要伪造脚手架。
Commit: `chore(m4): scaffold expo app in mobile/`

### Task 2 (TDD 锚点): 20 字节协议编码器 + 金样单测
`mobile/src/protocol/frame.test.ts`（先写）断言：常量 `HEADER_LEN=20/MAGIC=0x4f4c/VERSION=1`；`encodeFrame(7, 0x0102030405060708n, 0x1112131415161718n, [FF,D8,AA])` 的 hex === 上方金样；channel 掩码到 u8、header 小端；接受 number 型 seq/ts（capture.html 用 `Date.now()`）。
`mobile/src/protocol/frame.ts`：`encodeFrame(channel, seq:number|bigint, tsMs:number|bigint, payload:Uint8Array): Uint8Array` — `DataView` setUint16(0,MAGIC,true)/setUint8(2,VERSION)/setUint8(3,channel&0xff)/setBigUint64(4,BigInt(seq),true)/setBigUint64(12,BigInt(tsMs),true)+payload。文件头注释指向 protocol.py 为唯一权威。
验证：`npm test -- frame`。Commit: `feat(m4): byte-exact 20-byte frame encoder with python golden test`

### Task 3 (TDD): 指数退避 `net/backoff.ts`
`backoffDelay(attempt, rng=Math.random, {baseMs=500,factor=2,capMs=8000})` = `round(rng()*min(cap, base*factor^attempt))`。测试：attempt0 rng1→500 / rng0→0 / rng0.5→250；1/2/3/4→1000/2000/4000/8000；5 与 50 都 clamp 8000（不溢出）。Commit: `feat(m4): reconnect backoff with full jitter`

### Task 4 (TDD): `net/uplinkStats.ts`（镜像 capture.html）
`buildUplinkStats({channel,sent,skipped,winBaseSent,winBaseSkipped,intervalS,lastRtt})` → `{frame:{type:"uplink_stats",channel,fps_sent:(sent-winBaseSent)/intervalS,skipped:skipped-winBaseSkipped,rtt_ms:lastRtt}, fpsSent, winBaseSent:sent, winBaseSkipped:skipped}`。测试：25/3 基线5/1 间隔2 → fps10 skip2；lastRtt null 透传、channel 保留。注意 channel 必须真 int（服务端对非 int/bool 会拒）。Commit: `feat(m4): uplink_stats builder mirroring capture.html`

### Task 5 (TDD): `net/endpoint.ts`
`parseEndpoint(host, port)` → `{host,port}`：IPv4 正则 + 每段 ≤255 校验，port 空→8900、否则 1-65535 整数，非法抛错（错误信息用正常模板字符串 `` `invalid IPv4 address: ${host}` ``，勿写 `${host!r}`）。`ingestUrl({host,port}, tls)` → `ws(s)://host:port/ingest`。测试覆盖合法/非法 IP/端口/URL 构造。Commit: `feat(m4): endpoint parsing and ws url builder`

### Task 6 (TDD): 参考传输 `net/uplinkClient.ts`
`UplinkClient(url, channel, deps)`，deps 注入 `wsFactory/now/setTimeout/clearTimeout/setInterval/clearInterval/rng/onState/onHud`。方法：`start/stop/hud()/markSkipped/sendFrame(jpeg)/reportStats()`。行为：`sendFrame` 在未连或 `bufferedAmount>1MB` 时 `skipped++` 跳帧、否则 `encodeFrame(channel, seq, Date.now(), jpeg)` 发 `ArrayBuffer` 并 seq++/sent++；`reportStats` 发 `{type:"ping",t:now()}` + uplink_stats 帧并推进窗口基线；onmessage 收 `{type:"pong",t}` → `lastRtt=now()-t`（WS 链路 RTT）；onclose 且 running 时 `backoffDelay(attempt++)` 后重连；`stop()` 摘 onclose 防重连。用假 WebSocket + 注入时钟单测：tick 发 ping+uplink_stats 且 fps 正确、pong 回显算 RTT、二进制帧带 20 字节头（u8[0]=0x4c、u8[3]=channel）。Commit: `feat(m4): reference uplink transport (rtt, stats, backoff reconnect)`

### Task 7: Node 环回 E2E `mobile/e2e/loopback.ts`（无真机可验证）
同一份纯 TS 传输 + Node `ws` 连本地真引擎（默认 `E2E_PORT=8930`），~10fps 发合法头+占位 JPEG（`FF D8 FF D9`）约 6s（跨 ≥2 上报窗口），停后 GET `/status` 断言 `uplink[0]` 存在、`stale===false`、`fps_sent>0`、`rtt_ms` 是 number；打印 JSON + exit 0/1，引擎不可达 exit 2 并提示启动命令。运行：终端1 `<m0-venv-python> -m service.run_local --port 8930`（engine/），终端2 `E2E_PORT=8930 npx tsx mobile/e2e/loopback.ts`（`ws`/`tsx` 走仓库根 node_modules；缺 `ws` 则 `npm i -D ws @types/ws`）。Commit: `feat(m4): node loopback e2e — transport hits real engine /status uplink`

### Task 8: 设置持久化 + 连接状态机 UI（原生外壳）
- `src/storage/settings.ts`：AsyncStorage `loadEndpoint()/saveEndpoint()`（key `onelive.endpoint`，默认 `{host:"",port:"8900"}`，坏 JSON 回默认）。
- `App.tsx`：两屏切换（endpoint 为 null → SettingsScreen；否则 LiveScreen）；`goLive()` = `parseEndpoint`（抛错交 Settings 显红）+ `saveEndpoint` + setEndpoint。深色底。
- `src/screens/SettingsScreen.tsx`：IP + 端口输入、大「开播」按钮、错误红字；扫码填 IP 标 TODO（诚实占位，非本里程碑）。
- `src/components/Hud.tsx`：诚实标签 `上行 {fps} fps · 链路RTT(ws) {rtt} ms` + 连接态色（idle/connecting/connected/error/closed）。
Commit: `feat(m4): settings persistence, go-live UI, honest HUD component`

### Task 9: WebView 相机上行（复用 capture.html）+ 生命周期
`cp engine/service/capture.html mobile/assets/capture-native.html`，仅改三处（其余逐字节保留以保 byte-exact）：
1. **host/scheme/channel/fps 来自注入**：读 `window.__ONELIVE`（原生用 `injectedJavaScriptBeforeContentLoaded` 注入 `{host:"ip:port",scheme:"ws",channel:0,fps:10,autostart:true}`）优先于 `location`；`connect()` 用 `${WS_SCHEME}://${WS_HOST}/ingest`。
2. **HUD 上桥**：`updateHud()`/`setStatus()` 末尾 `window.ReactNativeWebView?.postMessage(JSON.stringify({type:"hud",fps,rtt,running}))` / `{type:"state",ws}`。
3. **start/stop 由原生驱动**：`window.__start/__stop`，`cfg.autostart` 时 load 自触发。
- `src/webview/CaptureWebView.tsx`：隐藏 WebView（1x1 opacity0）承载该 html（metro asset，`metro.config.js` 加 `resolver.assetExts.push("html")`）；`Camera.requestCameraPermissionsAsync()` 触发系统授权；`allowsInlineMediaPlayback` + iOS `mediaCapturePermissionGrantType="grant"`；`AppState` 非 active 时 inject `__stop`、active 时 `__start`；onMessage 解析 hud/state 回调父屏。
- `src/screens/LiveScreen.tsx`：组合 CaptureWebView + Hud + 「停播」（onStop 回设置屏）。
`npm run typecheck` 通过。Commit: `feat(m4): webview camera uplink reusing capture.html + lifecycle`

### Task 10: Expo Go smoke + 交付文档（含 OWNER 侧载步骤）
- Expo Go 冒烟：`npx expo start`（扫码/模拟器 `i`）。可验证：设置输入/校验/持久化（杀进程重开仍在）、开播/停播导航、HUD 布局/状态、WebView 加载并连 WS。需真机：WKWebView getUserMedia 取真相机、iOS file:// 安全上下文+权限、AppState 真机行为。
- `mobile/README.md`：架构与偏离说明、本地开发命令、Safari 兜底（`http://<pc-ip>:8900/capture`）、**OWNER 步骤（勿自动化，需 Apple ID）**：`eas build -p ios --profile preview` 产 IPA → Sideloadly 侧载（免费证书 7 天，到期重签）。
- `mobile/eas.json`：preview profile，distribution internal，ios.simulator false。
- `docs/superpowers/m4-results.md`：取帧选型理由、可/不可无真机验证清单、环回 E2E 一次 PASS 证据（JSON）、backlog（vision-camera 原生取帧、WebRTC getStats、扫码填 IP、音频上行、iOS 安全上下文实测）。
Commit: `docs(m4): mobile readme, eas config, results and backlog`

### Task 11: 回归 + 收尾
`mobile`：`npm test && npm run typecheck`。引擎回归（未改，应全绿）：`<m0-venv-python> -m pytest -q`（engine/）。环回一次（另起引擎 --port 8930）。终审 → superpowers:finishing-a-development-branch 决定合并/PR。Commit: `chore(m4): regression pass and milestone wrap-up`

---

## Self-Review 记录
- **覆盖**：① 一键开播（设置 IP:port 持久化 + 大按钮 → WebView 连 /ingest ~10fps byte-exact 上行）；② 手机 HUD（fps_sent/链路RTT(ws)/连接态 + 每 2s uplink_stats，语义同 capture.html）；③ 重连/生命周期（uplinkClient 指数退避 + AppState 切后台停 + 状态机）；④ 兜底（capture.html 保留 + Safari 退路）。
- **偏离已记录**：WebRTC → WS+JPEG 复用（因果链论证在 Architecture）；WebRTC 与 vision-camera 原生取帧列 backlog。
- **无占位符**：编码器/退避/stats/endpoint/传输均真实代码 + 通过型测试；金样 = 真 Python pack_frame 输出（含再生成命令）。唯一显式 TODO 是扫码填 IP（诚实标注）。
- **可验证性分工**：无真机可验证 = 编码器金样（对 protocol.py）+ 退避/stats/endpoint（jest）+ 参考传输连真引擎 /status 非 stale uplink+RTT+fps（Node 环回）+ 引擎收真 JPEG（既有 capture-e2e）+ Expo Go 设置/持久化/导航/HUD/WebView 加载连 WS；必须真机 = WKWebView getUserMedia 取真相机 ~10fps、iOS 安全上下文+权限、AppState 真机、侧载后端到端。
- **诚实缺口 + 缓解**：设备热路径的 WS/编码/重连在 WebView（capture.html 派生），非 jest 直测——缓解：编码格式由金样 + capture-e2e 两侧对真 Python 消费方钉死；html 顶注释指向 protocol.py 防漂移；参考传输覆盖同款逻辑独立实现。真机 WebView getUserMedia 不稳的退路 = 引擎 `--https` 的 `/capture`（安全上下文有保证）或 Safari 直连，升级路 = vision-camera 原生取帧。
- **一致性**：uplink_stats/ping/pong/20 字节头全走既有 /ingest 契约，引擎零改；channel 保持真 int；RTT 全程标注 WS 链路 RTT。
