# netlab — clumsy 网络损伤脚本（spec §4.6）

用 [clumsy](https://github.com/jagt/clumsy)（WinDivert 内核驱动）对真实网络流量做损伤，
支撑 demo 的三档网络场景。**需要管理员权限**（WinDivert 装驱动），非管理员会拒绝并给出提示。

## 快速开始（管理员 PowerShell）

```powershell
cd <repo>\engine\netlab
powershell -NoProfile -ExecutionPolicy Bypass -File get-clumsy.ps1          # 一次性：下载 clumsy 0.3 win64
powershell -NoProfile -ExecutionPolicy Bypass -File profiles.ps1 -Profile latency -Ports 8900
# ... 观察 demo 效果 ...
powershell -NoProfile -ExecutionPolicy Bypass -File profiles.ps1 -Profile off
```

不确定命令会做什么时，加 `-DryRun` 只打印将执行的完整命令行（不需要管理员）。
`-TimeoutSec 60` 可让 clumsy 60 秒后自动退出（防止忘关）。

## 三档 profile ↔ spec §4.6

| Profile     | spec 档位 | clumsy 模块参数                                        | 预期 demo 现象 |
|-------------|-----------|--------------------------------------------------------|----------------|
| `congested` | 拥塞      | bandwidth 限速 120 KB/s + drop 5%                      | 帧率下降、马赛克/卡顿、RTMP 码率被压 |
| `weak`      | 弱覆盖    | drop 15% + 乱序(ood) 25%                               | 明显丢帧、重传抖动、音频断续 |
| `latency`   | 高时延    | lag 300 ms（双向）                                     | 口型/声音整体滞后、E2E 延迟 +600ms 量级（RTT 双向各 300ms） |
| `off`       | —         | 杀掉 clumsy 进程                                       | 恢复正常 |

## 端口选择（影响哪条 OneLive 链路）

过滤器按端口生成：`tcp and (tcp.DstPort == P or tcp.SrcPort == P ...)`。

| `-Ports`    | 受损链路 |
|-------------|----------|
| `8900`      | 手机/采集端 ↔ PC 的 WS 媒体路径（`/ingest`、`/out`、`/stream.mjpeg`、`/stream.wav`）——demo 主目标 |
| `1935`      | ffmpeg → rtmp-sink 的 RTMP 推流路径 |
| `8900,1935` | 两条都损伤 |
| `8918`      | 测试专用 EchoPipeline（`tests/helpers/serve_echo.py --port 8918`），配合 `tools/out_probe.py` 做量化测量 |

## CLI 参数（已从 jagt/clumsy master 源码逐一核实，release 0.3）

上游 README/manual 只写 GUI；CLI 是通用 `--key value` 对（`src/utils.c parseArgs` 存成
IUP global，各模块启动时读取）。已核实的键：

- `--filter "<WinDivert 表达式>"`；`--timeout <秒>`（自动退出）
- 模块开关：`--lag|--drop|--throttle|--ood|--dup|--tamper|--reset|--bandwidth on`
- 每模块方向：`--<mod>-inbound on|off`、`--<mod>-outbound on|off`
- 参数：`--lag-time <ms>`、`--drop-chance <%>`、`--ood-chance <%>`、
  `--throttle-chance <%>`、`--throttle-frame <ms>`、`--bandwidth-bandwidth <KB/s>`
- **注意**：CLI（parameterized）模式下 clumsy 启动即开始过滤；若非管理员则**静默退出、
  不弹 UAC**（`src/elevate.c` tryElevate silent 分支）——所以 profiles.ps1 自己做提权检查。

congested 档用的是 0.3 新增的 bandwidth 模块（KB/s 直接限速，@skywind3000 PR#70），
比老 throttle（时间窗攒包）更贴合"带宽受限"语义。

## Loopback 注意事项（来自上游 manual "Limitations"）

- clumsy 明确支持 localhost→localhost（README："Works even if you're offline (ie,
  connecting from localhost to localhost)"）。
- 但 WFP 把**所有** loopback 包归类为 outbound：filter 里不能用 `inbound`（我们的
  filter 只按端口过滤，不带方向词，安全）。
- loopback 包会被处理**两次**（发送一次、接收一次）：纯 localhost 测试时 lag 300ms
  实际约 600ms、drop 5% 实际约 9.75%。手机↔PC 的 LAN 流量**不受**此加倍影响。
- 本机非 127.0.0.1 的自有 IP（如路由器分配的内网 IP）互发也算 loopback。

## get-clumsy.ps1

- 下载 `clumsy-0.3-win64-a.zip`（上游未发布校验和；脚本内置固定 SHA256
  `F50DC734148815831C67D9FC2C246C22D421C53DCEA51E26EEE905B0B2806C27`，不匹配即中止）。
- 解压到 `engine/netlab/clumsy/`（已 gitignore）。幂等：存在即跳过，`-Force` 重新下载。
- 0.3 发布了 a/b/c 三个 win64 包，仅 WinDivert 驱动签名不同（上游 issue #84）；
  若驱动加载失败换 `-Variant b` / `-Variant c`。

## OWNER 实测步骤（需要管理员，本仓库会话未提权，未实测）

管理员 PowerShell 一行进入：

```powershell
Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-Command',"cd '<repo>\engine\netlab'"
```

量化验证（latency 档为例）：

```powershell
# python 一律用 M0 venv 的全路径（venv 在 v2-m0-spike worktree，不在本 worktree；
# 或任何装齐 numpy/opencv/websockets/httpx 的 python 也行）：
$m0py = 'C:\Users\76475\Documents\OneLive\.worktrees\v2-m0-spike\engine\.venv\Scripts\python.exe'

# 终端A（普通权限即可，本 worktree 的 engine/ 下）：起 echo 服务
& $m0py tests\helpers\serve_echo.py --port 8918
# 终端B：基线到达统计
& $m0py -m tools.out_probe --url ws://127.0.0.1:8918/out --count 60 --latency-from-header
# 终端C（管理员）：施加 300ms lag（loopback 双倍 → 预期 +600ms 量级）
powershell -NoProfile -ExecutionPolicy Bypass -File netlab\profiles.ps1 -Profile latency -Ports 8918
# 终端B：复测，对比 fps / 延迟
& $m0py -m tools.out_probe --url ws://127.0.0.1:8918/out --count 60 --latency-from-header
# 终端C：恢复
powershell -NoProfile -ExecutionPolicy Bypass -File netlab\profiles.ps1 -Profile off
```

demo 现场则把 `-Ports` 换成 `8900`（WS）或 `8900,1935`（WS+RTMP），观察上表现象。
`off` 必须在启动 clumsy 的同一管理员会话里执行（普通权限杀不掉提权进程）。
