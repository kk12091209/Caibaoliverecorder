import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Store} from '../server/store.js';
import {Recorder} from '../server/recorder.js';
import {MultiPlatformRecorder} from '../server/multi-platform-recorder.js';

async function fixture(t,{automatic=true,streaming=true,available=true}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bilibili-room-state-'));
  const executable=path.join(root,'fake-core.exe');await fs.writeFile(executable,'not executable; injected core only');
  const configFile=path.join(root,'originals','config.json'),calls=[];
  const state={available,rooms:[{roomId:42,name:'测试主播',title:'测试直播',autoRecord:automatic,autoRecordForThisSession:true,streaming,recording:automatic&&streaming}],spawnSnapshots:[],failConfig:false};
  let store=new Store(root),recorder;
  const writeConfig=async()=>fs.writeFile(configFile,JSON.stringify({version:3,global:{keep:'untouched'},rooms:state.rooms.map(room=>({RoomId:{HasValue:true,Value:room.roomId},AutoRecord:{HasValue:true,Value:room.autoRecord},custom:'preserved'}))}));
  await fs.mkdir(path.dirname(configFile),{recursive:true});await writeConfig();
  const lifecycle={healthMs:60000,requestMs:1000,startupMs:1000,startupPollMs:1,
    findOwned:async()=>state.available?{pid:999999,port:45001,executable,directory:path.dirname(configFile)}:null,
    isAlive:()=>state.available,availablePort:async()=>45001,stopProcess:async()=>{state.available=false;return true;},
    async fetch(url,options){
      const route=new URL(url).pathname,body=options.body?JSON.parse(options.body):null;
      calls.push({route,body,method:options.method});
      if(!state.available)throw new TypeError('refused',{cause:Object.assign(new Error('refused'),{code:'ECONNREFUSED'})});
      if(state.intercept){const result=await state.intercept(route,body,options);if(result)return result;}
      const match=/^\/api\/room\/(\d+)\/(config|start|stop)$/.exec(route);
      if(match){
        const room=state.rooms.find(room=>room.roomId===Number(match[1])||room.shortId===Number(match[1]));assert.ok(room);
        if(match[2]==='config'&&body?.autoRecord!==undefined){
          if(state.failConfig)return new Response('',{status:500});
          if(!room.autoRecord&&body.autoRecord)room.autoRecordForThisSession=true;
          room.autoRecord=body.autoRecord;await writeConfig();
          if(room.autoRecord&&room.autoRecordForThisSession&&room.streaming)room.recording=true;
        }
        if(match[2]==='start'){room.autoRecordForThisSession=true;room.recording=room.streaming;}
        if(match[2]==='stop'){room.autoRecordForThisSession=false;room.recording=false;}
        return new Response(JSON.stringify(room));
      }
      const deletion=/^\/api\/room\/(\d+)$/.exec(route);
      if(deletion&&options.method==='DELETE'){state.rooms=state.rooms.filter(room=>room.roomId!==Number(deletion[1]));await writeConfig();}
      if(route==='/api/room'&&options.method==='POST'){
        const room={roomId:body.roomId,name:'新房间',title:'',autoRecord:body.autoRecord,autoRecordForThisSession:true,streaming:false,recording:false};state.rooms.push(room);await writeConfig();return new Response(JSON.stringify(room));
      }
      return new Response(JSON.stringify(route==='/api/room'?state.rooms:null));
    },
    spawn(){
      const config=JSON.parse(readFileSync(configFile,'utf8'));state.spawnSnapshots.push(config);
      state.rooms=config.rooms.map(room=>({roomId:room.RoomId.Value,name:'测试主播',title:'测试直播',autoRecord:room.AutoRecord.Value,autoRecordForThisSession:true,streaming,recording:room.AutoRecord.Value&&streaming}));
      state.available=true;const child=new EventEmitter();child.pid=999999;child.unref=()=>{};return child;
    }
  };
  const create=(Constructor=Recorder)=>{recorder=new Constructor(store,{executable,port:0,lifecycle,douyin:{resolver:{room:async()=>{throw Error('no network allowed');}},chat:{setRateLimit(){},close:async()=>{}}}});return recorder;};
  create();
  const f={root,executable,calls,state,configFile,lifecycle,create,get recorder(){return recorder;},get store(){return store;},
    async reopen({coreRestart=true,Constructor=Recorder}={}){recorder.close();await recorder.starting;store.close();store=new Store(root);if(coreRestart)state.available=false;return create(Constructor);}};
  t.after(async()=>{recorder.close();await recorder.starting;while(recorder.pollBusy)await new Promise(resolve=>setTimeout(resolve,1));store.close();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('bilibili-room-state-'));await fs.rm(root,{recursive:true,force:true});});
  return f;
}

test('B站手动停止持久保存，重开数据库与核心时已停止房间立刻可见且不会录制',async t=>{
  const f=await fixture(t);await f.recorder.start();await f.recorder.stopRoom(42);await f.recorder.poll();
  assert.equal(f.store.setting('bilibili-rooms')[0].enabled,false);
  assert.equal(f.recorder.rooms[0].autoRecord,true);assert.equal(f.state.rooms[0].autoRecord,false);
  f.recorder.rememberExitRooms(await f.recorder.roomsForExit());assert.deepEqual(f.store.setting('recorder-resume-rooms'),[]);
  await f.reopen();assert.equal(f.recorder.rooms.length,1);assert.equal(f.recorder.rooms[0].name,'测试主播');assert.equal(f.recorder.rooms[0].recordingEnabled,false);
  const before=f.calls.length;await f.recorder.start();
  assert.equal(f.state.spawnSnapshots[0].rooms[0].AutoRecord.Value,false);
  assert.equal(f.state.rooms[0].recording,false);
  assert.equal(f.calls.slice(before).some(call=>call.route.endsWith('/42/start')),false);
  await f.recorder.startRoom(42);await f.recorder.poll();assert.equal(f.state.rooms[0].recording,true);assert.equal(f.recorder.rooms[0].recordingEnabled,true);
  await f.reopen();await f.recorder.start();assert.equal(f.state.rooms[0].recording,true);
});

test('停止监控后遇到下一次开播、核心重连与旧恢复名单仍不会自行启动',async t=>{
  const f=await fixture(t,{streaming:false});await f.recorder.start();await f.recorder.stopRoom(42);
  f.state.rooms[0].streaming=true;f.state.rooms[0].autoRecordForThisSession=true;await f.recorder.poll();assert.equal(f.state.rooms[0].recording,false);
  f.store.setting('recorder-resume-rooms',[42]);await f.reopen();const before=f.calls.length;await f.recorder.start();
  assert.equal(f.recorder.rooms[0].recordingEnabled,false);assert.equal(f.calls.slice(before).some(call=>call.route.endsWith('/42/start')),false);
});

test('使用真实 B站 DTO 字段，退出只恢复仍启用的房间，退出停止不改用户启停意图',async t=>{
  const f=await fixture(t,{streaming:false});f.state.rooms.push({roomId:43,name:'已停止',autoRecord:true,autoRecordForThisSession:false,streaming:false,recording:false});
  await f.recorder.start();const rooms=await f.recorder.roomsForExit();f.recorder.rememberExitRooms(rooms);
  assert.deepEqual(f.store.setting('recorder-resume-rooms'),[42]);await f.recorder.stopForExit(rooms);
  assert.deepEqual(f.store.setting('bilibili-rooms').map(room=>[room.roomId,room.enabled]),[[42,true],[43,false]]);
  await f.reopen();await f.recorder.start();assert.equal(f.recorder.rooms.find(room=>room.roomId===42).recordingEnabled,true);assert.equal(f.recorder.rooms.find(room=>room.roomId===43).recordingEnabled,false);
});

test('仅监控时快速退出不丢失启用状态，也不恢复用户已停止的房间',async t=>{
  const f=await fixture(t,{streaming:false});f.state.rooms.push({roomId:43,name:'已停止',autoRecord:true,autoRecordForThisSession:false,streaming:false,recording:false});
  await f.recorder.start();assert.equal(await f.recorder.stopIdle(),true);
  assert.deepEqual(f.store.setting('recorder-resume-rooms'),[42]);
  assert.deepEqual(f.store.setting('bilibili-rooms').map(room=>[room.roomId,room.enabled]),[[42,true],[43,false]]);
  await f.reopen();await f.recorder.start();
  assert.equal(f.state.rooms.find(room=>room.roomId===42).autoRecord,true);
  assert.equal(f.state.rooms.find(room=>room.roomId===43).autoRecord,false);
  assert.equal(f.calls.filter(call=>call.route.endsWith('/43/start')).length,0);
});

test('停止配置请求失败仍保存意图，下次启动核心前关闭自动录制且保留其他配置',async t=>{
  const f=await fixture(t);await f.recorder.start();f.state.failConfig=true;
  await assert.rejects(f.recorder.stopRoom(42),/500/);assert.equal(f.store.setting('bilibili-rooms')[0].enabled,false);
  f.state.failConfig=false;await f.reopen();await f.recorder.start();
  const guarded=f.state.spawnSnapshots[0];assert.equal(guarded.rooms[0].AutoRecord.Value,false);assert.equal(guarded.rooms[0].custom,'preserved');assert.deepEqual(guarded.global,{keep:'untouched'});
  assert.equal(f.state.rooms[0].recording,false);assert.equal((await fs.readdir(path.dirname(f.configFile))).some(name=>name.startsWith('.config-start-')),false);
});

test('同一房间开始与停止串行，后发的停止不会被较早的异步开始覆盖',async t=>{
  const f=await fixture(t);await f.recorder.start();await f.recorder.stopRoom(42);
  let entered,release;const startEntered=new Promise(resolve=>{entered=resolve;}),waiting=new Promise(resolve=>{release=resolve;});
  f.state.intercept=async(route,body)=>{if(route.endsWith('/42/config')&&body?.autoRecord){entered();await waiting;}};
  const start=f.recorder.startRoom(42);await startEntered;const stop=f.recorder.stopRoom(42);release();await Promise.all([start,stop]);await f.recorder.poll();
  assert.equal(f.state.rooms[0].recording,false);assert.equal(f.store.setting('bilibili-rooms')[0].enabled,false);
});

test('B站和抖音启停记录隔离；移除 B站监控后重开不显示旧房间',async t=>{
  const f=await fixture(t,{streaming:false});await f.recorder.start();await f.recorder.stopRoom(42);
  f.store.setting('douyin-rooms',[{webRid:'123',name:'抖音测试',autoRecord:true,enabled:false}]);
  await f.reopen({coreRestart:false,Constructor:MultiPlatformRecorder});assert.equal(f.recorder.rooms.length,2);assert.equal(f.recorder.rooms.find(room=>room.platform==='douyin').recordingEnabled,false);
  await f.recorder.start();await f.recorder.action('42','remove',{confirmed:true});
  assert.deepEqual(f.store.setting('bilibili-rooms'),[]);assert.equal(f.store.setting('douyin-rooms')[0].enabled,false);
  await f.reopen({coreRestart:false,Constructor:MultiPlatformRecorder});assert.deepEqual(f.recorder.rooms.map(room=>room.roomId),['douyin:123']);
});

test('关闭自动录制和手动开始继续分开，手动停止两种状态都能跨重启保留',async t=>{
  const f=await fixture(t,{streaming:false});await f.recorder.start();await f.recorder.setAuto(42,false);await f.recorder.poll();
  assert.equal(f.recorder.rooms[0].autoRecord,false);assert.equal(f.recorder.rooms[0].recordingEnabled,false);
  f.state.rooms[0].streaming=true;await f.recorder.startRoom(42);await f.recorder.poll();assert.equal(f.state.rooms[0].recording,true);assert.equal(f.recorder.rooms[0].autoRecord,false);
  await f.recorder.stopRoom(42);await f.reopen();await f.recorder.start();assert.equal(f.state.rooms[0].recording,false);assert.equal(f.recorder.rooms[0].autoRecord,false);
});

test('核心将短号换成正式房间号时保留停止状态与自动录制偏好',async t=>{
  const f=await fixture(t);await f.recorder.start();await f.recorder.stopRoom(42);
  Object.assign(f.state.rooms[0],{roomId:420000,shortId:42});await f.recorder.poll();
  assert.equal(f.recorder.rooms[0].recordingEnabled,false);assert.equal(f.recorder.rooms[0].autoRecord,true);
  assert.equal(f.store.setting('bilibili-rooms').length,1);assert.equal(f.store.setting('bilibili-rooms')[0].roomId,420000);
  await f.recorder.startRoom(42);await f.recorder.poll();assert.equal(f.state.rooms[0].recording,true);
  await f.recorder.stopRoom(420000);await f.reopen();await f.recorder.start();assert.equal(f.state.rooms[0].recording,false);assert.equal(f.recorder.rooms[0].autoRecord,true);
});

test('使用短号重新添加已有的正式房间时不会丢失监控记录',async t=>{
  const f=await fixture(t,{streaming:false});Object.assign(f.state.rooms[0],{roomId:420000,shortId:42});await f.recorder.start();await f.recorder.stopRoom(420000);
  f.state.intercept=async(route,body,options)=>route==='/api/room'&&options.method==='POST'?new Response(JSON.stringify(f.state.rooms[0])):null;
  await f.recorder.addRoom({url:'42',autoRecord:true});assert.equal(f.store.setting('bilibili-rooms').length,1);assert.equal(f.recorder.rooms[0].recordingEnabled,true);
});
