import fs from 'node:fs/promises';
import os from 'node:os';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {protectDataDirectory} from '../server/local-access.js';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao native 权限-'));
try {
  // The script below is the exact production command, with only fixture data.
  const source=await fs.readFile(new URL('../server/local-access.js',import.meta.url),'utf8');
  const script=JSON.parse(source.match(/const script=("[^\n]+");/)[1]);
  try {await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,CAIBAO_PRIVATE_ROOT:root},timeout:10000,windowsHide:true});}
  catch(error){console.error('Native ACL fixture:',error.code,error.stderr);throw error;}
  await protectDataDirectory(root);
  await fs.writeFile(path.join(root,'fixture.txt'),'test-only');
  // Elevated Windows processes may create files owned by Administrators.
  // Verify the explicit directory owner and both effective ACLs independently.
  const inspect="$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $d=[System.IO.Directory]::GetAccessControl($env:CAIBAO_PRIVATE_ROOT); $f=[System.IO.File]::GetAccessControl([System.IO.Path]::Combine($env:CAIBAO_PRIVATE_ROOT,'fixture.txt')); if($d.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid){throw 'Unexpected directory owner'}; foreach($acl in @($d,$f)){$rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); if($rules.Count -ne 2){throw 'Unexpected rule count'}; foreach($rule in $rules){if($rule.IdentityReference.Value -notin @($sid,'S-1-5-18') -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl'){throw 'Unexpected permission'}}}; if(-not $d.AreAccessRulesProtected){throw 'Directory inheritance remains enabled'}; Write-Output 'ACL_VERIFIED'";
  const result=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',inspect],{env:{...process.env,CAIBAO_PRIVATE_ROOT:root},timeout:10000,windowsHide:true});
  assert.match(result.stdout,/ACL_VERIFIED/);
  console.log('Native private ACL, inherited file permissions, Unicode paths and subsequent writes passed');
} finally {await fs.rm(root,{recursive:true,force:true});}
