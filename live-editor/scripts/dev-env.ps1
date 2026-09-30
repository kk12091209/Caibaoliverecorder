# Dot-source this file from the project drive: . .\scripts\dev-env.ps1
[CmdletBinding()]
param([string]$ProjectRoot = '')
if (!$ProjectRoot) { $ProjectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
$devProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).Path
$devToolRoot = Join-Path $devProjectRoot '.tools'
$devEnvironment = [ordered]@{
    TEMP = (Join-Path $devToolRoot 'temp')
    TMP = (Join-Path $devToolRoot 'temp')
    NPM_CONFIG_CACHE = (Join-Path $devToolRoot 'npm-cache')
    NUGET_PACKAGES = (Join-Path $devToolRoot 'nuget\packages')
    DOTNET_CLI_HOME = (Join-Path $devToolRoot 'dotnet-home')
}
foreach ($devDirectory in ($devEnvironment.Values | Select-Object -Unique)) {
    New-Item -ItemType Directory -Force -Path $devDirectory -ErrorAction Stop | Out-Null
}
foreach ($devEntry in $devEnvironment.GetEnumerator()) {
    # Process scope only; existing user/machine environment and shared caches stay intact.
    [Environment]::SetEnvironmentVariable($devEntry.Key, $devEntry.Value, [EnvironmentVariableTarget]::Process)
}
Write-Output "Development caches for this PowerShell session: $devToolRoot"
