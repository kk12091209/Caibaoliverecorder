import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createApp,fetch} from './helpers/authenticated-app.js';
import {DouyinUserDiscovery} from '../server/douyin-user-discovery.js';
import {FLV_HEADER} from '../server/ingest.js';
import {flvTag} from './helpers/source-stream-fixture.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let n=0;n<200;n++){if(fn())return;await wait(5);}assert.fail('not settled');}
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-anchors-'));let streams=0,clock=100000;
 const metadata={webRid:'123',roomId:'9007199254740993123',ownerId:'111',name:'主播A',title:'A的直播标题',streaming:true,stream:{url:'https://pull-test.douyincdn.com/123.flv'}};
 const host={...metadata,webRid:'456',roomId:'9007199254740993456',ownerId:'222',name:'主播B',title:'B的直播标题'};
 const resolver={room:async id=>{if(id==='123')return {...metadata};if(id==='456')return {...host};throw Object.assign(Error('missing'),{code:'ROOM_NOT_FOUND'});}};
 const discovery=new DouyinUserDiscovery({resolver,request:async()=>new Response(null,{status:302,headers:{location:'https://www.iesdouyin.com/share/user/SEC_USER_A'}})});
 discovery.json=async()=>({status_code:0,user:{uid:'111',sec_uid:'SEC_USER_A',nickname:'主播A'}});
 const observations=new Map([['111',{state:'self-live',metadata}],['222',{state:'self-live',metadata:host}]]);
 discovery.observe=async uid=>observations.get(uid)||{state:'offline-observation'};
 const packet=Buffer.concat([FLV_HEADER,flvTag(9,0,24,{header:true}),flvTag(8,0,8,{header:true}),flvTag(9,0,24,{key:true}),flvTag(9,1000,24,{key:true})]);
 const app=await createApp({data:path.join(root,'data'),port:0,noRecorder:true,preparation:false,compact:false,ffmpeg:'unused',ffprobe:'unused',updatesAutoCheck:false,
  bilibiliResolver:{room:async()=>null},douyinFollow:{discovery,now:()=>clock},
  douyin:{resolver,now:()=>clock,pollMs:60000,chat:{start(){},async stop(){},async close(){}},request:async(url,{signal})=>{streams++;return new Response(new ReadableStream({start(c){c.enqueue(packet);signal.addEventListener('abort',()=>c.close(),{once:true});}}));}}});
 await app.startupRecovery;app.recorder.douyin.core.started=true;app.recorder.douyin.following.started=true;
 t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
 async function post(route,body={}){const response=await fetch(app.runtime.origin+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};}
 return {app,post,metadata,host,observations,get streams(){return streams;},async poll(){clock+=15000;await app.recorder.douyin.following.poll(true);}};
}

test('one endpoint accepts personal cards, room URLs and numeric rooms, and duplicate identity stays one monitor/stream',async t=>{
 const f=await fixture(t);const first=await f.post('anchors',{url:'分享 https://v.douyin.com/card/ 查看TA'});assert.equal(first.status,200);assert.equal(first.body.enabled,true);
 await until(()=>f.app.recorder.douyin.core.rooms[0]?.recording);
 assert.equal((await f.post('anchors',{url:'https://live.douyin.com/123'})).status,200);
 assert.equal((await f.post('anchors',{url:'123'})).status,200);
 assert.equal(f.app.snapshot().anchors.length,1);assert.equal(f.app.snapshot().anchors[0].ownWebRid,'123');assert.equal(f.streams,1);
 assert.equal(f.app.snapshot().anchors[0].key,'douyin-user:111');
 await f.post('anchors/douyin-user:111/stop');assert.equal(f.app.snapshot().anchors[0].enabled,false);
 await f.post('anchors',{url:'https://live.douyin.com/123'});assert.equal(f.app.snapshot().anchors[0].enabled,false);assert.equal(f.streams,1);
 await f.post('anchors/douyin-user:111/start');await until(()=>f.streams===2);
});

test('guest destination is a material origin, not an extra monitored person; removing guest preserves the host monitor and capture',async t=>{
 const f=await fixture(t);f.observations.set('111',{state:'guest-confirmed',metadata:f.host});
 await f.post('anchors',{url:'https://www.douyin.com/user/SEC_USER_A'});await until(()=>f.app.recorder.douyin.core.rooms[0]?.recording);
 assert.deepEqual(f.app.snapshot().anchors.map(a=>a.name),['主播A']);
 let material=f.app.snapshot().sessions[0];assert.equal(material.hostName,'主播B');assert.deepEqual(material.captureKinds,['guest']);assert.equal(material.monitoring[0].name,'主播A');assert.equal(material.monitoring[0].host,'主播B');
 await f.post('anchors',{url:'https://live.douyin.com/456'});await f.poll();assert.equal(f.app.snapshot().anchors.length,2);assert.equal(f.streams,1);
 material=f.app.snapshot().sessions[0];assert.deepEqual(new Set(material.captureKinds),new Set(['guest','self']));
 assert.equal((await f.post('anchors/douyin-user:111/remove')).status,400);
 assert.equal((await f.post('anchors/douyin-user:111/remove',{confirmed:true})).status,200);
 assert.equal(f.app.snapshot().anchors.length,1);assert.equal(f.app.recorder.douyin.core.rooms[0].recording,true);assert.equal(f.app.snapshot().sessions[0].monitoring.some(m=>m.name==='主播A'),true);
 await f.post('anchors/douyin-user:222/stop');assert.equal(f.app.recorder.douyin.core.rooms.length,0);
});

test('legacy room migration transfers a running capture without duplicates and preserves stopped intent',async t=>{
 const f=await fixture(t),recorder=f.app.recorder;
 await recorder.douyin.core.add({webRid:'123'});await until(()=>recorder.douyin.core.rooms[0]?.recording);const session=recorder.douyin.core.entries.get('123').session;
 await recorder.douyin.adoptMonitoredRoom(recorder.douyin.core.entries.get('123'),f.metadata);
 assert.equal(recorder.anchors.length,1);assert.equal(recorder.anchors[0].key,'douyin-user:111');assert.equal(recorder.anchors[0].enabled,true);
 assert.equal(f.streams,1);assert.equal(recorder.douyin.core.entries.get('123').session,session);assert.deepEqual(f.app.store.setting('douyin-rooms'),[]);
 await recorder.douyin.core.add({webRid:'456'},false);await recorder.douyin.adoptMonitoredRoom(recorder.douyin.core.entries.get('456'),f.host);
 assert.equal(recorder.anchors.find(a=>a.key==='douyin-user:222').enabled,false);assert.equal(f.streams,1);
 await f.post('anchors/douyin-user:111/stop');assert.equal(recorder.douyin.core.rooms.length,0);
});

test('unified Bilibili controls retain auto monitoring and are independent from Douyin targets',async t=>{
 const f=await fixture(t),r=f.app.recorder,calls=[];r.bilibili.online=true;
 const rooms=[];r.bilibili.api=async(route,body)=>{calls.push([route,body]);if(route==='room'&&body){const room={roomId:77,name:'B站主播',autoRecord:true,autoRecordForThisSession:true,streaming:false,recording:false};rooms.push(room);return room;}return route==='room'?rooms:null;};
 assert.equal((await f.post('anchors',{url:'https://live.bilibili.com/77'})).status,200);assert.equal(r.anchors[0].key,'bilibili:77');
 await f.post('anchors/bilibili:77/stop');assert.equal(r.anchors[0].enabled,false);
 await f.post('anchors/bilibili:77/start');assert.equal(r.anchors[0].enabled,true);assert.ok(calls.some(([route,body])=>route==='room/77/config'&&body.autoRecord===true));assert.equal(r.douyin.following.targets.size,0);
});
