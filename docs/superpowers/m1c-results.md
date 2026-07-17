# M1c 实测结果：浏览器采集桥 + Playwright 假摄像头全链路 E2E

日期：2026-07-17　|　分支：`feature/v2-m1c-capture-bridge`　|　机器：本地 Arc（DML split 管线，pasteback 关闭）

## 全链路 E2E（Task 6）

**拓扑**（四方，全部真实组件，无 mock）：

```
chromium 假摄像头 (d14.y4m，真人脸驱动视频)
  → page A /capture?fps=10   （getUserMedia → canvas ≤640 → JPEG → ws /ingest，20 字节协议头）
  → engine 服务 :8910         （python -m service.run_local --port 8910，真实 LivePortrait，source=s10.jpg）
  → page B /?channel=0        （viewer，ws /out → createImageBitmap → canvas，帧计数）
  → tools.out_probe           （并行第三订阅者，--count 60 --latency-from-header --channel 0）
```

- 驱动源：`ffmpeg -i d14.mp4 -pix_fmt yuv420p -t 18 engine/out/d14.y4m`（536 帧 / 17.86s / 30fps，**210,767,052 字节 ≈ 201MB**，位于 gitignore 的 `engine/out/`，保留以便复跑；重新生成仅需上述一条命令）。chromium 对 y4m 假设备自动循环播放，60s 运行覆盖 ≈3.3 遍。
- 浏览器：Playwright 1.61.1 chromium（headless），flags：`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-video-capture=<d14.y4m>`。假摄像头 headless 下工作正常。
- **Node/Playwright 解析方案（记录备查）**：本 worktree 无 node_modules，但 worktree 目录位于主 checkout 内（`OneLive\.worktrees\v2-m1c`），Node ESM 从脚本目录逐级向上找 node_modules 天然命中 `OneLive\node_modules`（含 @playwright/test 与已装好的 chromium-1228）。因此 `node engine/e2e/capture-e2e.mjs` 直接可跑，无需 NODE_PATH / npm install。脚本：`engine/e2e/capture-e2e.mjs`（入库）。
- **脚本已自断言（Task 7 补强，本次实测时尚无）**：结束时拉 `GET /status` 自判 `errors==0 && processed>0` 且 viewer 帧数递增（首采样 < 末采样），打印 PASS/FAIL；FAIL 退出码 1，前置不满足（y4m 缺失 / 服务不可达，起浏览器前有可达性预检）退出码 2。复跑无需人工读日志判结果。
- **后台标签页节流（有意为之）**：标签页被隐藏时浏览器把定时器节流到 ~1 次/s，capture 页发帧率随之降到 ~1fps 但帧持续流动、链路不断；回前台后 visibilitychange 重置节拍基线（t0/n），恢复目标 fps 且无追赶突发（commit ad4ebe1）。headless E2E 双页面均"可见"，不触发此路径。

### out_probe 输出（原文）

```
[probe] received 60 frames in 36.22s (first->last arrival) -> arrival fps = 1.63
[probe] jpeg bytes: avg=36550 min=33130 max=39435
[probe] received seqs: [0, 10, 16, 22, 29, 35, 41, 48, 54, 60, 66, 72, 77, 83, 90, 96, 102, 108, 114, 120, 126, 132, 138, 144, 150, 156, 163, 169, 175, 181, 186, 192, 198, 204, 210, 216, 222, 228, 234, 240, 246, 252, 259, 265, 271, 278, 284, 290, 297, 303, 309, 316, 322, 329, 335, 342, 348, 354, 360, 366]
[probe] e2e latency (header ts_ms -> probe recv, 60 frames): mean=678ms median=674ms min=598ms max=1041ms
[probe] saved out\e2e_m1c\probe_seq0.png shape=(512, 512, 3)
[probe] saved out\e2e_m1c\probe_seq186.png shape=(512, 512, 3)
[probe] saved out\e2e_m1c\probe_seq366.png shape=(512, 512, 3)
[probe] all 60 jpegs decode ok
```

### 双页面每 10s 采样（原文，page.evaluate 读 DOM 计数器）

```
[e2e] started capture at 2026-07-17T07:15:36.102Z, sampling every 10s for 60s
[e2e 10s] A: capturing | sent: 99 | skipped: 1 | target: 10fps | seq: 99 (512x512) | B: frames: 15 | seq: 90 | fps (last 10): 1.40 (connected)
[e2e 20s] A: capturing | sent: 199 | skipped: 1 | target: 10fps | seq: 199 (512x512) | B: frames: 31 | seq: 186 | fps (last 10): 1.66 (connected)
[e2e 30s] A: capturing | sent: 299 | skipped: 1 | target: 10fps | seq: 299 (512x512) | B: frames: 48 | seq: 290 | fps (last 10): 1.67 (connected)
[e2e 40s] A: capturing | sent: 399 | skipped: 1 | target: 10fps | seq: 399 (512x512) | B: frames: 64 | seq: 391 | fps (last 10): 1.60 (connected)
[e2e 50s] A: capturing | sent: 499 | skipped: 1 | target: 10fps | seq: 499 (512x512) | B: frames: 80 | seq: 491 | fps (last 10): 1.59 (connected)
[e2e 60s] A: capturing | sent: 599 | skipped: 1 | target: 10fps | seq: 599 (512x512) | B: frames: 96 | seq: 591 | fps (last 10): 1.60 (connected)
```

### 运行结束后的 GET /status（原文）

```
{"engine":"ok","channels":{"0":{"processed":98,"dropped":503,"skipped":0,"errors":0,"last_infer_ms":644.4448999973247}},"channel":{"processed":98,"dropped":503,"skipped":0,"errors":0,"last_infer_ms":644.4448999973247}}
```

（服务本次启动到 /status 就绪 ≈2s——ORT/DML 图缓存已热；冷启动仍按 15-20s 预期，见滚动待办「启动成本」。）

### 结果解读

| 指标 | 实测 | 预期 | 结论 |
|---|---|---|---|
| /out 到达 fps | **1.63** | ~1.9（M1a 实测 1.92） | 符合但略低：本次 last_infer_ms 612-644ms（M1a 为 ~534ms），1/0.63≈1.6，吞吐仍=推理速度。差异来源：同机并行跑着 chromium（双页面渲染+JPEG 编码）+ 三订阅者扇出，GPU/CPU 有争抢 |
| E2E 延迟（**真实头内 ts_ms**） | **mean 678ms / median 674ms / min 598 / max 1041** | M1a 旁路 CSV 测法 585/566ms | 首次由 `--latency-from-header` 直接测得：浏览器 `Date.now()` 写入帧头 → 探针 `recv`，同机时钟直接相减有效。678 ≈ 本次单帧推理 ~630ms + ~50ms（上行WS+排队+编码+扇出+下行WS），与 M1a 的"≈1 帧推理时间+少量排队"结论一致；比 M1a 高的 ~90ms 主要是本次推理本身更慢 |
| processed / dropped / skipped / errors | **98 / 503 / 0 / 0** | processed>0 硬性要求 | ✅ 98+503=601 帧全部核算清（60s 采样时 sent=599，截图窗口又发了 2 帧）。**skipped=0：d14 全程有人脸，601 帧无一因检测失败被跳**；dropped=503（83.7%）是 latest-wins 设计行为（10fps 输入 vs ~1.6fps 推理）。errors=0 |
| 采集页计数 | sent=599 @60s，skipped=1 | 10fps×60s=600 拍 | 599+1=600 拍全核算：绝对时钟定拍无漂移；skipped 的 1 拍是 Start 后 ws 尚在 connecting 的首拍 |
| viewer 帧计数 | 15→31→48→64→80→96 单调递增，fps 稳定 ~1.6 | 持续进帧 | ✅ 浏览器 viewer 全程活跃；seq 591 vs 采集端 seq 599 ≈ 0.8s 差 ≈ 管线在途量，与延迟实测吻合 |
| 帧完整性 | 60/60 JPEG 解码 ok，512×512，avg 36.5KB | — | 协议头+payload 经 浏览器→服务→双订阅者 全程无损 |

### 帧证据（目检，均在 gitignore 的 `engine/out/e2e_m1c/`）

- `probe_seq0.png`（首帧）：源像 s10（蓝头巾珍珠耳环少女）干净渲染，嘴闭合、神态平静，无色偏无花屏。
- `probe_seq366.png`（第 60 帧）：同一源像但**嘴张开、双眼睁大**——表情/姿态明显随 d14 驱动帧变化，动作复刻链路经浏览器采集路径依然有效。
- `pageA_capture.png`（采集页截图）：假摄像头画面为 d14 真人脸（截图瞬间恰为眨眼闭目帧），本地预览正常，状态行 `capturing | sent: 599 | skipped: 1`。
- `pageB_viewer.png`（viewer 截图）：数字人渲染帧上屏，眼帘低垂与驱动帧眨眼状态对应，状态行 `frames: 96 | seq: 591 | fps (last 10): 1.60`。

### 测试回归

```
26 passed, 1 warning in 1.57s
```

## 加固项逐条验证（M1c Task 1-5 回看）

| # | 加固项 | 验证证据 |
|---|---|---|
| 1 | **ts_ms 透传**（Subscriber 带 ts，/out 帧头回填驱动帧原始 ts_ms） | 本 E2E：`out_probe --latency-from-header` 直接测得 mean 678ms（不再依赖旁路 CSV）；单测 `test_frame_roundtrip`、`test_seq_and_ts_ranges` |
| 2 | **JPEG 解码入 worker + 文本控制帧** | 单测 `test_ingest_text_ping_gets_pong`、`test_ingest_garbage_text_survives`、`test_garbage_jpeg_counts_error_and_thread_survives`；本 E2E：/ingest 事件循环只透传 bytes，503 帧被覆盖丢弃的解码全部省掉，errors=0 |
| 3 | **/out 空闲断连清理** | 单测 `test_out_idle_disconnect_unsubscribes_immediately`；本 E2E：out_probe 收满 60 帧断开后，viewer 页继续正常收帧至 96，服务无泄漏订阅 |
| 4 | **多频道 worker 注册表** | 单测 `test_two_channels_route_independently`、`test_out_unknown_channel_closes_4400`、`test_ingest_unknown_channel_frame_ignored`、`test_create_app_rejects_*`；本 E2E 经注册表频道 0 全链路跑通 |
| 5 | **capture 页 + HTTPS** | 单测 `test_capture_page_served`；本 E2E 用真实 getUserMedia（假设备）驱动 /capture 页跑满 60s；wss 跟随页面协议：capture.html 自带（commit d438997），viewer.html 由 ad4ebe1 补齐；`run_local --https` 代码路径就绪，真机 HTTPS 见下方 OWNER 项 |

## 遗留 OWNER 项（验收时，需真机/真人）

1. **iPhone Safari 真机**：`run_local --https` + 手机访问 `https://<lan-ip>:<port>/capture`，验证 getUserMedia 安全上下文、wss、前摄采集（本环境无 iOS 设备）。
2. **真人入镜**：打开本机摄像头物理隐私挡板（M1a 时确认处于遮挡位），真人驱动复跑，目检 avatar 跟随真人头部动作（假摄像头已验证链路，真人视角未验证）。
3. **摄像头丢失恢复**：拔掉/系统收回摄像头触发 `track.onended` → 页面显示 "camera lost — stopped" 并释放资源（commit ad4ebe1 的代码路径，headless 假设备无法触发 ended，需实机验证）。

## M1b 滚动待办（m1a-results §待办 滚动更新）

M1c 已关闭：~~/out 空闲断连清理~~（Task 3）、~~解码移出事件循环~~（Task 2）、~~/ingest 文本帧防护~~（Task 2）、~~ts_ms 透传~~（Task 1）、~~run_local --host/--cfg~~（Task 5 一并补齐）、~~探针入库~~（M1a Task 6 已完成）。

仍开放（沿用 m1a-results 编号）+ 本轮新增：

1. **WS 生产化**：/ingest、/out 无鉴权、无 max_size 限制、无 keepalive/ping 配置。（原 #6）
2. **errors 口径拆分**：管线异常 / JPEG 编码失败 / 订阅者回调异常仍聚合一个计数。（原 #7）
3. **无脸中途丢跟踪**：适配器 `_initialized` 只保证首帧初始化，中途长时间无脸后的恢复未验证（本 E2E d14 全程有脸，未触发）。（原 #8）
4. **无脸 4-tuple 返回形态对上游 clone 复核**。（原 #9）
5. **viewer 乱序防护高 fps 复核**：lastDrawnSeq 守卫在本地 ~1.6fps 下无法充分压测。（原 #10）
6. **适配器 chdir 副作用**：`liveportrait_pipeline.py` 构造时仍 `os.chdir(_CLONE)`，动 cfg 加载时一并移除。（原 #12）
7. **新：/status 顶层 "channel" 别名退役**：多频道后顶层 `"channel"` 只是频道 0 的兼容别名（app.py），下游消费方切换到 `"channels"` 后应删除，避免双口径漂移。
8. **新：/out 未知频道关闭码 4400 vs 1008**：当前用自定义 4400；RFC6455 语义上 1008 (policy violation) 更标准。选定一个并在 protocol.py 文档化，客户端重连逻辑需区分"频道不存在（别重试）"与"临时故障（可重试）"。
9. **新：启动成本**：冷启动模型加载 15-20s（本次 warm 缓存 ≈2s）。多频道=每频道一套管线，动态建频道前需要预热/加载进度暴露（/status 加 loading 态），否则前 N 秒 /ingest 帧全静默丢弃。
10. **新：跨机时钟偏移**：`--latency-from-header` 的前提是采集端与探针同机（本次浏览器 Date.now() vs Python time.time() 同机有效）。跨机部署后头内 ts_ms 延迟含时钟偏移，需 NTP 校准或改单向延迟估计。
11. **新：capture 页 sent 计数含出口缓冲**：`ws.send()` 只是入 bufferedAmount，sent 计数≠对端已收。已有 MAX_BUFFERED=1MB 跳帧保护；如需精确投递口径，需服务端回执或读 bufferedAmount 差分。
12. **新：openssl 证书命令 Git Bash 引号坑**：Git Bash (MSYS) 会把 `-subj "/CN=..."` 的前导 `/` 当路径改写；生成 --https 用的自签证书需 `MSYS_NO_PATHCONV=1` 前缀或双斜杠 `//CN=...`，写运维脚本时注意。

## 复现命令（全部入库可复跑）

```bash
# M0 venv 绝对路径（下文 $PY）：
PY="C:/Users/76475/Documents/OneLive/.worktrees/v2-m0-spike/engine/.venv/Scripts/python.exe"

# 1. y4m（仅首次）。d14.mp4 在 M0 clone 的驱动示例目录：
#    <ONELIVE_M0_ENGINE>/FasterLivePortrait/assets/examples/driving/d14.mp4
#    （ONELIVE_M0_ENGINE 默认 .worktrees/v2-m0-spike/engine）
#    ffmpeg 不在 PATH 上，用 winget 装的绝对路径调用（见 spike-results.md 环境备注）
ffmpeg -i <d14.mp4> -pix_fmt yuv420p -t 18 engine/out/d14.y4m
# 2. 服务（worktree engine/ 目录下运行）
$PY -m service.run_local --port 8910
# 3. E2E（依赖主 checkout node_modules，见上文解析方案说明；跑满 60s）
node engine/e2e/capture-e2e.mjs        # E2E_PORT/E2E_Y4M/E2E_DURATION_S 可覆盖
# 4. 并行探针 —— 第二个终端，在步骤 3 启动后 ~5s 内跟上（探针要在 60s 采集窗口内收满
#    --count 60 帧，~1.6fps 下约需 37s，起晚了窗口不够）
$PY -m tools.out_probe --url ws://127.0.0.1:8910/out --channel 0 --count 60 --timeout 120 --latency-from-header --save-dir out/e2e_m1c
```
