[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Stage,
    [Parameter(Mandatory=$true)][string]$ToolsRoot,
    [string]$Version = '0.1.5',
    [string]$ProjectRoot = '',
    [string]$QaInstaller = ''
)
$ErrorActionPreference = 'Stop'
if (!$ProjectRoot) { $ProjectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
. (Join-Path $PSScriptRoot 'dev-env.ps1') -ProjectRoot $ProjectRoot
$qaId = 'Caibo.QA.' + [Guid]::NewGuid().ToString('N')
$qaRoot = Join-Path $ProjectRoot ('.tools\release-qa\installer-' + $qaId)
if ($QaInstaller) {
    $QaInstaller=(Resolve-Path -LiteralPath $QaInstaller).Path
    $qaRoot=Split-Path $QaInstaller -Parent
    $name=Split-Path $qaRoot -Leaf
    $prefix=[IO.Path]::GetFullPath((Join-Path $ProjectRoot '.tools\release-qa')).TrimEnd('\')+'\'
    if (!$qaRoot.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or $name -notmatch '^installer-(Caibo\.QA\.[a-f0-9]{32})$' -or (Split-Path $QaInstaller -Leaf) -ne 'installer-qa.exe') { throw 'Only an isolated QA installer can be reused.' }
    $qaId=$Matches[1]
}
$target = Join-Path $qaRoot ('安装测试-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
$app = Join-Path $target '程序组件\live-editor'
$data = Join-Path $app 'data'
$registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $qaId + '_is1'
$utf8 = [Text.UTF8Encoding]::new($false)
$backend = $null
$envBefore = @{}
foreach ($key in @('NO_RECORDER','EDITOR_DATA','EDITOR_PROJECT_ROOT','EDITOR_PORT','RECORDER_PORT','EDITOR_DESKTOP_MANAGED')) { $envBefore[$key] = [Environment]::GetEnvironmentVariable($key) }
function Assert-Installer([bool]$condition, [string]$message) { if (!$condition) { throw $message } }
function Invoke-Setup([string]$exe, [string]$arguments) {
    $process = Start-Process -FilePath $exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
    try {
        if (!$process.WaitForExit(90000)) { $process.Kill(); throw 'Isolated installer test timed out.' }
        return $process.ExitCode
    } finally { $process.Dispose() }
}
function Read-Endpoint { Get-Content -LiteralPath (Join-Path $data 'desktop-service.json') -Raw -Encoding UTF8 | ConvertFrom-Json }
function Wait-Endpoint {
    for ($i=0;$i -lt 100;$i++) { if (Test-Path -LiteralPath (Join-Path $data 'desktop-service.json')) { return }; Start-Sleep -Milliseconds 100 }
    throw 'Isolated backend did not publish its endpoint.'
}
function Wait-BackendExit {
    Assert-Installer ($backend.WaitForExit(15000)) 'Maintenance did not safely stop the isolated idle backend.'
}
try {
    New-Item -ItemType Directory -Force -Path $qaRoot | Out-Null
    Assert-Installer (!(Test-Path -LiteralPath $registry)) 'The QA identity is already installed.'
    $installer=$QaInstaller
    if (!$installer) { $installer = & (Join-Path $PSScriptRoot 'build-installer.ps1') -Stage $Stage -Version $Version -ToolsRoot $ToolsRoot -OutputRoot $qaRoot -AppId $qaId -BaseName 'installer-qa' -QaFastCompile }
    $shared = Join-Path $qaRoot 'shared-folder'
    New-Item -ItemType Directory -Force -Path $shared | Out-Null
    $outside = Join-Path $shared 'keep.txt'
    [IO.File]::WriteAllText($outside,'outside installation',$utf8)
    $unsafeArgs = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TASKS="" /DIR="{0}" /LOG="{1}"' -f $shared,(Join-Path $qaRoot 'unsafe-install.log')
    Assert-Installer ((Invoke-Setup $installer $unsafeArgs) -ne 0) 'Installer accepted a nonempty shared folder.'
    Assert-Installer ([IO.File]::ReadAllText($outside) -eq 'outside installation') 'Shared-folder rejection changed unrelated files.'
    Assert-Installer (!(Test-Path -LiteralPath $registry)) 'Rejected shared-folder install registered the application.'
    $arguments = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TASKS="" /DIR="{0}" /GROUP="{1}" /LOG="{2}"' -f $target,$qaId,(Join-Path $qaRoot 'install.log')
    Assert-Installer ((Invoke-Setup $installer $arguments) -eq 0) 'Fresh install failed.'
    $uninstaller = Join-Path $target '程序组件\卸载\unins000.exe'
    Assert-Installer (Test-Path -LiteralPath $uninstaller) 'Missing uninstaller executable.'
    Assert-Installer (Test-Path -LiteralPath (Join-Path $target '卸载菜播·录包机.lnk')) 'Missing root uninstall shortcut.'
    Assert-Installer (Test-Path -LiteralPath $registry) 'Missing Windows uninstall registration.'
    $installedBytes = [long]((Get-ChildItem -LiteralPath $target -File -Recurse | Measure-Object Length -Sum).Sum)
    $manifest = Get-Content (Join-Path $target '程序组件\release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($file in $manifest.files) { Assert-Installer ((Get-FileHash -LiteralPath (Join-Path $target $file.path)).Hash.ToLowerInvariant() -eq $file.sha256) ('Installed file differs: ' + $file.path) }
    $preserved = @('程序组件/live-editor/data/originals/fixture.bin','程序组件/live-editor/data/chunks/fixture/00000000.flvpart','导出视频默认路径/完整素材/fixture.mp4','导出视频默认路径/导出片段/fixture.mp4',
      '程序组件/live-editor/data/render-cache/fixture/cache.mp4','程序组件/live-editor/data/temp/fixture/work.bin',
      '程序组件/live-editor/data/desktop-profile/fixture.cache','程序组件/live-editor/data/editor.sqlite.backup','unregistered.txt')
    foreach ($file in $preserved) { $full=Join-Path $target $file; New-Item -ItemType Directory -Force -Path (Split-Path $full -Parent) | Out-Null; [IO.File]::WriteAllText($full,'private synthetic fixture',$utf8) }
    $link = Join-Path $target 'outside-link'
    New-Item -ItemType Junction -Path $link -Target $shared | Out-Null
    $marker = Join-Path $target '程序组件/installation-owner.txt'
    Assert-Installer (Test-Path -LiteralPath $marker) 'Installation ownership marker is missing.'
    $env:NO_RECORDER='1'; $env:EDITOR_DATA=$data; $env:EDITOR_PROJECT_ROOT=$target; $env:EDITOR_PORT='0'; $env:RECORDER_PORT='0'; $env:EDITOR_DESKTOP_MANAGED='0'
    $node = Join-Path $target '程序组件\runtime\node\node.exe'
    $backend = Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $app 'server\index.js') + '"') -WorkingDirectory $app -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $qaRoot 'backend-out.log') -RedirectStandardError (Join-Path $qaRoot 'backend-err.log')
    Wait-Endpoint
    $fixture = Join-Path $qaRoot 'state.mjs'
    [IO.File]::WriteAllText($fixture,@'
import {DatabaseSync} from 'node:sqlite';
const [file,action]=process.argv.slice(2),db=new DatabaseSync(file);
if(action==='busy')db.prepare("INSERT INTO sessions(id,title,room,created,status) VALUES('qa-busy','synthetic fixture',0,?,'recording')").run(new Date().toISOString());
else db.exec("UPDATE sessions SET status='finished' WHERE id='qa-busy'");
db.close();
'@,$utf8)
    & $node $fixture (Join-Path $data 'editor.sqlite') busy
    if ($LASTEXITCODE -ne 0) { throw 'Fixture creation failed.' }
    $uninstallArgs = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG="{0}"' -f (Join-Path $qaRoot 'uninstall.log')
    Assert-Installer ((Invoke-Setup $installer $arguments) -ne 0) 'Upgrade interrupted simulated recording.'
    Assert-Installer ((Invoke-Setup $uninstaller $uninstallArgs) -ne 0) 'Uninstall interrupted simulated recording.'
    $backend.Refresh(); Assert-Installer (!$backend.HasExited) 'Busy backend was terminated.'
    $endpoint=Read-Endpoint
    $status=Invoke-RestMethod -Uri ($endpoint.origin+'/internal/desktop') -Headers @{'X-Caibo-Instance'=$endpoint.token}
    Assert-Installer ($status.busy -and !$status.pending) 'Blocked maintenance requested a pending exit.'
    & $node $fixture (Join-Path $data 'editor.sqlite') idle
    Assert-Installer ((Invoke-Setup $installer $arguments) -eq 0) 'Idle upgrade failed.'
    Wait-BackendExit
    foreach ($file in $preserved) { Assert-Installer ([IO.File]::ReadAllText((Join-Path $target $file)) -eq 'private synthetic fixture') ('Upgrade changed user data: '+$file) }
    $markerText = [IO.File]::ReadAllText($marker)
    [IO.File]::WriteAllText($marker,($qaId + "`r`n" + $qaRoot + "`r`n"),$utf8)
    Assert-Installer ((Invoke-Setup $uninstaller $uninstallArgs) -ne 0) 'Uninstall accepted an ownership path mismatch.'
    Assert-Installer (Test-Path -LiteralPath (Join-Path $target '录播机.exe')) 'Refused uninstall removed the application.'
    [IO.File]::WriteAllText($marker,$markerText,$utf8)
    Assert-Installer ((Invoke-Setup $uninstaller $uninstallArgs) -eq 0) 'Idle uninstall failed.'
    # Inno's temporary cleanup process removes the uninstaller after its parent
    # exits. Wait for that process rather than racing it with fs.stat.
    for ($i=0;$i -lt 100 -and (Test-Path -LiteralPath $target);$i++) { Start-Sleep -Milliseconds 100 }
    foreach ($file in $preserved) { Assert-Installer (!(Test-Path -LiteralPath (Join-Path $target $file))) ('Uninstall retained user data: '+$file) }
    Assert-Installer (!(Test-Path -LiteralPath (Join-Path $data 'editor.sqlite'))) 'Uninstall retained the editing database.'
    foreach ($file in @('录播机.exe','程序组件/runtime/node/node.exe','卸载菜播·录包机.lnk','程序组件/卸载/unins000.exe')) { Assert-Installer (!(Test-Path -LiteralPath (Join-Path $target $file))) ('Uninstall retained program file: '+$file) }
    Assert-Installer (!(Test-Path -LiteralPath $registry)) 'Uninstall registration remained.'
    Assert-Installer (!(Test-Path -LiteralPath $target)) 'Uninstall left the installation directory behind.'
    Assert-Installer ([IO.File]::ReadAllText($outside) -eq 'outside installation') 'Uninstall followed a junction into unrelated files.'
    [ordered]@{result='passed';qaRoot=$qaRoot;filesVerified=$manifest.files.Count;installedBytes=$installedBytes;checks=@('shared-folder-install-refused','install','root-uninstall-shortcut','Windows-uninstall-registration','installed-hashes','busy-upgrade-refused','busy-uninstall-refused','idle-safe-upgrade','user-data-survives-upgrade','ownership-mismatch-refused','all-installation-files-removed','outside-junction-target-preserved','program-directory-and-registration-removed')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $qaRoot 'verification.json') -Encoding UTF8
    Get-Content (Join-Path $qaRoot 'verification.json') -Raw -Encoding UTF8
} finally {
    if ($backend) {
        $backend.Refresh()
        if (!$backend.HasExited) {
            # Only this explicitly started, synthetic test process may be stopped.
            $backend.Kill(); $backend.WaitForExit(5000) | Out-Null
        }
        $backend.Dispose()
    }
    foreach ($key in $envBefore.Keys) { [Environment]::SetEnvironmentVariable($key,$envBefore[$key]) }
}
