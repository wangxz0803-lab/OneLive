# M1a 实测结果：引擎服务化 + 本地单频道闭环

日期：2026-07-17　|　分支：`feature/v2-m1a-engine-service`　|　机器：本地 Arc（DML split 管线，pasteback 关闭）

## E2E 闭环实测（Task 5 Step 3）

**拓扑**：三进程同机——

1. 引擎服务：`python -m service.run_local --port 8903`（M0 venv，真实 LivePortrait 管线，source=s10.jpg）
2. 驱动 feeder：`python -m service.feeder --url ws://127.0.0.1:8903/ingest --video <d14.mp4> --fps 15 --max-frames 200 --log-sends <csv>`
3. /out 探针：临时脚本（未入库），连 `/out` 收协议帧直至 8s 无帧，按 seq 匹配 feeder 发送日志算延迟，存首/末帧 PNG。

**端到端延迟测法（如实说明）**：当前 `/out` 帧头 `ts_ms=0`——worker 的 Subscriber 回调是 `(seq, jpeg)`，没有 ts 槽位，驱动帧的发送时刻没有透传到输出帧（已列入 M1b 待办）。因此采用最简单的诚实测法：feeder 加 `--log-sends`，把每帧 `seq,发送时刻(epoch ms，与 /ingest 帧头 ts_ms 同值)` 写入 CSV；探针收到 /out 帧后取其 seq（seq 全程透传）回查 CSV，同机时钟直接相减。延迟 = feeder `ws.send` 前一刻 → 探针 `ws.recv` 返回后一刻，覆盖 上行WS + 排队 + 推理 + JPEG编码 + 扇出 + 下行WS 全链路。

### 探针输出（原文）

```
[probe] received 27 frames in 13.53s (first->last arrival) -> arrival fps = 1.92
[probe] jpeg bytes: avg=36380 min=34282 max=39435
[probe] received seqs: [0, 10, 18, 26, 33, 41, 49, 56, 64, 72, 80, 88, 96, 104, 111, 119, 127, 135, 143, 151, 158, 166, 174, 182, 189, 197, 199]
[probe] e2e latency (feeder send ts_ms -> probe recv, 27 matched frames): mean=585ms median=566ms min=516ms max=984ms
[probe] per-frame latency (seq, ms): (0,718) (10,580) (18,546) (26,523) (33,564) (41,556) (49,532) (56,606) (64,587) (72,587) (80,593) (88,566) (96,552) (104,533) (111,602) (119,567) (127,569) (135,553) (143,557) (151,523) (158,583) (166,559) (174,536) (182,516) (189,589) (197,608) (199,984)
[probe] first frame seq=0 shape=(512, 512, 3), last frame seq=199 shape=(512, 512, 3)
```

### 运行结束后的 GET /status（原文）

```
{"engine":"ok","channel":{"processed":27,"dropped":173,"skipped":0,"errors":0,"last_infer_ms":515.554899990093}}
```

### 结果解读

| 指标 | 实测 | 预期 | 结论 |
|---|---|---|---|
| /out 到达 fps | **1.92** | ≈ 1/0.534 ≈ 1.9 | 符合：吞吐 = 推理速度，无额外瓶颈 |
| E2E 延迟 | **mean 585ms / median 566ms / min 516 / max 984** | ~0.6-1.2s | 优于预期上限：≈1 帧推理时间 + 少量排队。max 984ms 是末帧（seq 199，feeder 已断开后的收尾帧，含更长排队） |
| processed / dropped | **27 / 173**（27+173=200 帧全部核算，skipped=0, errors=0） | 丢帧率 ~87% | 173/200 = **86.5% 丢帧——这是 latest-wins 设计正确的证据**：15fps 输入 vs ~1.9fps 推理，旧帧被最新帧覆盖而不是排队放大延迟。收到的 seq 序列单调且大致等距（间隔 ≈8 帧 ≈ 534ms×15fps），也印证槽位永远保留最新帧 |
| 帧完整性 | 27/27 帧 JPEG 解码成功，512×512 | — | 协议头 + payload 全程无损 |

### 帧证据（目检）

- `engine/out/e2e_first_seq0.png`（首帧，seq=0）与 `engine/out/e2e_last_seq199.png`（末帧，seq=199），均 512×512。
- 两帧都是源像 s10.jpg（蓝头巾珍珠耳环少女油画风格肖像）的干净渲染：肤色/头巾蓝色/背景深色均正常，无色偏（RGB→BGR 转换正确）、无花屏。
- 首末帧姿态可辨差异：头部位置/朝向有偏移，眼睛开合度与嘴部形态不同——数字人姿态随 d14.mp4 驱动帧变化，动作复刻链路有效。
- （PNG 在 gitignore 的 `engine/out/`，不入库；执行环境无浏览器，viewer.html 仅做了 `GET /` 返回内容验证——标题与 /out 连接逻辑正确，浏览器目检留给 Task 6/验收者。）

### 测试回归

```
======================== 16 passed, 1 warning in 1.49s ========================
```

（协议 4 + worker 6 + app 集成 4 + M0 audio_lip 2；warning 为 starlette testclient 弃用提示，与本项目无关。）

## 摄像头 E2E（Task 6）

**结论先行：摄像头链路全程打通且行为符合设计，但本机摄像头物理隐私挡板处于关闭状态，驱动帧是驱动程序的占位图（无人脸），因此"真人动作复刻"未能在本环境验证——留待项目 owner 验收时开挡板复测（OWNER-VALIDATION-REQUIRED）。**

### 摄像头可用性

- index 0：`cap.isOpened()=True`，读帧成功，640×480×3。**但画面是驱动层隐私挡板占位图**（灰色笔记本插画 + 划线相机图标），非真实场景——本机（含 GameViewer/MuMu/Oray 等虚拟显示适配器环境）的物理摄像头隐私开关处于遮挡位。
- index 1、2：打不开（`Camera index out of range`）。

### 实测拓扑与命令（2026-07-17）

1. 服务：`python -m service.run_local --port 8905`（M0 venv，source=s10.jpg 默认）
2. feeder：`python -m service.feeder --url ws://127.0.0.1:8905/ingest --camera 0 --fps 10 --max-frames 600 --log-sends out/task6/sends.csv --save-raw out/task6/raw`（60 秒，正常跑完 600 帧，exit 0）
3. 探针：`python -m tools.out_probe --url ws://127.0.0.1:8905/out --count 120 --timeout 75 --save-dir out/task6/probe --sends-csv out/task6/sends.csv`

### 实际观察到的行为

- 探针原文：`[probe] no frame for 75.0s, stopping` / `[probe] no frames received`——**/out 全程 0 帧输出**。
- 运行结束 `GET /status`（原文）：

```
{"engine":"ok","channel":{"processed":0,"dropped":115,"skipped":485,"errors":0,"last_infer_ms":144.86939999915194}}
```

- 口径核算：485 skipped + 115 dropped = 600，全部核算清。**skipped=485**——每一帧被 worker 取走推理，人脸检测（约 145ms/帧，见 last_infer_ms）找不到脸，管线返回 None 计 skipped；**没有垃圾输出、没有 errors、没有冻结帧**。dropped=115 是 latest-wins 正常覆盖（10fps 输入 vs ~6.9fps 的检测-only 处理速度）。
- 这正是适配器 docstring 承诺的"首次检测到人脸之前无脸→None→skipped"路径的大规模实测：600 帧无一进入生成阶段，下游订阅者干净地收到 0 帧而非坏帧。
- 已知局限"已跟踪后中途丢脸"路径本次未触发（全程无脸，从未进入跟踪态）。

### 证据文件（gitignore 的 engine/out/，不入库）

- `engine/out/task6/camcheck_idx0.png`、`engine/out/task6/raw/raw_seq{0,200,400}.png`：输入侧——4 张目检均为同一隐私挡板占位图，确认全程无人脸（`--save-raw` 为本次给 feeder 新增的输入证据参数）。
- `engine/out/task6/sends.csv`：600 行发送日志；`engine/out/task6/{feeder,service}.log`。
- `engine/out/task6/probe/`：空（0 输出帧，无可存）。

### feeder 摄像头韧性修复验证（Part A 回归）

用 duck-typed 永久失败 cap 调 `service.feeder.run()`：5.5 秒后干净退出 `SystemExit: driving source read failed repeatedly (50 consecutive failures)`——不再 100% CPU 空转（旧代码会在 `cap.set(POS_FRAMES,0)` no-op 上死循环）。

### 遗留验证项（验收时）

1. 打开摄像头物理隐私挡板，真人入镜复跑上述命令，目检 avatar 姿态是否跟随真人头部动作（首次真人验证）。
2. 浏览器打开 `http://127.0.0.1:<port>/` 目检 viewer 页面（本环境无浏览器，Task 5/6 均只做了 GET / 内容验证）。
3. 中途丢脸（真人离镜再回来）的跟踪恢复行为（M1b 待办 #8）。

## M1b 待办（评审累积）

1. **/out 空闲断连清理**：handler 阻塞在 `queue.get()`，不并发 `ws.receive()`，客户端断开后要等到下一次 `send_bytes` 失败才能感知；死订阅者在无帧输出期间永不清理。本次实测已复现：探针超时退出后服务端未记录 connection closed。
2. **JPEG 解码移出事件循环**：/ingest 在事件循环里 `cv2.imdecode` 每一帧，但 latest-wins 下高输入帧率时 ~87% 的解码是白做的——应把解码搬进 worker 线程（提交 bytes，推理前才解码最新帧）。
3. **/ingest 文本帧防护**：`receive_bytes` 收到文本帧会 KeyError 断连；protocol.py docstring 承诺"控制消息走 JSON 文本帧"，app 层还没实现该分支。
4. **ts_ms 透传 Subscriber**：回调签名加 ts 槽位（`(seq, ts_ms, jpeg)`），/out 帧头带上驱动帧原始 ts_ms，E2E 延迟可由任意订阅端直接测得（本次用 feeder 发送日志旁路测的）。
5. **run_local 补 `--host` / `--cfg` 参数**（当前硬编码 127.0.0.1 与 onnx_infer.yaml）。
6. **WS 生产化**：/ingest、/out 无鉴权、无 max_size 限制、无 keepalive/ping 配置。
7. **errors 口径拆分**：当前管线异常 / JPEG 编码失败 / 订阅者回调异常聚合成一个 errors 计数，排障需拆分（如 cb_errors 独立）。
8. **无脸中途丢跟踪的适配器局限**：`liveportrait_pipeline.py` 的 `_initialized` 只保证首帧初始化；中途长时间无脸后跟踪状态的恢复行为未验证（docstring 已注明）。
9. **无脸 4-tuple 返回形态需对未打补丁的上游 clone 复核**：当前"无脸返回 None（4-tuple out_crop=None）"的处理基于 M0 patched clone 实测，上游行为可能不同。
10. **viewer 乱序绘制防护在高 fps 下需复核**：`createImageBitmap` 异步解码可能让旧帧晚于新帧完成绘制。viewer.html 已加 lastDrawnSeq（BigInt）守卫（Task 6 修复）；本地 ~1.9fps 下难以触发，M1b 高帧率部署后需确认守卫足够（必要时改单飞 decode 队列）。
11. **探针入库**：Task 5 的临时 /out 探针已固化为 `engine/tools/out_probe.py`（--url/--count/--timeout/--save-dir/--sends-csv），本文档所有实测可从仓库直接复现（已完成，Task 6）。
