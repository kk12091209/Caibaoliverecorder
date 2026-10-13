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

test('global:null 配置恢复后真实核心可连接，再次冷启动不重复恢复或误报退出',{skip:process.env.CAIBO_CORE_SMOKE!=='1',timeout:60000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-real-config-'));
  const original=JSON.stringify({version:3,global:null,rooms:[]}),directory=path.join(root,'originals');
  await fs.mkdir(directory);await fs.writeFile(path.join(directory,'config.json'),original);
  const options={data:root,port:0,recorderPort:0,preparation:false,compact:false,updatesAutoCheck:false};
  let app,backups;
  t.after(async()=>{
    const owned=app?.recorder.ownedEndpoint;await app?.close();
    if(owned&&alive(owned.pid))assert.equal(await stopOwnedCore(owned),true);
    await fs.rm(root,{recursive:true,force:true});
  });
  for(let attempt=0;attempt<2;attempt++){
    app=await createApp(options);
    const deadline=Date.now()+20000;
    while(!app.recorder.online&&Date.now()<deadline)await delay(50);
    assert.equal(app.recorder.online,true,app.recorder.error);
    assert.deepEqual(await app.recorder.api('room'),[]);
    const current=await fs.readdir(path.join(root,'recovery'));
    if(attempt===0){
      backups=current;assert.equal(backups.length,1);
      assert.equal(await fs.readFile(path.join(root,'recovery',backups[0]),'utf8'),original);
      assert.equal(app.store.recovery.coreConfigRecovered,true);
    }else{
      assert.deepEqual(current,backups);assert.ok(!app.store.recovery.coreConfigRecovered);
    }
    const pid=app.recorder.ownedEndpoint.pid;
    const result=await app.desktopExit.request(false);assert.equal(result.quitAccepted,true);
    await app.desktopExit.completion;await app.close();assert.equal(alive(pid),false);
    const log=await fs.readFile(path.join(root,'logs',app.diagnostics.day+'.txt'),'utf8');
    assert.doesNotMatch(log,/NullReferenceException|录制核心已退出 .*正在尝试恢复/);
    const exits=[...log.matchAll(/B站录制核心退出：(\{[^\n]+\})/g)].map(match=>JSON.parse(match[1]));
    const exit=exits.findLast(event=>event.pid===pid);
    assert.equal(exit?.expected,true);assert.equal(exit.reason,'用户请求退出');
    // Windows taskkill reports unsigned -1 after an intentional process stop;
    // macOS's SIGINT path lets the core return zero. Neither may trigger recovery.
    assert.ok((process.platform==='win32'?[0,4294967295]:[0]).includes(exit.code),JSON.stringify(exit));
  }
});
