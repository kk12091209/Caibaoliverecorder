function Get-CaiboVersion {
    param([Parameter(Mandatory=$true)][string]$AppRoot, [string]$Expected = '')
    $version = (Get-Content -LiteralPath (Join-Path $AppRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    if ($version -cnotmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-beta\.[1-9]\d{0,4})?$') { throw 'Expected a release version or a numbered beta in live-editor/package.json.' }
    if ($Expected -and $Expected -cne $version) { throw "Requested version $Expected does not match the editor version $version." }
    return $version
}
