import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createApp} from '../server/index.js';

test('settings expose a fixed log directory; desktop events require authentication and are saved before exit',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'daily-log-api-'));
  const app=await createApp({data:root,noRecorder:true,preparation:false,compact:false,updatesAutoCheck:false});
  t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${app.port}`;
  const state=await (await fetch(origin+'/api/state')).json();assert.equal(state.paths.logs,path.join(root,'logs'));
  const event={action:'diagnostic',message:'native test failed token=private-token',warning:true};
  let response=await fetch(origin+'/internal/desktop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(event)});assert.equal(response.status,403);await response.json();
  const headers={'Content-Type':'application/json','X-Caibo-Instance':app.runtime.token};
  response=await fetch(origin+'/internal/desktop',{method:'POST',headers,body:JSON.stringify({action:'heartbeat',client:'a'.repeat(32),pid:process.pid,clientKind:'desktop'})});assert.equal(response.status,200);await response.json();
  response=await fetch(origin+'/internal/desktop',{method:'POST',headers,body:JSON.stringify(event)});assert.equal(response.status,200);await response.json();
  app.recorder.action=async()=>{};
  for(const action of ['start','stop','auto']){response=await fetch(origin+`/api/rooms/280446/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:true})});assert.equal(response.status,200);await response.json();}
  await app.close();const names=(await fs.readdir(state.paths.logs)).filter(name=>name.endsWith('.txt'));const text=await fs.readFile(path.join(state.paths.logs,names[0]),'utf8');
  assert.match(text,/直播间 280446：stop 已成功执行/);assert.match(text,/停止录制与监控/);assert.match(text,/直播间 280446：auto 已成功执行/);
  assert.match(text,/打开应用/);assert.match(text,/native test failed/);assert.match(text,/后台正常退出/);assert.equal(text.includes('private-token'),false);assert.equal(text.includes(app.runtime.token),false);
});
