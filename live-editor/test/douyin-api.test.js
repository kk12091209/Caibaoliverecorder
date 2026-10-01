import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.js';
import {Media} from '../server/media.js';
import {FLV_HEADER,Ingestor} from '../server/ingest.js';
import {flvTag} from './helpers/source-stream-fixture.js';

test('HTTP auto-detects Douyin; namespaced actions preserve numeric Bilibili rooms and leak no guest secrets',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'douyin-api-test-'));
 const app=await createApp({noRecorder:true,preparation:false,compact:false,data:path.join(root,'data'),port:0,ffmpeg:'not-executed',ffprobe:'not-executed',
  douyin:{resolver:{room:async()=>({platform:'douyin',webRid:'837518741716',roomId:'7691637058724547364',name:'主播',title:'测试',streaming:false,cookie:'ttwid=secret'})},chat:{close:async()=>{}}}});
 t.after(async()=>{await app.close();assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});});
 app.recorder.douyin.start();app.recorder.rooms=[{roomId:1016,recording:false,autoRecord:true}];
 const request=async(route,input)=>{const response=await fetch(`http://127.0.0.1:${app.port}/api/${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return {status:response.status,body:await response.json()};};
 const added=await request('rooms',{url:'https://live.douyin.com/837518741716?tracking=1'});assert.equal(added.status,200);assert.equal(added.body.platform,'douyin');
 let snapshot=app.snapshot();assert.equal(snapshot.rooms.length,2);assert.equal(snapshot.recorder.douyinOnline,true);assert.equal(JSON.stringify(snapshot).includes('ttwid'),false);
 assert.equal((await request('rooms/douyin:837518741716/stop',{})).status,200);snapshot=app.snapshot();assert.equal(snapshot.rooms[1].recordingEnabled,false);assert.equal(snapshot.rooms[0].roomId,1016);
 assert.equal((await request('rooms/douyin:837518741716/remove',{confirmed:false})).status,400);assert.equal((await request('rooms/douyin:837518741716/remove',{confirmed:true})).status,200);assert.equal(app.snapshot().rooms.length,1);
});
test('finished Douyin recording enters existing background preparation without automatically exporting a clean video',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'douyin-prep-test-')),prepared=[];
 t.mock.method(Media.prototype,'prepareNext',async function(id){prepared.push(id);return {done:true,preparedSeconds:2,totalSeconds:2,bytes:0};});
 const app=await createApp({noRecorder:true,compact:false,data:path.join(root,'data'),port:0,ffmpeg:'not-executed',ffprobe:'not-executed',preparationOptions:{pollMs:10,idleGraceMs:0}});
 t.after(async()=>{await app.close();assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});});
 const session=app.store.createSession({title:'抖音',room:0,status:'recording'});app.store.setting('douyin-session:'+session.id,{platform:'douyin',webRid:'123'});
 const original=path.join(root,'data','originals','douyin','123','source.flv');await fs.mkdir(path.dirname(original),{recursive:true});await fs.writeFile(original,Buffer.concat([FLV_HEADER,flvTag(9,0,24,{header:true}),flvTag(8,0,8,{header:true}),flvTag(9,0,24,{key:true}),flvTag(9,1000,24),flvTag(9,2000,24,{key:true})]));await fs.writeFile(original.replace('.flv','.xml'),'<i></i>');
 const source=app.store.addSource(session.id,original);await app.preparation.tick();assert.equal(prepared.length,0);
 app.store.run('UPDATE sources SET closed=1 WHERE id=?',source.id);app.store.run("UPDATE sessions SET status='finishing' WHERE id=?",session.id);await app.preparation.tick();assert.equal(prepared.length,0);
 app.ingestor.stop();while(app.ingestor.busy)await new Promise(resolve=>setTimeout(resolve,5));await new Ingestor(app.store).tick();
 const deadline=Date.now()+4000;while(!prepared.includes(session.id)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(app.store.session(session.id).status,'finished');assert.ok(prepared.includes(session.id));assert.equal(app.store.get('SELECT count(*) n FROM jobs').n,0);
});
