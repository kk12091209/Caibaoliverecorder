import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.js';
import {DouyinRecorder} from '../server/douyin-recorder.js';
import {DouyinUserFollow} from '../server/douyin-user-follow.js';
import {hasRecording,hasIndexing} from '../server/app-activity.js';
import {FLV_HEADER,tags} from '../server/ingest.js';
import {flvTag} from './helpers/source-stream-fixture.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){for(let n=0;n<200;n++){if(check())return;await wait(5);}assert.fail('not settled');}
const guest=(webRid='123',roomId='9007199254740993123')=>({state:'guest-confirmed',metadata:{webRid,roomId,ownerId:'77',name:'主房间'+webRid,title:'连麦',streaming:true,stream:{url:'https://pull-test.douyincdn.com/'+webRid+'.flv'}}});
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-user-follow-')),store=new Store(root);let clock=100000,streams=0;const replies=new Map(),packet=Buffer.concat([FLV_HEADER,flvTag(9,0,24,{header:true}),flvTag(8,0,8,{header:true}),flvTag(9,0,24,{key:true}),flvTag(9,1000,24,{key:true})]);
 const recorder=new DouyinRecorder(store,{now:()=>clock,pollMs:60000,resolver:{room:async id=>guest(id).metadata},chat:{start(){},async stop(){},async close(){}},request:async(url,{signal})=>{streams++;return new Response(new ReadableStream({start(c){c.enqueue(packet);signal.addEventListener('abort',()=>c.close(),{once:true});}}));}});
 recorder.started=true;
 const discovery={identity:async uid=>({uid,name:'用户'+uid,secUid:'SEC_USER_'+uid,profile:'https://www.douyin.com/user/SEC_USER_'+uid}),observe:async(uid,opts)=>{const reply=replies.get(uid);return typeof reply==='function'?reply(opts):reply||{state:'offline-observation'};}};
 const following=new DouyinUserFollow(store,{recorder,discovery,now:()=>clock});following.started=true;
 t.after(async()=>{await following.close();await recorder.close();store.close();await fs.rm(root,{recursive:true,force:true});});
 async function enable(uid='9007199254740993999'){await following.add(uid);following.targets.get(uid).enabled=true;return uid;}
 const poll=async(ms=15000)=>{clock+=ms;await following.poll(true);};
 return {store,recorder,following,replies,enable,poll,get streams(){return streams;}};
}
test('user-only discovery records valid FLV, confirms exit twice, preserves originals and interval times',async t=>{
 const f=await fixture(t),uid=await f.enable();f.replies.set(uid,guest());await f.poll();await until(()=>f.recorder.rooms[0]?.recording);
 assert.equal(f.streams,1);assert.equal(f.following.snapshot[0].history[0].started!==null,true);
 f.replies.set(uid,{state:'offline-observation'});await f.poll();assert.equal(f.recorder.rooms[0].recording,true);await f.poll();assert.equal(f.recorder.rooms.length,0);
 const history=f.following.snapshot[0].history[0];assert.equal(history.reason,'确认退出连麦');assert.ok(history.ended>=history.started);assert.equal(history.materials.length,1);
 const source=f.store.sources(history.materials[0])[0],bytes=await fs.readFile(source.path);assert.ok(source.closed);assert.equal(tags(bytes.subarray(13)).items.length,4);
});
test('short disconnect and return reuse capture; confirmed exit and return create new interval',async t=>{
 const f=await fixture(t),uid=await f.enable();f.replies.set(uid,guest());await f.poll();await until(()=>f.recorder.rooms[0]?.recording);
 f.replies.set(uid,{state:'offline-observation'});await f.poll();f.replies.set(uid,{state:'unknown',reason:'暂缺名单'});await f.poll();f.replies.set(uid,guest());await f.poll();assert.equal(f.streams,1);assert.equal(f.following.snapshot[0].history.length,1);
 f.replies.set(uid,{state:'offline-observation'});await f.poll();await f.poll();f.replies.set(uid,guest());await f.poll();await until(()=>f.streams===2);assert.equal(f.following.snapshot[0].history.length,2);
});
test('move A to B releases only that target; shared and manual recordings remain',async t=>{
 const f=await fixture(t),a=await f.enable('111'),b=await f.enable('222');f.replies.set(a,guest());f.replies.set(b,guest());await f.poll();await until(()=>f.recorder.rooms[0]?.recording);assert.equal(f.streams,1);
 f.replies.set(a,guest('456'));await f.poll();await until(()=>f.streams===2);assert.equal(f.recorder.rooms.length,2);assert.equal(f.recorder.rooms.find(r=>r.webRid==='123').followUsers,1);
 f.recorder.entries.get('123').enabled=true;await f.following.enable(b,false);assert.equal(f.recorder.entries.get('123').recording,true);
 await f.following.enable(a,false);assert.equal(f.recorder.entries.has('456'),false);assert.equal(f.recorder.entries.get('123').recording,true);
});
test('unknown or failed queries do not claim exit; three-minute protection closes and later re-verifies',async t=>{
 const f=await fixture(t),uid=await f.enable();f.replies.set(uid,guest());await f.poll();await until(()=>f.recorder.rooms[0]?.recording);
 f.replies.set(uid,()=>{throw Error('temporary');});await f.poll();assert.equal(f.recorder.rooms[0].recording,true);assert.match(f.following.snapshot[0].state,/待确认/);await f.poll(180000);assert.equal(f.following.snapshot[0].history[0].reason,'状态失联保护');assert.equal(f.recorder.rooms.length,0);
 f.replies.set(uid,guest());await f.poll();await until(()=>f.streams===2);
});
test('disable while discovery is pending prevents a stale result from starting capture',async t=>{
 const f=await fixture(t),uid=await f.enable();let resolve;f.replies.set(uid,()=>new Promise(r=>resolve=r));const pending=f.poll();await until(()=>!!resolve);await f.following.enable(uid,false);resolve(guest());await pending;assert.equal(f.streams,0);assert.equal(f.recorder.rooms.length,0);
});
test('query concurrency is two, repeated polls coalesce, and max duration stops',async t=>{
 const f=await fixture(t);let inFlight=0,peak=0;for(const uid of ['111','222','333','444']){await f.enable(uid);f.replies.set(uid,async()=>{peak=Math.max(peak,++inFlight);await wait(10);inFlight--;return guest();});}
 const first=f.poll();await Promise.all([first,f.following.poll(true)]);assert.equal(peak,2);await until(()=>f.recorder.rooms[0]?.recording);
 await f.poll(4*60*60*1000);assert.ok(f.following.snapshot.every(t=>!t.enabled));assert.equal(f.recorder.rooms.length,0);
 const saved=f.store.setting('douyin-follow-users');assert.equal(saved.length,4);assert.equal((f.store.setting('douyin-rooms')||[]).length,0);
});

test('restart preserves enabled intent but does not blindly reuse the previous host',async t=>{
 const f=await fixture(t),uid=await f.enable();f.following.save();f.replies.set(uid,guest());await f.poll();await until(()=>f.recorder.rooms[0]?.recording);await f.following.close();
 const resumed=new DouyinUserFollow(f.store,{recorder:f.recorder,discovery:f.following.discovery});resumed.started=true;assert.equal(resumed.snapshot[0].enabled,true);assert.equal(resumed.snapshot[0].recording,false);
 f.replies.set(uid,{state:'unknown',reason:'暂不可确认'});await resumed.poll(true);assert.equal(f.recorder.rooms.length,0);assert.equal(f.streams,1);await resumed.close();
});

test('a changed broadcast in the same web room closes the old interval before attributing new material',async t=>{
 const f=await fixture(t),uid=await f.enable();f.replies.set(uid,guest());await f.poll();await until(()=>f.recorder.rooms[0]?.recording);const old=f.following.snapshot[0].history[0].id;
 f.replies.set(uid,guest('123','9007199254740993998'));await f.poll();await until(()=>f.streams===2);await until(()=>f.recorder.rooms[0]?.recording);
 const history=f.following.snapshot[0].history;assert.equal(history.length,2);assert.equal(history.find(h=>h.id===old).reason,'直播场次变化');assert.equal(history[0].room_id,'9007199254740993998');assert.equal(history[0].materials.length,1);assert.notEqual(history[0].materials[0],history[1].materials[0]);
});

test('disabling during old-broadcast finalization cannot start a stale new capture',async t=>{
 const f=await fixture(t),uid=await f.enable();f.replies.set(uid,guest());await f.poll();await until(()=>f.recorder.rooms[0]?.recording);
 const room=f.recorder.entries.get('123');room.enabled=true;await f.following.enable(uid,false);const before=f.streams;
 const original=f.recorder.finish.bind(f.recorder);let release;f.recorder.finish=async target=>{await new Promise(resolve=>release=resolve);await original(target);};
 f.following.targets.get(uid).enabled=true;f.replies.set(uid,guest('123','9007199254740993998'));const pending=f.poll();await until(()=>!!release);await f.following.enable(uid,false);release();await pending;f.recorder.finish=original;assert.equal(f.streams,before);assert.equal(f.following.snapshot[0].enabled,false);assert.equal(f.recorder.entries.get('123').followers.size,0);
});

test('one monitored user moves from own broadcast to guest room and back, keeping typed material history',async t=>{
 const f=await fixture(t),uid=await f.enable('111'),own={state:'self-live',metadata:{...guest('456','8888888').metadata,ownerId:uid,name:'主播A'}};
 f.replies.set(uid,own);await f.poll();await until(()=>f.recorder.rooms[0]?.recording);
 assert.equal(f.following.snapshot[0].ownWebRid,'456');assert.equal(f.following.snapshot[0].kind,'self');assert.equal(f.following.snapshot[0].history[0].kind,'self');
 f.replies.set(uid,guest());await f.poll();await until(()=>f.streams===2);await until(()=>f.recorder.rooms[0]?.recording);
 assert.equal(f.following.snapshot[0].kind,'guest');assert.equal(f.following.snapshot[0].ownWebRid,'456');assert.equal(f.following.snapshot[0].history.length,2);
 f.replies.set(uid,own);await f.poll();await until(()=>f.streams===3);assert.equal(f.following.snapshot[0].kind,'self');
 await f.following.enable(uid,false);assert.equal(f.recorder.rooms.length,0);assert.equal(f.following.snapshot[0].enabled,false);
 assert.equal(f.following.snapshot[0].history.length,3);assert.deepEqual(new Set(f.following.snapshot[0].history.map(h=>h.kind)),new Set(['self','guest']));
});

test('own broadcast is not stopped by the guest-only four-hour limit and room data survives restart',async t=>{
 const f=await fixture(t),uid=await f.enable('111');f.replies.set(uid,{state:'self-live',metadata:{...guest().metadata,ownerId:uid,name:'主播A'}});
 await f.poll();await until(()=>f.recorder.rooms[0]?.recording);await f.poll(4*60*60*1000);assert.equal(f.following.snapshot[0].enabled,true);
 assert.equal(f.store.setting('douyin-follow-users')[0].ownWebRid,'123');
 f.replies.set(uid,{state:'offline-observation'});await f.poll();assert.equal(f.recorder.rooms[0].recording,true);await f.poll();assert.equal(f.recorder.rooms.length,0);assert.equal(f.following.snapshot[0].history[0].reason,'确认直播结束');
});

test('confirmed own-room offline releases a disconnected self capture for indexing and idle preparation',async t=>{
 const f=await fixture(t),uid=await f.enable('111');
 const metadata={...guest().metadata,ownerId:uid,name:'主播A'};
 f.replies.set(uid,{state:'self-live',metadata});
 await f.poll();
 const room=f.recorder.entries.get(metadata.webRid);
 await until(()=>room.progress?.mediaMs>=1000);
 const id=room.session;
 room.abort.abort();
 await room.active;
 assert.equal(f.store.session(id).status,'waiting');
 assert.equal(hasRecording(f.store,f.recorder),true);

 const unknown={state:'unknown',reason:'状态接口未返回目标用户'};
 f.replies.set(uid,unknown);await f.poll();
 assert.equal(f.store.session(id).status,'waiting');
 f.replies.set(uid,{...unknown,ownOffline:{webRid:metadata.webRid,roomId:metadata.roomId}});
 await f.poll();
 assert.equal(f.store.session(id).status,'waiting');
 await f.poll();
 assert.equal(f.store.session(id).status,'finishing');
 assert.equal(hasRecording(f.store,f.recorder),false);
 assert.equal(hasIndexing(f.store),true);
 assert.equal(f.following.snapshot[0].state,'监控中，等待开播或连麦');
 assert.equal(f.following.snapshot[0].enabled,true);
 assert.equal(f.following.snapshot[0].history[0].reason,'确认直播结束');
});

test('own-room offline cannot end a verified guest capture or make an idle monitor busy',async t=>{
 const f=await fixture(t),uid=await f.enable('111');
 const unknown={state:'unknown',ownOffline:{webRid:'456',roomId:''}};
 f.replies.set(uid,unknown);await f.poll();
 assert.equal(hasRecording(f.store,f.recorder),false);
 assert.match(f.following.snapshot[0].state,/连麦状态暂无法确认/);
 f.replies.set(uid,guest());await f.poll();await until(()=>f.recorder.rooms[0]?.recording);
 f.replies.set(uid,unknown);await f.poll();await f.poll();
 assert.equal(f.following.snapshot[0].kind,'guest');
 assert.equal(f.recorder.rooms[0].recording,true);
});
