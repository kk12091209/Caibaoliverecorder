[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
. (Join-Path $PSScriptRoot 'dev-env.ps1') -ProjectRoot $root
Set-Location $root
$version = (Get-Content live-editor/package.json -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Expected a numeric release version.' }
$revision = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot read source revision.' }
$tools = Join-Path $root '.tools/release-tools'
$runtime = Join-Path $root '.tools/windows-runtime'
$output = Join-Path $root '.tools/windows-release'
$qa = Join-Path $root '.tools/windows-release-qa'

# Reuse only byte-verified, unchanged Node/FFmpeg from the previous public
# Windows release. Always rebuild the editor, desktop and recording core.
$baselineSha = '342effdacca96f48b5ba4ef8579b5585405de8e55614cd6fdbe1337c043cc717'
$baselineZip = Join-Path $root '.tools/downloads/BiliLiveEditor-0.1.3-win-x64.zip'
node live-editor/scripts/fetch-tool.mjs 'https://github.com/kk12091209/Caibaoliverecorder/releases/download/v0.1.3/BiliLiveEditor-0.1.3-win-x64.zip' $baselineZip $baselineSha
if ($LASTEXITCODE -ne 0) { throw 'Baseline runtime download failed.' }
$baselineRoot = Join-Path $qa 'baseline'
& (Join-Path $PSScriptRoot 'test-release.ps1') -Package $baselineZip -ProjectRoot $root -OutputRoot $baselineRoot
$baselineManifest = @(Get-ChildItem $baselineRoot -Filter release-manifest.json -Recurse)
if ($baselineManifest.Count -ne 1) { throw 'Expected exactly one baseline manifest.' }
$components = $baselineManifest[0].Directory.FullName
& (Join-Path $PSScriptRoot 'prepare-release-tools.ps1') -ProjectRoot $root -Destination $tools -SkipMediaBuild
$media = Join-Path $tools 'ffmpeg-slim'
Copy-Item -LiteralPath (Join-Path $components 'licenses/ffmpeg') -Destination $media -Recurse
Copy-Item -LiteralPath (Join-Path $components 'runtime/ffmpeg') -Destination (Join-Path $media 'bin') -Recurse
New-Item -ItemType Directory -Force (Join-Path $runtime 'node') | Out-Null
Copy-Item -LiteralPath (Join-Path $components 'runtime/node/node.exe') -Destination (Join-Path $runtime 'node/node.exe')
$env:FFMPEG_PATH = Join-Path $media 'bin/ffmpeg.exe'
$env:FFPROBE_PATH = Join-Path $media 'bin/ffprobe.exe'
$env:RECORDER_PATH = Join-Path $runtime 'recorder/BililiveRecorder.Cli.exe'

Set-Location (Join-Path $root 'live-editor')
npm ci
if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency restore failed.' }
node --test --test-concurrency=2 test/*.test.js scripts/dev.test.js
if ($LASTEXITCODE -ne 0) { throw 'Editor regression tests failed.' }
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
& (Join-Path $PSScriptRoot 'test-installer.ps1') -ProjectRoot $root -Stage (Join-Path $output $name) -ToolsRoot $tools -Version $version
& (Join-Path $PSScriptRoot 'package-source.ps1') -ProjectRoot $root -AppRoot (Join-Path $root 'live-editor') -OutputFile (Join-Path $output "Caibo-$version-source.zip") -RepositoryUrl 'https://github.com/kk12091209/Caibaoliverecorder.git'
$metadata = [ordered]@{version=$version;buildRevision=(Get-Content live-editor/package.json -Raw | ConvertFrom-Json).buildRevision;sourceRevision=$revision;sourceUrl=$sourceUrl;runtimeBaseline='v0.1.3';runtimeBaselineZipSha256=$baselineSha;workflowRun=$env:GITHUB_RUN_ID;nodeTests='passed';coreTests='passed';coreLifecycle='passed';portableZip='passed';portable7z='passed';installerUpgradeUninstall='passed'}
$metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'windows-build.json') -Encoding UTF8
$hashes = @(Get-ChildItem -LiteralPath $output -File | Sort-Object Name | ForEach-Object { ((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()) + '  ' + $_.Name })
[IO.File]::WriteAllText((Join-Path $output 'SHA256SUMS.txt'),($hashes -join "`n") + "`n",[Text.UTF8Encoding]::new($false))
Write-Output "Verified Windows $version release files: $output"
