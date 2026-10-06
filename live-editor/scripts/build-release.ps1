[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ProjectRoot,
    [string]$ToolsRoot = '',
    [string]$OutputRoot = '',
    [string]$AppRoot = '',
    [string]$DesktopRoot = '',
    [string]$RuntimeRoot = '',
    [string]$NuGetRoot = '',
    [string]$FFmpegRoot = '',
    [string]$Version = '0.1.9',
    [switch]$ForPublic,
    [string]$SourceUrl = '',
    [switch]$Include7z,
    [long]$MaxDownloadBytes = 100000000
)
$ErrorActionPreference = 'Stop'
if ($ForPublic) {
    $sourceUri = $null
    if (![Uri]::TryCreate($SourceUrl, [UriKind]::Absolute, [ref]$sourceUri) -or $sourceUri.Scheme -ne 'https') { throw 'A public build requires -SourceUrl linking the complete corresponding source of this modified project.' }
    if ($SourceUrl.TrimEnd('/') -eq 'https://github.com/BililiveRecorder/BililiveRecorder') { throw 'The upstream repository does not contain these editor modifications; supply this release source archive/tag.' }
}
if (!$AppRoot) { $AppRoot = Split-Path $PSScriptRoot -Parent }
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$AppRoot = (Resolve-Path -LiteralPath $AppRoot).Path
if (!$ToolsRoot) { $ToolsRoot = Join-Path $ProjectRoot '.tools\release-tools' }
if (!$OutputRoot) { $OutputRoot = Join-Path $ProjectRoot '.tools\release-work' }
$ToolsRoot = (Resolve-Path -LiteralPath $ToolsRoot).Path
if (!$DesktopRoot) { $DesktopRoot = $ProjectRoot }
$DesktopRoot = (Resolve-Path -LiteralPath $DesktopRoot).Path
# RuntimeRoot names the runtime directory itself, not the source repository.
# Support both a developer checkout and a checkout kept in the app's source folder.
if (!$RuntimeRoot) {
    $runtimeCandidates = @(
        (Join-Path $ProjectRoot '程序组件\runtime'),
        (Join-Path $ProjectRoot 'runtime'),
        (Join-Path (Split-Path $ProjectRoot -Parent) '程序组件\runtime')
    )
    foreach ($candidate in $runtimeCandidates) {
        if ((Test-Path -LiteralPath (Join-Path $candidate 'node\node.exe') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $candidate 'recorder\BililiveRecorder.Cli.dll') -PathType Leaf)) {
            $RuntimeRoot = $candidate
            break
        }
    }
    if (!$RuntimeRoot) { throw 'Runtime not found. Supply -RuntimeRoot pointing to the directory containing node and recorder.' }
}
$RuntimeRoot = (Resolve-Path -LiteralPath $RuntimeRoot).Path
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
# License lookup is read-only. A fresh project cache can fall back to packages
# already restored elsewhere without copying or changing the shared cache.
$nuGetCandidates = @($NuGetRoot, $env:NUGET_PACKAGES, (Join-Path $ProjectRoot '.tools\nuget\packages'))
if ($env:USERPROFILE) { $nuGetCandidates += (Join-Path $env:USERPROFILE '.nuget\packages') }
$nuGetRoots = @($nuGetCandidates | Where-Object { ![string]::IsNullOrWhiteSpace($_) } | ForEach-Object { [IO.Path]::GetFullPath($_) } | Select-Object -Unique)
function Find-NuGetPackage([string]$Package, [string]$PackageVersion, [string]$RequiredFile = '') {
    foreach ($candidateRoot in $nuGetRoots) {
        $candidate = Join-Path $candidateRoot ($Package + '\' + $PackageVersion)
        if (!(Test-Path -LiteralPath $candidate -PathType Container)) { continue }
        if ($RequiredFile -and !(Test-Path -LiteralPath (Join-Path $candidate $RequiredFile) -PathType Leaf)) { continue }
        return $candidate
    }
    throw "Missing dependency metadata: $Package/$PackageVersion. Restore the pinned dependencies or provide -NuGetRoot."
}
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') { throw 'Invalid release version.' }
$name = "BiliLiveEditor-$Version-win-x64"
$stage = Join-Path $OutputRoot $name
$componentDirectory = '程序组件'
$componentRoot = Join-Path $stage $componentDirectory
$emptyDirectories = @('导出视频默认路径/完整素材', '导出视频默认路径/导出片段')
# A new destination is required: never recursively delete or reuse user data.
foreach ($target in @($stage, "$stage.7z", "$stage.zip", "$stage-setup.exe")) {
    if (Test-Path -LiteralPath $target) { throw "Release target already exists: $target" }
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$forbidden = '(?i)(^|/)(data|originals|chunks|archives|exports|videos?|desktop-profile|profiles?|logs|\.git|\.tools|node_modules|bin|obj)(/|$)|(^|/)\.env($|\.)|\.(db(?:-wal|-shm)?|sqlite(?:-wal|-shm)?|log|pdb|map|flv|mp4|mkv|webm|mp3|wav)$'
function Add-File([string]$source, [string]$relative) {
    $relative = $relative.Replace('\','/')
    if ($relative -match $forbidden -or $relative -match '(^|/)\.\.(/|$)' -or $relative.Contains(':') -or [IO.Path]::IsPathRooted($relative)) { throw "Forbidden release path: $relative" }
    $sourceFile = Get-Item -LiteralPath $source
    if ($sourceFile.PSIsContainer -or ($sourceFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Expected a regular file: $source" }
    $destination = Join-Path $stage $relative
    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
    Copy-Item -LiteralPath $sourceFile.FullName -Destination $destination
}
function Add-ComponentFile([string]$source, [string]$relative) {
    Add-File $source ($componentDirectory + '/' + $relative)
}
function Write-Text([string]$relative, [string]$text) {
    $destination = Join-Path $stage $relative
    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
    [IO.File]::WriteAllText($destination, $text, [Text.UTF8Encoding]::new($false))
}
$desktopVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $DesktopRoot '录播机.exe'))
if ($desktopVersion.ProductName -ne '菜播·录包机' -or $desktopVersion.ProductVersion -ne $Version) { throw 'Desktop executable does not match the requested application release version.' }
Add-File (Join-Path $DesktopRoot '录播机.exe') '录播机.exe'
Add-ComponentFile (Join-Path $DesktopRoot '程序组件\录播机.exe.config') '录播机.exe.config'
# Create fresh, empty destinations. Never copy files from a user's export folders.
foreach ($relative in $emptyDirectories) { New-Item -ItemType Directory -Path (Join-Path $stage $relative) -Force | Out-Null }
Add-ComponentFile (Join-Path $ProjectRoot 'LICENSE') 'LICENSE'
Add-ComponentFile (Join-Path $ProjectRoot 'THIRD_PARTY_NOTICES.md') 'licenses/THIRD_PARTY_NOTICES.md'
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $AppRoot 'docs\licenses') -File -Filter '*.txt') { Add-ComponentFile $file.FullName ('licenses/douyin/' + $file.Name) }
Add-ComponentFile (Join-Path $AppRoot 'package.json') 'live-editor/package.json'
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $AppRoot 'server') -File -Filter '*.js') { Add-ComponentFile $file.FullName ('live-editor/server/' + $file.Name) }
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $AppRoot 'shared') -File -Filter '*.js') { Add-ComponentFile $file.FullName ('live-editor/shared/' + $file.Name) }
Add-ComponentFile (Join-Path $AppRoot 'dist\index.html') 'live-editor/dist/index.html'
# Only reachable build assets are included, so old hashed bundles cannot accumulate.
$assets = [Collections.Generic.Queue[string]]::new()
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$assets.Enqueue('index.html')
while ($assets.Count) {
    $relative = $assets.Dequeue()
    if (!$seen.Add($relative)) { continue }
    $source = Join-Path (Join-Path $AppRoot 'dist') $relative
    if ($relative -ne 'index.html') { Add-ComponentFile $source ('live-editor/dist/' + $relative) }
    if ($relative -match '\.(html|css|js)$') {
        $text = [IO.File]::ReadAllText($source)
        foreach ($match in [regex]::Matches($text, '["''(](?:/|\./)?(assets/[A-Za-z0-9_.\-/]+)["'')]')) { $assets.Enqueue($match.Groups[1].Value) }
        foreach ($match in [regex]::Matches($text, '["''(](\./[A-Za-z0-9_.\-/]+\.(?:js|css|woff2?|png|svg|jpg|webp))["'')]')) {
            $assetRoot = [IO.Path]::GetFullPath((Join-Path $AppRoot 'dist')) + [IO.Path]::DirectorySeparatorChar
            $resolved = [IO.Path]::GetFullPath((Join-Path (Split-Path $source -Parent) $match.Groups[1].Value))
            if (!$resolved.StartsWith($assetRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Build asset escaped dist.' }
            $assets.Enqueue($resolved.Substring($assetRoot.Length).Replace('\','/'))
        }
    }
}
foreach ($relative in @('node','recorder')) {
    # Published recorder output is flat; runtime config/deps JSON are explicitly allowed.
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $RuntimeRoot $relative) -File) {
        if ($file.Name -match '(?i)(\.dll|\.exe|\.deps\.json|\.runtimeconfig\.json|\.dat)$') { Add-ComponentFile $file.FullName ('runtime/' + $relative + '/' + $file.Name) }
    }
}
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $DesktopRoot '程序组件\runtime\desktop') -File) {
    if ($file.Name -match '(?i)(\.dll|(?:LICENSE|NOTICE)\.txt)$') { Add-ComponentFile $file.FullName ('runtime/desktop/' + $file.Name) }
}
if (!$FFmpegRoot) { $FFmpegRoot = Join-Path $ToolsRoot 'ffmpeg-slim' }
$FFmpegRoot = (Resolve-Path -LiteralPath $FFmpegRoot).Path
$ffmpegComponent = Get-Content -LiteralPath (Join-Path $FFmpegRoot 'component.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($ffmpegComponent.version -ne '8.1.2' -or $ffmpegComponent.variant -ne 'caibo-shared') { throw 'Expected the verified Caibo FFmpeg 8.1.2 shared build.' }
$ffmpegFiles = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($file in $ffmpegComponent.files) {
    $componentName = [string]$file.name
    if ($componentName -notmatch '^[A-Za-z0-9_.+-]+\.(dll|exe)$' -or !$ffmpegFiles.Add($componentName)) { throw 'Unsafe or duplicate FFmpeg component file.' }
    $source = Join-Path $FFmpegRoot ('bin\' + $componentName)
    if ((Get-Item -LiteralPath $source).Length -ne $file.bytes -or (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw "FFmpeg component mismatch: $componentName" }
    Add-ComponentFile $source ('runtime/ffmpeg/' + $componentName)
}
foreach ($required in @('ffmpeg.exe','ffprobe.exe')) { if (!$ffmpegFiles.Contains($required)) { throw "Missing media program: $required" } }
foreach ($file in Get-ChildItem -LiteralPath $FFmpegRoot -File -Recurse | Where-Object { !$_.FullName.StartsWith((Join-Path $FFmpegRoot 'bin') + '\', [StringComparison]::OrdinalIgnoreCase) }) {
    $relative = $file.FullName.Substring($FFmpegRoot.Length + 1).Replace('\','/')
    Add-ComponentFile $file.FullName ('licenses/ffmpeg/' + $relative)
}
Add-ComponentFile (Join-Path $ToolsRoot 'NODE-LICENSE.txt') 'licenses/node/LICENSE.txt'
Add-ComponentFile (Join-Path $ToolsRoot '7zip\License.txt') 'licenses/7zip/LICENSE.txt'
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $ToolsRoot 'license-texts') -File -Filter '*.txt') { Add-ComponentFile $file.FullName ('licenses/texts/' + $file.Name) }
Add-ComponentFile (Join-Path $ToolsRoot 'download-manifest.json') 'licenses/download-sources.json'
foreach ($dependency in @('vue','lucide-vue-next')) { Add-ComponentFile (Join-Path $AppRoot ('node_modules\' + $dependency + '\LICENSE')) ('licenses/frontend/' + $dependency + '.txt') }
$runtimeConfig = Get-Content -LiteralPath (Join-Path $componentRoot 'runtime\recorder\BililiveRecorder.Cli.runtimeconfig.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($framework in $runtimeConfig.runtimeOptions.includedFrameworks) {
    $package = $framework.name.ToLowerInvariant() + '.runtime.win-x64'
    $packageRoot = Find-NuGetPackage $package $framework.version ($package + '.nuspec')
    foreach ($file in Get-ChildItem -LiteralPath $packageRoot -File) {
        if ($file.Name -match '(?i)^(LICENSE|THIRD-PARTY-NOTICES)\.TXT$') { Add-ComponentFile $file.FullName ('licenses/dotnet/' + $package + '/' + $file.Name) }
    }
}
# Preserve dependency metadata/copyright and any license texts supplied by NuGet.
$deps = Get-Content -LiteralPath (Join-Path $componentRoot 'runtime\recorder\BililiveRecorder.Cli.deps.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$notices = @()
foreach ($entry in $deps.libraries.PSObject.Properties) {
    if ($entry.Value.type -ne 'package') { continue }
    $parts = $entry.Name.ToLowerInvariant().Split('/')
    $packageRoot = Find-NuGetPackage $parts[0] $parts[1] ($parts[0] + '.nuspec')
    $nuspec = Join-Path $packageRoot ($parts[0] + '.nuspec')
    if (!(Test-Path -LiteralPath $nuspec)) { throw "Missing dependency metadata: $($entry.Name)" }
    [xml]$xml = Get-Content -LiteralPath $nuspec -Encoding UTF8
    $metadata = $xml.package.metadata
    Add-ComponentFile $nuspec ('licenses/nuget/' + $parts[0] + '/' + $parts[0] + '.nuspec')
    foreach ($file in Get-ChildItem -LiteralPath $packageRoot -File) {
        if ($file.Name -match '(?i)^(LICENSE|COPYING|NOTICE|THIRD.PARTY.NOTICES)(\.[A-Za-z]+)?$') { Add-ComponentFile $file.FullName ('licenses/nuget/' + $parts[0] + '/' + $file.Name) }
    }
    if ($metadata.license.type -eq 'file') { Add-ComponentFile (Join-Path $packageRoot $metadata.license.'#text') ('licenses/nuget/' + $parts[0] + '/' + [IO.Path]::GetFileName($metadata.license.'#text')) }
    $notices += [ordered]@{ name=$entry.Name; authors=[string]$metadata.authors; copyright=[string]$metadata.copyright; license=[string]$metadata.license.'#text'; licenseUrl=[string]$metadata.licenseUrl; projectUrl=[string]$metadata.projectUrl; repository=[string]$metadata.repository.url; commit=[string]$metadata.repository.commit }
}
Write-Text ($componentDirectory + '/licenses/nuget/dependencies.json') ($notices | ConvertTo-Json -Depth 8)
Add-File (Join-Path $PSScriptRoot '..\docs\RELEASE-USER.txt') '使用说明.txt'
if ($ForPublic) {
    $readme = [IO.File]::ReadAllText((Join-Path $stage '使用说明.txt'))
    $readme = $readme.Replace('此包为本地候选构建。公开发布时须同时提供对应版本的完整项目源码及依赖源码获取说明。', "此版本完整对应源码：$SourceUrl`r`n组件许可和来源见 程序组件/licenses 文件夹。")
    Write-Text '使用说明.txt' $readme
}
$node = Join-Path $componentRoot 'runtime\node\node.exe'
$ffmpeg = Join-Path $componentRoot 'runtime\ffmpeg\ffmpeg.exe'
$ffprobe = Join-Path $componentRoot 'runtime\ffmpeg\ffprobe.exe'
$nodeVersion = & $node --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne 'v24.12.0') { throw 'Node must match the pinned 24.12.0 license/version; update tools and pin together.' }
# Read the entire output before selecting its first line: closing a native pipe
# early can make FFmpeg exit nonzero on Windows PowerShell 5.1.
$ffmpegOutput = @(& $ffmpeg -version)
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg verification failed.' }
$ffmpegVersion = $ffmpegOutput[0]
$ffprobeOutput = @(& $ffprobe -version)
if ($LASTEXITCODE -ne 0) { throw 'FFprobe verification failed.' }
$ffprobeVersion = $ffprobeOutput[0]
$encoders = (& $ffmpeg -hide_banner -encoders 2>&1) -join "`n"
foreach ($encoder in @('libx264','aac','h264_amf','h264_nvenc','h264_qsv')) { if ($encoders -notmatch "\b$encoder\b") { throw "Missing FFmpeg encoder: $encoder" } }
$filters = (& $ffmpeg -hide_banner -filters 2>&1) -join "`n"
if ($filters -notmatch '\bass\s') { throw 'Missing libass filter.' }
$manifest = [ordered]@{ version=$Version; layoutVersion=2; componentDirectory=$componentDirectory; emptyDirectories=$emptyDirectories; architecture='win-x64'; publicRelease=[bool]$ForPublic; sourceUrl=$SourceUrl; node=$nodeVersion; ffmpeg=$ffmpegVersion; ffprobe=$ffprobeVersion; recorder=[Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $componentRoot 'runtime\recorder\BililiveRecorder.Cli.dll')).ProductVersion; frameworks=$runtimeConfig.runtimeOptions.includedFrameworks; prerequisites=@('Windows 10/11 x64','.NET Framework 4.7.2 or newer','Microsoft Edge WebView2 Evergreen Runtime'); files=@() }
foreach ($file in Get-ChildItem -LiteralPath $stage -File -Recurse | Sort-Object FullName) {
    $relative = $file.FullName.Substring($stage.Length + 1).Replace('\','/')
    if ($relative -match $forbidden) { throw "Private or development file in release: $relative" }
    $manifest.files += [ordered]@{ path=$relative; bytes=$file.Length; sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    # Normalize timestamps; together with sorted paths and fixed tool version, rebuilds are stable.
    $file.LastWriteTimeUtc = [datetime]'2026-01-01T00:00:00Z'
}
# The clean application root has two files and two folders; developer sources are separate.
$expectedRootItems = @('录播机.exe', '使用说明.txt', '程序组件', '导出视频默认路径')
$rootItems = @(Get-ChildItem -LiteralPath $stage -Force)
if ($rootItems.Count -ne $expectedRootItems.Count -or @($rootItems | Where-Object { $_.Name -notin $expectedRootItems }).Count) { throw 'Unexpected item in portable application root.' }
foreach ($relative in $emptyDirectories) {
    if (@(Get-ChildItem -LiteralPath (Join-Path $stage $relative) -Force).Count) { throw 'Default export directories must be empty.' }
}
Write-Text ($componentDirectory + '/release-manifest.json') ($manifest | ConvertTo-Json -Depth 10)
$sevenZip = Join-Path $ToolsRoot '7zip\7z.exe'
Push-Location $OutputRoot
try {
    if ($Include7z) {
        & $sevenZip a "$name.7z" "$name\*" -t7z -mx=9 -m0=LZMA2 -md=128m -ms=on -mmt=1 -mtc=off -mta=off -mtm=off -bsp0
        if ($LASTEXITCODE -ne 0) { throw 'Archive creation failed.' }
        & $sevenZip t "$name.7z" -bsp0
        if ($LASTEXITCODE -ne 0) { throw 'Archive integrity test failed.' }
    }
    & $sevenZip a "$name.zip" "$name\*" -tzip -mm=Deflate -mx=9 -mmt=1 -mcu=on -bsp0
    if ($LASTEXITCODE -ne 0) { throw 'ZIP creation failed.' }
    & $sevenZip t "$name.zip" -bsp0
    if ($LASTEXITCODE -ne 0) { throw 'ZIP integrity test failed.' }
} finally { Pop-Location }
# Build a standard installer independently from the portable archives.
$installer = & (Join-Path $PSScriptRoot 'build-installer.ps1') -Stage $stage -Version $Version -ToolsRoot $ToolsRoot -OutputRoot $OutputRoot
$size = (Get-Item -LiteralPath $installer).Length
$installedBytes = [long]0
foreach ($file in $manifest.files) { $installedBytes += $file.bytes }
$installedBytes += (Get-Item -LiteralPath (Join-Path $componentRoot 'release-manifest.json')).Length
$report = [ordered]@{ version=$Version; installer="$name-setup.exe"; bytes=$size; decimalMB=[Math]::Round($size/1000000,2); installedBytes=$installedBytes; under100MB=($size -lt $MaxDownloadBytes); sha256=(Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant(); fileCount=($manifest.files.Count+1) }
if ($Include7z) { $report.archive="$name.7z" }
$report.zip = "$name.zip"
$report.zipBytes = (Get-Item -LiteralPath "$stage.zip").Length
$report.zipSha256 = (Get-FileHash -LiteralPath "$stage.zip" -Algorithm SHA256).Hash.ToLowerInvariant()
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputRoot "$name-size.json") -Encoding UTF8
$report | ConvertTo-Json
if ($size -ge $MaxDownloadBytes) { throw "Release exceeds download budget: $size bytes" }
