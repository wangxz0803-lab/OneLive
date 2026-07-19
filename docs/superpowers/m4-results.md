# M4 Results — Expo 原生手机采集 App

里程碑 M4 交付一个 Expo（React Native，managed workflow）原生 iPhone App：一次性设置
PC 局域网 `IP:端口`（默认 8900，持久化）→ 大按钮开播 → 手机摄像头以**与
`engine/service/protocol.py` 逐字节一致的 20 字节协议**、约 10fps 通过
`ws://<pc-ip>:8900/ingest` 上行 JPEG；手机端诚实 HUD（fps_sent / 链路RTT(ws) / 连接态），
每 2s 上报 `uplink_stats`；断线指数退避重连、切后台自动停。引擎侧**零改动**。

---

## 取帧选型（关键决策）

热路径采用 **(c) 隐藏 WebView 复用 `capture.html`**（拷贝为
`mobile/assets/capture-native.html`，仅改 3 处：host/scheme/channel/fps 来自原生注入、
HUD 经 `postMessage` 上桥、start/stop 由原生 `injectJavaScript` 驱动，其余逐字节保留）。

理由：
- **最大化复用已验证的 byte-exact 管线**：`capture.html` 的 `/ingest` + 20 字节头 +
  `uplink_stats` + ping/pong RTT 已被 `engine/e2e/capture-e2e.mjs` 端到端证明，约 10fps
  实测可达。
- **Expo Go 兼容**：`react-native-webview` 随 Expo Go 提供，无需 dev build 即可冒烟。
- **无真机可见进展**：编码/传输逻辑另有一份纯 TS 独立实现（`src/protocol/`、`src/net/`），
  可 jest 单测、可用 Node 环回连真引擎验证。

被否选项（记为 backlog）：
- `expo-camera` 的 `takePictureAsync` 循环 —— 达不到 10fps。
- `react-native-vision-camera` frame processor —— 性能最好，但需 dev build（Mac/EAS）
  且无真机不可测。

### 刻意偏离 spec §4.1

spec 原选 WebRTC（`react-native-webrtc` + `getStats()`）。M4 改为复用现有 WS+JPEG 上行。
诚实标注的代价：**RTT 是 WS 链路 RTT（ping/pong），不是蜂窝上行 RTT**；上行损伤用应用层
跳帧计数（`skipped`）而非 WebRTC `getStats()` 的真实 UDP 码率/抖动/丢包。「网差→上行帧掉
→数字人动作差」的因果链在 WS+JPEG 下依然成立（出口拥塞跳帧 + skipped 即损伤可观测出口）。

---

## 验证分工（诚实清单）

### 无真机即可验证（本里程碑已做）

- **编码器 byte 正确性** = jest 金样：`encodeFrame` 逐字节等于 Python
  `struct.pack("<HBBQQ", 0x4F4C, 1, channel, seq, ts_ms)` + payload（金样 hex
  `4c4f010708070605040302011817161514131211ffd8aa`，含再生成命令）。
- **指数退避 / uplink_stats / endpoint 校验** = jest（注入时钟/rng 的确定性单测）。
- **参考传输连真引擎** = Node 环回 E2E（`mobile/e2e/loopback.ts`）：同一份纯 TS 传输在
  Node 连本地真引擎，断言 `/status.uplink[0]` 出现、`stale===false`、`fps_sent>0`、
  `rtt_ms` 是数值。见下方证据。
- **引擎接受真实 JPEG 帧** = 既有 `engine/e2e/capture-e2e.mjs`（未改，回归网内）。
- **Expo Go 冒烟**（可验证项）：设置输入/校验/持久化（杀进程重开仍在）、开播/停播导航、
  HUD 布局/状态、WebView 加载并连 WS。

### 必须真机（本里程碑**未做**，诚实缺口）

- WKWebView `getUserMedia` 取真相机 ~10fps。
- iOS `file://` / 非 localhost http 安全上下文 + 相机权限系统弹窗真机行为。
- `AppState` 切后台自动停 / 回前台恢复的真机行为。
- Sideloadly 侧载后的端到端（见 `mobile/README.md` 的 OWNER 步骤）。

---

## 环回 E2E 证据（Node 传输 → 真引擎 /status uplink）

引擎 `-m service.run_local --port 8930` 起，`E2E_PORT=8930 npx tsx mobile/e2e/loopback.ts`
从 worktree 根运行，约 6.5s 发合法头 + 占位 JPEG（`FF D8 FF D9`）跨 ≥2 上报窗口，停后拉
`/status`。逐字输出：

```json
{
  "base": "http://127.0.0.1:8930",
  "ws_url": "ws://127.0.0.1:8930/ingest",
  "channel": 0,
  "duration_ms": 6500,
  "client_hud": {
    "fpsSent": 9.5,
    "rttMs": 1.157600000000457,
    "state": "connected"
  },
  "uplink": {
    "fps_sent": 9.5,
    "skipped": 0,
    "rtt_ms": 1.070400000000518,
    "age_s": 0.797,
    "stale": false
  },
  "checks": {
    "uplink[0] present": true,
    "stale === false": true,
    "fps_sent > 0": true,
    "rtt_ms is a number": true
  },
  "result": "PASS"
}
[e2e] PASS — fps_sent=9.5, rtt_ms=1.070400000000518, stale=false
```

`fps_sent=9.5`（约 10fps 的窗口测量）、`rtt_ms` 为真实 WS 链路 RTT（约 1ms 本机环回）、
`stale===false`（帧确实打进引擎且被 UplinkStore 记录）、`result: PASS`（exit 0）。

---

## 全量回归

Task 11 逐字实测（本轮），四项全绿。

### 1. `cd mobile && npm test` → 33 passed

```
> mobile@1.0.0 test
> jest

PASS src/net/endpoint.test.ts
PASS src/net/uplinkStats.test.ts
PASS src/storage/settings.test.ts
PASS src/protocol/frame.test.ts
PASS src/net/backoff.test.ts
PASS src/net/uplinkClient.test.ts

Test Suites: 6 passed, 6 total
Tests:       33 passed, 33 total
Snapshots:   0 total
Time:        2.601 s
Ran all test suites.
```

### 2. `cd mobile && npm run typecheck` → exit 0

```
> mobile@1.0.0 typecheck
> tsc --noEmit

EXIT:0
```

### 3. 引擎回归（未改，全绿）→ 171 passed

`cd engine` 后
`PYTHONPATH=. <m0-venv-python> -m pytest -q`（模型加载慢，约 2 分钟）。tail 逐字：

```
........................................................................ [ 42%]
........................................................................ [ 84%]
...........................                                              [100%]
============================== warnings summary ===============================
..\..\v2-m0-spike\engine\.venv\Lib\site-packages\fastapi\testclient.py:1
  C:\Users\76475\Documents\OneLive\.worktrees\v2-m0-spike\engine\.venv\Lib\site-packages\fastapi\testclient.py:1: StarletteDeprecationWarning: Using `httpx` with `starlette.testclient` is deprecated; install `httpx2` instead.
    from starlette.testclient import TestClient as TestClient  # noqa

tests/test_asr.py::test_two_sentences_two_segments
  ...UserWarning: `huggingface_hub` cache-system uses symlinks by default ... (Windows symlink 警告，无害)

-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
171 passed, 2 warnings in 136.55s (0:02:16)
```

（2 条 warning 均为环境无害提示：Starlette/httpx 弃用 + Windows 符号链接缓存降级。）

### 4. Node 环回 E2E（另起真引擎 --port 8930）→ PASS / exit 0

见上方「环回 E2E 证据」的逐字 JSON。本轮 `EXIT:0`，引擎随后已停（`/status` 返回 000）。

---

## Backlog（未来升级项）

- **vision-camera 原生取帧**：`react-native-vision-camera` frame processor 替代 WebView
  取帧，最高性能，但需 dev build（Mac/EAS）+ 真机验证。
- **WebRTC 真实上行指标**：`react-native-webrtc` + `getStats()` 拿真实 UDP 上行码率/抖动/
  丢包，替代当前应用层 `skipped` 跳帧计数；RTT 变蜂窝上行 RTT 而非 WS 链路 RTT。
- **扫码填 IP**：当前 SettingsScreen 有诚实 TODO 占位；接扫码自动填 `IP:port`。
- **音频上行复用**：当前只上行视频帧；复用同管线上行音频。
- **iOS 安全上下文真机实测**：WKWebView `getUserMedia` 在 iOS 的安全上下文/权限行为需真机
  确认；退路为引擎 `--https` 的 `/capture` 或 Safari 直连。

## OWNER 滚动项（跨里程碑，指向 `project_onelive_v2` scope）

沿用 V2 全局 OWNER 待办（需本人凭据 / 硬件，agent 不代做）：**AutoDL 边缘 GPU**、
**平台 RTMP 推流出口**、**平台 API key**、**真 iPhone / 真人真机验收**。详见 memory
`project_onelive_v2` 里程碑 scope。M4 新增 OWNER 项：`eas build -p ios --profile preview`
出 IPA + Sideloadly 侧载（需你的 Apple ID，免费证书 7 天有效，到期重签）——步骤见
`mobile/README.md`。
