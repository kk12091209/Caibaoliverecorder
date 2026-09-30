import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/index.js';
import { alive } from '../server/service-runtime.js';
import { availableLocalPort,findOwnedCore,stopOwnedCore } from '../server/local-endpoint.js';

test('核心停止器拒绝不属于本份原件目录的 PID，不碰端口上的其他程序',async()=>{
  assert.equal(await stopOwnedCore({pid:0,executable:process.execPath,directory:os.tmpdir()}),false);
  assert.equal(await stopOwnedCore({pid:process.pid,executable:process.execPath,directory:path.join(os.tmpdir(),'not-current-process')}),false);
  assert.equal(alive(process.pid),true);
});

test('本机地址自动分配可用端口',async()=>{const port=await availableLocalPort();assert.ok(port>0&&port<65536);});

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
  const response=await fetch(app.runtime.origin+'/internal/desktop',{method:'POST',headers:{'X-Caibo-Instance':app.runtime.token,'Content-Type':'application/json'},body:JSON.stringify({action:'exit'})});
  assert.equal(response.status,200);await until(()=>app.runtime.closed,'full exit did not settle');await app.close();
  assert.equal(alive(owned.pid),false);assert.equal(app.runtime.pending,'exit');
});
