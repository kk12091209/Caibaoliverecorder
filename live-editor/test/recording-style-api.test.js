import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.js';
import {DEFAULT_RECORDING_STYLE} from '../shared/recording-style.js';

test('global camera settings persist atomically, invalidate preparation only on changes and leave timestamp independent',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'camera-settings-'));
  const open=()=>createApp({data:root,noRecorder:true,preparation:false,compact:false,updatesAutoCheck:false,ffmpeg:'must-not-launch',ffprobe:'must-not-launch'});
  let app=await open();t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});await app.startupRecovery;
  const request=async input=>{const r=await fetch(`http://127.0.0.1:${app.port}/api/settings`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return {status:r.status,body:await r.json()};};
  assert.deepEqual(app.snapshot().recordingStyle,DEFAULT_RECORDING_STYLE);
  const session=app.store.createSession({status:'finished'});app.store.run("INSERT INTO preparation_jobs(session,status) VALUES(?,'ready')",session.id);
  let invalidated=0;app.preparation.invalidate=id=>{assert.equal(id,session.id);invalidated++;};
  const style={cameraPosition:'top-right',cameraSize:30};
  let result=await request({recordingStyle:style,previewTimestamp:true});assert.equal(result.status,200);assert.deepEqual(result.body.recordingStyle,style);assert.equal(invalidated,1);
  await request({recordingStyle:style});await request({previewTimestamp:false});assert.equal(invalidated,1);
  for(const value of [null,{},[],{...style,cameraSize:50},{...style,roomId:1}]) {
    result=await request({recordingStyle:value,previewTimestamp:true});assert.equal(result.status,400);assert.equal(app.snapshot().previewTimestamp,false);assert.deepEqual(app.snapshot().recordingStyle,style);
  }
  await app.close();app=await open();await app.startupRecovery;assert.deepEqual(app.snapshot().recordingStyle,style);
});
