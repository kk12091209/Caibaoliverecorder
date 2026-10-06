param([string]$Executable = (Join-Path $PSScriptRoot 'build-slim\录播机.exe'))
$ErrorActionPreference = 'Stop'
$source = Split-Path $PSScriptRoot -Parent
. (Join-Path $source 'scripts\dev-env.ps1')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('caibo-desktop-service-' + [Guid]::NewGuid().ToString('N'))
$testApp = Join-Path $testRoot '程序组件\live-editor'
$testData = Join-Path $testApp 'data'
$environmentBefore = @{}
foreach ($key in @('NODE_EXE','RECORDER_PATH','FFMPEG_PATH','FFPROBE_PATH','NO_RECORDER')) { $environmentBefore[$key] = [Environment]::GetEnvironmentVariable($key) }
$flags = [Reflection.BindingFlags]'NonPublic,Instance,Static'
$assembly = [Reflection.Assembly]::LoadFrom([IO.Path]::GetFullPath($Executable))
$backendType = $assembly.GetType('LiveRecorderDesktop.BackendService', $true)
$constructor = $backendType.GetConstructor([Reflection.BindingFlags]'NonPublic,Instance', $null, [type[]]@([string]), $null)
function Invoke-Backend($Backend, [string]$Method, [object[]]$Arguments=@()) {
    $result = $backendType.GetMethod($Method,$flags).Invoke($Backend,$Arguments)
    if ($result -is [Threading.Tasks.Task]) { return $result.GetAwaiter().GetResult() }
    return $result
}
function Assert-Service([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function Read-TestEndpoint { Get-Content -LiteralPath (Join-Path $testData 'desktop-service.json') -Encoding UTF8 -Raw | ConvertFrom-Json }
function Wait-TestExit {
    for ($n=0;$n -lt 100;$n++) { if (!(Test-Path -LiteralPath (Join-Path $testData 'desktop-service.json'))) { return }; Start-Sleep -Milliseconds 100 }
    throw '独立测试后台未退出。'
}
$first = $null; $second = $null; $next = $null
try {
    New-Item -ItemType Directory -Force -Path $testApp | Out-Null
    Copy-Item -LiteralPath (Join-Path $source 'server') -Destination $testApp -Recurse
    Copy-Item -LiteralPath (Join-Path $source 'package.json') -Destination $testApp
    Copy-Item -LiteralPath $Executable -Destination (Join-Path $testRoot '录播机.exe')
    $project = Split-Path (Split-Path $source -Parent) -Parent
    $env:NODE_EXE = Join-Path $project '程序组件\runtime\node\node.exe'
    $env:RECORDER_PATH = Join-Path $project '程序组件\runtime\recorder\BililiveRecorder.Cli.exe'
    $env:FFMPEG_PATH = Join-Path $project '程序组件\runtime\ffmpeg\ffmpeg.exe'
    $env:FFPROBE_PATH = Join-Path $project '程序组件\runtime\ffmpeg\ffprobe.exe'
    $env:NO_RECORDER = '1'
    $helper = Join-Path $testRoot 'fixture.mjs'
    [IO.File]::WriteAllText($helper, @'
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
const [action,app]=process.argv.slice(2);
if(action==='build'){const {serviceBuild}=await import(pathToFileURL(path.join(app,'server/service-runtime.js'))); console.log(await serviceBuild(app));}
else { const db=new DatabaseSync(path.join(app,'data/editor.sqlite')); if(action==='busy')db.prepare("INSERT OR REPLACE INTO sessions(id,title,room,created,status) VALUES('test-recording','isolated fixture',0,?,'recording')").run(new Date().toISOString()); else db.exec("UPDATE sessions SET status='finished' WHERE id='test-recording'"); db.close(); }
'@)
    $nodeBuild = (& $env:NODE_EXE $helper 'build' $testApp).Trim()
    $desktopBuild = $backendType.GetMethod('ComputeBuild',$flags).Invoke($null,@([string]$testApp))
    Assert-Service ($nodeBuild -eq $desktopBuild) 'Node 和桌面版本指纹不一致。'
    $first = $constructor.Invoke(@([string]$testRoot))
    Invoke-Backend $first 'EnsureAsync' | Out-Null
    $initial = Read-TestEndpoint
    $closeStatus = Invoke-Backend $first 'HeartbeatAsync'
    Assert-Service ($closeStatus.GetType().GetField('CloseAction',$flags).GetValue($closeStatus) -eq 'ask') '首次关闭应每次询问。'
    Invoke-Backend $first 'SaveCloseActionAsync' @('background') | Out-Null
    $second = $constructor.Invoke(@([string]$testRoot))
    $closeStatus = Invoke-Backend $second 'EnsureAsync'
    Assert-Service ($closeStatus.GetType().GetField('CloseAction',$flags).GetValue($closeStatus) -eq 'background') '另一桌面连接未读取记住的动作。'
    Assert-Service ((Read-TestEndpoint).pid -eq $initial.pid) '重复打开创建了第二份后台。'
    & $env:NODE_EXE $helper 'busy' $testApp
    Assert-Service ((Invoke-Backend $second 'PrepareMaintenanceAsync') -eq 2) '安装维护应拒绝模拟录制中的素材。'
    $blockedStatus = Invoke-Backend $first 'HeartbeatAsync'
    Assert-Service ($blockedStatus.GetType().GetField('Pending',$flags).GetValue($blockedStatus) -eq '') '维护检查改变了进行中的后台退出状态。'
    Invoke-Backend $first 'SaveCloseActionAsync' @('exit') | Out-Null
    $closeStatus = Invoke-Backend $first 'HeartbeatAsync'
    Assert-Service ($closeStatus.GetType().GetField('Pending',$flags).GetValue($closeStatus) -eq '') '保存关闭偏好不应发起退出。'
    [IO.File]::AppendAllText((Join-Path $testApp 'server\index.js'), "`n// isolated version-change fixture`n")
    $next = $constructor.Invoke(@([string]$testRoot))
    $status = Invoke-Backend $next 'EnsureAsync'
    Assert-Service ($status.GetType().GetField('Busy',$flags).GetValue($status)) '更新打断了模拟录制。'
    Assert-Service ((Read-TestEndpoint).pid -eq $initial.pid) '任务进行时更新替换了后台。'
    & $env:NODE_EXE $helper 'idle' $testApp
    Wait-TestExit
    $closeStatus = Invoke-Backend $next 'EnsureAsync'
    Assert-Service ($closeStatus.GetType().GetField('CloseAction',$flags).GetValue($closeStatus) -eq 'exit') '服务重启后丢失关闭偏好。'
    Invoke-Backend $next 'SaveCloseActionAsync' @('ask') | Out-Null
    $closeStatus = Invoke-Backend $next 'HeartbeatAsync'
    Assert-Service ($closeStatus.GetType().GetField('CloseAction',$flags).GetValue($closeStatus) -eq 'ask') '未恢复每次询问。'
    $updated = Read-TestEndpoint
    Assert-Service ($updated.pid -ne $initial.pid) '空闲后没有自动切换后台。'
    Assert-Service ($updated.build -ne $initial.build) '没有载入新版本源码。'
    & $env:NODE_EXE $helper 'busy' $testApp
    $quitStatus=Invoke-Backend $next 'RequestQuitAsync' @($false)
    Assert-Service ($quitStatus.GetType().GetField('RequiresExitConfirmation',$flags).GetValue($quitStatus)) '录制中的退出没有请求确认。'
    Assert-Service (!$quitStatus.GetType().GetField('QuitAccepted',$flags).GetValue($quitStatus)) '未确认退出被提前受理。'
    Assert-Service (!$backendType.GetProperty('ExitRequested',$flags).GetValue($next)) '未确认退出改变了桌面退出状态。'
    Assert-Service ((Read-TestEndpoint).pid -eq $updated.pid) '未确认退出停止了后台。'
    $quitStatus=Invoke-Backend $next 'RequestQuitAsync' @($true)
    Assert-Service ($quitStatus.GetType().GetField('QuitAccepted',$flags).GetValue($quitStatus)) '确认退出未受理。'
    Assert-Service ($backendType.GetProperty('ExitRequested',$flags).GetValue($next)) '确认后桌面未结束等待。'
    # Reopen immediately: wait for the closing service instead of reusing it.
    $reopened=$constructor.Invoke(@([string]$testRoot))
    try {
        $quitStatus=Invoke-Backend $reopened 'EnsureAsync'
        Assert-Service (!$quitStatus.GetType().GetField('Stopping',$flags).GetValue($quitStatus)) '重新打开复用了退出中的后台。'
        Assert-Service ((Read-TestEndpoint).pid -ne $updated.pid) '退出后没有新建后台。'
        & $env:NODE_EXE $helper 'idle' $testApp
        $quitStatus=Invoke-Backend $reopened 'RequestQuitAsync' @($false)
        Assert-Service ($quitStatus.GetType().GetField('QuitAccepted',$flags).GetValue($quitStatus)) '空闲退出未直接受理。'
        Assert-Service (!$quitStatus.GetType().GetField('RequiresExitConfirmation',$flags).GetValue($quitStatus)) '空闲退出仍弹出任务确认。'
        Wait-TestExit
    } finally { $reopened.Dispose() }
    $next.Dispose();$next=$constructor.Invoke(@([string]$testRoot));Invoke-Backend $next 'EnsureAsync' | Out-Null
    Assert-Service ((Invoke-Backend $next 'PrepareMaintenanceAsync') -eq 0) '空闲后台未能安全退出供安装/卸载维护。'
    Wait-TestExit
    $lock = [IO.File]::Open((Join-Path $testData 'desktop-service.lock.sqlite'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)
    try { Assert-Service ((Invoke-Backend $second 'PrepareMaintenanceAsync') -eq 3) '未知持有者占用数据锁时应拒绝维护。' } finally { $lock.Dispose() }
    Assert-Service ((Invoke-Backend $second 'PrepareMaintenanceAsync') -eq 0) '无运行服务时维护启动了额外进程。'
    # A live Node PID with an HTTP socket that never answers must not hold
    # the desktop in its connect loop forever. Shorten only this fixture's budget.
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
    $listener.Start()
    $fixtureNode = $null; $timedBackend = $null
    try {
        $start = [Diagnostics.ProcessStartInfo]::new($env:NODE_EXE)
        $start.UseShellExecute=$false; $start.CreateNoWindow=$true
        $start.Arguments='-e "setInterval(()=>{},60000)"'
        $fixtureNode=[Diagnostics.Process]::Start($start)
        $port=$listener.LocalEndpoint.Port
        $fakeEndpoint=@{protocol=1;pid=$fixtureNode.Id;origin="http://127.0.0.1:$port";dataPath=$testData;token=('a'*64);instance=('b'*32);build=$nodeBuild}
        [IO.File]::WriteAllText((Join-Path $testData 'desktop-service.json'),($fakeEndpoint | ConvertTo-Json))
        $timedBackend=$constructor.Invoke(@([string]$testRoot))
        $backendType.GetProperty('ConnectionTimeout',$flags).SetValue($timedBackend,[TimeSpan]::FromMilliseconds(600))
        for($run=0;$run -lt 2;$run++) {
            $watch=[Diagnostics.Stopwatch]::StartNew();$failed=$false
            try { Invoke-Backend $timedBackend 'EnsureAsync' | Out-Null } catch {$failed=$true}
            Assert-Service $failed '无响应的后台连接应按总时限返回错误。'
            Assert-Service ($watch.Elapsed.TotalSeconds -lt 2) 'HTTP 等待超出了整体连接预算。'
            Assert-Service (!$fixtureNode.HasExited) '超时不应杀死或替换现有后台。'
        }
    } finally {
        $listener.Stop()
        if($timedBackend){$timedBackend.Dispose()}
        if($fixtureNode){if(!$fixtureNode.HasExited){$fixtureNode.Kill();$fixtureNode.WaitForExit(5000)|Out-Null};$fixtureNode.Dispose()}
        Remove-Item -LiteralPath (Join-Path $testData 'desktop-service.json') -Force -ErrorAction SilentlyContinue
    }
    $dailyLogs=Get-ChildItem -LiteralPath (Join-Path $testData 'logs') -Filter '*.txt'
    Assert-Service ($dailyLogs.Count -gt 0) '没有生成每天的 TXT 日志。'
    $dailyText=($dailyLogs | ForEach-Object {Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8}) -join "`n"
    Assert-Service ($dailyText.Contains('打开应用') -and $dailyText.Contains('后台正常退出')) '日志缺少桌面打开或安全退出记录。'
    '桌面后台集成测试通过：自动地址、复用与更新、关闭偏好、任务退出确认、空闲直接退出、退出后立即重开；安装维护保护。'
} catch { Write-Output $_.Exception.ToString(); throw } finally {
    if (Test-Path -LiteralPath $helper) { try { & $env:NODE_EXE $helper 'idle' $testApp } catch {} }
    if ($reopened) { try { Invoke-Backend $reopened 'RequestQuitAsync' @($true) | Out-Null } catch {}; $reopened.Dispose() }
    foreach ($backend in @($first,$second,$next)) { if ($backend) { try { Invoke-Backend $backend 'RequestExitAsync' | Out-Null } catch {}; $backend.Dispose() } }
    foreach ($key in $environmentBefore.Keys) { [Environment]::SetEnvironmentVariable($key,$environmentBefore[$key]) }
    $testStillRunning=$false
    if (Test-Path -LiteralPath (Join-Path $testData 'desktop-service.json')) { try { Wait-TestExit } catch { $testStillRunning=$true;Write-Warning $_ } }
    $target = [IO.Path]::GetFullPath($testRoot)
    $allowed = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (!$target.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path $target -Leaf) -notlike 'caibo-desktop-service-*') { throw '独立测试清理路径无效。' }
    if (!$testStillRunning -and (Test-Path -LiteralPath $target)) { Remove-Item -LiteralPath $target -Recurse -Force }
}
