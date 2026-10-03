import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {constants} from 'node:fs';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {stopMacCore} from '../server/mac-core-stop.js';
import {availableLocalPort,stopOwnedCore} from '../server/local-endpoint.js';
const execFileAsync=promisify(execFile);

for(const locale of ['unset','C'])test(`Finder 环境识别并退出中文路径核心：${locale}`,{skip:process.platform!=='darwin',timeout:15000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-locale-'));
  const directory=path.join(root,'录像 原件'),executable=path.join(root,'菜播·录包机.app','Contents','录制核心');
  await fs.mkdir(path.dirname(executable),{recursive:true});await fs.mkdir(directory);
  await fs.copyFile(await fs.realpath(process.execPath),executable,constants.COPYFILE_FICLONE);
  await fs.writeFile(path.join(root,'run'),`process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000);process.stdout.write('ready');`);
  const child=spawn(executable,['run','--http-bind',`http://127.0.0.1:${await availableLocalPort()}`,'--http-basic-user','editor','--http-basic-pass','a'.repeat(48),'--enable-file-browser','false',directory],{cwd:root,detached:true,stdio:['ignore','pipe','pipe']});
  const ended=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await ended;}await fs.rm(root,{recursive:true,force:true});});
  await once(child.stdout,'data');
  const env={...process.env};for(const key of Object.keys(env))if(key==='LANG'||key.startsWith('LC_'))delete env[key];
  if(locale==='C'){env.LANG='C';env.LC_ALL='C';env.LC_CTYPE='C';}
  const script=`import assert from 'node:assert/strict';
    import {findOwnedCore,stopOwnedCore} from ${JSON.stringify(new URL('../server/local-endpoint.js',import.meta.url).href)};
    const owned=JSON.parse(process.argv[1]);
    assert.equal(await stopOwnedCore({...owned,directory:owned.directory+'-wrong'}),false);
    process.kill(owned.pid,0);
    assert.equal((await findOwnedCore(owned))?.pid,owned.pid,'Finder locale must preserve Chinese executable and originals paths');
    assert.equal(await stopOwnedCore(owned),true);
    console.log('verified and stopped');`;
  const {stdout}=await execFileAsync(process.execPath,['--input-type=module','-e',script,JSON.stringify({pid:child.pid,executable,directory})],{env,timeout:12000});
  assert.match(stdout,/verified and stopped/);assert.deepEqual(await ended,[0,null]);
});

function fixture(){
  const state={alive:true,identity:'original-process',time:0,signals:[],events:[]};
  const options={inspect:async()=>state.identity,isAlive:()=>state.alive,
    signal:(_pid,name)=>state.signals.push(name),now:()=>state.time,
    wait:async ms=>{state.time+=ms;},report:event=>state.events.push(event),
    stages:[['SIGINT',100],['SIGTERM',100],['SIGKILL',100]]};
  return {state,options};
}
test('正常停止留出写入收尾时间，不发送强制信号',async()=>{
  const {state,options}=fixture();options.wait=async ms=>{state.time+=ms;if(state.time===100)state.alive=false;};
  assert.equal(await stopMacCore(42,options),true);assert.deepEqual(state.signals,['SIGINT']);
  assert.equal(state.events.at(-1).outcome,'exited');
});
test('核心不响应时有界升级回收，并且确认消失才返回成功',async()=>{
  const {state,options}=fixture();options.signal=(_pid,name)=>{state.signals.push(name);if(name==='SIGKILL')state.alive=false;};
  assert.equal(await stopMacCore(42,options),true);assert.deepEqual(state.signals,['SIGINT','SIGTERM','SIGKILL']);
  assert.equal(state.time,200);
  const stuck=fixture();assert.equal(await stopMacCore(42,stuck.options),false);assert.equal(stuck.state.time,300);
});
test('身份变化或无法重新核实的 PID 不发送后续信号',async()=>{
  for(const identity of ['replacement-process',null]){
    const {state,options}=fixture();options.wait=async ms=>{state.time+=ms;state.identity=identity;};
    assert.equal(await stopMacCore(42,options),false);assert.deepEqual(state.signals,['SIGINT']);
    assert.equal(state.events.at(-1).outcome,'identity-changed');
  }
  const unowned=fixture();unowned.state.identity=null;
  assert.equal(await stopMacCore(42,unowned.options),false);assert.deepEqual(unowned.state.signals,[]);
});
test('核实或发送信号期间已经退出可成功，权限错误不谎报成功',async()=>{
  const gone=fixture();gone.options.inspect=async()=>{gone.state.alive=false;return null;};
  assert.equal(await stopMacCore(42,gone.options),true);
  for(const code of ['ESRCH','EPERM']){
    const f=fixture();f.options.signal=()=>{throw Object.assign(new Error(code),{code});};
    assert.equal(await stopMacCore(42,f.options),code==='ESRCH');
  }
});

for(const mode of ['graceful','ignore-int','ignore-both'])test(`Mac 真实独立进程退出：${mode}`,{skip:process.platform!=='darwin',timeout:25000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-stop-signal-'));
  const directory=path.join(root,'originals'),executable=await fs.realpath(process.execPath);
  await fs.mkdir(directory);
  // Match the recorder launch contract with an isolated Node fixture. Never
  // send signals to an installed app or a process found by name alone.
  await fs.writeFile(path.join(root,'run'),`const fs=require('node:fs');
    process.on('SIGINT',()=>{if(${JSON.stringify(mode)}==='graceful'){fs.writeFileSync('flushed','yes');process.exit(0);}});
    process.on('SIGTERM',()=>{if(${JSON.stringify(mode)}==='ignore-int')process.exit(0);});
    setInterval(()=>{},1000);process.stdout.write('ready\\n');`);
  const child=spawn(executable,['run','--http-bind',`http://127.0.0.1:${await availableLocalPort()}`,'--http-basic-user','editor','--http-basic-pass','a'.repeat(48),'--enable-file-browser','false',directory],{cwd:root,detached:true,stdio:['ignore','pipe','pipe']});
  const ended=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await ended;}await fs.rm(root,{recursive:true,force:true});});
  await once(child.stdout,'data');
  assert.equal(await stopOwnedCore({pid:child.pid,executable,directory:directory+'-wrong'}),false);
  assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
  const started=Date.now();assert.equal(await stopOwnedCore({pid:child.pid,executable,directory}),true);
  const [code,signal]=await ended;
  if(mode==='ignore-both')assert.equal(signal,'SIGKILL');else assert.equal(code,0);
  if(mode==='graceful')assert.equal(await fs.readFile(path.join(root,'flushed'),'utf8'),'yes');
  t.diagnostic(`${mode}: ${Date.now()-started}ms, exit=${code}, signal=${signal}`);
});
