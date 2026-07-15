[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("demo", "mock", "dev")]
    [string]$Mode = "demo",

    [ValidateRange(1, 65535)]
    [int]$Port = 5173,

    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

function Get-LanIPv4 {
    try {
        return [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
            Where-Object {
                $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
                -not [System.Net.IPAddress]::IsLoopback($_) -and
                -not $_.ToString().StartsWith("169.254.")
            } |
            Select-Object -First 1
    }
    catch {
        return $null
    }
}

function Invoke-Npm {
    param([string[]]$Arguments)

    & $script:NpmExecutable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) {
    throw "Node.js was not found. Install Node.js 20 LTS or newer and reopen PowerShell."
}

$Npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $Npm) {
    $Npm = Get-Command npm -ErrorAction SilentlyContinue
}
if (-not $Npm) {
    throw "npm was not found. Install npm with Node.js and reopen PowerShell."
}
$script:NpmExecutable = $Npm.Source

$NodeVersion = (& $Node.Source --version).Trim()
$NodeMajor = [int](($NodeVersion -replace '^v', '').Split('.')[0])
if ($NodeMajor -lt 20) {
    throw "OneLive requires Node.js 20 or newer. Current version: $NodeVersion"
}

Push-Location $ProjectRoot
try {
    Write-Host ""
    Write-Host "OneLive launcher" -ForegroundColor Cyan
    Write-Host "Project : $ProjectRoot"
    Write-Host "Mode    : $Mode"
    Write-Host "Node    : $NodeVersion"
    Write-Host "Port    : $Port"

    if (-not (Test-Path (Join-Path $ProjectRoot "node_modules"))) {
        if ($SkipInstall) {
            Write-Warning "node_modules is missing and -SkipInstall was used. Startup may fail."
        }
        else {
            Write-Host ""
            Write-Host "Installing dependencies..." -ForegroundColor Yellow
            Invoke-Npm -Arguments @("install")
        }
    }
    else {
        Write-Host "Dependencies found. Use npm install manually after package changes."
    }

    $env:PORT = $Port.ToString()
    $LanAddress = Get-LanIPv4

    switch ($Mode) {
        "demo" {
            $env:DEMO_HTTPS = "true"
            $env:DEMO_MOCK = "false"
            $NpmScript = "demo"
            $Scheme = "https"
        }
        "mock" {
            $env:DEMO_HTTPS = "false"
            $env:DEMO_MOCK = "true"
            $NpmScript = "demo:mock"
            $Scheme = "http"
        }
        "dev" {
            $env:DEMO_HTTPS = "false"
            $env:DEMO_MOCK = "false"
            $NpmScript = "dev"
            $Scheme = "http"
        }
    }

    Write-Host ""
    Write-Host ("Expected local URL: {0}://localhost:{1}" -f $Scheme, $Port) -ForegroundColor Green
    if ($LanAddress) {
        Write-Host ("Expected LAN URL  : {0}://{1}:{2}" -f $Scheme, $LanAddress, $Port) -ForegroundColor Green
    }
    else {
        Write-Host "LAN address could not be detected; use the URL printed by the OneLive server."
    }

    if ($Mode -eq "demo") {
        Write-Host ""
        Write-Host "Phone note:" -ForegroundColor Yellow
        Write-Host "  Open the LAN HTTPS URL on the phone once and accept the local certificate."
        Write-Host "  Then scan the session QR code shown in the control room."
        Write-Host "  If the phone or certificate fails, switch to Local Camera or Mock Source."
    }
    elseif ($Mode -eq "mock") {
        Write-Host ""
        Write-Host "Mock mode needs no phone, API key, or external network." -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "Starting npm run $NpmScript ..." -ForegroundColor Cyan
    Invoke-Npm -Arguments @("run", $NpmScript)
}
finally {
    Pop-Location
}
