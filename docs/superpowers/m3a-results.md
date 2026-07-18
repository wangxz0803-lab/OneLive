# M3a 实测结果：真实 RTMP 推流（渲染帧 + 连续音轨 → 自建收流端）

日期：2026-07-18　|　分支：`feature/v2-m3a-rtmp`　|　状态：**Task 1-4 完成**（154 passed + rtmp E2E PASS）

## Task 1：AudioMixer（已完成，`356abf2`）

- `service/audio_mixer.py`：每信道实时连续 pcm16 块流（sr=16000、chunk 100ms）——静音打底，TTS 语音 `splice()` FIFO 接时间线尾部（排队播出不重叠，语义对齐 SpeechSchedule）。
- 节拍 = 绝对时刻排程（`t0 + n*chunk_s`，防漂移，同 feeder）；纯拼装逻辑 `_next_chunk` 与节拍循环分离，可注入时钟确定性单测。
- 溢出：语音队列按总秒数有界（60s）丢最老**排队**段（正在播的头段不掐断）；订阅队列 16 块丢最旧；stop 后订阅者收 `None` 哨兵（finally 里发，任何退出路径不漏）。
- 生命周期一次性：stop 后再 start 是 RuntimeError（重启 = 新实例，lifespan 每次都新建）。

## Task 2：/stream.mjpeg + /stream.wav（已完成，`b446540`）

- `/stream.mjpeg?channel=`：multipart/x-mixed-replace，worker 订阅者 Queue(4) 丢最旧；订阅生存期严格等于生成器生存期（断连 → CancelledError 落在 `queue.get()` → finally 退订，/out 僵尸订阅者教训的延续）。
- `/stream.wav?channel=`：44 字节无限流 RIFF 头（RIFF/data 尺寸字段 0xFFFFFFFF 惯例）+ mixer 块流；`None` 哨兵正常终结响应。
- mixer 每信道一个（`app.state.mixers`），**与翻译管线无关**——纯静音直播也要有连续音轨（RTMP 断音轨即断流）。TTSReady tee 第三半区 `mixer.splice(...)`（与 SpeechSchedule 入队、/speech 广播并列，各自独立兜底，sr 不匹配宁缺毋腐跳过）。
- A/V 契约 M3a 补充（app.py docstring）：混音器"到达即拼"vs 嘴型等下一渲染轮询——段切换嘴型额外滞后 ≤1 渲染周期；丢弃上限三处各自为政（mixer 60s / SpeechSchedule 16 段 / /speech Queue(8)），统一化留 M3b。

## Task 3：StreamerManager + run_local --rtmp（已完成，`62eb260`）

- `service/streamer.py`：每信道受监督 ffmpeg，拉 `/stream.mjpeg` + `/stream.wav` → libx264（veryfast + zerolatency，`-r 15 -g 30`）+ aac 16k → flv 推 `rtmp_url_template.format(ch=N)`。
- 与计划的命令行偏差：`-use_wallclock_as_timestamps 1` 是**输入侧** demuxer 选项，计划放两个 `-i` 之后（输出位置）ffmpeg 直接报错退出——实现改为每个 `-i` 之前各一份（test_command_shape 锁定，demuxer E2E 背书真实可用性）。
- supervisor：spawn → 并发排空 stderr（环形 50 行；不排空则 ffmpeg 写满管道缓冲僵而不死、wait() 死锁）→ 记 exit code → 指数退避重启（1s 倍增至 30s，stopping 事件即刻打断）。
- 启停顺序（评审 carry-forward，写死在 streamer.py/app.py docstring）：
  - **启动**：ffmpeg 要拉的 /stream.* 在 uvicorn serving 后才可达，而 lifespan startup 完成于 serving **之前**——start_all 走 lifespan 后台任务，先 `await ready_probe()`（run_local 注入轮询 /status 到 200）再 spawn；
  - **停机**：ffmpeg puller 就是 /stream.* 的长连接 HTTP 客户端，先走服务收尾则 uvicorn 优雅停机等连接 drain、puller 继续拉、互相僵持——lifespan shutdown **最先** `stop_all()`（puller 死 → 流式生成器随断连取消 → 管线/混音器/worker 收尾畅通）。
- run_local `--rtmp <template>`（`{ch}` 占位）；与 `--https` 不兼容（ffmpeg 拉 http://127.0.0.1 过不了自签校验）；多频道缺 `{ch}` 直接拒启。
- /status 增 `streams` 块：`running/pid/restarts/last_exit_code/stderr_tail`（尾 5 行）。

### Task 3 评审 ride-alongs（本任务落地，`bcb6eeb`）

- **stall watchdog**：两个 `-i` 前各带 `-rw_timeout 10000000`（10s，µs 单位）——端点"僵而不断"（连接在、字节不来）时 ffmpeg 自行超时退出、监督器重启。E2E 里无法故意弄僵端点，验证面 = flag 在生产命令里（exact-list 测试）+ 正常运行不受影响（E2E 稳态 restarts=0）。
- **退避归位**：一次运行存活 ≥ `stable_reset_s`（默认 60s，可注入）即视为"曾经健康"，下次崩溃从 backoff_base 重来——长跑后的偶发断线不吃累积指数惩罚。测试：fake ffmpeg 存活 0.3s + stable_reset_s=0.2 → 白盒观测退避恒为基值；负对照（立即崩溃）照旧指数增长。
- **串流码脱敏**：stderr 行进环形缓冲前，把推流 URL 末段路径（`rtmp://host/app/KEY` 的 KEY——公开平台串流码位）替换为 `***`（按 template 逐信道生成精确匹配模式）。/status 把 stderr_tail 吐给任意观测方，密钥绝不能跟着泄出。

## Task 4：rtmp-sink + 推流 E2E（已完成）

### rtmp-sink（engine/rtmp-sink/）

- node-media-server **2.7.4**（package-lock 入库锁死；node_modules/media gitignore）：RTMP 1935 收流 + HTTP-FLV 8000 播出，`node server.mjs` 即起；会话事件（pre/post/done × Connect/Publish/Play）全量打点 console。
- 沙盒冒烟：testsrc 512x512@15 + sine 16k 推 3s → ffprobe `http://127.0.0.1:8000/live/ch0.flv` 探出 `h264 512x512 15/1` + `aac 16000 mono`。
- 环境注记（如实）：node 首次监听后**第一波**连接尝试曾整体报 ffmpeg `Error number -138`（推 1935 与探 8000 同时失败，node 明明在 LISTENING）；数秒后同命令全通，此后不复现——疑似 Windows 防火墙对 node.exe 首次放行的暂态，未再深究。

### E2E（engine/e2e/rtmp_e2e.py，端口 8917，exit 0 = PASS）

组合：sink（node 子进程）+ 真服务（`--translate-stub --rtmp rtmp://127.0.0.1:1935/live/ch{ch}`）+ feeder d14 @5fps + `/audio` 实时喂 2 句中文 fixture。timeline 全程留档（out/rtmp_e2e/timeline.txt），一次通过，全程 60.1s：

```
[t+ 14.02s] service ready (models loaded) → feeder 立即跟上
[t+ 17.61s] streams.0 running=True pid=29304 restarts(warmup)=0   ← 无早期看门狗重启
[t+ 26.66s] 稳态 8s 窗口：running=True restarts=0
[t+ 28.41s] [probe] video: codec=h264 512x512 r_frame_rate=15/1 pix_fmt=yuvj420p
[t+ 28.41s] [probe] audio: codec=aac sr=16000 channels=1
[t+ 37.42s] tts_ready seg1 (duration 1.392s synth 2503ms) → 即刻起 10s FLV 拉流
[t+ 40.36s] tts_ready seg2 (duration 1.416s synth 1246ms)   ← 落在拉流窗内
[t+ 48.09s] 拉流完成 rc=0 size=1010225B
[t+ 50.30s] translation={segments:2 translated_ok:2 tts_ok:2 errors:0}
            channels.0: processed=56 errors=0 speech={queued:0 played:2 dropped:0}
            streams.0: running=True restarts=0
```

**断言② 拉流解剖：**

- 帧：10s FLV 解出 10 张 PNG（1fps），全部可解码、非空白（全帧均值 69.1–69.8）。目检：数字人 = 默认底图（戴珍珠耳环的少女），画面清晰、512x512、头部姿态随 d14 驱动逐帧变化（frame_02 目视左侧 → frame_05 转向镜头 → frame_09 低头侧倾），PNG 存 out/rtmp_e2e/。
- 音轨：16k mono wav，40 个 250ms 窗 RMS verbatim：`[0, 2983, 4086, 583, 0×9, 4929, 1972, 2, 0×24]`——两段语音窗（seg1: 2983/4086/583，seg2: 4929/1972）与静音窗（AAC 解码后精确为 0）界限分明；speech(max)=4929 vs silence(p10)=0，**ratio 4929x**（断言阈 >300 / >5x，远超）。

**断言③ known-noise stderr（verbatim，稳态 stderr_tail）：**

```
[aist#1:0/pcm_s16le @ ...] Guessed Channel Layout: mono
[aac @ ...] Queue input is backward in time
    Last message repeated 3 times
[swscaler @ ...] deprecated pixel format used, make sure you did set range correctly
[aac @ ...] Queue input is backward in time
```

指引：以上三族（mono 布局猜测 / aac queue backward——wallclock 时间戳下音频包偶发回拨 / swscaler yuvj 弃用告警）在本管线属**已知噪音**。Task 3 预告过的 flv mux 等时 DTS 帧 dup 告警族（`... dup ...` / `Non-monotonic DTS`）**本轮 status 尾窗（末 5 行/环形 50 行）未现身**——如后续在长跑里出现，同归此已知噪音族。以上告警不影响推流与解码（本 E2E 全链断言即证据）；`restarts` 不动、探针照常出流即健康。真正要警惕的是 stderr_tail 出现 `Error number -10054` / `Connection refused` 类连接错误 + restarts 增长。

**断言④ 弹性（kill sink → 退避重启 → 恢复）timeline：**

```
[t+ 50.31s] sink KILLED
[t+ 51.47s] restarts 0 -> 1（kill 后 1.2s 检出）running=False last_exit_code=4294957242（= -10054 WSAECONNRESET 的 u32 表示）
            stderr_tail: [out#0/flv] Terminating thread with return code -10054
                         [flv] Failed to update header with correct duration.
                         [flv] Failed to update header with correct filesize.
                         [out#0/flv] Error writing trailer / Error closing file: -10054
[t+ 54.48s] sink 重启（新 node 进程）
[t+ 60.14s] RECOVERED：h264 再次探出，距 sink 重启 4.5s、距 kill 9.8s；restarts=1 running=True
```

- **NMS ghost session 注记**：publisher 被杀而 **sink 存活**时，NMS 旧会话要等 TCP 超时才清、期间同路径 re-publish 被 `Already has a stream` 拒绝——监督器的退避重试天然覆盖；本轮弹性用例杀的是 sink 整个进程（无 ghost 残留），恢复 4.5s 即一个退避周期 + 探针节拍，未触发 ghost 路径。与 Task 5 clumsy（断连不杀进程）组合时预期会真踩到，届时如实记录。
- 收尾：feeder/service/sink 全杀，1935/8000/8917 实测无 LISTENING 残留。

服务侧监督日志（service.log，verbatim）：

```
WARNING:engine.streamer:streamer ch0: ffmpeg exited rc=4294957242, restart #1 in 1.0s; stderr: [out#0/flv @ ...] Terminating thread with return code -10054 ...
INFO:engine.streamer:streamer ch0: ffmpeg started (pid=40732)
```

事件链（events.jsonl UTF-8 正常；控制台 GBK 乱码仅显示问题，同 M2b）：subtitle→translation(ok, stub 自我声明)→tts_ready(channel=0) 逐段成链，两段 segment_id 1/2 完整。

## Backlog（M3b/后续）

- **app.py 拆分升级**：app.py 已 676 行（本里程碑又进 /stream.*、streamer 集成、mixer 生命周期），单文件承载 路由+广播+tee+生命周期编排 逼近失控——M3b 动手拆（端点模块 / 广播编排 / 生命周期各归位）。
- 丢弃上限三处各自为政（mixer 60s / SpeechSchedule 16 段 / /speech Queue(8)）：严重积压时三端各自丢段是已知失同步源，统一丢弃策略 M3b。
- `-ar 16000` 推流音轨采样率：TTS 管线 16k 一路到底；主流平台推荐 44.1k/48k——遇平台收流约束时在 ffmpeg 侧 `-ar 44100` 重采样即可（命令一处改动），是否需要由 OWNER 对目标平台确认。
- DTS 警告族（见 Task 4 known noise）：flv mux 等时间戳帧 dup + aac queue backward——现阶段属已知噪音，若后续平台端出现音画撕裂再回头治理。

## OWNER 项（滚动）

- **公开平台推流**：只差 `--rtmp` 换成平台推流地址+串流码（YouTube/B站/Twitch 账号归 OWNER）；串流码在 /status stderr_tail 里已自动脱敏。
- **A/V 同步观感验收**：机制契约见 app.py docstring；数值实测见 E2E；最终"看起来对不对"需 OWNER 拉流目检（VLC/potplayer 开 `http://127.0.0.1:8000/live/ch0.flv`）。
- **clumsy 管理员运行**（Task 5 预告）：WinDivert 需要 elevated PowerShell。
