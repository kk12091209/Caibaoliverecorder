import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

test('source package retains recorder Runtime/Logs source and current CI while excluding private runtime files', {skip:process.platform!=='win32'}, async t=>{
  const appRoot=fileURLToPath(new URL('../',import.meta.url));
  const projectRoot=path.dirname(appRoot);
  const tempRoot=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-source-package-'));
  t.after(async()=>{
    assert.equal(path.dirname(tempRoot),path.resolve(os.tmpdir()));
    await fs.rm(tempRoot,{recursive:true,force:true});
  });
  const output=path.join(tempRoot,'source.zip');
  const powershell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  execFileSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    path.join(appRoot,'scripts','package-source.ps1'),'-ProjectRoot',projectRoot,'-AppRoot',appRoot,'-OutputFile',output],
  {windowsHide:true,encoding:'utf8',timeout:60000,
    env:{...process.env,PSModulePath:path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','Modules')}});
  const manifest=JSON.parse(await fs.readFile(path.join(tempRoot,'source.manifest.json'),'utf8'));
  const included=new Set(manifest.files.map(file=>file.path));
  for(const required of [
    'BililiveRecorder.Core/Scripting/Runtime/JintConsole.cs',
    'BililiveRecorder.Core/Scripting/Runtime/JintFetchSync.cs',
    'BililiveRecorder.Web/Models/Rest/Logs/WebApiLogEventSink.cs',
    '.github/workflows/editor.yml'
  ])assert.ok(included.has(required),`missing corresponding source: ${required}`);
  if(manifest.submodules.find(module=>module.path==='webui/source')?.initialized)
    assert.ok(included.has('webui/source/.github/default.conf'),'initialized Web UI source must retain its build configuration');
  assert.ok(!manifest.excluded.some(file=>file.path.endsWith('.cs')),'tracked C# source must not be filtered as generated data');
  for(const file of manifest.files){
    const policyPath=file.path.replace(/^test\/data\//,'test/fixtures/');
    assert.ok(!/(^|\/)(data|\.tools|node_modules|bin|obj|dist|originals|chunks|archives|exports|\.git)(\/|$)|\.(?:sqlite|db|flv|exe|dll|log)$/i.test(policyPath),`private/build file: ${file.path}`);
    assert.ok(!policyPath.startsWith('live-editor/runtime/'));
  }
  assert.ok((await fs.stat(output)).size>0);
  // Imported historical source metadata must not collide with the new manifest.
  // Verify the actual ZIP, since the sidecar alone cannot detect duplicate names
  // or entries whose content was silently substituted while writing the archive.
  const verifyArchive = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($env:CAIBO_SOURCE_ZIP)
try {
  $names=@($zip.Entries | ForEach-Object { $_.FullName })
  if ($names.Count -ne @($names | Select-Object -Unique).Count) { throw 'Duplicate source ZIP entries.' }
  $manifest=Get-Content -LiteralPath $env:CAIBO_SOURCE_MANIFEST -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($file in $manifest.files) {
    $entry=$zip.GetEntry($file.path)
    if (!$entry) { throw ('Missing ZIP source: '+$file.path) }
    $stream=$entry.Open(); $sha=[Security.Cryptography.SHA256]::Create()
    try { $actual=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
    if ($actual -ne $file.sha256 -or $entry.Length -ne $file.bytes) { throw ('Source ZIP hash mismatch: '+$file.path) }
  }
} finally { $zip.Dispose() }
`;
  execFileSync(powershell,['-NoProfile','-NonInteractive','-Command',verifyArchive],{
    windowsHide:true,encoding:'utf8',timeout:60000,
    env:{...process.env,CAIBO_SOURCE_ZIP:output,CAIBO_SOURCE_MANIFEST:path.join(tempRoot,'source.manifest.json'),
      PSModulePath:path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','Modules')}
  });
});
