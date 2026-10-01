[CmdletBinding()]
param([string]$ProjectRoot = '', [switch]$Apply)
$ErrorActionPreference = 'Stop'
if (!$ProjectRoot) { $ProjectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$projectPrefix = $ProjectRoot.TrimEnd('\') + '\'
# Only obsolete, reproducible build/distribution outputs. Current source,
# publication checkouts, history, SDKs, package metadata and user data stay out.
$relativeTargets = @(
    'releases\v0.1.0', 'releases\v0.1.1',
    '.tools\release-work\public-v0.1.0\runtime',
    '.tools\release-work\public-v0.1.0\desktop',
    '.tools\release-work\public-v0.1.1\build',
    '.tools\release-work\public-v0.1.1\desktop',
    '.tools\release-work\public-v0.1.1\syntax-check',
    '.tools\release-work\public-v0.1.1\syntax-stage',
    '.tools\timeline-signals-update\recorder-publish',
    'BililiveRecorder.Cli\bin'
)
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'releases') -File) {
    if ($file.Name -match '^BiliLiveEditor-0\.1\.0-preview\.[0-9.]+-(source\.zip|win-x64\.exe)$') {
        $relativeTargets += 'releases\' + $file.Name
    }
}
$plan = @()
foreach ($relative in $relativeTargets) {
    $target = [IO.Path]::GetFullPath((Join-Path $ProjectRoot $relative))
    if (!$target.StartsWith($projectPrefix,[StringComparison]::OrdinalIgnoreCase) -or $relative -match '(^|\\)(data|\.git|codex-history)(\\|$)') { throw 'Cleanup target escaped the build allowlist.' }
    if (!(Test-Path -LiteralPath $target)) { continue }
    for ($ancestor = Split-Path $target -Parent; $ancestor.StartsWith($projectPrefix,[StringComparison]::OrdinalIgnoreCase); $ancestor = Split-Path $ancestor -Parent) {
        if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked cleanup ancestor.' }
    }
    $resolved = (Resolve-Path -LiteralPath $target).Path
    if (![string]::Equals($resolved,$target,[StringComparison]::OrdinalIgnoreCase)) { throw 'Linked cleanup target.' }
    $item = Get-Item -LiteralPath $target -Force
    $entries = @($item)
    if ($item.PSIsContainer) { $entries += @(Get-ChildItem -LiteralPath $target -Recurse -Force) }
    foreach ($entry in $entries) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $entry.Name -eq '.git' -or $entry.Name -eq 'data' -or $entry.Name -match '\.(sqlite(?:-wal|-shm)?|flv|flvpart|mp4|mkv|webm)$') { throw "Unexpected private/link input in generated output: $($entry.FullName)" }
    }
    $files = @($entries | Where-Object { !$_.PSIsContainer })
    $bytes = [long](($files | Measure-Object Length -Sum).Sum)
    $plan += [ordered]@{path=$target;bytes=$bytes;files=$files.Count;removed=$false}
}
$reportRoot = Join-Path $ProjectRoot '.tools\build-cleanup'
New-Item -ItemType Directory -Force -Path $reportRoot | Out-Null
$reportPath = Join-Path $reportRoot ((Get-Date -Format 'yyyyMMddHHmmss') + '.json')
$report = [ordered]@{apply=[bool]$Apply;targets=$plan;bytes=($plan | ForEach-Object { [long]$_.bytes } | Measure-Object -Sum).Sum;userDataTouched=$false}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding UTF8
if ($Apply) {
    foreach ($entry in $plan) {
        Remove-Item -LiteralPath $entry.path -Force -Recurse
        $entry.removed = $true
        $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding UTF8
    }
}
[pscustomobject]@{applied=[bool]$Apply;targetCount=$plan.Count;MiB=[Math]::Round($report.bytes/1MB,2);report=$reportPath} | ConvertTo-Json
