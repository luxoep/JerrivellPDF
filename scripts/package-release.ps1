param()
$ErrorActionPreference = 'Stop'
function Get-AuraSha256([string]$Path) {
    $taskHasher = [Security.Cryptography.SHA256]::Create()
    $taskStream = [IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($taskHasher.ComputeHash($taskStream)).Replace('-', '').ToLowerInvariant() }
    finally { $taskStream.Dispose(); $taskHasher.Dispose() }
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskConfig = Get-Content -LiteralPath (Join-Path $taskRoot 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$taskVersion = $taskConfig.version
$taskRelease = Join-Path $taskRoot 'release'
$taskExe = Join-Path $taskRoot 'src-tauri\target\release\jerrivell-pdf.exe'
$taskInstaller = Join-Path $taskRoot "src-tauri\target\release\bundle\nsis\Jerrivell PDF_${taskVersion}_x64-setup.exe"
if (-not (Test-Path -LiteralPath $taskExe) -or -not (Test-Path -LiteralPath $taskInstaller)) {
    throw 'Build the release first: npm run build:desktop'
}
& node (Join-Path $PSScriptRoot 'check-release-gate.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Release verification gate did not pass; no release artifacts were copied.' }
New-Item -ItemType Directory -Force -Path $taskRelease | Out-Null
Copy-Item -LiteralPath $taskInstaller -Destination $taskRelease -Force

# Package only source/configuration/licensing files, never local build caches or user PDFs.
$taskSourceZip = Join-Path $taskRelease "Jerrivell-PDF-${taskVersion}-source.zip"
$taskZipStream = [IO.File]::Open($taskSourceZip, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite)
$taskArchive = [IO.Compression.ZipArchive]::new($taskZipStream, [IO.Compression.ZipArchiveMode]::Create)
try {
    $taskFiles = @(
        '.gitattributes', '.gitignore', 'index.html', 'compare.html', 'LICENSE', 'package.json', 'package-lock.json',
        'README.md', 'rust-toolchain.toml', 'LICENSE-MIT', 'LICENSE-APACHE', 'THIRD_PARTY_NOTICES.md', 'tsconfig.json', 'vite.config.ts',
        '启动Jerrivell.cmd', '启动开发版.cmd', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock',
        'fixtures/README.md', 'fixtures/sample.pdf', 'fixtures/second.pdf', 'fixtures/manifest.json',
        'src-tauri/build.rs', 'src-tauri/tauri.conf.json', 'src-tauri/windows-hooks.nsh'
    )
    foreach ($taskFolder in @('src', 'docs', 'licenses', 'scripts', 'tests', 'tools', 'src-tauri/src', 'src-tauri/icons', 'src-tauri/permissions', 'src-tauri/capabilities')) {
        $taskFolderPath = Join-Path $taskRoot $taskFolder
        $taskFiles += Get-ChildItem -LiteralPath $taskFolderPath -File -Recurse | Where-Object {
            $_.FullName -notmatch '[\\/]__pycache__[\\/]' -and $_.Extension -notin @('.pyc', '.pdf', '.dll', '.exe', '.tgz', '.zip', '.ttf', '.ttc', '.otf', '.woff', '.woff2', '.pfx', '.p12', '.pem', '.key')
        } | ForEach-Object { $_.FullName.Substring($taskRoot.Length + 1) }
    }
    foreach ($taskRelative in ($taskFiles | Sort-Object -Unique)) {
        $taskFilePath = Join-Path $taskRoot $taskRelative
        if (-not (Test-Path -LiteralPath $taskFilePath -PathType Leaf)) { throw "Missing source file: $taskRelative" }
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($taskArchive, $taskFilePath, $taskRelative.Replace('\', '/'), [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally { $taskArchive.Dispose() }
$taskManifest = [ordered]@{
    product = 'Jerrivell PDF'
    version = $taskVersion
    platform = 'windows-x86_64'
    license = 'MIT OR Apache-2.0'
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    installer = [ordered]@{ file = [IO.Path]::GetFileName($taskInstaller); sha256 = Get-AuraSha256 $taskInstaller }
    source = [ordered]@{ file = [IO.Path]::GetFileName($taskSourceZip); sha256 = Get-AuraSha256 $taskSourceZip }
    executableSha256 = Get-AuraSha256 $taskExe
    installedExecutable = $null
    cargoLockSha256 = Get-AuraSha256 (Join-Path $taskRoot 'src-tauri/Cargo.lock')
    npmLockSha256 = Get-AuraSha256 (Join-Path $taskRoot 'package-lock.json')
    pdfium = Get-Content -LiteralPath (Join-Path $taskRoot 'src-tauri/resources/pdfium/aurapdf-runtime.json') -Raw | ConvertFrom-Json
    thirdPartySourceSupplement = $null
    note = 'Unsigned development build. Project source archive excludes dependency caches and native binaries; pinned manifests and build instructions are included. The third-party source supplement covers the components listed in its manifest, upstream terms remain separate from the project MIT OR Apache-2.0 choice.'
}
$taskInstalledExe = Join-Path $taskRelease 'jerrivell-app/jerrivell-pdf.exe'
if (Test-Path -LiteralPath $taskInstalledExe -PathType Leaf) {
    $taskManifest.installedExecutable = [ordered]@{ file = 'jerrivell-app/jerrivell-pdf.exe'; sha256 = Get-AuraSha256 $taskInstalledExe }
}
$taskSourceSupplement = Join-Path $taskRelease "JerrivellPDF-${taskVersion}-third-party-sources.zip"
if (Test-Path -LiteralPath $taskSourceSupplement) {
    $taskManifest.thirdPartySourceSupplement = [ordered]@{ file = [IO.Path]::GetFileName($taskSourceSupplement); sha256 = Get-AuraSha256 $taskSourceSupplement }
}
$taskManifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskRelease 'release-manifest.json') -Encoding utf8
Write-Output "Release, project source archive and source-supplement records prepared in $taskRelease"
