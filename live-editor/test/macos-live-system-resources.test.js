import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run=promisify(execFile);
test('Mac live resource helper builds and reads power/thermal state without changing system settings',
  {skip:process.platform!=='darwin',timeout:150000},async t=>{
    const root=await fs.mkdtemp('/private/tmp/caibao-resource-helper-check-');t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const executable=path.join(root,'live-system-resources');
    await run(process.execPath,[fileURLToPath(new URL('../scripts/build-live-resource-helper.mjs',import.meta.url)),executable],{timeout:130000,maxBuffer:32768});
    const {stdout}=await run(executable,[],{timeout:3000,maxBuffer:4096});
    const sample=JSON.parse(stdout);
    assert.equal(sample.version,1);assert.ok([true,false,null].includes(sample.acPower));
    assert.equal(typeof sample.lowPowerMode,'boolean');assert.ok(['nominal','fair','serious','critical','unknown'].includes(sample.thermal));
    assert.ok(Math.abs(Date.now()-sample.sampledAt)<5000);t.diagnostic(`Read-only power=${sample.acPower}; thermal=${sample.thermal}; lowPowerMode=${sample.lowPowerMode}`);
  });
