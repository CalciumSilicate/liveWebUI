[CmdletBinding()]
param(
  [string]$Version = "1.17.1",
  [ValidateSet("amd64", "arm64")]
  [string]$Arch = "amd64"
)

$ErrorActionPreference = "Stop"

[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
chcp 65001 > $null

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$targetDir = Join-Path $root "vendor/mediamtx"
$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "livewebui-mediamtx-$Version-$Arch"
$asset = "mediamtx_v${Version}_windows_${Arch}.zip"
$url = "https://github.com/bluenviron/mediamtx/releases/download/v${Version}/${asset}"
$archive = Join-Path $tmpDir $asset

New-Item -ItemType Directory -Force -Path $targetDir, $tmpDir > $null

Write-Host "Downloading MediaMTX v$Version for Windows $Arch..."
Invoke-WebRequest -Uri $url -OutFile $archive

Remove-Item -LiteralPath (Join-Path $targetDir "*") -Force -Recurse -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $archive -DestinationPath $targetDir -Force

Set-Content -LiteralPath (Join-Path $targetDir "VERSION") -Value $Version -Encoding UTF8
Set-Content -LiteralPath (Join-Path $targetDir "ARCH") -Value "windows-$Arch" -Encoding UTF8

Write-Host "Fetched MediaMTX v$Version into $targetDir"
