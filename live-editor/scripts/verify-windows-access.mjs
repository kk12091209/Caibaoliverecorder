import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {protectDataDirectory} from '../server/local-access.js';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-native-acl-'));
try {
  // The script below is the exact production command, with only fixture data.
  const source=await fs.readFile(new URL('../server/local-access.js',import.meta.url),'utf8');
  const script=JSON.parse(source.match(/const script=("[^\n]+");/)[1]);
  try {await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,CAIBAO_PRIVATE_ROOT:root},timeout:10000,windowsHide:true});}
  catch(error){console.error('Native ACL fixture:',error.code,error.stderr);throw error;}
  await protectDataDirectory(root);
  await fs.writeFile(path.join(root,'fixture.txt'),'test-only');
  console.log('Native directory protection and subsequent writes passed');
} finally {await fs.rm(root,{recursive:true,force:true});}
