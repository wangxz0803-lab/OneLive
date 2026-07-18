# M3a 实测结果：真实 RTMP 推流（渲染帧 + 连续音轨 → 自建收流端）

日期：2026-07-18　|　分支：`feature/v2-m3a-rtmp`　|　状态：**Task 1-6 完成**（154 passed + rtmp E2E PASS + Node 32 passed）

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

## Task 5：clumsy 网络损伤脚本化（已完成，**OWNER-RUN-REQUIRED**）

新增 `engine/netlab/`：`get-clumsy.ps1`（下载器）+ `profiles.ps1`（三档损伤/off）+ `README.md`（使用说明），二进制目录 `netlab/clumsy/` 已 gitignore（`netlab/.gitignore`）。

**真实执行了什么：**

- **下载真实完成**：本会话真实运行 `get-clumsy.ps1` → GitHub 下载 `clumsy-0.3-win64-a.zip`（536,789B），SHA256 `F50DC734148815831C67D9FC2C246C22D421C53DCEA51E26EEE905B0B2806C27`（上游未发布校验和，此哈希已固化进脚本作 pin，不匹配即中止）；解压出 clumsy.exe / WinDivert.dll / WinDivert64.sys / config.txt / License.txt。二次运行验证幂等（`already present ... skip`）。
- **版本纠偏**：计划里写的 "clumsy 1.4.x" 不存在——上游 latest release 是 **0.3**（2023-10 发布，1.4/2.x 是 WinDivert 的版本号）。0.3 提供 a/b/c 三个 win64 包，仅 WinDivert 驱动签名不同（上游 issue #84）；默认取 a，驱动加载失败时 `-Variant b|c` 换签名。
- **CLI 契约从源码逐一核实**（上游 README/manual 只写 GUI）：`src/utils.c parseArgs` 把任意 `--key value` 存 IUP global，模块启动读取。有效键：`--filter`、`--timeout <s>`、`--<mod> on`（lag/drop/throttle/ood/dup/tamper/reset/bandwidth）、`--<mod>-inbound|outbound on|off`、`--lag-time <ms>`、`--drop-chance`、`--ood-chance`、`--throttle-chance/-frame`、`--bandwidth-bandwidth <KB/s>`。**关键发现**（`src/elevate.c`）：CLI 模式下非管理员时 clumsy **静默退出、不弹 UAC**——profiles.ps1 因此自带提权检查并给出精确的管理员命令。
- **congested 档用 bandwidth 模块而非 throttle**：0.3 新增 bandwidth 模块（KB/s 直接限速，PR#70），比 throttle 时间窗攒包更贴合"带宽受限"，映射为 120KB/s + drop 5%；weak = drop 15% + ood 25%；latency = lag 300ms 双向。
- **本会话未提权**（`net session` → Access denied），未做真实损伤测量；四档 `-DryRun` 全部真实执行（exit 0），verbatim：

```
===== -Profile congested -Ports 8900,1935 -DryRun =====
[netlab] DRY-RUN profile=congested ports=8900,1935
[netlab] filter: tcp and (tcp.DstPort == 8900 or tcp.SrcPort == 8900 or tcp.DstPort == 1935 or tcp.SrcPort == 1935)
[netlab] command: "...\engine\netlab\clumsy\clumsy.exe" --filter "tcp and (tcp.DstPort == 8900 or tcp.SrcPort == 8900 or tcp.DstPort == 1935 or tcp.SrcPort == 1935)" --bandwidth on --bandwidth-inbound on --bandwidth-outbound on --bandwidth-bandwidth 120 --drop on --drop-inbound on --drop-outbound on --drop-chance 5
===== -Profile weak -Ports 8900,1935 -DryRun =====
[netlab] command: "...clumsy.exe" --filter "..." --drop on --drop-inbound on --drop-outbound on --drop-chance 15 --ood on --ood-inbound on --ood-outbound on --ood-chance 25
===== -Profile latency -Ports 8900,1935 -DryRun =====
[netlab] command: "...clumsy.exe" --filter "..." --lag on --lag-inbound on --lag-outbound on --lag-time 300
===== -Profile off -DryRun =====
[netlab] DRY-RUN: Stop-Process -Name clumsy -Force
```

- 错误路径实测：非法端口 exit 1；非提权直跑 exit 1 并打印可复制的管理员命令。DryRun 执行本身即完成 ps1 语法验证。
- **踩坑修复**：`powershell -File` 传 `-Ports 8900,1935` 时整串是一个字符串，`[int[]]` 绑定按 culture 把逗号当千分位 → 端口变 89001935；改为 `[string[]]` 手动 split+校验后修复（首轮 DryRun 抓到）。
- **loopback 事实（上游 manual "Limitations" 原文核实）**：clumsy 支持 localhost↔localhost；但 WFP 把所有 loopback 包归 outbound（filter 不能带 `inbound` 词——我们只按端口过滤，安全），且 loopback 包被处理**两次**（lag 300ms 实测应 ~600ms）。手机↔PC 的 LAN 流量不受加倍影响。
- 套件回归：`154 passed`（不变，ps1 不进 pytest）。

**OWNER-RUN-REQUIRED**（需管理员 PowerShell，本会话无法提权、也不允许弹 UAC）：

```powershell
Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-Command',"cd 'C:\Users\76475\Documents\OneLive\.worktrees\v2-m3a\engine'"
```

进入后按 `engine/netlab/README.md` 的"OWNER 实测步骤"跑 latency 档量化验证（serve_echo 8918 + out_probe 基线/损伤对比，loopback 预期 +600ms 量级），demo 现场用 `-Ports 8900`（WS）或 `8900,1935`（WS+RTMP）。

## Backlog（滚动终稿，M3b/后续）

M3a 新增：

- **app.py 拆分（升级为 M3b 第一优先）**：app.py 已 676 行（本里程碑又进 /stream.*、streamer 集成、mixer 生命周期），单文件承载 路由+广播+tee+生命周期编排 逼近失控——M3b 动手拆（端点模块 / 广播编排 / 生命周期各归位）。
- 丢弃上限三处各自为政（mixer 60s / SpeechSchedule 16 段 / /speech Queue(8)）：严重积压时三端各自丢段是已知失同步源，统一丢弃策略 M3b（吸收 M2b「/speech(8) vs SpeechSchedule(16) 积压分歧」项）。
- `-ar 16000` 推流音轨采样率：TTS 管线 16k 一路到底；主流平台推荐 44.1k/48k——遇平台收流约束时在 ffmpeg 侧 `-ar 44100` 重采样即可（命令一处改动），是否需要由 OWNER 对目标平台确认。
- DTS 警告族（见 Task 4 known noise）：flv mux 等时间戳帧 dup + aac queue backward——现阶段属已知噪音，若后续平台端出现音画撕裂再回头治理。
- **stderr 脱敏的截断行限制**：脱敏按整 URL 精确匹配——ffmpeg 把 URL 截断/换行输出时 KEY 可能漏出；接真实串流码前收紧为按 KEY 子串匹配。另 run_local 启动 banner 打印未脱敏推流 URL（OWNER 项已提示）。
- **D14 驱动 fixture 依赖外部 worktree**：`rtmp_e2e.py`/`lip_e2e.py` 的驱动视频住在 v2-m0-spike worktree（未入库），worktree 清理即断——Task 6 已给两脚本加 `ONELIVE_D14` 环境变量兜底；长期应把小体积驱动 fixture 入库或提供下载脚本（两脚本一起换）。

M2a/M2b 滚动项（M3a 未动，逐项带状态）：

- SegmentTranscriber `_audio` 无界累积 + O(n²) 拼接（M2a）：**仍开放，长跑前必改**（环形缓冲）。
- TTS 流式首块（M2a，首配音 5-6s 超预算的最大单点收益）：仍开放。
- /events 满队丢最旧 → wire seq 或快照/重放（M2a）：仍开放，M3 控制台可靠展示的前置。
- whisper 降延迟旋钮 beam_size/模型档（M2a）：仍开放，配音链达标后再动。
- 麦克风自适应静音阈值（M2a）：仍开放，待 OWNER 真机数据标定。
- speech-period lip-log 音量（M2b，75 行/秒@25fps×3ch）：仍开放，M1b 部署前降 DEBUG/抽样。
- run_local 未暴露 `--lang-channels`（M2b，写死 `{"en": 0}`）：仍开放，三语演示前置。
- viewer 奇数字节 pcm 硬化（M2b，美化项）：仍开放。
- SpeechSchedule stats 新鲜度（M2b，nit）：仍开放。
- 嘴型观感增强（M2b，可选）：仍开放，帧率提升自然缓解或 lip_open 上调。
- 已闭合：/audio 奇数字节帧误诊 4409（M2a 记录）→ M2b 已在 /audio 入口加 `len(pcm)%2` 丢弃守卫（app.py）。

## Task 6：收尾（评审项落地 + 回归 + README）

评审项落地（全部小改，docs/e2e 脚本）：

- `rtmp_e2e.py` + `lip_e2e.py`：D14 路径加 **`ONELIVE_D14` 环境变量兜底**（默认仍指 v2-m0-spike worktree）；入库/下载脚本进 backlog。
- `rtmp_e2e.py`：sink 重启复用同一 log 句柄（原实现二次 `open` 泄漏句柄）；`_wait_status` 容忍 warmup 期非 JSON 响应（`ValueError` 并入重试，`json.JSONDecodeError` 是其子类）。
- `rtmp-sink/README.md`：`npm install` → **`npm ci`**（2.7.4 锁定从"大概率"变成硬保证）。
- `netlab/README.md` OWNER 步骤：venv 路径纠正——本 worktree 无 `.venv`，改为 M0 venv 全路径（`$m0py` 变量式），并注明任何装齐依赖的 python 均可。
- 本文件：脱敏措辞收敛（"已自动脱敏"→"整 URL 形态已脱敏，截断行未覆盖"）+ run_local 明文 URL 提示 + rtmps/采样率/关键帧间隔三点并入 OWNER 推流项。

回归（本轮实测）：

- Python 套件：`154 passed`（M0 venv，engine/tests）。
- Node 套件：`32 passed (5 files)`（主 checkout 运行——M3a diff 仅触及 engine/ + docs + README，前端/server TS 零改动，主 checkout 即等价验证面）。
- 浏览器回归 `capture-e2e.mjs`：**本轮 SKIP**——`git diff master..HEAD -- engine/service/viewer.html` 为空（M3a 未触碰 viewer/采集页/前端 JS），M2b Task 6 的浏览器回归结论（PASS，0 console error）对本分支依然成立；A/V 契约变化只在 app.py docstring（文档性质），无浏览器执行面变化。
- README（仓库根）：引擎服务节补 RTMP 推流用法 + netlab 网络损伤一段（见 README「RTMP 推流」「网络损伤实验」）。

## OWNER 项（滚动）

- **公开平台推流**：只差 `--rtmp` 换成平台推流地址+串流码（YouTube/B站/Twitch 账号归 OWNER）。已备好的正面证据：`-g 30`@15fps = **2s 关键帧间隔**，符合主流平台（YouTube/Twitch）对推流关键帧间隔的要求。注意三点：
  - 脱敏边界：/status stderr_tail 里推流 URL 的**整 URL 形态已脱敏**（`rtmp://host/app/KEY` → `.../***`），但**截断行未覆盖**（ffmpeg 把长 URL 截断/换行时 KEY 可能漏出，见 backlog）；且 `run_local` 启动 banner 会把**未脱敏**的完整推流 URL 打到控制台/service.log——用真实串流码时该日志勿外传。
  - 采样率：推流音轨当前 16k（TTS 管线一路到底），主流平台推荐 44.1k/48k——见 backlog 采样率项（ffmpeg 侧 `-ar 44100` 一处改动）。
  - rtmps：YouTube 现推荐 `rtmps://` 入口——转公网时需验证本机 ffmpeg 的 TLS 推流可用（本地 E2E 只验证过明文 rtmp）。
- **A/V 同步观感验收**：机制契约见 app.py docstring；数值实测见 E2E；最终"看起来对不对"需 OWNER 拉流目检（VLC/potplayer 开 `http://127.0.0.1:8000/live/ch0.flv`）。
- **clumsy 真实损伤验证**（Task 5 交付，脚本/文档/DryRun 已备）：需 OWNER 在管理员 PowerShell 跑 `engine/netlab/profiles.ps1`，按 netlab/README.md 步骤做 latency 档 out_probe 前后对比 + demo 三档目检；`off` 要在同一管理员会话执行。
- **真机验收**（M2b 滚动携带，仍开放）：手机浏览器打开 viewer（HTTPS），点「开启声音」，确认音频播放 + speaking 状态行 + 嘴型动；录屏留档待 OWNER 演示时补。
- **AI_API_KEY / AI_API_URL / AI_MODEL**（M2b 滚动携带，仍开放）：真翻译 Provider 配 key 后用 `--translate` 复跑 E2E（stub 只证链路机制）。
- **idle 语义视觉验收**（M2b 滚动携带，仍开放）：目检 `idle_semantic_lip_on.png` vs `idle_semantic_lip_off_m1a.png`，不可接受则演示用 `--no-lip`。
