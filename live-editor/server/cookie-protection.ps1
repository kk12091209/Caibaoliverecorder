$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Security
    $text = [Console]::In.ReadToEnd()
    if ($text.Length -gt 131072) { throw 'Invalid request' }
    $request = $text | ConvertFrom-Json
    if ($request.namespace -notmatch '^[a-f0-9]{64}$' -or $request.context -cne "caibao.cookies.v1:$($request.namespace):bilibili") { throw 'Invalid scope' }
    $bytes = [Convert]::FromBase64String($request.data)
    $entropy = [Text.Encoding]::UTF8.GetBytes($request.context)
    if ($request.operation -eq 'seal') {
        $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    } elseif ($request.operation -in @('open', 'unlock')) {
        $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    } else { throw 'Invalid operation' }
    [Console]::Out.Write('{"data":"' + [Convert]::ToBase64String($result) + '"}')
    [Array]::Clear($bytes, 0, $bytes.Length)
    [Array]::Clear($result, 0, $result.Length)
} catch {
    # Never echo input, exception objects, or PowerShell invocation details.
    [Console]::Error.Write('Secure storage unavailable')
    exit 1
}
