import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);

test('Mac 休眠检测区分合盖策略、缺失信息和本应用防休眠，读取不改变系统设置',{skip:process.platform!=='darwin',timeout:150000},async t=>{
  const root=await fs.mkdtemp('/private/tmp/caibo-power-status-');t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=await fs.readFile(new URL('../desktop-macos/App.swift',import.meta.url),'utf8');
  const start=source.indexOf('enum RecordingPowerStatus {'),end=source.indexOf('@MainActor final class AppDelegate');
  assert.ok(start>=0&&end>start);
  const module=path.join(root,'PowerStatus.swift'),executable=path.join(root,'checks');
  await fs.writeFile(module,'import Foundation\nimport IOKit.pwr_mgt\n'+source.slice(start,end));
  const env={...process.env,TMPDIR:'/private/tmp',TMP:'/private/tmp',TEMP:'/private/tmp'};
  await run('xcrun',['swiftc','-swift-version','5','-j','1','-module-cache-path',path.join(root,'modules'),module,
    fileURLToPath(new URL('../desktop-macos/ProcessOwnership.swift',import.meta.url)),
    fileURLToPath(new URL('./helpers/macos-power-status.swift',import.meta.url)),'-o',executable],{env,timeout:120000});
  const {stdout}=await run(executable,[],{env,timeout:10000});assert.match(stdout,/PASS power state checks/);t.diagnostic(stdout.trim());
});
