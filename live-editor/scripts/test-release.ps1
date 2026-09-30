[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Package,
    [string]$OutputRoot = '',
    [string]$ProjectRoot = ''
)
$ErrorActionPreference = 'Stop'
$Package = (Resolve-Path -LiteralPath $Package).Path
if (!$ProjectRoot) { $ProjectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
if (!$OutputRoot) { $OutputRoot = Join-Path (Join-Path $ProjectRoot '.tools\release-qa') ([IO.Path]::GetFileNameWithoutExtension($Package) + '-' + [Guid]::NewGuid().ToString('N')) }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $OutputRoot) { throw 'Extraction test requires a new empty destination.' }
$extension = [IO.Path]::GetExtension($Package).ToLowerInvariant()
if ($extension -notin @('.7z','.zip')) { throw 'Expected a portable ZIP or 7z. Test setup.exe with test-installer.ps1.' }
New-Item -ItemType Directory -Path $OutputRoot | Out-Null
$clock = [Diagnostics.Stopwatch]::StartNew()
$peakBytes = [long]0
if ($extension -eq '.zip') {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($Package, $OutputRoot)
} else {
$sevenZip = Join-Path $ProjectRoot '.tools\release-tools\7zip\7z.exe'
$process = Start-Process -FilePath $sevenZip -ArgumentList ('x "' + $Package + '" -o"' + $OutputRoot + '" -y') -WindowStyle Hidden -PassThru
$peakBytes = [long]0
try {
    while (!$process.HasExited) {
        $process.Refresh()
        $peakBytes = [Math]::Max($peakBytes, $process.PeakWorkingSet64)
        if ($clock.Elapsed.TotalSeconds -gt 120) { $process.Kill(); throw 'Portable extraction timed out.' }
        Start-Sleep -Milliseconds 100
    }
    if ($process.ExitCode -ne 0) { throw "Portable extraction failed: $($process.ExitCode)" }
} finally { $process.Dispose() }
}
$clock.Stop()
$manifests = @(Get-ChildItem -LiteralPath $OutputRoot -Recurse -File -Filter 'release-manifest.json')
if ($manifests.Count -ne 1) { throw 'Expected one release manifest.' }
# JSON is intentionally UTF-8. Explicit decoding is needed on Windows PowerShell 5.1.
$manifest = Get-Content -LiteralPath $manifests[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json
$layoutVersion = $manifest.layoutVersion
if ($layoutVersion -eq 2) {
    if ($manifest.componentDirectory -cne '程序组件' -or $manifests[0].Directory.Name -cne '程序组件') { throw 'Unexpected component directory.' }
    $componentRoot = $manifests[0].Directory.FullName
    $root = $manifests[0].Directory.Parent.FullName
    $expectedRootItems = @('录播机.exe', '使用说明.txt', '程序组件', '导出视频默认路径')
    $rootItems = @(Get-ChildItem -LiteralPath $root -Force)
    if ($rootItems.Count -ne $expectedRootItems.Count -or @($rootItems | Where-Object { $_.Name -cnotin $expectedRootItems }).Count) { throw 'Unexpected item in portable application root.' }
    foreach ($name in @('录播机.exe', '使用说明.txt')) {
        if (!(Test-Path -LiteralPath (Join-Path $root $name) -PathType Leaf)) { throw "Expected root file: $name" }
    }
    foreach ($name in @('程序组件', '导出视频默认路径')) {
        if (!(Test-Path -LiteralPath (Join-Path $root $name) -PathType Container)) { throw "Expected root directory: $name" }
    }
    $expectedEmptyDirectories = @('导出视频默认路径/完整素材', '导出视频默认路径/导出片段')
    if (@($manifest.emptyDirectories).Count -ne 2 -or @(Compare-Object $expectedEmptyDirectories @($manifest.emptyDirectories) -CaseSensitive).Count) { throw 'Unexpected default export directories in manifest.' }
    $exportRoot = Join-Path $root '导出视频默认路径'
    if (@(Get-ChildItem -LiteralPath $exportRoot -Force).Count -ne 2) { throw 'Unexpected item in default export directory.' }
    foreach ($relative in $expectedEmptyDirectories) {
        $directory = Join-Path $root $relative
        if (!(Test-Path -LiteralPath $directory -PathType Container) -or @(Get-ChildItem -LiteralPath $directory -Force).Count) { throw "Default export directory must exist and be empty: $relative" }
    }
    if (!(Test-Path -LiteralPath (Join-Path $componentRoot '录播机.exe.config') -PathType Leaf)) { throw 'Missing component desktop configuration.' }
} else { throw "Unsupported release layout: $layoutVersion" }
$prefix = $root.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
$outputPrefix = $OutputRoot.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
if ($root -ne $OutputRoot -and !$root.StartsWith($outputPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Release root escaped extraction destination.' }
$forbidden = '(?i)(^|/)(data|originals|chunks|archives|exports|videos?|desktop-profile|profiles?|logs|\.git|\.tools|node_modules|bin|obj)(/|$)|(^|/)\.env($|\.)|\.(db(?:-wal|-shm)?|sqlite(?:-wal|-shm)?|log|pdb|map|flv|mp4|mkv|webm|mp3|wav)$'
$listed = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
if (!@($manifest.files).Count) { throw 'Manifest contains no application files.' }
foreach ($file in $manifest.files) {
    $relative = [string]$file.path
    if ([string]::IsNullOrWhiteSpace($relative) -or $relative.Contains('\') -or $relative.Contains(':') -or [IO.Path]::IsPathRooted($relative) -or $relative -match '(^|/)\.\.(/|$)') { throw "Unsafe manifest path: $relative" }
    $path = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (!$path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest path escaped release.' }
    if ($relative -match $forbidden) { throw "Private/development path: $relative" }
    if (!$listed.Add($path)) { throw 'Duplicate manifest entry.' }
    $item = Get-Item -LiteralPath $path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Expected a regular file: $relative" }
    if ($item.Length -ne $file.bytes -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw "File mismatch: $relative" }
}
foreach ($item in Get-ChildItem -LiteralPath $root -Recurse -Force) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Link in application package: $($item.FullName)" }
    $relative = $item.FullName.Substring($prefix.Length).Replace('\','/')
    if ($relative -match $forbidden) { throw "Private/development path: $relative" }
    if (!$item.PSIsContainer -and $item.FullName -ne $manifests[0].FullName -and !$listed.Contains($item.FullName)) { throw "Unlisted file: $relative" }
}
'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(":memory:"); console.log(db.prepare("select 1 as ok").get()); db.close();' | & (Join-Path $componentRoot 'runtime\node\node.exe') --input-type=module -
if ($LASTEXITCODE -ne 0) { throw 'Bundled Node/SQLite check failed.' }
& (Join-Path $componentRoot 'runtime\ffmpeg\ffmpeg.exe') -v error -f lavfi -i 'color=size=64x64:rate=60:duration=0.1' -c:v libx264 -f null -
if ($LASTEXITCODE -ne 0) { throw 'Bundled FFmpeg encode check failed.' }
$result = [ordered]@{ package=[IO.Path]::GetFileName($Package); sha256=(Get-FileHash -LiteralPath $Package -Algorithm SHA256).Hash.ToLowerInvariant(); layoutVersion=$layoutVersion; extractSeconds=[Math]::Round($clock.Elapsed.TotalSeconds,3); extractionPeakWorkingSetBytes=$peakBytes; verifiedFiles=$listed.Count; extractedRoot=$root; componentRoot=$componentRoot; emptyExportDirectories=if ($layoutVersion -eq 2) { 'passed' } else { 'not-applicable' }; nodeSQLite='passed'; softwareEncode='passed' }
$result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputRoot 'verification.json') -Encoding UTF8
$result | ConvertTo-Json
