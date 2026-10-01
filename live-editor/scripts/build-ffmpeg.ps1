[CmdletBinding()]
param([string]$ProjectRoot = '', [string]$ToolsRoot = '', [string]$WorkRoot = '',
    [string]$Node = '', [int]$Jobs = 4, [switch]$SkipInstall)
$ErrorActionPreference = 'Stop'
if (!$ProjectRoot) { $ProjectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
. (Join-Path $PSScriptRoot 'dev-env.ps1') -ProjectRoot $ProjectRoot
if (!$ToolsRoot) { $ToolsRoot = Join-Path $ProjectRoot '.tools\release-tools' }
if (!$WorkRoot) { $WorkRoot = Join-Path $ProjectRoot ('.tools\ffmpeg-build-' + [Guid]::NewGuid().ToString('N')) }
if (!$Node) { $Node = Join-Path (Split-Path $ProjectRoot -Parent) '程序组件\runtime\node\node.exe' }
$arguments = @((Join-Path $PSScriptRoot 'build-ffmpeg.mjs'), '--project', $ProjectRoot,
    '--tools', $ToolsRoot, '--work', $WorkRoot, '--jobs', [string]$Jobs)
if ($SkipInstall) { $arguments += '--skip-install' }
& $Node @arguments
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg build failed; see the isolated build log.' }
