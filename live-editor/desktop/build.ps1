param(
    [string]$DotNet = 'dotnet',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'package'),
    [switch]$NoRestore
)
$ErrorActionPreference = 'Stop'
$buildDirectory = Join-Path $PSScriptRoot 'build-slim'
$buildArguments = @('build', (Join-Path $PSScriptRoot 'RecorderDesktop.csproj'), '-c', 'Release', '-o', $buildDirectory)
if ($NoRestore) { $buildArguments += '--no-restore' }
& $DotNet @buildArguments
if ($LASTEXITCODE -ne 0) { throw '桌面程序构建失败。' }
$desktopRelease = [xml](Get-Content -LiteralPath (Join-Path $PSScriptRoot 'RecorderDesktop.csproj') -Raw -Encoding UTF8)
$desktopExpectedVersion = [string]($desktopRelease.Project.PropertyGroup | Where-Object { $_.Version } | Select-Object -First 1).Version
$desktopMetadata = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $buildDirectory '录播机.exe'))
if ($desktopMetadata.ProductVersion -ne $desktopExpectedVersion -or $desktopMetadata.FileVersion -ne ($desktopExpectedVersion + '.0') -or $desktopMetadata.ProductName -ne '菜播·录包机') { throw '桌面程序版本信息与发布源码不一致。' }
$packageDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$componentDirectory = Join-Path $packageDirectory '程序组件'
$bridgeDirectory = Join-Path $componentDirectory 'runtime\desktop'
New-Item -ItemType Directory -Force -Path $bridgeDirectory | Out-Null
Copy-Item -LiteralPath (Join-Path $buildDirectory '录播机.exe') -Destination (Join-Path $packageDirectory '录播机.exe') -Force
Copy-Item -LiteralPath (Join-Path $buildDirectory '录播机.exe.config') -Destination (Join-Path $componentDirectory '录播机.exe.config') -Force
$bridgeFiles = @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'WebView2.LICENSE.txt', 'WebView2.NOTICE.txt')
foreach ($name in $bridgeFiles) {
    Copy-Item -LiteralPath (Join-Path $buildDirectory $name) -Destination (Join-Path $bridgeDirectory $name) -Force
}
# Remove only artifacts created by the old builder when reusing its output directory.
$obsolete = @((Join-Path $packageDirectory '录播机.exe.config'))
foreach ($name in $bridgeFiles) { $obsolete += Join-Path $packageDirectory "runtime\desktop\$name" }
foreach ($file in $obsolete) {
    $full = [IO.Path]::GetFullPath($file)
    if (-not $full.StartsWith($packageDirectory.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '构建输出路径校验失败。' }
    if (Test-Path -LiteralPath $full -PathType Leaf) { Remove-Item -LiteralPath $full -Force }
}
$files = @(Get-ChildItem -LiteralPath $packageDirectory -File -Recurse)
[pscustomobject]@{
    Directory = $packageDirectory
    ExeBytes = (Get-Item -LiteralPath (Join-Path $packageDirectory '录播机.exe')).Length
    PackageBytes = ($files | Measure-Object -Property Length -Sum).Sum
    Files = $files.Count
} | ConvertTo-Json
