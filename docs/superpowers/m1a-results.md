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
