import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';

async function application(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-recording-only-'));
  const app=await createApp({data:root,port:0,noRecorder:true,preparation:false,compact:false,ffmpeg:'not-launched',ffprobe:'not-launched'});
  app.ingestor.stop();
  t.after(async()=>{
    await app.close();
    assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('caibo-recording-only-'));
    await fs.rm(root,{recursive:true,force:true});
  });
  return app;
}
const post=(app,route,value)=>fetch(app.runtime.origin+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});

test('不再接受本地导入或跟踪请求，且不读取或登记外部录像',async t=>{
  const app=await application(t),file=path.join(app.root,'external.flv'),bytes=Buffer.from('untouched local video');
  await fs.writeFile(file,bytes);
  for(const follow of [false,true]) {
    const response=await post(app,'/api/sessions/import',{path:file,follow});
    assert.equal(response.status,404);
  }
  assert.equal(app.store.sessions().length,0);
  assert.equal(app.store.all('SELECT * FROM sources').length,0);
  assert.deepEqual(await fs.readFile(file),bytes);
});

test('移除结束本地跟踪接口，不改变已有素材或正在录制的状态',async t=>{
  const app=await application(t);
  for(const room of [0,42]) {
    const session=app.store.createSession({room,status:'recording'});
    const source=app.store.addSource(session.id,path.join(app.recorder.directory,`${room}.flv`),0,new Date().toISOString(),false);
    assert.equal((await post(app,`/api/sessions/${session.id}/finish`,{})).status,404);
    assert.equal(app.store.session(session.id).status,'recording');
    assert.equal(app.store.sources(session.id)[0].closed,source.closed);
  }
});

test('直播录制事件继续登记原片、结束录制，并验证事件来源',async t=>{
  const app=await application(t),data={RoomId:42,RelativePath:'live.flv',FileOpenTime:new Date().toISOString(),Title:'直播录像'};
  const event=(id,type)=>({EventId:id,EventType:type,EventData:data});
  assert.equal((await post(app,'/internal/recorder-event',event('forbidden','FileOpening'))).status,403);
  assert.equal(app.store.sessions().length,0);
  const route='/internal/recorder-event?token='+app.recorder.webhookSecret;
  assert.equal((await post(app,route,event('opening','FileOpening'))).status,200);
  const session=app.store.sessions()[0];
  assert.equal(session.room,42);assert.equal(session.status,'recording');
  assert.equal(app.store.sources(session.id)[0].path,path.join(app.recorder.directory,'live.flv'));
  assert.equal((await post(app,route,event('closed','FileClosed'))).status,200);
  assert.equal(app.store.sources(session.id)[0].closed,1);
  assert.equal((await post(app,route,event('ended','StreamEnded'))).status,200);
  assert.equal(app.store.session(session.id).status,'finished');
  assert.equal((await (await fetch(app.runtime.origin+'/api/state')).json()).sessions[0].title,'直播录像');
});
