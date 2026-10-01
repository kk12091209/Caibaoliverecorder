import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { createApp } from '../server/index.js';
import { alive } from '../server/service-runtime.js';
import { availableLocalPort,findOwnedCore,stopOwnedCore,browserAccessiblePort,listenLocal } from '../server/local-endpoint.js';

test('核心停止器拒绝不属于本份原件目录的 PID，不碰端口上的其他程序',async()=>{
  assert.equal(await stopOwnedCore({pid:0,executable:process.execPath,directory:os.tmpdir()}),false);
  assert.equal(await stopOwnedCore({pid:process.pid,executable:process.execPath,directory:path.join(os.tmpdir(),'not-current-process')}),false);
  assert.equal(alive(process.pid),true);
});

test('本机地址自动分配浏览器可访问的端口',async()=>{assert.equal(browserAccessiblePort(await availableLocalPort()),true);});

class AllocatedServer extends EventEmitter {
  constructor(ports){super();this.ports=ports;this.starts=[];this.closes=0;}
  listen(port,host){this.starts.push({port,host});this.allocated=this.ports.shift();queueMicrotask(()=>this.emit('listening'));}
  address(){return {port:this.allocated};}
  close(callback){this.closes++;queueMicrotask(callback);}
}
test('跳过系统分配的禁止端口，保留安全端口的绑定，不泄漏监听器',async()=>{
  const server=new AllocatedServer([6000,6667,10080,18080]);
  assert.equal(await listenLocal(server),18080);assert.equal(server.closes,3);
  assert.deepEqual(server.starts,Array.from({length:4},()=>({port:0,host:'127.0.0.1'})));
  assert.equal(server.listenerCount('error'),0);assert.equal(server.listenerCount('listening'),0);
});
test('不可访问的显式地址被拒绝；连续禁止端口有重试上限',async()=>{
  const explicit=new AllocatedServer([]);
  await assert.rejects(listenLocal(explicit,6000),/不可访问/);assert.equal(explicit.starts.length,0);
  const exhausted=new AllocatedServer(Array(32).fill(6000));
  await assert.rejects(listenLocal(exhausted),/自动分配/);assert.equal(exhausted.closes,32);
});
test('真正的端口占用错误仍会返回，清理临时事件监听',async()=>{
  const server=new AllocatedServer([]),error=Object.assign(new Error('occupied'),{code:'EADDRINUSE'});
  server.listen=()=>queueMicrotask(()=>server.emit('error',error));
  await assert.rejects(listenLocal(server,18080),{code:'EADDRINUSE'});
  assert.equal(server.listenerCount('error'),0);assert.equal(server.listenerCount('listening'),0);
});

test('真实录制核心自动启动、编辑器重启复用，完整退出清理独立进程',{skip:process.env.CAIBO_CORE_SMOKE!=='1',timeout:60000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-real-core-'));
  const options={data:root,port:0,recorderPort:0,preparation:false,compact:false,runtimePollMs:20};
  let app,owned;
  t.after(async()=>{
    await app?.close();if(owned&&alive(owned.pid))await stopOwnedCore(owned);
    await fs.rm(root,{recursive:true,force:true});
  });
  async function until(check,message){const end=Date.now()+35000;while(Date.now()<end){if(await check())return;await delay(50);}assert.fail(message);}
  app=await createApp(options);await until(()=>app.recorder.online,'core did not become ready: '+app.recorder.error);
  owned=app.recorder.ownedEndpoint;assert.ok(owned.pid>0);assert.notEqual(app.port,owned.port);
  assert.deepEqual((await findOwnedCore(owned)).pid,owned.pid);
  const config=await app.recorder.api('config/global');
  assert.ok(JSON.stringify(config).includes('127.0.0.1:'+app.port));
  const oldPort=app.port;await app.close();assert.equal(alive(owned.pid),true);
  app=await createApp(options);await until(()=>app.recorder.online,'core reconnect failed');
  assert.equal(app.recorder.ownedEndpoint.pid,owned.pid);assert.equal(app.recorder.process,null);
  assert.notEqual(app.port,oldPort);
  const started=performance.now();
  const response=await fetch(app.runtime.origin+'/internal/desktop',{method:'POST',headers:{'X-Caibo-Instance':app.runtime.token,'Content-Type':'application/json'},body:JSON.stringify({action:'quit',confirmed:false})});
  assert.equal(response.status,200);const decision=await response.json();assert.equal(decision.quitAccepted,true);assert.equal(decision.requiresExitConfirmation,false);
  t.diagnostic(`真实空闲核心退出受理 ${Math.round(performance.now()-started)}ms；进程收尾独立执行`);
  await app.desktopExit.completion;await until(()=>app.runtime.closed,'full exit did not settle');await app.close();
  assert.equal(alive(owned.pid),false);assert.equal(app.runtime.pending,'quit');
});
