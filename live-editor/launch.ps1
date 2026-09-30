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
$url = $null
function Test-EditorReady {
    try {
        $endpoint = Get-Content -LiteralPath (Join-Path $appRoot 'data\desktop-service.json') -Encoding UTF8 -Raw | ConvertFrom-Json
        if ($endpoint.protocol -ne 1 -or $endpoint.token -notmatch '^[a-f0-9]{64}$' -or $endpoint.instance -notmatch '^[a-f0-9]{32}$') { return $false }
        $address = [Uri]$endpoint.origin
        if ($address.Scheme -ne 'http' -or $address.Host -ne '127.0.0.1' -or $address.AbsolutePath -ne '/' -or $address.UserInfo -or $address.Query -or $address.Fragment) { return $false }
        $state = Invoke-RestMethod -Uri ($endpoint.origin + '/internal/desktop') -Headers @{'X-Caibo-Instance'=$endpoint.token} -TimeoutSec 2
        if ($state.instance -ne $endpoint.instance -or -not $state.dataPath -or [IO.Path]::GetFullPath($state.dataPath) -ne [IO.Path]::GetFullPath((Join-Path $appRoot 'data'))) { return $false }
        $script:url = $endpoint.origin
        return $true
    } catch { return $false }
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
    $env:EDITOR_PORT = '0'
    $env:RECORDER_PORT = '0'
    # Browser-only developer fallback. Portable releases always use the desktop
    # launcher, which supplies the tray and managed process lifecycle.
    $env:EDITOR_DESKTOP_MANAGED = '0'
    $temporary = Join-Path $appRoot 'data\temp'
    New-Item -ItemType Directory -Force -Path $temporary | Out-Null
    $env:TEMP = $temporary
    $env:TMP = $temporary
    $entry = '"' + (Join-Path $appRoot 'server\index.js') + '"'
    Start-Process -FilePath $nodeExe -ArgumentList $entry -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $appRoot 'data\server-out.log') -RedirectStandardError (Join-Path $appRoot 'data\server-error.log') | Out-Null
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        Start-Sleep -Milliseconds 250
        if (Test-EditorReady) { $ready = $true; break }
    }
}
if (-not $ready) { throw '编辑服务未能启动，请查看 程序组件\live-editor\data\server-error.log。' }
Start-Process $url
