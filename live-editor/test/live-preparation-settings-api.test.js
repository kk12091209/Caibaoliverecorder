import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.js';

test('live preparation settings are opt-in and validate the complete request before changing either switch',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'live-settings-api-'));
  const app=await createApp({data:root,noRecorder:true,preparation:false,compact:false,updatesAutoCheck:false,ffmpeg:'must-not-launch',ffprobe:'must-not-launch'});
  t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
  await app.startupRecovery;
  const request=async input=>{
    const response=await fetch(`http://127.0.0.1:${app.port}/api/preparation/settings`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    return {status:response.status,body:await response.json()};
  };
  assert.equal(app.preparation.snapshot().liveEnabled,false);
  let result=await request({liveEnabled:true});assert.equal(result.status,200);assert.equal(result.body.liveEnabled,true);assert.equal(result.body.enabled,true);
  for(const input of [{enabled:false,liveEnabled:'yes'},{enabled:0,liveEnabled:false},{liveEnabled:false,unknown:true},{},null,[]]){
    assert.equal((await request(input)).status,400);
    assert.equal(app.preparation.snapshot().enabled,true);assert.equal(app.preparation.snapshot().liveEnabled,true);
  }
  result=await request({enabled:false,liveEnabled:false});assert.equal(result.status,200);
  assert.equal(result.body.enabled,false);assert.equal(result.body.liveEnabled,false);
  assert.equal(app.store.setting('livePreparationEnabled'),false);assert.equal(app.store.setting('backgroundPreparationEnabled'),false);
  assert.equal(app.media.children.size,0);
});
