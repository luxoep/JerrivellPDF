# SPDX-License-Identifier: MIT OR Apache-2.0
# Match @tauri-apps/cli 2.12.4's official NSIS toolchain without using mirrors.
[CmdletBinding()]
param([string]$ToolsDirectory = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'tauri'))

$ErrorActionPreference = 'Stop'
$auraProject = Split-Path -Parent $PSScriptRoot
$auraDownloads = Join-Path $auraProject 'src-tauri\resources\downloads'
$auraCacheRoot = [IO.Path]::GetFullPath($ToolsDirectory)
$auraNsisCache = Join-Path $auraCacheRoot 'NSIS'
$auraSource = 'https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.12.4/crates/tauri-bundler/src/bundle/windows/nsis/mod.rs'

New-Item -ItemType Directory -Path $auraDownloads -Force | Out-Null
New-Item -ItemType Directory -Path $auraCacheRoot -Force | Out-Null

function Get-AuraFileHash {
    param([string]$Path, [ValidateSet('SHA1', 'SHA256')][string]$Algorithm)
    $auraHasher = if ($Algorithm -eq 'SHA1') { [Security.Cryptography.SHA1]::Create() } else { [Security.Cryptography.SHA256]::Create() }
    $auraStream = [IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($auraHasher.ComputeHash($auraStream)).Replace('-', '') }
    finally { $auraStream.Dispose(); $auraHasher.Dispose() }
}

function Get-AuraVerifiedDownload {
    param([string]$Url, [string]$Path, [string]$Sha1, [string]$Sha256)
    if (-not (Test-Path -LiteralPath $Path) -or (Get-AuraFileHash -Path $Path -Algorithm SHA256) -ne $Sha256) {
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path -TimeoutSec 180
    }
    if ((Get-AuraFileHash -Path $Path -Algorithm SHA1) -ne $Sha1 -or
        (Get-AuraFileHash -Path $Path -Algorithm SHA256) -ne $Sha256) {
        throw "Downloaded NSIS tool hash mismatch: $Path"
    }
}

$auraZip = Join-Path $auraDownloads 'nsis-3.13.zip'
$auraPlugin = Join-Path $auraDownloads 'nsis_tauri_utils-0.5.3.dll'
Get-AuraVerifiedDownload -Url 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip' -Path $auraZip `
    -Sha1 'DB14F8AF2EA346B786C6AE19343F61AAF5E09B8E' -Sha256 'BA63DFFC4410EE89193E1CB5A41989991BD77C61068DA17E3156D136B7B0B3D8'
Get-AuraVerifiedDownload -Url 'https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll' -Path $auraPlugin `
    -Sha1 '75197FEE3C6A814FE035788D1C34EAD39349B860' -Sha256 '5BA143B5DB4A87D32D6E7802E033330AAE56CBCEABE0D1E3BA41948385AD4709'

$auraRequired = @('makensis.exe', 'Bin/makensis.exe', 'Stubs/lzma-x86-unicode', 'Stubs/lzma_solid-x86-unicode',
    'Include/MUI2.nsh', 'Include/FileFunc.nsh', 'Include/x64.nsh', 'Include/nsDialogs.nsh', 'Include/WinMessages.nsh',
    'Include/Win/COM.nsh', 'Include/Win/Propkey.nsh', 'Include/Win/RestartManager.nsh')
$auraMissing = @($auraRequired | Where-Object { -not (Test-Path -LiteralPath (Join-Path $auraNsisCache $_)) })
$auraExe = Join-Path $auraNsisCache 'NSIS.exe'
$auraExeValid = (Test-Path -LiteralPath $auraExe) -and (Get-AuraFileHash -Path $auraExe -Algorithm SHA1) -eq '6D45D4E8CCF18FE1FDAC9164058F356102A2ECF2'
if ($auraMissing.Count -gt 0 -or -not $auraExeValid) {
    $auraExtract = Join-Path $auraDownloads 'nsis-3.13-verified-extract'
    # Reject traversal before extracting. This directory stays under the project download cache.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $auraArchive = [IO.Compression.ZipFile]::OpenRead($auraZip)
    try {
        foreach ($auraEntry in $auraArchive.Entries) {
            $auraName = $auraEntry.FullName.Replace('\', '/')
            if (-not $auraName.StartsWith('nsis-3.13/') -or $auraName.Contains(':') -or
                ($auraName.Split('/') -contains '..') -or $auraName.StartsWith('/')) {
                throw "Unsafe NSIS archive entry: $auraName"
            }
        }
    } finally { $auraArchive.Dispose() }
    Expand-Archive -LiteralPath $auraZip -DestinationPath $auraExtract -Force
    $auraExtractRoot = Join-Path $auraExtract 'nsis-3.13'
    New-Item -ItemType Directory -Path $auraNsisCache -Force | Out-Null
    Get-ChildItem -LiteralPath $auraExtractRoot -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $auraNsisCache -Recurse -Force
    }
}

$auraPluginDir = Join-Path $auraNsisCache 'Plugins\x86-unicode\additional'
New-Item -ItemType Directory -Path $auraPluginDir -Force | Out-Null
Copy-Item -LiteralPath $auraPlugin -Destination (Join-Path $auraPluginDir 'nsis_tauri_utils.dll') -Force

foreach ($auraRelative in $auraRequired) {
    if (-not (Test-Path -LiteralPath (Join-Path $auraNsisCache $auraRelative))) { throw "Missing NSIS file: $auraRelative" }
}
if ((Get-AuraFileHash -Path $auraExe -Algorithm SHA1) -ne '6D45D4E8CCF18FE1FDAC9164058F356102A2ECF2') { throw 'NSIS.exe hash mismatch' }
if ((Get-AuraFileHash -Path (Join-Path $auraPluginDir 'nsis_tauri_utils.dll') -Algorithm SHA1) -ne '75197FEE3C6A814FE035788D1C34EAD39349B860') { throw 'NSIS plugin hash mismatch' }

Write-Output "Verified NSIS 3.13 and nsis_tauri_utils 0.5.3: $auraNsisCache"
Write-Output "Tauri source: $auraSource"
& (Join-Path $auraNsisCache 'makensis.exe') /VERSION
if ($LASTEXITCODE -ne 0) { throw 'NSIS version check failed' }
