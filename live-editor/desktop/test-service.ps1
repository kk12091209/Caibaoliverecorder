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
function Invoke-Backend($Backend, [string]$Method) {
    $result = $backendType.GetMethod($Method,$flags).Invoke($Backend,@())
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
else { const db=new DatabaseSync(path.join(app,'data/editor.sqlite')); if(action==='busy')db.prepare("INSERT INTO sessions(id,title,room,created,status) VALUES('test-recording','isolated fixture',0,?,'recording')").run(new Date().toISOString()); else db.exec("UPDATE sessions SET status='finished' WHERE id='test-recording'"); db.close(); }
'@)
    $nodeBuild = (& $env:NODE_EXE $helper 'build' $testApp).Trim()
    $desktopBuild = $backendType.GetMethod('ComputeBuild',$flags).Invoke($null,@([string]$testApp))
    Assert-Service ($nodeBuild -eq $desktopBuild) 'Node 和桌面版本指纹不一致。'
    $first = $constructor.Invoke(@([string]$testRoot))
    Invoke-Backend $first 'EnsureAsync' | Out-Null
    $initial = Read-TestEndpoint
    $second = $constructor.Invoke(@([string]$testRoot))
    Invoke-Backend $second 'EnsureAsync' | Out-Null
    Assert-Service ((Read-TestEndpoint).pid -eq $initial.pid) '重复打开创建了第二份后台。'
    & $env:NODE_EXE $helper 'busy' $testApp
    Assert-Service ((Invoke-Backend $second 'PrepareMaintenanceAsync') -eq 2) '安装维护应拒绝模拟录制中的素材。'
    $blockedStatus = Invoke-Backend $first 'HeartbeatAsync'
    Assert-Service ($blockedStatus.GetType().GetField('Pending',$flags).GetValue($blockedStatus) -eq '') '维护检查改变了进行中的后台退出状态。'
    [IO.File]::AppendAllText((Join-Path $testApp 'server\index.js'), "`n// isolated version-change fixture`n")
    $next = $constructor.Invoke(@([string]$testRoot))
    $status = Invoke-Backend $next 'EnsureAsync'
    Assert-Service ($status.GetType().GetField('Busy',$flags).GetValue($status)) '更新打断了模拟录制。'
    Assert-Service ((Read-TestEndpoint).pid -eq $initial.pid) '任务进行时更新替换了后台。'
    & $env:NODE_EXE $helper 'idle' $testApp
    Wait-TestExit
    Invoke-Backend $next 'EnsureAsync' | Out-Null
    $updated = Read-TestEndpoint
    Assert-Service ($updated.pid -ne $initial.pid) '空闲后没有自动切换后台。'
    Assert-Service ($updated.build -ne $initial.build) '没有载入新版本源码。'
    Assert-Service ((Invoke-Backend $next 'PrepareMaintenanceAsync') -eq 0) '空闲后台未能安全退出供安装/卸载维护。'
    Wait-TestExit
    $lock = [IO.File]::Open((Join-Path $testData 'desktop-service.lock.sqlite'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)
    try { Assert-Service ((Invoke-Backend $second 'PrepareMaintenanceAsync') -eq 3) '未知持有者占用数据锁时应拒绝维护。' } finally { $lock.Dispose() }
    Assert-Service ((Invoke-Backend $second 'PrepareMaintenanceAsync') -eq 0) '无运行服务时维护启动了额外进程。'
    '桌面后台集成测试通过：版本指纹、自动地址、重复打开复用、任务期间延后切换、空闲更新；维护拒绝录制且不请求退出、数据锁拒绝、空闲维护退出。'
} catch { Write-Output $_.Exception.ToString(); throw } finally {
    foreach ($backend in @($first,$second,$next)) { if ($backend) { try { Invoke-Backend $backend 'RequestExitAsync' | Out-Null } catch {}; $backend.Dispose() } }
    foreach ($key in $environmentBefore.Keys) { [Environment]::SetEnvironmentVariable($key,$environmentBefore[$key]) }
    if (Test-Path -LiteralPath (Join-Path $testData 'desktop-service.json')) { try { Wait-TestExit } catch { Write-Warning $_ } }
    $target = [IO.Path]::GetFullPath($testRoot)
    $allowed = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (!$target.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path $target -Leaf) -notlike 'caibo-desktop-service-*') { throw '独立测试清理路径无效。' }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}
