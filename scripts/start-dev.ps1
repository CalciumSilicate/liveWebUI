[CmdletBinding()]
param(
  [string]$AdminPassword = "callmegpt",
  [string]$SessionSecret = "dev-session-secret-callmegpt-local",
  [int]$AppPort = 42110,
  [int]$WebPort = 5278,
  [int]$RtmpPort = 42111,
  [int]$HlsPort = 42112,
  [string]$PublicWebRtcHosts = "",
  [switch]$SkipInstall,
  [switch]$SkipStaticBuild,
  [switch]$SkipFetch
)

$ErrorActionPreference = "Stop"

[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
chcp 65001 > $null

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  throw "uv not found. Install uv first, then run: uv run scripts/dev.py"
}

$argsList = @(
  "run",
  "scripts/dev.py",
  "--admin-password", $AdminPassword,
  "--session-secret", $SessionSecret,
  "--app-port", "$AppPort",
  "--web-port", "$WebPort",
  "--rtmp-port", "$RtmpPort",
  "--hls-port", "$HlsPort"
)

if ($PublicWebRtcHosts) {
  $argsList += @("--public-webrtc-hosts", $PublicWebRtcHosts)
}

if ($SkipInstall) {
  $argsList += "--skip-install"
}

if ($SkipStaticBuild) {
  $argsList += "--skip-static-build"
}

if ($SkipFetch) {
  $argsList += "--skip-fetch"
}

Write-Host "Forwarding to single-terminal uv dev supervisor..."
Write-Host "Command: uv $($argsList -join ' ')"
& uv @argsList
