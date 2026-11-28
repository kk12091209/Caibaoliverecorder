import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {BilibiliPlatform} from '../server/bilibili-platform.js';
import {PlatformCredentials} from '../server/platform-credentials.js';
import {RecordingPolicy} from '../server/recording-policy.js';
import {Store} from '../server/store.js';
import {testProtection} from './credential-fixtures.js';

const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const envelope=(revision,entries,channel='beta')=>{
  const data=Buffer.from(JSON.stringify({schema:1,type:'caibo-recording-policy',channel,revision,entries}));
  return {schema:1,data:data.toString('base64'),signature:sign(null,data,privateKey).toString('base64')};
};
const ban=uid=>({platform:'bilibili',uid});
const json=value=>Response.json(value);

test('升级保留监控和 Cookie，命中后只移除空闲或已结束场次，解除后可重新添加', async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-policy-test-'));
  let store=new Store(root),credentials;
  t.after(async()=>{await credentials?.close();store.close();await fs.rm(root,{recursive:true,force:true});});
  const settings=[{roomId:42,name:'空闲',enabled:true,autoRecord:true},{roomId:43,name:'在录',enabled:true,autoRecord:true},{roomId:44,name:'原配置',enabled:false,autoRecord:false}];
  store.setting('bilibili-rooms',settings);
  const options={protection:testProtection()};
  credentials=await new PlatformCredentials(root,{...options,store}).initialize();
  const cookie='SESSDATA=isolated-upgrade-fixture; DedeUserID=777; bili_jct=fixture';
  await credentials.save('bilibili',cookie);
  await credentials.close();store.close();
  store=new Store(root);
  credentials=await new PlatformCredentials(root,{...options,store}).initialize();
  const original=path.join(root,'original-fixture.flv'), exported=path.join(root,'export-fixture.mp4');
  await Promise.all([fs.writeFile(original,'test original'),fs.writeFile(exported,'test export')]);
  let manifest=envelope(1,[]), now=Date.parse('2026-11-28T00:00:00Z');
  const requests=[];
  const policy=new RecordingPolicy(store,{channel:()=> 'beta',publicKey,now:()=>now,
    fetcher:async(url,{headers})=>{requests.push({url,headers});return Response.json(manifest,{headers:{etag:'"policy"'}});}});
  await policy.restore();
  await policy.check();
  assert.equal(credentials.get('bilibili'),cookie);
  assert.deepEqual(store.setting('bilibili-rooms'),settings);
  let rooms=settings.map((room,index)=>({...room,uid:900+index,recording:room.roomId===43,streaming:room.roomId===43,autoRecordForThisSession:room.enabled}));
  const calls=[];
  const recorder=new BilibiliPlatform(store,{policy,bilibiliResolver:{room:async id=>({roomId:Number(id),uid:'900'})}});
  t.after(()=>recorder.close());
  recorder.api=async(route,body,method)=>{
    calls.push([route,method]);
    if(route==='room'&&body){const room={...body,uid:900,recording:false};rooms.push(room);return room;}
    if(route==='room')return rooms;
    if(method==='DELETE'){rooms=rooms.filter(room=>room.roomId!==Number(route.split('/')[1]));return null;}
    if(route.endsWith('/config'))return null;
    if(route.endsWith('/stop'))return null;
    return rooms.find(room=>room.roomId===Number(route.split('/')[1]));
  };
  recorder.online=true;
  await recorder.poll();
  assert.equal(calls.some(([,method])=>method==='DELETE'),false);
  manifest=envelope(2,[ban('900'),ban('901')]);now+=4*3600*1000;
  await policy.check();await recorder.poll();
  assert.equal(requests.at(-1).headers['If-None-Match'],'"policy"');
  assert.deepEqual(recorder.rooms.map(room=>room.roomId),[43,44]);
  assert.equal(recorder.rooms[0].policyPending,true);
  assert.equal(calls.some(([route])=>route==='room/43/stop'),false);
  await assert.rejects(recorder.addRoom({url:'https://live.bilibili.com/42'}),/限制录制/);
  const active=rooms.find(room=>room.roomId===43);
  active.recording=false;active.recordingPolicyContinuation=true;
  await recorder.poll();assert.equal(recorder.rooms[0].policyPending,true);
  active.recordingPolicyContinuation=false;active.streaming=false;
  await recorder.poll();assert.deepEqual(recorder.rooms.map(room=>room.roomId),[44]);
  assert.equal(recorder.rooms[0].recordingEnabled,false);
  assert.equal(await fs.readFile(original,'utf8'),'test original');
  assert.equal(await fs.readFile(exported,'utf8'),'test export');
  assert.equal(credentials.get('bilibili'),cookie);
  manifest=envelope(3,[]);
  await policy.check({force:true});await recorder.addRoom({url:'https://live.bilibili.com/42'});
  assert.equal(recorder.rooms.find(room=>room.roomId===42)?.uid,900);
});

test('旧版、签名错误、跨通道和离线清单不会覆盖已校验的规则',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-policy-test-'));
  const store=new Store(root);
  t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
  let result=envelope(4,[ban('900')]);
  const policy=new RecordingPolicy(store,{channel:()=> 'beta',publicKey,
    fetcher:async()=>{if(!result)throw Error('offline');return json(result);}});
  await policy.restore();
  await policy.check();
  for(const candidate of [envelope(3,[]),{...envelope(5,[]),signature:'A'.repeat(88)},envelope(5,[],'stable'),null]){
    result=candidate;
    const state=await policy.check({force:true});
    assert.equal(state.revision,4);assert.match(state.error,/暂时无法/);
    assert.equal(policy.blocked('bilibili','900'),true);
    assert.deepEqual(JSON.parse(await fs.readFile(policy.coreFile,'utf8')),['900']);
  }
  const restored=new RecordingPolicy(store,{channel:()=> 'beta',publicKey});
  await restored.restore();
  assert.equal(restored.blocked('bilibili','900'),true);
});
