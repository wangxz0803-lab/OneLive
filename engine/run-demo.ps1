# run-demo.ps1 — OneLive 一键演示（零成本，本机核显）
#
# 用法（普通 PowerShell，不需要管理员）：
#   cd C:\Users\76475\Documents\OneLive\engine
#   powershell -NoProfile -ExecutionPolicy Bypass -File run-demo.ps1
#
# 起来后自动打开浏览器到导播控制台 /studio。
# 默认会循环喂一段驱动视频，让数字人一直在动（不想要就加 -NoFeed，
# 然后自己开 /capture 用摄像头驱动）。
#
# 停止：本窗口按 Ctrl+C（引擎与喂帧一起收）。

param(
  [int]$Port = 8900,
  [switch]$NoFeed,        # 不自动喂驱动视频（改用摄像头 /capture 驱动）
  [switch]$NoBrowser,     # 不自动开浏览器
  [string]$Source,        # 底图（默认用 M0 示例 s0.jpg）
  [int]$Channels = 1      # 频道数；>1 时本地会更慢，但三路是真的
)

$ErrorActionPreference = 'Stop'

$Repo   = Split-Path -Parent $PSScriptRoot
$Engine = Join-Path $Repo 'engine'
$M0     = Join-Path $Repo '.worktrees\v2-m0-spike\engine'
$M0Py   = Join-Path $M0 '.venv\Scripts\python.exe'
$Assets = Join-Path $M0 'FasterLivePortrait\assets\examples'
if (-not $Source) { $Source = Join-Path $Assets 'source\s0.jpg' }
$Driving = Join-Path $Assets 'driving\d14.mp4'

if (-not (Test-Path $M0Py))    { Write-Error "M0 venv python 不在：$M0Py"; exit 1 }
if (-not (Test-Path $Source))  { Write-Error "底图不在：$Source"; exit 1 }

$env:PYTHONPATH = '.'
Set-Location $Engine

Write-Host ''
Write-Host '  OneLive 演示环境' -ForegroundColor Cyan
Write-Host '  ----------------'
Write-Host "  底图    : $Source"
Write-Host "  频道数  : $Channels"
Write-Host "  驱动画面: $(if ($NoFeed) { '关闭（请开 /capture 用摄像头驱动）' } else { '自动循环喂 d14.mp4' })"
Write-Host ''

# ---- 启动引擎 ----
$engineArgs = @('-m','service.run_local','--port',"$Port",'--source',"$Source")
if ($Channels -gt 1) { $engineArgs += @('--channels',"$Channels") }
Write-Host '  正在加载数字人模型（约 10-30 秒）…' -ForegroundColor DarkGray
$engine = Start-Process -FilePath $M0Py -ArgumentList $engineArgs `
                        -WorkingDirectory $Engine -PassThru -NoNewWindow

# ---- 等就绪 ----
$ready = $false
foreach ($i in 1..60) {
  Start-Sleep -Milliseconds 700
  if ($engine.HasExited) { Write-Error '引擎进程意外退出，请看上方报错。'; exit 1 }
  try {
    if ((Invoke-WebRequest "http://127.0.0.1:$Port/status" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) {
      $ready = $true; break
    }
  } catch { }
}
if (-not $ready) { Stop-Process -Id $engine.Id -Force -EA SilentlyContinue; Write-Error '引擎启动超时。'; exit 1 }
Write-Host '  引擎就绪 ✓' -ForegroundColor Green

# ---- 循环喂驱动画面（让数字人一直动）----
$feeder = $null
if (-not $NoFeed) {
  if (Test-Path $Driving) {
    # 用独立子进程循环喂（Start-Job 在部分环境下不可靠，这里直接起进程好排查、好收尾）
    $inner = "`$env:PYTHONPATH='.'; Set-Location '$Engine'; " +
             "while (`$true) { & '$M0Py' -m service.feeder --url 'ws://127.0.0.1:$Port/ingest' " +
             "--video '$Driving' --fps 10 *> `$null; Start-Sleep -Milliseconds 300 }"
    $feeder = Start-Process powershell `
      -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-Command',$inner `
      -PassThru
    Write-Host '  驱动画面已开始循环喂入 ✓' -ForegroundColor Green
  } else {
    Write-Host "  找不到驱动视频，跳过：$Driving" -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host '  打开这些页面：' -ForegroundColor Cyan
Write-Host "    http://127.0.0.1:$Port/studio    导播控制台（实时画面 + 真实遥测）"
Write-Host "    http://127.0.0.1:$Port/capture   采集页（点开始，用你的摄像头驱动数字人）"
Write-Host "    http://127.0.0.1:$Port/console   工程控制台"
Write-Host ''
Write-Host '  停止：本窗口 Ctrl+C' -ForegroundColor Yellow
Write-Host ''

if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$Port/studio" }

# ---- 前台守候，Ctrl+C 时把引擎与喂帧一起收掉 ----
try {
  while (-not $engine.HasExited) { Start-Sleep -Seconds 1 }
} finally {
  Write-Host ''
  Write-Host '  正在停止…' -ForegroundColor DarkGray
  if ($feeder) { & taskkill /F /T /PID $feeder.Id *> $null }   # /T 连子 python 一起收
  Get-Process -Id $engine.Id -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
  Write-Host '  已停止。' -ForegroundColor DarkGray
}
