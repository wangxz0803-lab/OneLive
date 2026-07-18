# M3b Results

## Task 4：控制台 E2E（Playwright）

真 Playwright 驱真 chromium 打开 `/console`，逐项断言导播控制台在**活数据**下的
行为。数据源是确定性桩，但走的全是服务真实路径（真 EchoPipeline worker、真 /events
广播消费者 + tee、真 UplinkStore、真 StreamerManager.status() 形态）。

### 启动器（test-only，engine/tests/helpers/serve_console.py）

serve_echo.py 只喂视频帧、不带翻译/推流/uplink，console 的字幕流/casting/HUD 上行/
推流徽标无从断言。serve_console.py 补齐这些：

- **频道 0 真 EchoPipeline**：后台线程 ~15fps 喂灰度 JPEG，灰阶随 seq 变化
  （`30 + (seq%8)*25`）→ 预览 canvas 逐帧像素不同，可断言帧在推进。
  `EchoPipeline.set_source` 是 recorder（存路径、不抛）→ casting 走 /ingest →
  `worker.post_command` → `casting_ack ok=true` 全链路真实。
- **假翻译管线**（鸭子对齐真 TranslationPipeline 的 start/events/feed_audio/close/stats）：
  `events()` 循环发 `subtitle → translation(status=ok, "EN: …" 桩自证) → tts_ready`
  （lang=en → 频道 0，真 tee 进 SpeechSchedule + /speech 广播 + 混音器 splice）。
  **直接注入事件，不喂 /audio** —— 确定性、不依赖 whisper/edge-tts（比走音频链简单且可复现）。
  tts_ready 携带真 TTSResult（1s 静音 pcm + 25 帧平嘴曲线，SpeechClip 一致性校验通过）。
- **假 uplink**：feeder 线程每 ~1.5s `uplink.record(0, {rtt_ms:8, …}, monotonic())`，
  /status age 恒 < stale 阈值(5s) → HUD 链路RTT(ws) 显示 `8ms`、`FRESH`、不置灰。
- **假 streamer**：`status()` 报频道 0 `running=true` → 徽标"推流中"（badge stream live）。
  start_all/stop_all 为 async no-op（不真起 ffmpeg）。
- casting 底图目录默认指 M0 资产（`ONELIVE_AVATAR_DIR` 可覆盖）——`/avatars` 枚举与
  `set_source` 的 is_file 校验都需真 jpg。

驱动脚本（engine/e2e/console_e2e.mjs）自 spawn 启动器于端口 8920、等 /status 就绪、
驱 chromium @1440x900、断言、必杀（`taskkill /F /T` 整树）、还端口。Node 从 repo 内跑
即命中主 checkout node_modules（同 capture-e2e.mjs）。产物落 engine/out/console_e2e/。

### 断言输出（本轮实测，逐字）

```
[assert] PASS — 1. 频道0预览 canvas 帧推进（非黑且逐帧变化） :: size=320x240 px1=130,130,130 px2=180,180,180
[assert] PASS — 2. 字幕面板含发出的真实字幕串 :: probe="OneLive-E2E-字幕探针" present=true
[assert] PASS — 3. casting 选底图→切换→ack ok=true :: source=s0.jpg ack="✓ s0.jpg · 0.4ms" cls="ack ok"
[assert] PASS — 4. HUD 链路RTT(ws) 有值且未 stale/置灰 :: rtt="8ms" stale=false badge=FRESH dim=false
[assert] PASS — 5. 推流徽标 running（假 streams → 推流中） :: badge="推流中" cls="badge stream live"
[e2e] PASS — 5/5 assertions
```

退出码 0；启动器进程 taskkill /F /T 收割整棵进程树（退出码 1 = 被强杀，预期），端口 8920 随进程树终止归还（脚本未额外主动复探端口）。

**断言 5 选型**：走"假 streams 块 → running 徽标"分支（非"无 streams → 推流未启用"），
正向验证徽标 live 态 + HUD Streaming 组 running=yes 渲染。

### 最终截图描述（console_full.png，本人目检）

暗色导播机房布局，1440x900。顶栏 `ONELIVE OPERATOR CONSOLE`，中央绿 LED +
`ENGINE OK` + `Uptime 00:00:05`，右上 Edge(灰置)/Local 段选。
主区三张频道卡：
- **CH 0**（配置）：EN 语言徽标 + 绿色"推流中"徽标 + 琥珀 ON AIR tally；预览屏显示
  灰度驱动帧（EchoPipeline 回吐，上下黑边居中灰块）；语音行 `seg 2 (en) · played 2 · queue 0`；
  底图下拉选中 `s0.jpg`、"切换"按钮，其下绿色 ack `✓ s0.jpg · 0.4ms`。
- **CH —** ×2（未配置槽）：斜纹占位 + "未配置 / 该市场频道未启用"，诚实留位。

底部 Subtitle Stream 面板：多行事件，含 `原文 OneLive-E2E-字幕探针 seg2`、
`译 EN: OneLive E2E probe seg2`、`TTS ♪ en · en-US-JennyNeural · 1.0s`——真实事件链逐段渲染。

右侧 Telemetry HUD：频道 0 块 `FRESH` 徽标；Uplink 组 `fps 14.7 / skip 3 / 链路RTT(ws) 8ms /
age 1.2s`；Engine 组 `processed 84 / errors 0 / spk played 2`；Streaming 组 `running yes /
restarts 0`。其下两个未配置占位块（斜纹灰置）。

### 回归

- Python 套件：`171 passed`（M0 venv，engine/tests）——启动器是 `serve_console.py`
  非 `test_*.py`，pytest 不收集，套件数不变。
- serve_console.py 已提交（clean）；不改任何既有测试。

---

## 全量回归（Task 5，本轮实测，逐字）

四项全部在本 worktree（`feature/v2-m3b-console`，HEAD `e69ffb8`）本轮真实执行，命令输出逐字留档。

### 1. Python 套件（M0 venv，`engine/`，`PYTHONPATH=.`）

`pytest -q` 尾部逐字：

```
........................................................................ [ 42%]
........................................................................ [ 84%]
...........................                                              [100%]
============================== warnings summary ===============================
..\..\v2-m0-spike\engine\.venv\Lib\site-packages\fastapi\testclient.py:1
  ...: StarletteDeprecationWarning: Using `httpx` with `starlette.testclient` is deprecated; install `httpx2` instead.
    from starlette.testclient import TestClient as TestClient  # noqa

171 passed, 1 warning in 34.63s
```

`171 passed` = 基线不变（M3b 新增 console_api/uplink 测试已含在内；serve_console.py 是 `helpers/` 非 `test_*.py`，pytest 不收集）。唯一 warning 是 M0 venv 里 starlette/httpx 版本弃用告警，与本里程碑无关、历史里程碑同款。

### 2. Node 控制台 E2E（`node engine/e2e/console_e2e.mjs`，自起启动器）

断言逐字（本轮实测，退出码 0）：

```
[e2e] spawning launcher: ...\v2-m0-spike\engine\.venv\Scripts\python.exe tests/helpers/serve_console.py --port 8920
[e2e] launcher serving; launching chromium @1440x900
[assert] PASS — 1. 频道0预览 canvas 帧推进（非黑且逐帧变化） :: size=320x240 px1=130,130,130 px2=180,180,180
[assert] PASS — 2. 字幕面板含发出的真实字幕串 :: probe="OneLive-E2E-字幕探针" present=true
[assert] PASS — 3. casting 选底图→切换→ack ok=true :: source=s0.jpg ack="✓ s0.jpg · 0.3ms" cls="ack ok"
[assert] PASS — 4. HUD 链路RTT(ws) 有值且未 stale/置灰 :: rtt="8ms" stale=false badge=FRESH dim=false
[assert] PASS — 5. 推流徽标 running（假 streams → 推流中） :: badge="推流中" cls="badge stream live"
[e2e] screenshots → ...\v2-m3b\engine\out\console_e2e
[e2e] PASS — 5/5 assertions
[e2e] launcher exited code=1
```

`5/5 assertions`、`CAPTURE_EXIT=0`（脚本退出码 0）；启动器 `code=1` = 被 `taskkill /F /T` 强杀，预期（Task 4 同款）。

### 3. Node 采集全链路 E2E（`node engine/e2e/capture-e2e.mjs`，M1c 浏览器回归）

**本轮真实运行（未 SKIP）。** M3a 曾以「viewer/采集页零改动」SKIP 此项；M3b **Task 2 实际改了 `capture.html`**（`git diff master..HEAD -- engine/service/capture.html` = +54 行：上行 HUD + ping/pong RTT + `uplink_stats` 周期上报），采集→pipeline→viewer 链路有真实执行面变化，故本轮如实跑通。

运行前置本环境需自备（脚本不自起服务/不自造 fixture）：

- **y4m 假摄像头 fixture**：本 worktree `engine/out/` 无 `d14.y4m`（gitignore，201MB）。本轮用 winget ffmpeg 从 M0 的 `d14.mp4` 重新生成（同 m1c 记录的命令）：`ffmpeg -y -i <M0>/FasterLivePortrait/assets/examples/driving/d14.mp4 -pix_fmt yuv420p -t 18 engine/out/d14.y4m` → `frame=536 ... Lsize=205827KiB`，产物 **210,767,052 字节**（与 m1c-results.md 记录逐字一致）。
- **真 engine 服务**：本 worktree M0 venv python 起 `service.run_local --port 8910`（真 LivePortrait，模型加载 ~14s，Arc/DML），就绪后 `/status` 200。

断言逐字（脚本尾部 summary，退出码 0）：

```
  "checks": {
    "status.errors == 0": true,
    "status.processed > 0": true,
    "viewer frames progressed (last > first)": true
  },
  "result": "PASS"
[e2e] PASS — processed=103, errors=0, viewer frames 16 -> 103
```

**M3b 相关的额外收获**：本轮 summary 里 `/status.uplink` 块由**真 capture.html 上报驱动**（非 console_e2e 的桩 feeder），逐字：

```
"uplink": { "0": { "fps_sent": 10, "skipped": 0, "rtt_ms": 2.0999999940395355,
                   "age_s": 0.344, "stale": false } }
```

即 Task 2 新增的采集端上报（每 2s 一窗 `fps_sent`/`skipped` + ping/pong 测得的 `链路RTT(ws)`）在真浏览器假摄像头链路里端到端跑通、`/status` 汇总正确（`stale=false`、`rtt_ms` 是 loopback 传输层往返 ~2ms，符合「链路RTT(ws)」定性），且**没有破坏**采集→pipeline→viewer 主路径（`processed=103 errors=0`、viewer 帧 16→103 递增）。运行完杀服务、8910 归还。

> 运行约束注记（如实）：capture-e2e 本身**不自起服务、不自造 y4m**（需 8910 已监听 + y4m 已生成，缺则退出码 2）；本环境这两项均可满足（winget ffmpeg 可解析、M0 d14.mp4 在位、真服务可起），故本轮完整跑通。若换到无 ffmpeg / 无 M0 资产 / 无显示的 CI，缺件即退 2，届时应记为已知运行约束而非失败。

### 4. rtmp-sink 依赖/锁文件完整性（`engine/rtmp-sink`）

未起真流（重，M3a Task 4 已全链验证过），本轮只校验依赖可复现安装：

```
$ npm ci --dry-run
...
added 83 packages in 818ms
19 packages are looking for funding
```

退出码 0，`node_modules/node-media-server` 锁定 `"version": "2.7.4"`（package-lock.json）——锁文件完整、可干净安装（node_modules 本身 gitignore，M3b 未触碰 rtmp-sink 任何文件，`git diff master..HEAD -- engine/rtmp-sink` 为空）。

---

## OWNER 项（滚动，承接 m3a-results.md「OWNER 项（滚动）」）

M3a 遗留、M3b 未消解，逐项沿用（本里程碑纯 console/docs，未触及推流/真机/翻译真链）：

- **AutoDL 边缘 GPU（M1b 前置）**：console 的 Edge⇄Local 段选目前 Edge 灰置占位，待 M1b 边缘节点落地后接线；边缘 GPU 资源（AutoDL 等）归 OWNER 备。
- **公开平台推流**：`--rtmp` 换平台推流地址+串流码（YouTube/B站/Twitch 账号+key 归 OWNER）；注意脱敏边界（整 URL 已脱敏、截断行未覆盖；run_local 启动 banner 含未脱敏 URL 勿外传）、采样率（当前 16k，平台推荐 44.1k/48k）、rtmps 入口三点（详见 m3a-results.md）。
- **clumsy 真实损伤验证**：netlab 脚本/文档/DryRun 已备（M3a Task 5），需 OWNER 在**管理员 PowerShell** 跑 `engine/netlab/profiles.ps1` 做 latency 档前后对比 + demo 三档目检（本会话无法提权、不弹 UAC）。
- **AI_API_KEY / AI_API_URL / AI_MODEL**：真翻译 Provider 配 key 后用 `--translate` 复跑（stub 只证链路机制）。
- **真机验收**：手机浏览器打开 viewer（HTTPS）点「开启声音」，确认音频播放 + speaking 状态行 + 嘴型动；录屏留档。
- **idle 语义视觉验收**：目检 `idle_semantic_lip_on.png` vs `idle_semantic_lip_off_m1a.png`，不可接受则演示用 `--no-lip`。
- **A/V 同步观感验收**：机制契约见 app.py docstring、数值见 rtmp E2E；最终「看起来对不对」需 OWNER 拉流目检（VLC/potplayer 开 `http://127.0.0.1:8000/live/ch0.flv`）。

---

## Backlog（滚动）

M2b/M3a 未闭合项**整体沿用 m3a-results.md 的「Backlog（滚动终稿）」+「OWNER 项」**
（app.py 拆分已在 M3b Task 1 落地，其余 SegmentTranscriber 无界累积、TTS 流式首块、
/events 满队丢最旧、丢弃上限三处统一、推流采样率/脱敏截断行、D14 外部依赖、N 频道
libx264 CPU 上限 等逐项仍开放）。M3b Task 4 新增/相关：

- **console_e2e.mjs 依赖 M0 venv 的绝对路径**（`E2E_PY` 可覆盖，默认硬编码 v2-m0-spike
  worktree 下 python.exe）——同 lip_e2e/rtmp_e2e 的 D14 外部依赖族，worktree 清理即断；
  长期与那些脚本一并收敛（环境探测或统一入口）。
- **casting 底图目录同为外部 M0 资产依赖**（`ONELIVE_AVATAR_DIR` 默认指 M0 source 目录）——
  与 `_avatar_dir()` 生产默认同源；入库小体积示例底图可同时解此项 + D14 项。
- console_e2e 断言"帧推进"用固定中心像素两次采样比对（灰阶随 seq 变必然不同）——
  够证 /out→canvas 活着；若未来预览接真 LivePortrait 输出，改采样点/多点即可，无需改结构。
- **/events 满队丢最旧对 console 的影响**（承接 m3a backlog 同项）：console 字幕流是 200 行
  环形，快照/重放缺失时刷新页面丢历史；本 E2E 只验证实时到达，可靠展示（补偿/重放）仍开放。

M3b Task 4 评审指出的两处诚实 E2E 缺口（本里程碑未补，如实记）：

- **casting「预览可见变化」子句未断言**：Task 4 断言 3 只验证 casting 换角 `ack ok=true`（控制链路
  全通），但未断言「换底图后预览画面确实变了」——启动器用 `EchoPipeline`（回吐输入帧、`set_source`
  是 recorder 只存路径不真换底图），预览像素不随 casting 变，无从断言可见变化。真 LivePortrait 接入
  console E2E 后可补此断言（换 source → 预览底图随之变）。
- **「推流未启用」占位徽标分支未断言**：Task 4 断言 5 走的是「假 streams 块 → running 徽标」正向分支；
  「无 streams 块 → 推流未启用」占位分支（run_local 未带 `--rtmp` 时）未被覆盖。补法简单：启动器加一档
  不喂 streams 的变体，断言徽标落「推流未启用」态即可，留待后续。
