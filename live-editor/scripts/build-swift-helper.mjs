import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

export const projectRoot=fileURLToPath(new URL('../..',import.meta.url));
const run=promisify(execFile);

export async function buildSwiftHelper({target,name,source,framework,temporaryPrefix,temporaryEnvironment,
  createTargetDirectoryBeforeBuild=false,signIdentifier,successMessage}) {
  if(createTargetDirectoryBeforeBuild)await fs.mkdir(path.dirname(target),{recursive:true});
  const temporary=await fs.mkdtemp(`/private/tmp/${temporaryPrefix}`);
  try {
    const binary=path.join(temporary,name);
    await run('xcrun',['swiftc','-swift-version','5','-O','-j','1','-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macos14.0`,
      '-module-cache-path',path.join(temporary,'modules'),'-framework',framework,
      path.join(projectRoot,'live-editor/desktop-macos',source),'-o',binary],
    {env:{...process.env,...temporaryEnvironment},timeout:120000,maxBuffer:32768});
    if(!createTargetDirectoryBeforeBuild)await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.copyFile(binary,target);await fs.chmod(target,0o755);
    if(signIdentifier)await run('/usr/bin/codesign',['--force','--sign','-','--identifier',signIdentifier,target],{timeout:30000});
    console.log(successMessage);
  } finally {await fs.rm(temporary,{recursive:true,force:true});}
}
