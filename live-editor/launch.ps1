$ErrorActionPreference = 'Stop'
function Resolve-AppLayout([string]$SourceDirectory) {
    $project = Split-Path ([IO.Path]::GetFullPath($SourceDirectory)) -Parent
    if ((Split-Path $project -Leaf) -eq '程序组件') {
        $project = Split-Path $project -Parent
    } elseif ((Split-Path $project -Leaf) -eq '源码') {
        $parent = Split-Path $project -Parent
        if (Test-Path -LiteralPath (Join-Path $parent '程序组件\live-editor\server\index.js') -PathType Leaf) { $project = $parent }
    }
    if (-not [string]::IsNullOrWhiteSpace($env:EDITOR_PROJECT_ROOT)) { $project = [IO.Path]::GetFullPath($env:EDITOR_PROJECT_ROOT.Trim().Trim('"')) }
    foreach ($candidate in @((Join-Path $project '程序组件\live-editor'), (Join-Path $project 'live-editor'))) {
        if (Test-Path -LiteralPath (Join-Path $candidate 'server\index.js') -PathType Leaf) {
            return [pscustomobject]@{ ProjectRoot = $project; AppRoot = $candidate }
        }
    }
    throw '找不到项目组件。请完整解压发布包并保留程序组件文件夹。'
}
$layout = Resolve-AppLayout $PSScriptRoot
$appRoot = $layout.AppRoot
$projectRoot = $layout.ProjectRoot
$desktopExe = Join-Path $projectRoot '录播机.exe'
if (Test-Path -LiteralPath $desktopExe) {
    Start-Process -FilePath $desktopExe
    exit
}
$url = 'http://127.0.0.1:17860'
function Test-EditorReady {
    try { $state = Invoke-RestMethod -Uri "$url/api/state" -TimeoutSec 2 } catch { return $false }
    if (-not $state.dataPath -or [IO.Path]::GetFullPath($state.dataPath) -ne [IO.Path]::GetFullPath((Join-Path $appRoot 'data'))) {
        throw '端口 17860 正由另一份项目使用。请先关闭另一份编辑服务，再打开此项目。'
    }
    return $null -ne $state.recorder
}
function Resolve-RuntimeTool([string]$Component, [string]$Name, [string]$Variable) {
    foreach ($bundled in @((Join-Path $projectRoot "程序组件\runtime\$Component\$Name"), (Join-Path $projectRoot "runtime\$Component\$Name"))) {
        if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
    }
    $configured = [Environment]::GetEnvironmentVariable($Variable)
    if (-not [string]::IsNullOrWhiteSpace($configured)) {
        $configured = $configured.Trim().Trim('"')
        if ([IO.Path]::IsPathRooted($configured) -or $configured.Contains('\') -or $configured.Contains('/')) {
            $candidate = if ([IO.Path]::IsPathRooted($configured)) { [IO.Path]::GetFullPath($configured) } else { [IO.Path]::GetFullPath((Join-Path $projectRoot $configured)) }
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        } else {
            $command = Get-Command $configured -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($command) { return $command.Source }
        }
        throw "$Variable 配置的运行组件不存在：$configured。请修正该变量或恢复 程序组件\runtime\$Component\$Name。"
    }
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    throw "缺少 $Name。请完整解压发布包并保留 程序组件\runtime\$Component\$Name，或配置 $Variable / PATH。"
}
$ready = Test-EditorReady
if (-not $ready) {
    $nodeExe = Resolve-RuntimeTool 'node' 'node.exe' 'NODE_EXE'
    $major = [int]((& $nodeExe --version).TrimStart('v').Split('.')[0])
    if ($major -lt 24) { throw '需要 Node.js 24 或更新版本。请恢复发布包的 程序组件\runtime\node 组件。' }
    $env:FFMPEG_PATH = Resolve-RuntimeTool 'ffmpeg' 'ffmpeg.exe' 'FFMPEG_PATH'
    $env:FFPROBE_PATH = Resolve-RuntimeTool 'ffmpeg' 'ffprobe.exe' 'FFPROBE_PATH'
    $env:EDITOR_DATA = Join-Path $appRoot 'data'
    $env:EDITOR_PROJECT_ROOT = $projectRoot
    $env:RECORDER_PATH = Resolve-RuntimeTool 'recorder' 'BililiveRecorder.Cli.exe' 'RECORDER_PATH'
    $env:EDITOR_PORT = '17860'
    $env:RECORDER_PORT = '17861'
    $entry = '"' + (Join-Path $appRoot 'server\index.js') + '"'
    Start-Process -FilePath $nodeExe -ArgumentList $entry -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $appRoot 'server-out.log') -RedirectStandardError (Join-Path $appRoot 'server-error.log') | Out-Null
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        if (Test-EditorReady) { $ready = $true; break }
    }
}
if (-not $ready) { throw '编辑服务未能启动，请查看 live-editor\server-error.log。' }
Start-Process $url
