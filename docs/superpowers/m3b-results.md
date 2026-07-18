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

退出码 0；端口 8920 收尾后确认 FREE；启动器进程 taskkill 收割（退出码 1 = 被强杀，预期）。

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
