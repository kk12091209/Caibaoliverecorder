import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.js';

test('preview timestamp defaults off, persists independently, and does not invalidate rendered work',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'preview-timestamp-api-'));
  const open=()=>createApp({data:root,noRecorder:true,preparation:false,compact:false,updatesAutoCheck:false,ffmpeg:'must-not-launch',ffprobe:'must-not-launch'});
  let app=await open();
  t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
  await app.startupRecovery;
  const request=async input=>{
    const response=await fetch(`http://127.0.0.1:${app.port}/api/settings`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    return {status:response.status,body:await response.json()};
  };
  assert.equal(app.snapshot().previewTimestamp,false);
  const session=app.store.createSession({status:'finished'});
  app.store.run("INSERT INTO preparation_jobs(session,status) VALUES(?,'ready')",session.id);
  const prepared=app.store.all('SELECT * FROM preparation_jobs');
  const style=app.snapshot().danmakuStyle;
  app.preparation.invalidate=()=>assert.fail('a preview preference must not invalidate prepared video');
  let result=await request({previewTimestamp:true});assert.equal(result.status,200);assert.equal(result.body.previewTimestamp,true);
  assert.equal(app.snapshot().previewTimestamp,true);
  for(const value of ['true',1,0,null,{},[]]){
    assert.equal((await request({previewTimestamp:value,closeAction:'exit'})).status,400);
    assert.equal(app.snapshot().previewTimestamp,true);assert.equal(app.snapshot().closeAction,'ask');
  }
  for(const input of [{previewTimestamp:false,unknown:true},{previewTimestamp:false,danmakuStyle:{size:-1}},null,[]]){
    assert.equal((await request(input)).status,400);assert.equal(app.snapshot().previewTimestamp,true);
  }
  assert.deepEqual(app.store.all('SELECT * FROM preparation_jobs'),prepared);
  assert.deepEqual(app.snapshot().danmakuStyle,style);
  assert.equal(app.media.children.size,0);
  await app.close();app=await open();await app.startupRecovery;
  assert.equal(app.snapshot().previewTimestamp,true);
  result=await request({previewTimestamp:false});assert.equal(result.status,200);assert.equal(result.body.previewTimestamp,false);
  assert.equal(app.snapshot().previewTimestamp,false);
});
