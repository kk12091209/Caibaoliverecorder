import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root=fileURLToPath(new URL('../..',import.meta.url));
if(process.platform!=='darwin')throw new Error('系统资源助手仅适用于 macOS。');
const target=path.resolve(process.argv[2]||path.join(root,'.tools/runtime/resources/live-system-resources'));
await fs.mkdir(path.dirname(target),{recursive:true});
const temporary=await fs.mkdtemp('/private/tmp/caibao-live-resources-');
try {
  const binary=path.join(temporary,'live-system-resources');
  await promisify(execFile)('xcrun',['swiftc','-swift-version','5','-O','-j','1','-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macos14.0`,
    '-module-cache-path',path.join(temporary,'modules'),'-framework','IOKit',
    path.join(root,'live-editor/desktop-macos/LiveSystemResources.swift'),'-o',binary],
  {env:{...process.env,TMPDIR:'/private/tmp',TMP:'/private/tmp',TEMP:'/private/tmp'},timeout:120000,maxBuffer:32768});
  await fs.copyFile(binary,target);await fs.chmod(target,0o755);
  console.log(`系统资源助手已生成：${target}`);
} finally {await fs.rm(temporary,{recursive:true,force:true});}
