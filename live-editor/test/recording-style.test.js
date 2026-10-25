import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.js';
import {LinkmicIndex} from '../server/linkmic.js';
import {platformSei,cameraFrames,linkmicSei} from '../server/linkmic-sei.js';
import {FLV_HEADER} from '../server/ingest.js';
import {biliCameraLayout,douyinCameraLayout} from '../server/recording-layout.js';
import {cameraLayout,cameraGeometry,blockCameraEvents,validateRecordingStyle,DEFAULT_RECORDING_STYLE} from '../shared/recording-style.js';
import {selectDouyinIndependentFlv} from '../server/douyin-room.js';
import {BILI_LAYOUT_VERSION} from '../server/bilibili-layouts.js';

const layout={main:{x:0,y:.25,w:.5,h:.5},camera:{x:.75,y:.25,w:.25,h:1/3}};
const bili=()=>({MULTI_SCREEN:{crop_info:[{position:1,x:.75,y:.25,cx:.25,cy:1/3},{position:0,x:0,y:.25,cx:.5,cy:.5}],layout_type:0}});
function tag(value,type=5,time=0) {
  const payload=Buffer.from((type===5?'LIVE_SEI_CHANNEL':'')+JSON.stringify(value)),size=[];
  for(let n=payload.length;n>=255;n-=255)size.push(255);size.push(payload.length%255);
  const nal=Buffer.concat([Buffer.from([6,type,...size]),payload,Buffer.from([128])]),length=Buffer.alloc(4);length.writeUInt32BE(nal.length);
  const body=Buffer.concat([Buffer.from([0x27,1,0,0,0]),length,nal]),out=Buffer.alloc(body.length+15);
  out[0]=9;out.writeUIntBE(body.length,1,3);out.writeUIntBE(time*1000,4,3);body.copy(out,11);out.writeUInt32BE(out.length-4,out.length-4);return out;
}
test('only explicit independent crops enable camera composition, malformed and baked layouts stay untouched',()=>{
  assert.deepEqual(biliCameraLayout(bili()),layout);
  assert.deepEqual(cameraFrames(platformSei(tag(bili()))),[{platform:'bilibili',layout}]);
  const extension={game_clip:layout.main,camera_clip:layout.camera,camera_hidden:0};
  assert.deepEqual(douyinCameraLayout(extension),layout);
  assert.deepEqual(cameraFrames(platformSei(tag({app_data:JSON.stringify(extension)},100)))[0].layout,layout);
  assert.equal(biliCameraLayout({}),undefined);
  assert.equal(biliCameraLayout({MULTI_SCREEN:{crop_info:[]}}),null);
  assert.equal(douyinCameraLayout({...extension,camera_hidden:1}),null);
  for(const bad of [{...layout,camera:{...layout.camera,x:0}},{...layout,main:{...layout.main,w:NaN}},{...layout,camera:{...layout.camera,h:2}},{...layout,camera:null}])assert.equal(cameraLayout(bad),null);
  assert.deepEqual(linkmicSei(tag(bili())),[],'independent camera must never erase linkmic names');
  assert.doesNotThrow(()=>linkmicSei(tag({LIVE_MULTI_VIDEO_LINK:{members:[null],interact_template:{layout_data:{width:2,height:2,cells:[null]}}}})));
});
test('all global positions preserve aspect ratio and stay inside the main picture; settings are strict',()=>{
  for(const cameraPosition of ['top-left','top-right','bottom-left','bottom-right'])for(const cameraSize of [10,24,40])for(const [w,h] of [[1920,1080],[1080,1920],[854,480]]) {
    const g=cameraGeometry(layout,{cameraPosition,cameraSize},w,h),m=g.mainTarget,c=g.cameraTarget;
    assert.ok(c.x>=m.x&&c.y>=m.y&&c.x+c.w<=m.x+m.w&&c.y+c.h<=m.y+m.h);
    assert.ok(Math.abs(c.w/c.h-g.camera.w/g.camera.h)<.12);
    if(cameraPosition.endsWith('left'))assert.ok(c.x<m.x+m.w/2);else assert.ok(c.x>m.x+m.w/2);
    if(cameraPosition.startsWith('top'))assert.ok(c.y<m.y+m.h/2);else assert.ok(c.y+c.h>m.y+m.h/2);
  }
  assert.equal(cameraGeometry(layout,{...DEFAULT_RECORDING_STYLE,cameraPosition:'original'},320,180),null);
  for(const value of [null,{},[],{...DEFAULT_RECORDING_STYLE,cameraPosition:'free'},{...DEFAULT_RECORDING_STYLE,cameraSize:'24'},{...DEFAULT_RECORDING_STYLE,cameraSize:41},{...DEFAULT_RECORDING_STYLE,room:123}])assert.throws(()=>validateRecordingStyle(value));
});
test('camera index backfills, persists, expires and explicitly stops independently of name frames',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'camera-index-')),store=new Store(root);
  t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
  const session=store.createSession({status:'finished'}),file=path.join(root,'source.flv');
  await fs.writeFile(file,Buffer.concat([FLV_HEADER,tag(bili(),5,1),tag(bili(),5,2),tag({MULTI_SCREEN:{crop_info:[]}},5,4),tag(bili(),5,8)]));
  const source=store.addSource(session.id,file,10,undefined,true);store.run('UPDATE sources SET closed=2,duration=30 WHERE id=?',source.id);
  let index=new LinkmicIndex(store);await index.ensure(session.id);
  const events=index.cameraEvents(session.id);assert.deepEqual(events.map(e=>[e.time,e.end]),[[11,14],[18,28]]);
  assert.equal(index.events(session.id).length,0);
  assert.deepEqual(blockCameraEvents(events,source.id,12,13).map(e=>[e.time,e.end]),[[12,13]]);
  await index.close();index=new LinkmicIndex(store);await index.ensure(session.id);assert.deepEqual(index.cameraEvents(session.id),events);await index.close();
});
test('Bilibili PK and multi-link cells inherit default sizes and resolve official layout IDs without guessing people',()=>{
  const frame={LIVE_MULTI_VIDEO_LINK:{session_status:1,sei_room_status:1,interact_template:{layout_id:'left1_right1',layout_version:BILI_LAYOUT_VERSION},members:[{position:1,uid_str:'9007199254740993123',uname:'右方'},{position:0,uid:101,uname:'左方'}]}};
  let people=linkmicSei(tag(frame))[0].participants;
  assert.deepEqual(people.map(p=>[p.id,p.x,p.w,p.h]),[['9007199254740993123',.5,.5,1],['101',0,.5,1]]);
  frame.LIVE_MULTI_VIDEO_LINK.interact_template.layout_id='left1_right2_new2';
  people=linkmicSei(tag(frame))[0].participants;assert.deepEqual(people.map(p=>[p.x,p.w,p.h]),[[.5,.5,.5],[0,.5,1]]);
  frame.LIVE_MULTI_VIDEO_LINK.interact_template.layout_id='1v1_zoom';
  people=linkmicSei(tag(frame))[0].participants;assert.equal(people.length,2);assert.equal(people.find(p=>p.id==='101').w,1,'host tile ends at the declared canvas edge');
  frame.LIVE_MULTI_VIDEO_LINK.interact_template.layout_version=999;assert.deepEqual(linkmicSei(tag(frame)),[]);
  frame.LIVE_MULTI_VIDEO_LINK.interact_template={layout_data:{width:10,height:8,default_cell:{x:0,y:0,width:5,height:8},cells:[{position:0},{position:1,x:5}]}};
  assert.equal(linkmicSei(tag(frame))[0].participants.length,2);
  frame.LIVE_MULTI_VIDEO_LINK.members.push({position:1,uid:103});assert.equal(linkmicSei(tag(frame))[0].participants.length,1);
  frame.LIVE_MULTI_VIDEO_LINK.session_status=2;assert.deepEqual(linkmicSei(tag(frame))[0].participants,[]);
});
test('Douyin selects only the exact independent H.264 stream paired with validated crop metadata',()=>{
  const entry={extension:{game_clip:layout.main,camera_clip:layout.camera,camera_hidden:0},stream_data:JSON.stringify({data:{origin:{main:{flv:'https://pull-test.douyincdn.com/camera.flv',sdk_params:{VCodec:'h264'}}}}})};
  const stream={pull_datas:{camera:entry},flv_pull_url:{FULL_HD1:'https://pull-test.douyincdn.com/legacy.flv'}};
  assert.deepEqual(selectDouyinIndependentFlv(stream).cameraLayout,layout);
  assert.match(selectDouyinIndependentFlv(stream).url,/camera.flv$/);
  entry.stream_data=entry.stream_data.replace('h264','h265');assert.equal(selectDouyinIndependentFlv(stream),null);
  entry.stream_data=entry.stream_data.replace('h265','h264');entry.extension.camera_clip={x:0,y:0,w:1,h:1};assert.equal(selectDouyinIndependentFlv(stream),null);
  delete entry.extension;assert.equal(selectDouyinIndependentFlv(stream),null);
});
