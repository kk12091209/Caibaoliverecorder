[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
. (Join-Path $PSScriptRoot 'dev-env.ps1') -ProjectRoot $root
Set-Location $root
. (Join-Path $PSScriptRoot 'release-version.ps1')
$version = Get-CaiboVersion -AppRoot (Join-Path $root 'live-editor')
$pinned = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json).windows
$revision = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot read source revision.' }
$tools = Join-Path $root '.tools/release-tools'
$runtime = Join-Path $root '.tools/windows-runtime'
$output = Join-Path $root '.tools/windows-release'
$qa = Join-Path $root '.tools/windows-release-qa'

# Runtime components are provisioned independently of product releases.
# An existing standalone FFmpeg component can be reused after verification.
$media = $env:CAIBO_WINDOWS_FFMPEG_ROOT
& (Join-Path $PSScriptRoot 'prepare-release-tools.ps1') -ProjectRoot $root -Destination $tools -SkipMediaBuild:([bool]$media)
if (!$media) { $media = Join-Path $tools 'ffmpeg-slim' }
node live-editor/scripts/verify-ffmpeg-component.mjs $media
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg runtime verification failed.' }
$nodeDirectory = Join-Path $runtime 'node'
New-Item -ItemType Directory -Force -Path $nodeDirectory | Out-Null
$nodeExecutable = Join-Path $nodeDirectory 'node.exe'
node live-editor/scripts/fetch-tool.mjs $pinned.node.url $nodeExecutable $pinned.node.sha256
if ($LASTEXITCODE -ne 0) { throw 'Node runtime verification failed.' }
$env:FFMPEG_PATH = Join-Path $media 'bin/ffmpeg.exe'
$env:FFPROBE_PATH = Join-Path $media 'bin/ffprobe.exe'
$env:RECORDER_PATH = Join-Path $runtime 'recorder/BililiveRecorder.Cli.exe'

Set-Location (Join-Path $root 'live-editor')
npm ci
if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency restore failed.' }
node --test --test-concurrency=2 test/*.test.js scripts/dev.test.js
if ($LASTEXITCODE -ne 0) { throw 'Editor regression tests failed.' }
npm run lint
if ($LASTEXITCODE -ne 0) { throw 'Editor static checks failed.' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
Set-Location $root
dotnet publish BililiveRecorder.Cli/BililiveRecorder.Cli.csproj -c Release -r win-x64 -p:RuntimeIdentifiers=win-x64 --self-contained true -o (Join-Path $runtime 'recorder')
if ($LASTEXITCODE -ne 0) { throw 'Recording core publish failed.' }
dotnet test test/BililiveRecorder.Core.UnitTests/BililiveRecorder.Core.UnitTests.csproj -c Release -f net8.0
if ($LASTEXITCODE -ne 0) { throw 'Recording core tests failed.' }
$env:CAIBO_CORE_SMOKE = '1'
node --test live-editor/test/local-endpoint.test.js
if ($LASTEXITCODE -ne 0) { throw 'Windows core startup/reuse/quit test failed.' }
Remove-Item Env:CAIBO_CORE_SMOKE
& ./live-editor/desktop/build.ps1

$sourceUrl = "https://github.com/kk12091209/Caibaoliverecorder/releases/download/v$version/Caibo-$version-source.zip"
& (Join-Path $PSScriptRoot 'build-release.ps1') -ProjectRoot $root -AppRoot (Join-Path $root 'live-editor') -DesktopRoot (Join-Path $root 'live-editor/desktop/package') -RuntimeRoot $runtime -ToolsRoot $tools -FFmpegRoot $media -NuGetRoot $env:NUGET_PACKAGES -OutputRoot $output -Version $version -ForPublic -SourceUrl $sourceUrl -Include7z
$name = "BiliLiveEditor-$version-win-x64"
foreach ($extension in @('zip','7z')) {
    & (Join-Path $PSScriptRoot 'test-release.ps1') -ProjectRoot $root -Package (Join-Path $output "$name.$extension") -OutputRoot (Join-Path $qa $extension)
}
$portable = (Get-Content (Join-Path $qa 'zip/verification.json') -Raw | ConvertFrom-Json).extractedRoot
foreach ($launch in @('first','reopened')) {
    node live-editor/scripts/verify-windows-ui.mjs $portable (Join-Path $qa "ui/$launch")
    if ($LASTEXITCODE -ne 0) { throw "Packaged Windows desktop UI failed: $launch" }
}
& (Join-Path $PSScriptRoot 'test-installer.ps1') -ProjectRoot $root -Stage (Join-Path $output $name) -ToolsRoot $tools -Version $version
& (Join-Path $PSScriptRoot 'package-source.ps1') -ProjectRoot $root -AppRoot (Join-Path $root 'live-editor') -OutputFile (Join-Path $output "Caibo-$version-source.zip") -RepositoryUrl 'https://github.com/kk12091209/Caibaoliverecorder.git'
$metadata = [ordered]@{version=$version;sourceRevision=$revision;sourceUrl=$sourceUrl;runtimeNode=$pinned.node.version;runtimeNodeSha256=$pinned.node.sha256;runtimeFFmpeg=$pinned.ffmpeg.version;runtimeFFmpegManifestSha256=(Get-FileHash -LiteralPath (Join-Path $media 'component.json') -Algorithm SHA256).Hash.ToLowerInvariant();workflowRun=$env:GITHUB_RUN_ID;nodeTests='passed';coreTests='passed';coreLifecycle='passed';portableZip='passed';portable7z='passed';installerUpgradeUninstall='passed';nativeDesktopUI='passed'}
$metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'windows-build.json') -Encoding UTF8
$hashes = @(Get-ChildItem -LiteralPath $output -File | Sort-Object Name | ForEach-Object { ((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()) + '  ' + $_.Name })
[IO.File]::WriteAllText((Join-Path $output 'SHA256SUMS.txt'),($hashes -join "`n") + "`n",[Text.UTF8Encoding]::new($false))
Write-Output "Verified Windows $version release files: $output"
