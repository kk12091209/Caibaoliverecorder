[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ProjectRoot,
    [Parameter(Mandatory=$true)][string]$OutputFile,
    [string]$AppRoot = '',
    [string]$RepositoryUrl = 'https://github.com/BililiveRecorder/BililiveRecorder.git'
)
$ErrorActionPreference = 'Stop'
if (!$AppRoot) { $AppRoot = Split-Path $PSScriptRoot -Parent }
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$AppRoot = (Resolve-Path -LiteralPath $AppRoot).Path
$OutputFile = [IO.Path]::GetFullPath($OutputFile)
if ([IO.Path]::GetExtension($OutputFile) -ne '.zip') { throw 'OutputFile must end in .zip.' }
$manifestFile = [IO.Path]::ChangeExtension($OutputFile, '.manifest.json')
foreach ($target in @($OutputFile, $manifestFile)) {
    if (Test-Path -LiteralPath $target) { throw "Output already exists: $target" }
}

# Copy only tracked upstream source plus an explicit allowlist for the new,
# possibly uncommitted editor. Never walk the project root into private data.
$files = [System.Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
$excluded = [System.Collections.Generic.List[object]]::new()
$submodules = [System.Collections.Generic.List[object]]::new()
$forbidden = '(?i)(^|/)(data|runtime|\.tools|node_modules|bin|obj|dist|qa|\.qa|desktop-profile|profiles?|originals|chunks|archives|exports|logs|\.git|build-slim|package|publish)(/|$)|(^|/)\.env($|\.)|\.(sqlite(?:-wal|-shm)?|db|log|exe|dll|pdb|zip|7z|tar|gz|flv|mp4|mkv|webm|mp3|wav|pdf)$'
$trackedAssetExtensions = @('.png','.jpg','.jpeg','.webp','.gif','.ico','.woff','.woff2','.ttf','.otf')
# Only these current editor images are build inputs. Other untracked binaries stay excluded.
$editorAssetPaths = @(
    'live-editor/desktop/app.ico',
    'live-editor/desktop/assets/app-original.png',
    'live-editor/src/assets/app-icon.png'
)
$textExtensions = @('.swift','.plist','.py','.cs','.csproj','.sln','.props','.targets','.json','.md','.txt','.yml','.yaml','.xml','.xaml','.config','.conf','.resx','.nuspec','.sh','.ps1','.js','.mjs','.cjs','.ts','.tsx','.jsx','.vue','.html','.css','.scss','.less','.svg','.toml','.manifest','.cmd','.bat','.iss','.isl')
$textNames = @('LICENSE','NOTICE','COPYING','AUTHORS','Dockerfile','.editorconfig','.gitattributes','.gitignore','.gitmodules','.nojekyll','.dockerignore','.npmrc','.prettierrc','.browserslistrc')
function Git-Read([string]$root, [string[]]$arguments) {
    $previousEncoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        $emptyExcludes = Join-Path $ProjectRoot '.tools\source-empty-excludes'
        if (!(Test-Path -LiteralPath $emptyExcludes)) { [IO.File]::WriteAllText($emptyExcludes, '') }
        if ((Get-Item -LiteralPath $emptyExcludes).Length -ne 0) { throw 'Expected an empty source-packaging Git excludes file.' }
        $output = & git -c ('safe.directory=' + $root.Replace('\','/')) -c ('core.excludesFile=' + $emptyExcludes.Replace('\','/')) -c core.quotepath=false -C $root @arguments
        if ($LASTEXITCODE -ne 0) { throw "Git read failed in $root" }
        return ($output -join "`n")
    } finally { [Console]::OutputEncoding = $previousEncoding }
}
function Add-Source([string]$source, [string]$relative, [string]$origin) {
    $relative = $relative.Replace('\','/')
    if ($relative.StartsWith('/') -or $relative -match '(^|/)\.\.(/|$)' -or $relative.Contains(':')) { throw "Unsafe archive path: $relative" }
    $extension = [IO.Path]::GetExtension($relative).ToLowerInvariant()
    $name = [IO.Path]::GetFileName($relative)
    $trackedAsset = $origin -eq 'tracked-upstream' -and $extension -in $trackedAssetExtensions
    $editorAsset = $origin -eq 'current-editor' -and $relative -cin $editorAssetPaths
    $syntheticFixture = $relative -ceq 'live-editor/test/fixtures/minimal.mp4'
    if ($syntheticFixture -and (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne 'C86785495D6D68A9C63D4277C2C270A67C69809EB12A43F526242DF26E2705DD') { throw 'Synthetic test fixture differs from the reviewed source input.' }
    $allowedAsset = $trackedAsset -or $editorAsset -or $syntheticFixture
    # This known upstream submodule contains public test fixture sources. Keep
    # its license/readme, while the media-extension rule still omits FLV files.
    $policyPath = if ($relative.StartsWith('test/data/')) { 'test/fixtures/' + $relative.Substring(10) } else { $relative }
    # These tracked C# directories contain recorder source, not generated
    # runtime components or user logs. Keep the exception narrow and textual.
    if ($origin -eq 'tracked-upstream' -and $extension -eq '.cs' -and
        ($relative.StartsWith('BililiveRecorder.Core/Scripting/Runtime/') -or
         $relative.StartsWith('BililiveRecorder.Web/Models/Rest/Logs/'))) {
        $policyPath = $relative.Replace('/Runtime/', '/SourceRuntime/').Replace('/Logs/', '/LogModels/')
    }
    if ((!$syntheticFixture -and $policyPath -match $forbidden) -or (!$allowedAsset -and $extension -notin $textExtensions -and $name -notin $textNames -and $name -notlike 'Dockerfile.*')) {
        $excluded.Add([ordered]@{path=$relative;reason='Private/runtime/build/binary path excluded by source allowlist'})
        return
    }
    $item = Get-Item -LiteralPath $source -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Unexpected directory/link: $source" }
    $bytes = [IO.File]::ReadAllBytes($item.FullName)
    if (!$allowedAsset -and $bytes -contains 0) { throw "Non-text source rejected: $relative" }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
    $files[$relative] = [ordered]@{path=$relative;bytes=$bytes;size=$bytes.Length;sha256=$hash;origin=$origin}
}
function Add-Tracked([string]$root, [string]$prefix) {
    $paths = (Git-Read $root @('ls-files','-z')).Split([char]0, [StringSplitOptions]::RemoveEmptyEntries)
    foreach ($relative in $paths) {
        $source = Join-Path $root $relative
        if (Test-Path -LiteralPath $source -PathType Leaf) { Add-Source $source ($prefix+$relative) 'tracked-upstream' }
    }
    foreach ($line in (Git-Read $root @('ls-files','--stage')) -split "`n") {
        if ($line -notmatch '^160000\s+([a-f0-9]+)\s+\d+\t(.+)$') { continue }
        $revision = $Matches[1]; $relative = $Matches[2]; $module = Join-Path $root $relative
        $initialized = Test-Path -LiteralPath (Join-Path $module '.git')
        $url = if ($initialized) { (Git-Read $module @('remote','get-url','origin')).Trim() } else { '' }
        if (!$url) {
            $modulePaths = (Git-Read $root @('config','--file','.gitmodules','--get-regexp','^submodule\..*\.path$')) -split "`n"
            foreach ($modulePath in $modulePaths) {
                if ($modulePath -match '^(.+)\.path\s+(.+)$' -and $Matches[2] -eq $relative) { $url = (Git-Read $root @('config','--file','.gitmodules','--get',($Matches[1]+'.url'))).Trim(); break }
            }
        }
        if ($url -match 'https?://[^/]+@') { throw 'Credential-bearing source URL rejected.' }
        $submodules.Add([ordered]@{path=$prefix+$relative;revision=$revision;initialized=$initialized;sourceUrl=$url})
        if ($initialized) { Add-Tracked $module ($prefix+$relative+'/') }
    }
}
Add-Tracked $ProjectRoot ''

# Recorder additions may not yet be tracked by Git. Keep this list exact so the
# binary's corresponding source is complete without scanning private/build trees.
$recorderSourceAdditions = @(
    'BililiveRecorder.Core/Danmaku/BoundedDanmakuBuffer.cs',
    'BililiveRecorder.Core/Danmaku/StickerPlaceholder.cs',
    'test/BililiveRecorder.Core.UnitTests/Danmaku/BoundedDanmakuBufferTests.cs',
    'BililiveRecorder.Core/Danmaku/LotteryDanmakuTracker.cs',
    'test/BililiveRecorder.Core.UnitTests/Danmaku/LotteryDanmakuTrackerTests.cs'
)
foreach ($relative in $recorderSourceAdditions) {
    # Required files fail closed when absent; do not silently publish partial source.
    Add-Source (Join-Path $ProjectRoot $relative) $relative 'current-recorder'
}

# Replace any previously tracked editor files with this selected current source
# tree, and include current untracked modules without admitting user data.
foreach ($key in @($files.Keys)) { if ($key.StartsWith('live-editor/')) { $files.Remove($key) | Out-Null } }
foreach ($folder in @('src','server','test','scripts','docs','installer','desktop-macos')) {
    $directory = Join-Path $AppRoot $folder
    if (!(Test-Path -LiteralPath $directory -PathType Container)) { continue }
    foreach ($file in Get-ChildItem -LiteralPath $directory -File -Recurse -Force) {
        $relative = $file.FullName.Substring($AppRoot.Length).TrimStart('\','/')
        Add-Source $file.FullName ('live-editor/'+$relative) 'current-editor'
    }
}
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $AppRoot 'desktop') -File -Force) {
    if ($file.Extension -in @('.swift','.plist','.py','.cs','.csproj','.config','.manifest','.ps1')) { Add-Source $file.FullName ('live-editor/desktop/'+$file.Name) 'current-editor' }
}
# Include nested desktop assets explicitly rather than walking its build/cache folders.
foreach ($assetPath in $editorAssetPaths) {
    $source = Join-Path $AppRoot $assetPath.Substring('live-editor/'.Length)
    Add-Source $source $assetPath 'current-editor'
}
foreach ($name in @('package.json','package-lock.json','vite.config.js','index.html','launch.ps1','README.md','.gitignore')) {
    $source = Join-Path $AppRoot $name
    if (Test-Path -LiteralPath $source -PathType Leaf) { Add-Source $source ('live-editor/'+$name) 'current-editor' }
}
# Conversational design notes stay local; build instructions live in live-editor/docs.
foreach ($relative in @('docs/live-editor/源码基线.txt')) {
    $source = Join-Path $ProjectRoot $relative
    if (Test-Path -LiteralPath $source -PathType Leaf) { Add-Source $source $relative 'project-documentation' }
}
Add-Source (Join-Path $ProjectRoot '.github/workflows/editor.yml') '.github/workflows/editor.yml' 'project-ci'
Add-Source (Join-Path $ProjectRoot 'script/build_and_run.sh') 'script/build_and_run.sh' 'project-entrypoint'
foreach ($name in @('README.md','CHANGELOG.md','THIRD_PARTY_NOTICES.md','启动录播机.cmd','项目说明.md')) {
    $source = Join-Path $ProjectRoot $name
    if (Test-Path -LiteralPath $source -PathType Leaf) { Add-Source $source $name 'project-entrypoint' }
}

$paths = [string[]]@($files.Keys)
[Array]::Sort($paths, [StringComparer]::Ordinal)
$manifest = [ordered]@{
    formatVersion = 1
    repositoryUrl = $RepositoryUrl
    upstreamRevision = (Git-Read $ProjectRoot @('rev-parse','HEAD')).Trim()
    description = 'Current source snapshot; editor and explicitly listed recorder additions include uncommitted files. Private data, upstream media fixtures and generated/runtime components are excluded; the verified 1.4 KB synthetic MP4 test fixture is included.'
    archiveTimestampUtc = '2000-01-01T00:00:00Z'
    submodules = @($submodules.ToArray())
    files = @($paths | ForEach-Object { $f=$files[$_]; [ordered]@{path=$f.path;bytes=$f.size;sha256=$f.sha256;origin=$f.origin} })
    excluded = @($excluded.ToArray() | Sort-Object path)
}
$utf8 = [Text.UTF8Encoding]::new($false)
$manifestBytes = $utf8.GetBytes(($manifest | ConvertTo-Json -Depth 8) + "`n")
$sourceReadme = @"
# Source snapshot

This archive contains the modified editor, explicitly listed recorder additions,
and tracked source at commit
$($manifest.upstreamRevision), including required tracked icons and other build
assets. It intentionally contains no Git database, local recordings, credentials,
development dependencies or runtime executables.

The upstream recorder build uses GitVersion and can require Git history. This ZIP
alone is not claimed to build the entire upstream solution. Prepare the exact
baseline checkout, then overlay the contents of this source archive into it:

git clone $RepositoryUrl source-build
git -C source-build checkout $($manifest.upstreamRevision)
git -C source-build submodule update --init --recursive

After overlaying, follow live-editor/README.md and the build/release scripts under
live-editor/scripts. Keep the cloned .git directory; the archive does not replace
it. Do not substitute a newer upstream checkout for the recorded baseline.

SOURCE-MANIFEST.json records every included file hash and every excluded tracked
file. Public upstream FLV test fixtures and the legacy WPF miniffmpeg executable
are omitted. The current CLI and editor builds do not use that legacy executable.
To restore omitted upstream fixtures, clone the recorded submodule source URL and
check out its exact commit below; these are upstream public fixtures, not recordings
from this installation. In a full Git checkout, git submodule update --init --recursive
restores the matching submodules. In this source-only ZIP, use the explicit clones:
"@
foreach ($module in $submodules) {
    if ($module.sourceUrl) { $sourceReadme += "`n- $($module.path): $($module.sourceUrl) at $($module.revision)`n  git clone --no-checkout $($module.sourceUrl) restored-$($module.path.Replace('/','-'))`n  git -C restored-$($module.path.Replace('/','-')) checkout $($module.revision)`n" }
}
$readmeBytes = $utf8.GetBytes($sourceReadme + "`n")
Add-Type -AssemblyName System.IO.Compression
New-Item -ItemType Directory -Force -Path (Split-Path $OutputFile -Parent) | Out-Null
$stream = [IO.File]::Open($OutputFile, [IO.FileMode]::CreateNew)
$zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($relative in @($paths)+@('SOURCE-MANIFEST.json','SOURCE-README.md')) {
        [byte[]]$bytes = @()
        if ($relative -eq 'SOURCE-MANIFEST.json') { $bytes = $manifestBytes }
        elseif ($relative -eq 'SOURCE-README.md') { $bytes = $readmeBytes }
        else { $bytes = $files[$relative].bytes }
        $entry = $zip.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = [DateTimeOffset]::new(2000,1,1,0,0,0,[TimeSpan]::Zero)
        $output = $entry.Open()
        try { $output.Write($bytes,0,$bytes.Length) } finally { $output.Dispose() }
    }
} finally { $zip.Dispose(); $stream.Dispose() }
[IO.File]::WriteAllBytes($manifestFile, $manifestBytes)
[ordered]@{
    sourceArchive=$OutputFile
    manifest=$manifestFile
    files=$paths.Count
    archiveBytes=(Get-Item -LiteralPath $OutputFile).Length
    sha256=(Get-FileHash -LiteralPath $OutputFile -Algorithm SHA256).Hash.ToLowerInvariant()
} | ConvertTo-Json
