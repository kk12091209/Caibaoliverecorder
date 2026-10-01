import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../server/index.js';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-close-')),apps=[];
  t.after(async()=>{for(const app of apps)await app.close();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('caibo-close-'));await fs.rm(root,{recursive:true,force:true});});
  return async()=>{const app=await createApp({data:root,port:0,noRecorder:true,preparation:false,compact:false,ffmpeg:'not-launched',ffprobe:'not-launched',runtimePollMs:10});apps.push(app);return app;};
}
async function post(app,route,input,authorized=true){
  const response=await fetch(app.runtime.origin+route,{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{'X-Caibo-Instance':app.runtime.token}:{})},body:JSON.stringify(input)});
  return {status:response.status,body:await response.json()};
}
async function status(app){
  const response=await fetch(app.runtime.origin+'/internal/desktop',{headers:{'X-Caibo-Instance':app.runtime.token}});return response.json();
}

test('关闭窗口默认询问，记住的动作同时提供给页面与桌面并在服务重启后保留',async t=>{
  const open=await fixture(t);let app=await open();
  assert.equal((await status(app)).closeAction,'ask');
  assert.equal((await (await fetch(app.runtime.origin+'/api/state')).json()).closeAction,'ask');
  const saved=await post(app,'/internal/desktop',{action:'setCloseAction',closeAction:'background'});
  assert.equal(saved.status,200);assert.equal(saved.body.closeAction,'background');assert.equal(saved.body.pending,'');
  await app.close();app=await open();
  assert.equal((await status(app)).closeAction,'background');
  assert.equal((await (await fetch(app.runtime.origin+'/api/state')).json()).closeAction,'background');
  assert.equal((await post(app,'/api/settings',{closeAction:'exit'})).body.closeAction,'exit');
  assert.equal((await status(app)).closeAction,'exit');
  assert.equal((await post(app,'/api/settings',{closeAction:'ask'})).body.closeAction,'ask');
  await app.close();app=await open();assert.equal((await status(app)).closeAction,'ask');
});

test('关闭设置与导出目录独立保存，无效或未授权的偏好不会覆盖已有设置',async t=>{
  const open=await fixture(t),app=await open(),directory=path.join(app.root,'custom-exports');
  assert.equal((await post(app,'/api/settings',{exportDirectory:directory,closeAction:'background'})).status,200);
  assert.equal((await post(app,'/api/settings',{closeAction:'exit'})).status,200);
  assert.equal(app.store.setting('export-directory'),directory);
  for(const value of [null,true,'minimize','',{},[]]){
    assert.equal((await post(app,'/api/settings',{closeAction:value,exportDirectory:path.join(app.root,'must-not-create')})).status,400);
    assert.equal((await post(app,'/internal/desktop',{action:'setCloseAction',closeAction:value})).status,400);
  }
  assert.equal((await post(app,'/internal/desktop',{action:'setCloseAction',closeAction:'background'},false)).status,403);
  assert.equal((await status(app)).closeAction,'exit');assert.equal(app.store.setting('export-directory'),directory);
  await assert.rejects(fs.stat(path.join(app.root,'must-not-create')),{code:'ENOENT'});
  app.store.setting('window-close-action','unrecognized');assert.equal((await status(app)).closeAction,'ask');
});

test('改变关闭偏好不发起退出；安装维护仍等录制结束，不受后台偏好影响',async t=>{
  const open=await fixture(t),app=await open(),session=app.store.createSession({title:'recording fixture',status:'recording'});
  const saved=await post(app,'/internal/desktop',{action:'setCloseAction',closeAction:'background'});
  assert.equal(saved.body.busy,true);assert.equal(saved.body.pending,'');
  assert.equal(app.store.session(session.id).status,'recording');
  const exit=await post(app,'/internal/desktop',{action:'exit'});assert.equal(exit.body.pending,'exit');
  await delay(50);assert.equal(app.runtime.closed,false);assert.equal(app.store.session(session.id).status,'recording');
  app.store.run("UPDATE sessions SET status='finished' WHERE id=?",session.id);
  for(let n=0;n<100&&!app.runtime.closed;n++)await delay(10);
  assert.equal(app.runtime.closed,true);
});
