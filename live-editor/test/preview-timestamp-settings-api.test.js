import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.js';
import {TIMESTAMP_STYLES,DEFAULT_TIMESTAMP_STYLE,TIMESTAMP_STYLE_SETTING,validateTimestampStyle,normalizedTimestampStyle,TIMESTAMP_POSITIONS,DEFAULT_TIMESTAMP_POSITION,TIMESTAMP_POSITION_SETTING,validateTimestampPosition,normalizedTimestampPosition} from '../shared/timestamp-style.js';

test('timestamp styles accept only known choices and safely normalize older settings',()=>{
  assert.deepEqual(TIMESTAMP_STYLES.map(style=>style.value),['outline','inline','stacked']);
  for(const {value} of TIMESTAMP_STYLES){
    assert.equal(validateTimestampStyle(value),value);
    assert.equal(normalizedTimestampStyle(value),value);
  }
  for(const value of [undefined,null,'unknown','Outline',' inline ',true,1,{},[]]){
    assert.throws(()=>validateTimestampStyle(value),/时间戳样式/);
    assert.equal(normalizedTimestampStyle(value),DEFAULT_TIMESTAMP_STYLE);
  }
});

test('timestamp positions accept four independent corners and normalize older settings',()=>{
  assert.deepEqual(TIMESTAMP_POSITIONS.map(position=>position.value),['top-left','top-right','bottom-left','bottom-right']);
  for(const {value} of TIMESTAMP_POSITIONS){
    assert.equal(validateTimestampPosition(value),value);
    assert.equal(normalizedTimestampPosition(value),value);
  }
  for(const value of [undefined,null,'center','original','Top-left',' top-left ',true,1,{},[]]){
    assert.throws(()=>validateTimestampPosition(value),/时间戳位置/);
    assert.equal(normalizedTimestampPosition(value),DEFAULT_TIMESTAMP_POSITION);
  }
});

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
  assert.equal(app.snapshot().previewTimestampStyle,DEFAULT_TIMESTAMP_STYLE);
  assert.equal(app.snapshot().previewTimestampPosition,DEFAULT_TIMESTAMP_POSITION);
  assert.equal(app.snapshot().recordingStyle.cameraPosition,'bottom-left');
  app.store.setting(TIMESTAMP_STYLE_SETTING,'old-unrecognized-style');
  assert.equal(app.snapshot().previewTimestampStyle,DEFAULT_TIMESTAMP_STYLE);
  app.store.setting(TIMESTAMP_POSITION_SETTING,'old-unrecognized-position');
  assert.equal(app.snapshot().previewTimestampPosition,DEFAULT_TIMESTAMP_POSITION);
  // The same corner is valid for both independently managed overlays.
  let result=await request({previewTimestampPosition:'top-left',recordingStyle:{cameraPosition:'top-left',cameraSize:24}});
  assert.equal(result.status,200);
  assert.equal(result.body.previewTimestampPosition,'top-left');
  assert.equal(result.body.recordingStyle.cameraPosition,'top-left');
  const session=app.store.createSession({status:'finished'});
  app.store.run("INSERT INTO preparation_jobs(session,status) VALUES(?,'ready')",session.id);
  const prepared=app.store.all('SELECT * FROM preparation_jobs');
  const style=app.snapshot().danmakuStyle;
  const recordingStyle=app.snapshot().recordingStyle;
  app.preparation.invalidate=()=>assert.fail('a preview preference must not invalidate prepared video');
  result=await request({previewTimestamp:true});assert.equal(result.status,200);assert.equal(result.body.previewTimestamp,true);
  assert.equal(app.snapshot().previewTimestamp,true);
  for(const {value} of TIMESTAMP_STYLES){
    result=await request({previewTimestampStyle:value});
    assert.equal(result.status,200);assert.equal(result.body.previewTimestampStyle,value);
    assert.equal(result.body.previewTimestamp,true);
    assert.equal(app.store.setting(TIMESTAMP_STYLE_SETTING),value);
    const state=await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).json();
    assert.equal(state.previewTimestampStyle,value);
    assert.equal(state.previewTimestampPosition,'top-left');
  }
  for(const {value} of TIMESTAMP_POSITIONS){
    result=await request({previewTimestampPosition:value});
    assert.equal(result.status,200);assert.equal(result.body.previewTimestampPosition,value);
    assert.equal(result.body.previewTimestampStyle,'stacked');
    assert.deepEqual(result.body.recordingStyle,recordingStyle);
    assert.equal(app.store.setting(TIMESTAMP_POSITION_SETTING),value);
    const state=await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).json();
    assert.equal(state.previewTimestampPosition,value);
  }
  for(const value of ['center','original','Top-left',' top-left ',true,1,null,{},[]]){
    result=await request({previewTimestampPosition:value,previewTimestampStyle:'inline',previewTimestamp:false,closeAction:'exit',recordingStyle:{cameraPosition:'top-right',cameraSize:30}});
    assert.equal(result.status,400);assert.match(result.body.error,/时间戳位置/);
    assert.equal(app.snapshot().previewTimestampPosition,'bottom-right');
    assert.equal(app.snapshot().previewTimestampStyle,'stacked');
    assert.equal(app.snapshot().previewTimestamp,true);assert.equal(app.snapshot().closeAction,'ask');
    assert.deepEqual(app.snapshot().recordingStyle,recordingStyle);
  }
  for(const value of ['unknown','Outline',' inline ',true,1,null,{},[]]){
    result=await request({previewTimestampStyle:value,previewTimestampPosition:'top-right',previewTimestamp:false,closeAction:'exit',recordingStyle:{cameraPosition:'top-right',cameraSize:30}});
    assert.equal(result.status,400);assert.match(result.body.error,/时间戳样式/);
    assert.equal(app.snapshot().previewTimestampStyle,'stacked');
    assert.equal(app.snapshot().previewTimestampPosition,'bottom-right');
    assert.equal(app.snapshot().previewTimestamp,true);assert.equal(app.snapshot().closeAction,'ask');
    assert.deepEqual(app.snapshot().recordingStyle,recordingStyle);
  }
  for(const value of ['true',1,0,null,{},[]]){
    assert.equal((await request({previewTimestamp:value,closeAction:'exit'})).status,400);
    assert.equal(app.snapshot().previewTimestamp,true);assert.equal(app.snapshot().closeAction,'ask');
  }
  for(const input of [{previewTimestamp:false,previewTimestampStyle:'inline',previewTimestampPosition:'top-right',unknown:true},{previewTimestamp:false,previewTimestampStyle:'inline',previewTimestampPosition:'top-right',danmakuStyle:{size:-1}},null,[]]){
    assert.equal((await request(input)).status,400);assert.equal(app.snapshot().previewTimestamp,true);
    assert.equal(app.snapshot().previewTimestampStyle,'stacked');
    assert.equal(app.snapshot().previewTimestampPosition,'bottom-right');
  }
  result=await request({previewTimestampPosition:'top-left'});
  assert.equal(result.status,200);assert.equal(result.body.previewTimestampPosition,'top-left');
  assert.equal(result.body.recordingStyle.cameraPosition,'top-left');
  assert.deepEqual(app.store.all('SELECT * FROM preparation_jobs'),prepared);
  assert.deepEqual(app.snapshot().danmakuStyle,style);
  assert.deepEqual(app.snapshot().recordingStyle,recordingStyle);
  assert.equal(app.media.children.size,0);
  await app.close();app=await open();await app.startupRecovery;
  assert.equal(app.snapshot().previewTimestamp,true);
  assert.equal(app.snapshot().previewTimestampStyle,'stacked');
  assert.equal(app.snapshot().previewTimestampPosition,'top-left');
  assert.equal(app.snapshot().recordingStyle.cameraPosition,'top-left');
  result=await request({previewTimestamp:false});assert.equal(result.status,200);assert.equal(result.body.previewTimestamp,false);
  assert.equal(app.snapshot().previewTimestamp,false);
  assert.equal(result.body.previewTimestampStyle,'stacked');
  assert.equal(result.body.previewTimestampPosition,'top-left');
});
