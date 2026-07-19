# run-demo.ps1 — OneLive V2 本地一键演示（零成本，本机核显）
#
# 用法（普通 PowerShell 即可，不需要管理员）：
#   cd C:\Users\76475\Documents\OneLive\engine
#   powershell -NoProfile -ExecutionPolicy Bypass -File run-demo.ps1
#
# 起来后浏览器开两个页：
#   http://127.0.0.1:8900/console    ← 导播控制台（评委看的那屏）
#   http://127.0.0.1:8900/capture    ← 采集页：点“开始”授权摄像头，把你的画面推给引擎
# 停止：本窗口按 Ctrl+C。
#
# 说明：--translate-stub 是测试脚手架（占位翻译，非真翻译），仅为让你看到
#       字幕→翻译→TTS→口型 整条链路。真翻译要 AI_API_KEY（OWNER 项）。

$ErrorActionPreference = 'Stop'
$Repo   = 'C:\Users\76475\Documents\OneLive'
$M0Py   = Join-Path $Repo '.worktrees\v2-m0-spike\engine\.venv\Scripts\python.exe'
$Engine = Join-Path $Repo 'engine'
$SrcDir = Join-Path $Repo '.worktrees\v2-m0-spike\engine\FasterLivePortrait\assets\examples\source'
$Source = Join-Path $SrcDir 's0.jpg'
$Port   = 8900

if (-not (Test-Path $M0Py))   { Write-Error "M0 venv python 不在：$M0Py（M0 spike worktree 是否还在？）"; exit 1 }
if (-not (Test-Path $Source)) { Write-Error "默认底图不在：$Source"; exit 1 }

Write-Host "== OneLive V2 本地演示 ==" -ForegroundColor Cyan
Write-Host "底图: $Source"
Write-Host "控制台: http://127.0.0.1:$Port/console"
Write-Host "采集页: http://127.0.0.1:$Port/capture  (点开始→授权摄像头→你的画面驱动数字人)"
Write-Host "停止:   Ctrl+C" -ForegroundColor Yellow
Write-Host ""

$env:PYTHONPATH = '.'
Set-Location $Engine
& $M0Py -m service.run_local --port $Port --source $Source --translate-stub
