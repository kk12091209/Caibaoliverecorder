param([string]$Executable = (Join-Path $PSScriptRoot 'build-slim\录播机.exe'))
$ErrorActionPreference = 'Stop'
$assembly = [Reflection.Assembly]::LoadFrom([IO.Path]::GetFullPath($Executable))
$resolver = $assembly.GetType('LiveRecorderDesktop.RuntimeDependencies', $true)
$flags = [Reflection.BindingFlags]'NonPublic,Static'
$resolve = $resolver.GetMethod('Resolve', $flags)
$checkNode = $resolver.GetMethod('CheckNodeVersion', $flags)
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('recorder-desktop-paths-' + [Guid]::NewGuid().ToString('N'))
$priorPath = $env:PATH
$priorFfmpeg = $env:FFMPEG_PATH
$launchErrors = $null
$launchAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Split-Path $PSScriptRoot -Parent) 'launch.ps1'), [ref]$null, [ref]$launchErrors)
if ($launchErrors) { throw ($launchErrors | Out-String) }
$launchResolver = $launchAst.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Resolve-RuntimeTool' }, $true)
if (-not $launchResolver) { throw '启动脚本未提供运行组件解析器。' }
Invoke-Expression $launchResolver.Extent.Text
$projectRoot = $testRoot
function Resolve-TestTool {
    $desktopResult = $resolve.Invoke($null, [object[]]@([string]$testRoot, 'ffmpeg', 'ffmpeg.exe', 'FFMPEG_PATH', 'FFmpeg'))
    $launcherResult = Resolve-RuntimeTool 'ffmpeg' 'ffmpeg.exe' 'FFMPEG_PATH'
    Assert-Equal $launcherResult $desktopResult
    return $desktopResult
}
function Assert-Equal($Actual, $Expected) {
    if ($Actual -ne $Expected) { throw "解析结果不符合预期：$Actual / $Expected" }
}
try {
    $bin = Join-Path $testRoot 'tools with spaces'
    $bundled = Join-Path $testRoot 'runtime\ffmpeg\ffmpeg.exe'
    New-Item -ItemType Directory -Force -Path $bin, (Split-Path $bundled -Parent) | Out-Null
    [IO.File]::WriteAllText($bundled, 'path-test fixture')
    $env:PATH = ''
    $env:FFMPEG_PATH = Join-Path $testRoot 'missing.exe'
    Assert-Equal (Resolve-TestTool) $bundled
    Remove-Item -LiteralPath $bundled
    $custom = Join-Path $bin 'ffmpeg.exe'
    [IO.File]::WriteAllText($custom, 'path-test fixture')
    $env:FFMPEG_PATH = '"' + $custom + '"'
    Assert-Equal (Resolve-TestTool) $custom
    $env:FFMPEG_PATH = 'tools with spaces\ffmpeg.exe'
    Assert-Equal (Resolve-TestTool) $custom
    $env:FFMPEG_PATH = 'ffmpeg'
    $env:PATH = $bin
    Assert-Equal (Resolve-TestTool) $custom
    $env:FFMPEG_PATH = $null
    Assert-Equal (Resolve-TestTool) $custom
    $env:PATH = ''
    $missingRejected = $false
    try { Resolve-TestTool | Out-Null } catch { $missingRejected = $_.Exception.ToString().Contains('runtime\ffmpeg\ffmpeg.exe') }
    if (-not $missingRejected) { throw '缺失组件没有返回可修复的提示。' }
    $checkNode.Invoke($null, [object[]]@([string]$node))
    '桌面与 PowerShell 启动器路径测试通过：包内优先、绝对/相对配置、PATH、缺失提示、Node 版本检查。'
} finally {
    $env:PATH = $priorPath
    $env:FFMPEG_PATH = $priorFfmpeg
    $resolvedRoot = [IO.Path]::GetFullPath($testRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolvedRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolvedRoot -Leaf) -notlike 'recorder-desktop-paths-*') { throw '测试清理路径超出临时目录。' }
    if (Test-Path -LiteralPath $resolvedRoot) { Remove-Item -LiteralPath $resolvedRoot -Recurse -Force }
}
