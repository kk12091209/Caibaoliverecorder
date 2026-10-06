import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
test('Mac repair handles offline, interrupted, corrupt and unwritable environments without partial replacement', {skip:process.platform!=='darwin',timeout:90000}, async()=>{
  const root=await fs.mkdtemp('/private/tmp/caibo-repair-extremes-');
  try {
    const env={...process.env,TMPDIR:'/private/tmp',TMP:'/private/tmp',TEMP:'/private/tmp'}, executable=path.join(root,'checks');
    const files=['ProcessOwnership.swift','Repair.swift','Backend.swift'].map(name=>fileURLToPath(new URL('../desktop-macos/'+name,import.meta.url)));
    await run('xcrun',['swiftc','-swift-version','5','-module-cache-path',path.join(root,'modules'),...files,fileURLToPath(new URL('./helpers/macos-repair-extremes.swift',import.meta.url)),'-o',executable],{env,timeout:45000});
    const {stdout}=await run(executable,[root],{env,timeout:35000});
    assert.equal(stdout.match(/^PASS /gm)?.length,17,stdout);
    if(process.env.CAIBO_REPAIR_TEST_EVIDENCE)await fs.writeFile(process.env.CAIBO_REPAIR_TEST_EVIDENCE,stdout);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
