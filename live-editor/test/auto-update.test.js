import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { waitForExit, atomicReplace, digest } from '../server/update-helper.js';
import { AutoUpdate } from '../server/auto-update.js';
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-update-transaction-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('更新等待 GUI 和后台全部退出，超时和取消不替换程序',async()=>{let checks=0;await waitForExit([1,2],{isAlive:pid=>pid===2&&checks++<2,pause:async()=>{}});assert.ok(checks>=3);await assert.rejects(waitForExit([1],{isAlive:()=>true,timeout:0,pause:async()=>{}}),/安全退出/);await assert.rejects(waitForExit([1],{isAlive:()=>true,cancelled:async()=>true}),/取消/);});
test('Mac 同目录原子替换成功并保留回退副本',async t=>{const root=await fixture(t),target=path.join(root,'app'),stage=path.join(root,'stage'),backup=path.join(root,'backup');await fs.mkdir(target);await fs.mkdir(stage);await fs.writeFile(path.join(target,'version'),'old');await fs.writeFile(path.join(stage,'version'),'new');await atomicReplace(target,stage,backup);assert.equal(await fs.readFile(path.join(target,'version'),'utf8'),'new');assert.equal(await fs.readFile(path.join(backup,'version'),'utf8'),'old');});
test('替换后的校验失败会自动恢复原目录',async t=>{const root=await fixture(t),target=path.join(root,'app'),stage=path.join(root,'stage'),backup=path.join(root,'backup');await fs.mkdir(target);await fs.mkdir(stage);await fs.writeFile(path.join(target,'version'),'old');await assert.rejects(atomicReplace(target,stage,backup,{validate:async()=>{throw new Error('Invalid code signature');}}),/Invalid/);assert.equal(await fs.readFile(path.join(target,'version'),'utf8'),'old');await assert.rejects(fs.stat(backup),/ENOENT/);});
test('执行前 SHA 校验拒绝链接，篡改后的字节不会保持原 SHA',async t=>{const root=await fixture(t),file=path.join(root,'package');await fs.writeFile(file,'good');const first=await digest(file);await fs.writeFile(file,'evil');assert.notEqual(await digest(file),first);});
test('自动安装只允许活跃且已认证的桌面进程，拒绝网页指定路径',async()=>{let quit=false;const updater=new AutoUpdate({runtime:{clients:new Map()},quit:async()=>{quit=true;},updates:{store:{setting(){}}},appRoot:os.tmpdir(),projectRoot:os.tmpdir()});await assert.rejects(updater.apply({target:os.tmpdir(),guiPid:process.pid}),/连接/);assert.equal(quit,false);});
test('并发更新在校验前独占，第一次失败后释放占用',async t=>{
  if(!['darwin','win32'].includes(process.platform)){t.skip('Native desktop platform');return;}
  const root=await fixture(t);let reject,entered;const started=new Promise(resolve=>{entered=resolve;});const pending=new Promise((_,fail)=>{reject=fail;});
  const updater=new AutoUpdate({runtime:{clients:new Map([['client',{pid:process.pid}]])},updates:{installPath:()=>{entered();return pending;},store:{setting(){}}},appRoot:process.platform==='darwin'?path.join(root,'Contents/Resources/live-editor'):root,projectRoot:root,activity:()=>({updateBusy:false})});
  const first=updater.apply({target:root,guiPid:process.pid});await assert.rejects(updater.apply({target:root,guiPid:process.pid}),/正在安装/);await started;const rejected=assert.rejects(first,/validation failure/);reject(new Error('validation failure'));await rejected;assert.equal(updater.applying,false);
});

test('Mac 允许父目录的系统别名，但拒绝链接应用和其他安装目录',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS path aliases');return;}
  const root=await fixture(t),target=path.join(root,'app');await fs.mkdir(target);let validated=0;
  const updater=new AutoUpdate({runtime:{clients:new Map([['client',{pid:process.pid}]])},updates:{installPath:()=>{validated++;throw new Error('package validation reached');},store:{setting(){}}},appRoot:path.join(await fs.realpath(target),'Contents/Resources/live-editor'),activity:()=>({updateBusy:false})});
  await assert.rejects(updater.apply({target,guiPid:process.pid}),/package validation reached/);assert.equal(validated,1);
  const link=path.join(root,'linked.app');await fs.symlink(target,link);await assert.rejects(updater.apply({target:link,guiPid:process.pid}),/符号链接/);
  await assert.rejects(updater.apply({target:root,guiPid:process.pid}),/正式安装/);assert.equal(validated,1);
});
