# get-clumsy.ps1 -- download clumsy (WinDivert-based network impairment tool) for OneLive netlab.
#
# Idempotent: skips download when engine/netlab/clumsy/clumsy.exe already exists (use -Force to re-fetch).
# The upstream release publishes no checksums, so we pin the SHA256 we observed on first download
# (2026-07-18) for the default variant and fail hard on mismatch.
#
# clumsy 0.3 ships three win64 zips (a/b/c) that differ only in the WinDivert driver signature
# (github.com/jagt/clumsy/issues/84). If the driver refuses to load on your machine, retry with
# -Variant b or -Variant c (their SHA256 is not pinned; the script prints what it got).
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File engine\netlab\get-clumsy.ps1 [-Variant a|b|c] [-Force]

[CmdletBinding()]
param(
    [ValidateSet('a', 'b', 'c')]
    [string]$Variant = 'a',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$Version = '0.3'
# SHA256 observed 2026-07-18 for clumsy-0.3-win64-a.zip (no upstream checksum published).
$PinnedSha256 = @{
    'a' = 'F50DC734148815831C67D9FC2C246C22D421C53DCEA51E26EEE905B0B2806C27'
}

$NetlabDir = $PSScriptRoot
$DestDir   = Join-Path $NetlabDir 'clumsy'
$ExePath   = Join-Path $DestDir 'clumsy.exe'
$ZipName   = "clumsy-$Version-win64-$Variant.zip"
$ZipPath   = Join-Path $NetlabDir $ZipName
$Url       = "https://github.com/jagt/clumsy/releases/download/$Version/$ZipName"

if ((Test-Path $ExePath) -and -not $Force) {
    Write-Host "[get-clumsy] already present: $ExePath (use -Force to re-download)"
    exit 0
}

Write-Host "[get-clumsy] downloading $Url"
Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing

$ActualSha256 = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash
Write-Host "[get-clumsy] SHA256: $ActualSha256"

if ($PinnedSha256.ContainsKey($Variant)) {
    if ($ActualSha256 -ne $PinnedSha256[$Variant]) {
        Remove-Item $ZipPath -Force
        throw "[get-clumsy] SHA256 mismatch for $ZipName. Expected $($PinnedSha256[$Variant]), got $ActualSha256. Aborting."
    }
    Write-Host "[get-clumsy] SHA256 matches pinned value."
} else {
    Write-Host "[get-clumsy] no pinned SHA256 for variant '$Variant'; record the hash above."
}

if (Test-Path $DestDir) { Remove-Item $DestDir -Recurse -Force }
Expand-Archive -Path $ZipPath -DestinationPath $DestDir -Force
Remove-Item $ZipPath -Force

if (-not (Test-Path $ExePath)) {
    throw "[get-clumsy] extraction finished but $ExePath is missing -- zip layout changed?"
}

Write-Host "[get-clumsy] installed to $DestDir"
Get-ChildItem $DestDir | ForEach-Object { Write-Host "  $($_.Name)" }
