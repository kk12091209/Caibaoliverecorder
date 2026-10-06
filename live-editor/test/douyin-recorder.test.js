import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DouyinRecorder,chatXml} from '../server/douyin-recorder.js';
import {DouyinFlv} from '../server/douyin-flv.js';
import {Store} from '../server/store.js';
import {Ingestor,FLV_HEADER,tags,timestamp} from '../server/ingest.js';
import {flvTag} from './helpers/source-stream-fixture.js';
import {MultiPlatformRecorder} from '../server/multi-platform-recorder.js';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let n=0;n<200;n++){if(check())return;await delay(5);}assert.fail('operation did not settle');}
const encoded=()=>Buffer.concat([FLV_HEADER,flvTag(9,123000,24,{header:true}),flvTag(8,123000,8,{header:true}),flvTag(9,123000,24,{key:true}),flvTag(8,123020,8),flvTag(9,124000,24,{key:true}),flvTag(9,125000,24,{key:true})]);
async function fixture(t,options={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'douyin-recorder-test-')),store=new Store(root),writes=[],controls=[];
 const metadata={webRid:'123',roomId:'7691637058724547364',name:'主播',title:'直播',streaming:true,stream:{url:'https://pull-test.douyincdn.com/stream.flv'},cookie:'ttwid=private',userUniqueId:'123456789'};
 const state={metadata,failure:false,streams:0};
 const chat={start(key,details,callbacks){writes.push({key,details,callbacks});},async stop(key){const item=writes.find(item=>item.key===key);if(item&&!item.stopped){item.stopped=true;await item.callbacks.write({messages:[{id:'chat1',text:'正常&聊天',user:'观众"',color:'16777215',time:0.5}],density:[{second:0,count:1000,kept:1}]});}},async close(){}};
 const recorder=new DouyinRecorder(store,{pollMs:60000,chat,now:Date.now,resolver:{async room(){if(state.failure)throw new Error('API unknown');return {...state.metadata};}},
  request:async(url,{signal})=>{state.streams++;return new Response(new ReadableStream({start(controller){controls.push(controller);controller.enqueue(encoded());signal.addEventListener('abort',()=>{try{controller.close();}catch{}},{once:true});}}));},...options});
 t.after(async()=>{await recorder.close();store.close();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});});
 return {root,store,recorder,state,writes,controls};
}
test('FLV normalization changes timestamps only, preserving every compressed packet byte',()=>{
 const input=encoded(),normalizer=new DouyinFlv(),blocks=[];for(let i=0;i<input.length;i+=7)blocks.push(...normalizer.feed(input.subarray(i,i+7)));normalizer.finish();
 const output=Buffer.concat(blocks),before=tags(input.subarray(13)).items,after=tags(output.subarray(13)).items;
 assert.equal(output.length,input.length);assert.deepEqual(after.map(item=>timestamp(item.tag)),[0,0,0,20,1000,2000]);
 for(let i=0;i<before.length;i++){assert.deepEqual(before[i].tag.subarray(11),after[i].tag.subarray(11));}assert.equal(normalizer.duration,2);
 const bad=encoded();bad[24]=0x1c;assert.throws(()=>new DouyinFlv().feed(bad),/H.264/);
});
test('Douyin records in its own originals namespace, indexes continuous chunks and drains final chat on stop',async t=>{
 const f=await fixture(t);f.recorder.start();await f.recorder.add({webRid:'123'},true);await until(()=>f.recorder.rooms[0].recording);
 const session=f.store.sessions()[0];assert.equal(session.room,0);await assert.rejects(f.store.deleteSession(session.id,true),/录制|结束/);
 await f.recorder.stopRoom('douyin:123');const ingest=new Ingestor(f.store);await ingest.tick();await ingest.tick();
 const source=f.store.sources(session.id)[0];assert.equal(source.closed,2);assert.equal(source.error,'');assert.equal(source.duration,2);assert.ok(source.path.includes(path.join('originals','douyin','123')));
 assert.equal(f.store.messages(session.id)[0].user,'观众"');assert.equal(f.store.messages(session.id)[0].text,'正常&聊天');assert.equal(f.store.get('SELECT extra FROM danmaku_density').extra,999);
 assert.equal(f.store.get('SELECT count(*) n FROM chunks').n,3);assert.equal(f.store.session(session.id).status,'finishing');
 assert.equal(f.recorder.rooms[0].recordingEnabled,false);assert.equal(JSON.stringify(f.recorder.rooms).includes('ttwid'),false);assert.equal(JSON.stringify(f.store.setting('douyin-rooms')).includes('private'),false);
});

test('official CDN to public IP and subsequent IP redirects record the same H.264/AAC stream without cookies',async t=>{
 const calls=[];let cancelled=0;
 const f=await fixture(t,{request:async(url,options)=>{
  calls.push({url,options});
  const next=calls.length===1?'http://111.2.123.206/origin.flv?token=sample':calls.length===2?'http://111.2.123.207/origin.flv?token=sample':null;
  if(next)return new Response(new ReadableStream({cancel(){cancelled++;}}),{status:302,headers:{location:next}});
  return new Response(new ReadableStream({start(controller){controller.enqueue(encoded());options.signal.addEventListener('abort',()=>controller.close(),{once:true});}}),{headers:{'content-type':'video/x-flv'}});
 }});
 f.recorder.start();await f.recorder.add({webRid:'123'},true);await until(()=>f.recorder.rooms[0].recording);await f.recorder.stopRoom('123');
 assert.deepEqual(calls.map(call=>new URL(call.url).hostname),['pull-test.douyincdn.com','111.2.123.206','111.2.123.207']);assert.equal(cancelled,2);
 for(const {options}of calls){assert.equal(options.redirect,'manual');assert.equal(new Headers(options.headers).has('cookie'),false);assert.equal(new Headers(options.headers).has('authorization'),false);}
 const source=f.store.sources(f.store.sessions()[0].id)[0],video=await fs.readFile(source.path);assert.equal(video.length,encoded().length);assert.equal(source.error,'');
 const before=tags(encoded().subarray(13)).items,after=tags(video.subarray(13)).items;
 for(let i=0;i<before.length;i++)assert.deepEqual(after[i].tag.subarray(11),before[i].tag.subarray(11));
});

test('unsafe redirect is rejected before a second request or creating a recording source',async t=>{
 for(const target of ['http://127.0.0.1/video.flv','http://[::1]/video.flv','https://untrusted.test/video.flv'])await t.test(target,async t=>{
  const calls=[];const f=await fixture(t,{request:async url=>{calls.push(url);return new Response(null,{status:302,headers:{location:target}});}});
  f.recorder.start();await f.recorder.add({webRid:'123'},true);await until(()=>!f.recorder.room('123').active);
  assert.equal(calls.length,1);assert.equal(f.store.sessions().length,0);assert.match(f.recorder.rooms[0].error,/重试/);
 });
});

test('redirect loops remain bounded and do not create empty recording material',async t=>{
 let requests=0;const f=await fixture(t,{request:async()=>{requests++;return new Response(null,{status:307,headers:{location:'http://111.2.123.206/loop.flv'}});}});
 f.recorder.start();await f.recorder.add({webRid:'123'},true);await until(()=>!f.recorder.room('123').active);
 assert.equal(requests,6);assert.equal(f.store.sessions().length,0);
});
test('offline monitoring, manual start and auto flags remain independent; stopped monitors do not start unexpectedly',async t=>{
 const f=await fixture(t);f.state.metadata.streaming=false;f.recorder.start();await f.recorder.add({webRid:'123'},true);assert.equal(f.recorder.rooms[0].recordingEnabled,true);assert.equal(f.state.streams,0);
 await f.recorder.stopRoom('douyin:123');f.state.metadata.streaming=true;await f.recorder.poll(true);assert.equal(f.state.streams,0);
 await f.recorder.startRoom('douyin:123');await until(()=>f.recorder.rooms[0].recording);await f.recorder.setAuto('douyin:123',false);assert.equal(f.recorder.rooms[0].recording,true);
 await f.recorder.stopRoom('douyin:123');assert.equal(f.recorder.rooms[0].recording,false);
});
test('an API failure cannot mark a live recording ended; stream reconnect shares one session',async t=>{
 const f=await fixture(t);f.recorder.start();await f.recorder.add({webRid:'123'},true);await until(()=>f.recorder.rooms[0].recording);const session=f.store.sessions()[0];
 f.state.failure=true;await f.recorder.poll(true);assert.equal(f.recorder.rooms[0].streaming,true);assert.equal(f.recorder.rooms[0].recording,true);
 f.controls[0].close();await until(()=>!f.recorder.room('123').active);f.state.failure=false;f.recorder.room('123').retryAt=0;await f.recorder.poll(true);await until(()=>f.state.streams===2&&f.recorder.rooms[0].recording);
 assert.equal(f.store.sessions().length,1);assert.equal(f.store.sources(session.id).length,2);await f.recorder.stopRoom('123');
});
test('confirmed offline ends recording, and a later broadcast creates a new session',async t=>{
 const f=await fixture(t);f.recorder.start();await f.recorder.add({webRid:'123'},true);await until(()=>f.recorder.rooms[0].recording);const id=f.store.sessions()[0].id;
 f.state.metadata.streaming=false;await f.recorder.poll(true);assert.equal(f.store.session(id).status,'finishing');assert.equal(f.recorder.rooms[0].recording,false);
 f.state.metadata={...f.state.metadata,roomId:'7691637058724547365',streaming:true};f.recorder.room('123').retryAt=0;await f.recorder.poll(true);await until(()=>f.recorder.rooms[0].recording);assert.equal(f.store.sessions().length,2);
});
test('deleting a finished Douyin material removes originals, chunks and platform metadata but retains exported videos',async t=>{
 const f=await fixture(t);f.recorder.start();await f.recorder.add({webRid:'123'},true);await until(()=>f.recorder.rooms[0].recording);await f.recorder.stopRoom('123');const session=f.store.sessions()[0],ingest=new Ingestor(f.store);await ingest.tick();await ingest.tick();
 const source=f.store.sources(session.id)[0],chunks=f.store.all('SELECT path FROM chunks WHERE source=?',source.id);f.store.run("UPDATE sessions SET status='finished' WHERE id=?",session.id);f.store.run("UPDATE source_storage SET status='blocked' WHERE source=?",source.id);
 const output=path.join(f.root,'已导出.mp4');await fs.writeFile(output,'exported');f.store.run("INSERT INTO jobs(id,session,status,file,data) VALUES('output',?,'done',?,?)",session.id,output,JSON.stringify({scope:'full',output:{danmaku:output}}));
 await f.store.deleteSession(session.id,true);assert.equal(f.store.setting('douyin-session:'+session.id),undefined);assert.ok((await fs.stat(output)).isFile());
 for(const file of [source.path,source.xml,...chunks.map(chunk=>chunk.path)])await assert.rejects(fs.stat(file),{code:'ENOENT'});
});
test('service close finalizes own writers and preserves enabled monitor settings for restart',async t=>{
 const f=await fixture(t);f.recorder.start();await f.recorder.add({webRid:'123'},true);await until(()=>f.recorder.rooms[0].recording);assert.equal(await f.recorder.pauseIdle(),false);
 await f.recorder.close();assert.equal(f.store.sources(f.store.sessions()[0].id)[0].closed,1);assert.equal(f.store.setting('douyin-rooms')[0].enabled,true);
 const restarted=new DouyinRecorder(f.store,{chat:{close:async()=>{}},resolver:{room:async()=>({...f.state.metadata,streaming:false})}});restarted.start();await restarted.polling;assert.equal(restarted.rooms[0].recordingEnabled,true);await restarted.close();
});
test('facade routes Douyin string namespace without touching Bilibili APIs',async t=>{
 const f=await fixture(t),calls=[];const recorder=new MultiPlatformRecorder(f.store,{executable:'',douyin:{resolver:{room:async()=>({...f.state.metadata,streaming:false})},chat:{close:async()=>{}}}});
 const bili={roomId:123,recording:false,autoRecord:true,autoRecordForThisSession:true};
 recorder.api=async(route,body)=>{calls.push({route,body});return route==='room'?[bili]:null;};recorder.online=true;recorder.rooms=[bili];recorder.douyin.start();
 t.after(()=>recorder.close());await recorder.addRoom({url:'https://live.douyin.com/123'});assert.equal(calls.length,0);assert.equal(recorder.rooms.length,2);assert.equal(recorder.rooms[1].roomId,'douyin:123');
 await recorder.action('douyin:123','stop');assert.equal(calls.length,0);await recorder.action('123','auto',{enabled:true});assert.ok(calls.some(call=>call.route==='room/123/config'));
});
test('XML serialization escapes user/content attributes and strips invalid control characters',()=>{
 const result=chatXml({messages:[{time:1.5,text:'<script>\u0000&',user:'"',id:'2',color:'16777215'}],density:[{second:1,count:100,kept:1}]});assert.ok(result.includes('&lt;script&gt;&amp;'));assert.ok(result.includes('user="&quot;"'));assert.equal(result.includes('\u0000'),false);
});
test('cancelling before the first video bytes seals the empty failed source instead of leaving indexing blocked',async t=>{
 const f=await fixture(t,{request:async(url,{signal})=>new Response(new ReadableStream({start(controller){signal.addEventListener('abort',()=>controller.close(),{once:true});}}))});
 f.recorder.start();await f.recorder.add({webRid:'123'},true);await until(()=>f.recorder.rooms[0].recording);await f.recorder.stopRoom('123');const source=f.store.sources(f.store.sessions()[0].id)[0];
 assert.equal(source.closed,2);assert.match(source.error,/未收到/);assert.equal(f.recorder.room('123').active,null);
});
test('turning auto recording off while offline disables monitoring; manual start can still record the current broadcast',async t=>{
 const f=await fixture(t);f.state.metadata.streaming=false;f.recorder.start();await f.recorder.add({webRid:'123'},true);await f.recorder.setAuto('123',false);assert.equal(f.recorder.rooms[0].recordingEnabled,false);
 f.state.metadata.streaming=true;await f.recorder.poll(true);assert.equal(f.state.streams,0);await f.recorder.startRoom('123');await until(()=>f.recorder.rooms[0].recording);assert.equal(f.recorder.rooms[0].autoRecord,false);await f.recorder.stopRoom('123');
});

test('monitoring reschedules after a transient persistence failure without changing stopped intent',async t=>{
 const f=await fixture(t,{pollMs:5});f.state.metadata.streaming=false;
 await f.recorder.add({webRid:'123'},false);
 const original=f.recorder.save.bind(f.recorder);let failures=3,attempts=0;
 f.recorder.save=()=>{attempts++;if(failures-->0)throw Object.assign(new Error('temporary disk failure'),{code:'EIO'});return original();};
 f.recorder.start();await until(()=>attempts>=5);
 assert.ok(f.recorder.timer||f.recorder.polling);assert.equal(f.recorder.rooms[0].recordingEnabled,false);assert.equal(f.state.streams,0);
});
test('a month of offline checks and network failures recovers without losing a user stop',async t=>{
 let now=Date.now();const f=await fixture(t,{now:()=>now});f.state.metadata.streaming=false;
 f.recorder.start();await f.recorder.add({webRid:'123'},false);
 for(let day=0;day<31;day++){now+=86400000;f.state.failure=day%3!==0;await f.recorder.poll();assert.equal(f.recorder.rooms[0].recordingEnabled,false);}
 f.state.failure=false;f.state.metadata.streaming=true;now+=86400000;await f.recorder.poll();assert.equal(f.state.streams,0);
 await f.recorder.startRoom('123');await until(()=>f.recorder.rooms[0].recording);assert.equal(f.state.streams,1);
});
