param(
    [string]$ExpectedSha256 = '73cc0de638ac2095e7445bf56a38200a5b7c7ca0e9f4ba144598f2457377ac08',
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
function Get-AuraSha256([string]$Path) {
    $taskHasher = [Security.Cryptography.SHA256]::Create()
    $taskStream = [IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($taskHasher.ComputeHash($taskStream)).Replace('-', '').ToLowerInvariant() }
    finally { $taskStream.Dispose(); $taskHasher.Dispose() }
}
$taskResources = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\src-tauri\resources'))
$taskNativeRoot = Join-Path $taskResources 'pdfium'
$taskManifestPath = Join-Path $taskNativeRoot 'aurapdf-runtime.json'
$taskDownloadRoot = Join-Path $taskResources 'downloads'
$taskArchive = Join-Path $taskDownloadRoot 'pdfium-win-x64-7881.tgz'
$taskUrl = 'https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F7881/pdfium-win-x64.tgz'

if (-not $Force -and (Test-Path -LiteralPath $taskManifestPath)) {
    $taskExisting = Get-Content -LiteralPath $taskManifestPath -Raw | ConvertFrom-Json
    $taskDll = Join-Path $taskNativeRoot 'bin\pdfium.dll'
    if ((Test-Path -LiteralPath $taskDll) -and ((Get-AuraSha256 $taskDll) -eq $taskExisting.dllSha256)) {
        Write-Output 'PDFium 7881 already prepared and its DLL hash matches the manifest.'
        exit 0
    }
}

New-Item -ItemType Directory -Path $taskNativeRoot -Force | Out-Null
New-Item -ItemType Directory -Path $taskDownloadRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $taskArchive) -or $Force) {
    Write-Output 'Downloading pinned PDFium chromium/7881 (Windows x64, third-party build)...'
    Invoke-WebRequest -Uri $taskUrl -OutFile $taskArchive
}
$taskArchiveHash = Get-AuraSha256 $taskArchive
if ($ExpectedSha256 -and $taskArchiveHash -ne $ExpectedSha256.ToLowerInvariant()) {
    throw 'PDFium archive checksum mismatch.'
}
$taskEntries = @(& tar.exe -tzf $taskArchive)
if ($LASTEXITCODE -ne 0) { throw 'Cannot read PDFium archive.' }
foreach ($taskEntry in $taskEntries) {
    $taskNormalized = $taskEntry.Replace('\', '/')
    if ($taskNormalized -match '^(/|[A-Za-z]:)' -or $taskNormalized -match '(^|/)\.\.(/|$)') {
        throw 'Archive contains an unsafe path.'
    }
}
& tar.exe -xzf $taskArchive -C $taskNativeRoot
if ($LASTEXITCODE -ne 0) { throw 'Cannot unpack PDFium archive.' }
$taskDll = Join-Path $taskNativeRoot 'bin\pdfium.dll'
if (-not (Test-Path -LiteralPath $taskDll)) { throw 'PDFium DLL missing after extraction.' }
$taskManifest = [ordered]@{
    source = 'bblanchon/pdfium-binaries'
    tag = 'chromium/7881'
    architecture = 'windows-x64'
    url = $taskUrl
    archiveSha256 = $taskArchiveHash
    dllSha256 = Get-AuraSha256 $taskDll
    preparedAtUtc = [DateTime]::UtcNow.ToString('o')
    note = 'Third-party precompiled PDFium. Upstream and bundled license files are retained alongside the runtime.'
}
$taskManifest | ConvertTo-Json | Set-Content -LiteralPath $taskManifestPath -Encoding utf8
Write-Output ('PDFium ready. Archive SHA-256: ' + $taskArchiveHash)
