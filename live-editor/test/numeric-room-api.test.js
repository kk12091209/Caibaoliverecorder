import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.js';
const absent=()=>Object.assign(new Error('not found'),{code:'ROOM_NOT_FOUND'});
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'numeric-room-api-')),biliCalls=[],biliRooms=[];
 const known={bilibili:{'1016':{roomId:1016,name:'B站主播',title:'B站标题',streaming:true},'42':{roomId:420000,name:'短号主播',title:'',streaming:false}},douyin:{'1016':{name:'抖音主播'},'57375952448':{name:'抖音独有主播'}}};
 const lookupCalls=[],bilibiliResolver={async room(id){lookupCalls.push(['bilibili',id]);if(known.bilibili[id] instanceof Error)throw known.bilibili[id];return known.bilibili[id]||null;}};
 const app=await createApp({data:path.join(root,'data'),noRecorder:true,port:0,preparation:false,compact:false,ffmpeg:'not-executed',ffprobe:'not-executed',bilibiliResolver,
  douyin:{resolver:{async room(id){lookupCalls.push(['douyin',id]);const room=known.douyin[id];if(room instanceof Error)throw room;if(!room)throw absent();return {...room,platform:'douyin',webRid:id,roomId:'7691707893343275816',streaming:false,cookie:'ttwid=private',userUniqueId:'secret'};}},chat:{close:async()=>{}}}});
 app.recorder.online=true;await fs.mkdir(app.recorder.directory,{recursive:true});
 app.recorder.api=async(route,body,method)=>{biliCalls.push({route,body,method});if(route==='room'&&body){const knownRoom=Object.values(known.bilibili).find(room=>room?.roomId===body.roomId);const room={...knownRoom,roomId:body.roomId,autoRecord:body.autoRecord,autoRecordForThisSession:true,recording:false,streaming:false};biliRooms.push(room);return room;}return route==='room'?biliRooms:null;};
 t.after(async()=>{await app.close();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(root).startsWith('numeric-room-api-'));await fs.rm(root,{recursive:true,force:true});});
 return {app,known,biliCalls,lookupCalls,async add(url){const response=await fetch(`http://127.0.0.1:${app.port}/api/rooms`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});return {status:response.status,body:await response.json()};}};
}

test('same numeric ID on both platforms proposes anchors without adding or recording before confirmation',async t=>{
 const f=await fixture(t),result=await f.add('1016');assert.equal(result.status,200);assert.equal(result.body.needsSelection,true);
 assert.deepEqual(result.body.candidates.map(room=>[room.platform,room.name]),[['bilibili','B站主播'],['douyin','抖音主播']]);
 assert.equal(f.app.snapshot().rooms.length,0);assert.equal(f.biliCalls.length,0);assert.equal(f.app.store.sessions().length,0);assert.equal(JSON.stringify(result.body).includes('private'),false);assert.equal(JSON.stringify(result.body).includes('secret'),false);
 await f.add(result.body.candidates[1].url);assert.deepEqual(f.app.snapshot().rooms.map(room=>room.platform),['douyin']);assert.equal(f.biliCalls.length,0);
});

test('confirming Bilibili adds only that anchor and keeps canonical short-ID resolution',async t=>{
 const f=await fixture(t),choices=await f.add('1016');await f.add(choices.body.candidates[0].url);
 assert.deepEqual(f.app.snapshot().rooms.map(room=>room.platform),['bilibili']);assert.equal(f.app.recorder.douyin.entries.size,0);
 assert.equal(f.biliCalls.filter(call=>call.route==='room'&&call.body).length,1);
 const short=await f.add(' 00042 ');assert.equal(short.status,200);assert.equal(short.body.roomId,420000);
});

test('a unique Douyin numeric room is automatically added without numeric truncation or Bilibili core calls',async t=>{
 const f=await fixture(t),result=await f.add('57375952448');assert.equal(result.status,200);assert.equal(result.body.platform,'douyin');assert.equal(result.body.webRid,'57375952448');assert.equal(result.body.needsSelection,undefined);assert.equal(f.biliCalls.length,0);
});

test('existing explicit platform links bypass dual-platform lookup',async t=>{
 const f=await fixture(t);await f.add('https://live.douyin.com/1016');assert.equal(f.lookupCalls.some(([platform])=>platform==='bilibili'),false);
 f.lookupCalls.length=0;await f.add('https://live.bilibili.com/1016');assert.equal(f.lookupCalls.length,0);
});

test('missing rooms and invalid numeric input add no monitoring entries',async t=>{
 const f=await fixture(t);for(const input of ['8888','0','123456789012345678901']){const result=await f.add(input);assert.equal(result.status,400);assert.match(result.body.error,/房间号|直播间号/);}
 assert.equal(f.app.snapshot().rooms.length,0);assert.equal(f.biliCalls.length,0);
});

test('failed competing lookup requires explicit selection rather than silently starting the other platform',async t=>{
 const f=await fixture(t);f.known.bilibili['1016']=Error('timeout');const result=await f.add('1016');assert.equal(result.body.needsSelection,true);assert.deepEqual(result.body.unavailable,['bilibili']);assert.equal(result.body.candidates.length,1);assert.equal(f.app.snapshot().rooms.length,0);
});
