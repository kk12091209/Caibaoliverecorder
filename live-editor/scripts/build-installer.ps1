[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Stage,
    [Parameter(Mandatory=$true)][string]$Version,
    [Parameter(Mandatory=$true)][string]$ToolsRoot,
    [Parameter(Mandatory=$true)][string]$OutputRoot,
    [string]$AppId = 'Caibo.LiveRecorder',
    [string]$BaseName = '',
    [switch]$QaFastCompile
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') { throw 'Installer version must be numeric.' }
if ($AppId -notmatch '^[A-Za-z0-9.-]+$') { throw 'Invalid installer identity.' }
if ($QaFastCompile -and $AppId -notmatch '^Caibo\.QA\.') { throw 'Uncompressed compilation is restricted to isolated QA installers.' }
if (!$BaseName) { $BaseName = "BiliLiveEditor-$Version-win-x64-setup" }
if ($BaseName -notmatch '^[A-Za-z0-9._-]+$') { throw 'Invalid installer filename.' }
$Stage = (Resolve-Path -LiteralPath $Stage).Path
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$compilerRoot = Join-Path $ToolsRoot 'inno-6.7.3'
$compiler = Join-Path $compilerRoot 'ISCC.exe'
$installer = Join-Path $OutputRoot ($BaseName + '.exe')
if (Test-Path -LiteralPath $installer) { throw 'Installer output already exists.' }
$manifest = Join-Path $Stage '程序组件\release-manifest.json'
if (!(Test-Path -LiteralPath $manifest)) { throw 'A validated release stage is required.' }
$forbidden = '(?i)(^|[\\/])(data|originals|chunks|render-cache|temp|desktop-profile|node_modules|\.git)([\\/]|$)|\.(sqlite|flv|mp4|log)$'
foreach ($item in Get-ChildItem -LiteralPath $Stage -Recurse -Force) {
    $relative = $item.FullName.Substring($Stage.Length + 1)
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $relative -match $forbidden) { throw "Private or linked installer input: $relative" }
}
if ((Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash -ne '0A8757031B33777E4C9CBFFEE40F11A5062B36D25CBE144C1DB73B6102B80AD7') { throw 'Expected pinned Inno Setup 6.7.3 compiler.' }
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
$compilerArguments = @('/Qp',("/DStageDir=$Stage"),("/DAppVersion=$Version"),("/DSetupOutputDir=$OutputRoot"),("/DSetupAppId=$AppId"),("/DSetupBaseName=$BaseName"),("/DInnoLicense=" + (Join-Path $compilerRoot 'LICENSE.TXT')))
if ($QaFastCompile) { $compilerArguments += '/DQaFastCompile=1' }
& $compiler @compilerArguments (Join-Path (Split-Path $PSScriptRoot -Parent) 'installer\setup.iss') | Out-Host
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $installer)) { throw 'Installer compilation failed.' }
Write-Output $installer
