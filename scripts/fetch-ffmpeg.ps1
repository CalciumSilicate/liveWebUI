[CmdletBinding()]
param(
  [string]$Url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-8.1.zip"
)

$ErrorActionPreference = "Stop"

[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
chcp 65001 > $null

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$targetDir = Join-Path $root "vendor/ffmpeg"
$binDir = Join-Path $targetDir "bin"
$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "livewebui-ffmpeg"
$archive = Join-Path $tmpDir "ffmpeg.zip"
$extractDir = Join-Path $tmpDir "extract"

New-Item -ItemType Directory -Force -Path $targetDir, $binDir, $tmpDir > $null
Remove-Item -LiteralPath $extractDir -Force -Recurse -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $extractDir > $null

Write-Host "Downloading FFmpeg for Windows..."
Invoke-WebRequest -Uri $Url -OutFile $archive
Expand-Archive -LiteralPath $archive -DestinationPath $extractDir -Force

$ffmpeg = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
$ffprobe = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter "ffprobe.exe" | Select-Object -First 1

if (-not $ffmpeg) {
  throw "ffmpeg.exe not found in downloaded archive."
}

Copy-Item -LiteralPath $ffmpeg.FullName -Destination (Join-Path $binDir "ffmpeg.exe") -Force
if ($ffprobe) {
  Copy-Item -LiteralPath $ffprobe.FullName -Destination (Join-Path $binDir "ffprobe.exe") -Force
}

[System.IO.File]::WriteAllText((Join-Path $targetDir "SOURCE_URL"), $Url, [System.Text.UTF8Encoding]::new($false))

Write-Host "Fetched FFmpeg into $binDir"
