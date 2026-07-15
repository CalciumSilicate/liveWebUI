[CmdletBinding()]
param(
  [int]$AppPort = 42110,
  [int]$RtmpPort = 42111,
  [int]$HlsPort = 42112,
  [int]$WebRtcPort = 42113,
  [int]$WebRtcUdpPort = 42114,
  [int]$WebRtcTcpPort = 42115,
  [string]$PublicWebRtcHosts = "127.0.0.1,localhost",
  [switch]$FetchIfMissing
)

$ErrorActionPreference = "Stop"

[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
chcp 65001 > $null

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$mediamtxExe = Join-Path $root "vendor/mediamtx/mediamtx.exe"

if (-not (Test-Path -LiteralPath $mediamtxExe)) {
  if (-not $FetchIfMissing) {
    throw "MediaMTX not found at $mediamtxExe. Run scripts/fetch-mediamtx.ps1 first."
  }

  & (Join-Path $PSScriptRoot "fetch-mediamtx.ps1")
}

$configPath = Join-Path $root "vendor/mediamtx/mediamtx.local.yml"
$hosts = $PublicWebRtcHosts.Split(",") |
  ForEach-Object { $_.Trim() } |
  Where-Object { $_.Length -gt 0 } |
  ForEach-Object { "  - $_" }

if (-not $hosts) {
  $hosts = @("  - 127.0.0.1")
}

$config = @"
logLevel: info

readTimeout: 10s
writeTimeout: 10s
writeQueueSize: 512

authMethod: http
authHTTPAddress: http://127.0.0.1:$AppPort/internal/mediamtx/auth
authHTTPExclude:
  - action: api
  - action: metrics
  - action: pprof

api: true
apiAddress: :9997
apiAllowOrigins: ['*']

rtmp: true
rtmpAddress: :$RtmpPort

hls: true
hlsAddress: :$HlsPort
hlsAllowOrigins: ['*']
hlsAlwaysRemux: false
hlsVariant: fmp4
hlsSegmentCount: 6
hlsSegmentDuration: 2s
hlsPartDuration: 500ms
hlsMuxerCloseAfter: 20s

webrtc: true
webrtcAddress: :$WebRtcPort
webrtcAllowOrigins: ['*']
webrtcLocalUDPAddress: :$WebRtcUdpPort
webrtcLocalTCPAddress: :$WebRtcTcpPort
webrtcIPsFromInterfaces: false
webrtcAdditionalHosts:
$($hosts -join "`n")

paths:
  all:
    source: publisher
"@

[System.IO.File]::WriteAllText($configPath, $config, [System.Text.UTF8Encoding]::new($false))

Write-Host "Starting MediaMTX with local config:"
Write-Host "  RTMP:   rtmp://0.0.0.0:$RtmpPort"
Write-Host "  HLS:    http://127.0.0.1:$HlsPort"
Write-Host "  WebRTC: http://127.0.0.1:$WebRtcPort"
Write-Host "  Auth:   http://127.0.0.1:$AppPort/internal/mediamtx/auth"

& $mediamtxExe $configPath
