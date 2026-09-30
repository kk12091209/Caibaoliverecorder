[CmdletBinding()]
param(
    [string]$Destination = '',
    [string]$ProjectRoot = ''
)
$ErrorActionPreference = 'Stop'
if (!$ProjectRoot) { $ProjectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
if (!$Destination) { $Destination = Join-Path $ProjectRoot '.tools\release-tools' }
$Destination = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$assets = @(
    @{ name='7zr.exe'; url='https://www.7-zip.org/a/7zr.exe'; sha256='ad4c82fadcbdf93c03b4fc440f300509c7d60c5c2f4d183e35d9d70d6957037d' },
    @{ name='7z2603-x64.exe'; url='https://github.com/ip7z/7zip/releases/download/26.03/7z2603-x64.exe'; sha256='0859c524b8a63551848f0c246abddcb1d0b7b656b0fbfe879f8d85e61a9e6edd' },
    @{ name='ffmpeg-8.1.2-essentials_build.7z'; url='https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.7z'; sha256='e25b682664025d49034c981afb4bae36238a40f29a3cc1c713ad9a8b5b3528f6' },
    @{ name='innosetup-6.7.3.exe'; url='https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe'; sha256='9c73c3bae7ed48d44112a0f48e66742c00090bdb5bef71d9d3c056c66e97b732' },
    @{ name='NODE-LICENSE.txt'; url='https://raw.githubusercontent.com/nodejs/node/v24.12.0/LICENSE'; sha256='537308465103a306d0e3eecf42632b4ff1b48aaaec044e9fc10a78c81fd00b34' },
    @{ name='license-texts/Apache-2.0.txt'; url='https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/Apache-2.0.txt'; sha256='074e6e32c86a4c0ef8b3ed25b721ca23aca83df277cd88106ef7177c354615ff' },
    @{ name='license-texts/BSD-2-Clause.txt'; url='https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/BSD-2-Clause.txt'; sha256='f32fb3b417a194167cfad068223fc975ba96c5960513a10f66a3c28720aec1df' },
    @{ name='license-texts/BSD-3-Clause.txt'; url='https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/BSD-3-Clause.txt'; sha256='5a93d5831e1297ab10fe643e1a631e83be392896da14ee2951285a79012df69d' },
    @{ name='license-texts/MIT.txt'; url='https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/MIT.txt'; sha256='b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5' },
    @{ name='license-texts/HierarchicalPropertyDefault.txt'; url='https://raw.githubusercontent.com/Genteure/HierarchicalPropertyDefault/75fdf624b14651a7d838569ec8b7dece740e8b68/LICENSE'; sha256='d073d2b1ed67e1e4d184db78b4e7dcda7fc63f9bbadaae0fc42176dae954a7ac' },
    @{ name='license-texts/StructLinq.txt'; url='https://raw.githubusercontent.com/reegeek/StructLinq/2a7ec0f9485f9e2c158b158381f41f6ab3912c9b/LICENSE'; sha256='feb87a2e0c305de3464cc44077da5393c52d8ca6362d37427157d04ec6f4510d' }
)
foreach ($asset in $assets) {
    $path = Join-Path $Destination $asset.name
    New-Item -ItemType Directory -Force -Path (Split-Path $path -Parent) | Out-Null
    if (!(Test-Path -LiteralPath $path)) { Invoke-WebRequest -UseBasicParsing -Uri $asset.url -OutFile $path }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset.sha256) { throw "Checksum mismatch: $($asset.name). Do not execute this file; review upstream version before updating the pinned hash." }
}
$extractor = Join-Path $Destination '7zr.exe'
foreach ($item in @(@{file='7z2603-x64.exe';folder='7zip'}, @{file='ffmpeg-8.1.2-essentials_build.7z';folder='ffmpeg-essentials'})) {
    $folder = Join-Path $Destination $item.folder
    if (!(Test-Path -LiteralPath $folder)) {
        & $extractor x (Join-Path $Destination $item.file) ('-o' + $folder) -y
        if ($LASTEXITCODE -ne 0) { throw "Extraction failed: $($item.file)" }
    }
}
$compilerRoot = Join-Path $Destination 'inno-6.7.3'
if (!(Test-Path -LiteralPath (Join-Path $compilerRoot 'ISCC.exe'))) {
    $setup = Join-Path $Destination 'innosetup-6.7.3.exe'
    $signature = Get-AuthenticodeSignature -LiteralPath $setup
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Pyrsys B.V.') { throw 'Inno Setup signature verification failed.' }
    # Developer compiler only: current user, no shortcuts or file associations.
    $arguments = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER /NOICONS /TASKS="" /DIR="{0}" /LOG="{1}"' -f $compilerRoot,(Join-Path $Destination 'inno-install.log')
    $process = Start-Process -FilePath $setup -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw 'Inno Setup compiler installation failed.' }
}
$assets | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Destination 'download-manifest.json') -Encoding UTF8
Write-Output "Verified release tools: $Destination"
