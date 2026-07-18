# profiles.ps1 -- launch clumsy with a named impairment profile against OneLive media ports.
#
# Profiles (spec section 4.6 three tiers):
#   congested : bandwidth cap 120 KB/s + drop 5%        (拥塞)
#   weak      : drop 15% + out-of-order 25%             (弱覆盖)
#   latency   : lag 300 ms each direction               (高时延)
#   off       : stop any running clumsy instance
#
# clumsy CLI contract (verified against jagt/clumsy master src, release 0.3):
#   generic "--key value" pairs; toggles take on/off; --filter takes a WinDivert expression.
#   Module keys: lag(-time), drop(-chance), ood(-chance), bandwidth(-bandwidth, KB/s),
#   plus <mod>-inbound / <mod>-outbound toggles. Global: --timeout <seconds>.
#   In CLI (parameterized) mode clumsy starts filtering immediately, and if NOT elevated it
#   exits silently without a UAC prompt (src/elevate.c tryElevate silent path) -- hence the
#   explicit elevation check below.
#
# Loopback caveat: WinDivert classifies ALL loopback packets as outbound, and clumsy processes
# them twice (send + receive). For pure-loopback testing keep both direction toggles on and
# remember effective lag/drop is roughly doubled; for LAN (phone <-> PC) traffic this does not apply.
#
# Usage examples (elevated PowerShell):
#   .\profiles.ps1 -Profile latency   -Ports 8900
#   .\profiles.ps1 -Profile congested -Ports 8900,1935
#   .\profiles.ps1 -Profile off
#   .\profiles.ps1 -Profile weak -DryRun          # prints the command line, no elevation needed

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('congested', 'weak', 'latency', 'off')]
    [string]$Profile,

    # Accepted as strings then split on ',' -- when invoked via `powershell -File`, an argument
    # like "8900,1935" arrives as ONE string, and a direct [int[]] cast would culture-parse the
    # comma as a thousands separator (8900,1935 -> 89001935).
    [ValidateCount(1, 16)]
    [string[]]$Ports = @('8900'),

    # Auto-stop after N seconds (0 = run until 'off' / window closed).
    [ValidateRange(0, 86400)]
    [int]$TimeoutSec = 0,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$ExePath = Join-Path $PSScriptRoot 'clumsy\clumsy.exe'

function Test-Elevated {
    $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ---- off: kill clumsy and exit -------------------------------------------------------------
if ($Profile -eq 'off') {
    if ($DryRun) {
        Write-Host '[netlab] DRY-RUN: Stop-Process -Name clumsy -Force'
        exit 0
    }
    $procs = Get-Process -Name clumsy -ErrorAction SilentlyContinue
    if (-not $procs) {
        Write-Host '[netlab] off: no clumsy process running.'
        exit 0
    }
    # clumsy runs elevated, so killing it also needs elevation.
    if (-not (Test-Elevated)) {
        Write-Error "[netlab] clumsy is running elevated; stopping it requires an elevated shell. Run this in the same admin PowerShell you started it from."
        exit 1
    }
    $procs | Stop-Process -Force
    Write-Host "[netlab] off: stopped clumsy (pid $($procs.Id -join ', '))."
    exit 0
}

# ---- normalize + validate ports ------------------------------------------------------------
$PortList = @($Ports -split ',' | Where-Object { $_ -ne '' } | ForEach-Object {
    $n = 0
    if (-not [int]::TryParse($_.Trim(), [ref]$n) -or $n -lt 1 -or $n -gt 65535) {
        Write-Error "[netlab] invalid port '$_' (expected 1-65535)"
        exit 1
    }
    $n
})

# ---- build WinDivert filter from ports -----------------------------------------------------
$portTerms = foreach ($p in $PortList) { "tcp.DstPort == $p or tcp.SrcPort == $p" }
$filter = 'tcp and (' + ($portTerms -join ' or ') + ')'

# ---- profile -> clumsy module arguments ----------------------------------------------------
switch ($Profile) {
    'congested' {
        $moduleArgs = @(
            '--bandwidth', 'on', '--bandwidth-inbound', 'on', '--bandwidth-outbound', 'on',
            '--bandwidth-bandwidth', '120',   # KB/s cap (clumsy 0.3 bandwidth module)
            '--drop', 'on', '--drop-inbound', 'on', '--drop-outbound', 'on',
            '--drop-chance', '5'
        )
    }
    'weak' {
        $moduleArgs = @(
            '--drop', 'on', '--drop-inbound', 'on', '--drop-outbound', 'on',
            '--drop-chance', '15',
            '--ood', 'on', '--ood-inbound', 'on', '--ood-outbound', 'on',
            '--ood-chance', '25'
        )
    }
    'latency' {
        $moduleArgs = @(
            '--lag', 'on', '--lag-inbound', 'on', '--lag-outbound', 'on',
            '--lag-time', '300'
        )
    }
}

$clumsyArgs = @('--filter', $filter) + $moduleArgs
if ($TimeoutSec -gt 0) { $clumsyArgs += @('--timeout', "$TimeoutSec") }

# Quote for display / Start-Process (only the filter contains spaces).
$displayArgs = ($clumsyArgs | ForEach-Object { if ($_ -match '\s') { '"{0}"' -f $_ } else { $_ } }) -join ' '

if ($DryRun) {
    Write-Host "[netlab] DRY-RUN profile=$Profile ports=$($PortList -join ',')"
    Write-Host "[netlab] filter: $filter"
    Write-Host "[netlab] command: `"$ExePath`" $displayArgs"
    exit 0
}

if (-not (Test-Path $ExePath)) {
    Write-Error "[netlab] clumsy.exe not found at $ExePath. Run engine\netlab\get-clumsy.ps1 first."
    exit 1
}

if (-not (Test-Elevated)) {
    Write-Error "[netlab] clumsy needs Administrator. Open an elevated PowerShell and run:`n  powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Profile $Profile -Ports $($PortList -join ',')"
    exit 1
}

# Only one clumsy instance can hold the WinDivert handle -- replace any running one.
$existing = Get-Process -Name clumsy -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[netlab] replacing running clumsy (pid $($existing.Id -join ', '))."
    $existing | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

Write-Host "[netlab] starting profile=$Profile"
Write-Host "[netlab] command: `"$ExePath`" $displayArgs"
$proc = Start-Process -FilePath $ExePath -ArgumentList $displayArgs -PassThru
Start-Sleep -Milliseconds 1200
if ($proc.HasExited) {
    Write-Error "[netlab] clumsy exited immediately (code $($proc.ExitCode)). Filter syntax error or WinDivert driver failure -- try get-clumsy.ps1 -Variant b."
    exit 1
}
Write-Host "[netlab] clumsy running (pid $($proc.Id)). Stop with: .\profiles.ps1 -Profile off"
