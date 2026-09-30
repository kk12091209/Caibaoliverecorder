import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {Recorder} from '../server/recorder.js';

const refused=()=>new TypeError('fetch failed',{cause:Object.assign(new Error('connection refused'),{code:'ECONNREFUSED'})});
const response=value=>new Response(JSON.stringify(value));
async function until(condition,message){
  const deadline=Date.now()+2000;
  while(!condition()){if(Date.now()>deadline)assert.fail(message);await new Promise(resolve=>setTimeout(resolve,5));}
}
async function fixture(t,{available=false,healthMs=10,retryMs=15,maxRetryMs=60,startupMs=80,port=17861}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-lifecycle-'));
  const executable=path.join(root,'fake-recorder.exe');await fs.writeFile(executable,'never executed; injected spawn only');
  const settings=new Map(),calls=[],children=[];
  const state={available,spawnCount:0,spawnFailures:0,authError:false,hang:false,closedStore:false,storeAfterClose:0,rooms:[{roomId:42,recording:false,streaming:false}],globalWrites:0,roomWrites:0};
  const accessed=()=>{if(state.closedStore){state.storeAfterClose++;throw new Error('store accessed after close');}};
  const store={root,setting(key,value){accessed();if(value!==undefined)settings.set(key,value);return settings.get(key);},all(){accessed();return [];},run(){accessed();}};
  const lifecycle={healthMs,retryMs,maxRetryMs,startupMs,startupPollMs:5,requestMs:60,
    async fetch(url,options){
      calls.push({url,method:options.method});
      if(state.fetchOverride)return state.fetchOverride(url,options);
      if(state.authError)return new Response('',{status:401});
      if(state.hang)return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
      if(!state.available)throw refused();
      const route=new URL(url).pathname;
      if(route==='/api/config/global')state.globalWrites++;
      if(route==='/api/room/42/config')state.roomWrites++;
      return response(route==='/api/room'?state.rooms:null);
    },
    spawn(){
      state.spawnCount++;const child=new EventEmitter();child.unref=()=>{};children.push(child);
      if(state.spawnFailures>0){state.spawnFailures--;queueMicrotask(()=>child.emit('error',new Error('simulated spawn failure')));return child;}
      child.pid=100+state.spawnCount;
      if(!state.keepPortClosed)state.available=true;
      child.exit=()=>{state.available=false;child.emit('exit',137);};
      return child;
    }
  };
  const recorder=new Recorder(store,{executable,port,lifecycle});
  t.after(async()=>{
    recorder.close();await recorder.starting;await until(()=>!recorder.pollBusy,'monitor did not finish after close');
    const resolved=path.resolve(root),temp=path.resolve(os.tmpdir())+path.sep;
    assert.ok(resolved.startsWith(temp)&&path.basename(resolved).startsWith('recorder-lifecycle-'));
    await fs.rm(resolved,{recursive:true,force:true});
  });
  return {recorder,state,calls,children,root,settings,store,executable};
}

test('核心退出后自动恢复，保留房间并重新应用采集配置，清除旧错误',async t=>{
  const {recorder,state,children}=await fixture(t);
  assert.equal(await recorder.start(),true);assert.equal(state.spawnCount,1);assert.equal(recorder.rooms[0].roomId,42);
  children[0].exit();assert.equal(recorder.online,false);assert.match(recorder.error,/已退出/);
  await until(()=>state.spawnCount===2&&recorder.online,'core did not recover after child exit');
  assert.equal(recorder.error,'');assert.equal(state.globalWrites,2);assert.equal(state.roomWrites,2);assert.equal(recorder.rooms[0].roomId,42);
});

test('重连独立运行的核心后，即使没有子进程退出事件也能检测离线并自动恢复',async t=>{
  const {recorder,state}=await fixture(t,{available:true,retryMs:50});
  assert.equal(await recorder.start(),true);assert.equal(state.spawnCount,0);assert.equal(recorder.process,null);
  assert.equal(recorder.rooms[0].roomId,42);
  // A core surviving an earlier editor has no ChildProcess handle in this editor.
  state.available=false;
  await until(()=>!recorder.online&&recorder.error!=='','health check did not detect detached core failure');
  assert.equal(state.spawnCount,0);assert.equal(recorder.process,null);assert.equal(recorder.rooms[0].roomId,42);
  await until(()=>state.spawnCount===1&&recorder.online,'detached core was not restarted by health monitoring');
  assert.equal(recorder.error,'');assert.equal(recorder.rooms[0].roomId,42);
  assert.equal(state.globalWrites,2);assert.equal(state.roomWrites,2);
});

test('首次启动失败仍持续健康检查，退避后重试成功',async t=>{
  const {recorder,state}=await fixture(t);state.spawnFailures=1;
  assert.equal(await recorder.start(),false);assert.match(recorder.error,/simulated spawn failure/);assert.equal(state.spawnCount,1);
  await until(()=>recorder.online,'initial spawn failure permanently stopped monitoring');
  assert.equal(state.spawnCount,2);assert.equal(recorder.error,'');
});

test('并发 start 与 poll 共享恢复任务，不重复启动核心',async t=>{
  const {recorder,state}=await fixture(t);
  const results=await Promise.all([recorder.start(),recorder.start(),recorder.poll(),recorder.start()]);
  assert.equal(results[0],true);assert.equal(results[1],true);assert.equal(results[3],true);assert.equal(state.spawnCount,1);assert.equal(state.globalWrites,1);
});

test('存活子进程尚未监听时继续探测，不启动第二个写入进程',async t=>{
  const {recorder,state}=await fixture(t,{startupMs:20});state.keepPortClosed=true;
  assert.equal(await recorder.start(),false);assert.equal(state.spawnCount,1);
  await new Promise(resolve=>setTimeout(resolve,100));assert.equal(state.spawnCount,1);
  state.available=true;
  await until(()=>recorder.online,'existing child did not reconnect');assert.equal(state.spawnCount,1);assert.equal(recorder.error,'');
});

test('鉴权失败或响应超时证明端口可能有人使用，均不另启核心',async t=>{
  const {recorder,state}=await fixture(t);state.authError=true;
  assert.equal(await recorder.start(),false);assert.match(recorder.error,/鉴权失败/);assert.equal(state.spawnCount,0);
  state.authError=false;state.hang=true;
  await new Promise(resolve=>setTimeout(resolve,120));assert.equal(state.spawnCount,0);
  state.hang=false;state.available=true;
  await until(()=>recorder.online,'recovery after timeout did not finish');assert.equal(recorder.error,'');assert.equal(state.spawnCount,0);
});

test('连续失败按有上限的退避重试，重复 start 不绕过退避',async t=>{
  const {recorder,state}=await fixture(t,{retryMs:30,maxRetryMs:50});state.spawnFailures=100;
  assert.equal(await recorder.start(),false);
  const first=recorder.retryAt-recorder.lifecycle.now();assert.ok(first>0&&first<=30);
  await Promise.all(Array.from({length:20},()=>recorder.start()));assert.equal(state.spawnCount,1);
  await until(()=>state.spawnCount>=3,'failed startup did not retry');
  assert.ok(recorder.retryAt-recorder.lifecycle.now()<=50);assert.ok(state.spawnCount<=3);
});

test('close 中止在途请求和监控，异步启动返回后不再读写已关闭数据库',async t=>{
  const {recorder,state,calls}=await fixture(t,{available:true});let releaseGlobal,globalEntered=false;
  state.fetchOverride=async(url,options)=>{
    if(new URL(url).pathname==='/api/config/global'){
      globalEntered=true;
      return new Promise(resolve=>{releaseGlobal=()=>resolve(response(null));});
    }
    return response(state.rooms);
  };
  const starting=recorder.start();await until(()=>globalEntered,'startup did not reach config');
  recorder.close();state.closedStore=true;const callsAtClose=calls.length;releaseGlobal();
  assert.equal(await starting,false);assert.equal(await recorder.start(),false);
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(calls.length,callsAtClose);assert.equal(state.storeAfterClose,0);assert.equal(state.spawnCount,0);assert.equal(recorder.timer,null);
});

test('close 立即取消等待核心监听的恢复流程，保持独立录制进程存活',async t=>{
  const {recorder,state,children}=await fixture(t,{startupMs:30000});state.keepPortClosed=true;
  const starting=recorder.start();await until(()=>state.spawnCount===1,'core was not launched');
  let killCount=0;children[0].kill=()=>{killCount++;};
  recorder.close();state.closedStore=true;
  assert.equal(await starting,false);assert.equal(state.storeAfterClose,0);assert.equal(killCount,0);assert.equal(recorder.timer,null);
});

test('素材扫描失败不将仍可连接的录制核心标为离线',async t=>{
  const {recorder}=await fixture(t,{available:true,healthMs:10000});assert.equal(await recorder.start(),true);
  recorder.reconcile=async()=>{throw new Error('simulated missing file');};await recorder.poll();
  assert.equal(recorder.online,true);assert.match(recorder.error,/素材同步失败/);
  recorder.reconcile=async()=>{};await recorder.poll();assert.equal(recorder.online,true);assert.equal(recorder.error,'');
});

test('自动分配核心地址并持久化，编辑服务重新打开时复用仍在运行的核心',async t=>{
  const {recorder,state,settings,store,executable}=await fixture(t,{port:0,healthMs:10000});
  let allocations=0;
  Object.assign(recorder.lifecycle,{findOwned:async()=>null,availablePort:async()=>{allocations++;return 41001;},isAlive:()=>true});
  await recorder.start();assert.equal(recorder.port,41001);assert.equal(allocations,1);assert.equal(state.spawnCount,1);
  assert.equal(settings.get('recorder-endpoint').port,41001);recorder.close();
  const next=new Recorder(store,{executable,port:0,editorPort:41002,lifecycle:recorder.lifecycle});t.after(()=>next.close());
  assert.equal(await next.start(),true);assert.equal(next.port,41001);assert.equal(state.spawnCount,1);
});

test('已有本份数据的独立核心自动发现，另一份安装和它的端口不受影响',async t=>{
  const {recorder,state,executable}=await fixture(t,{port:0,available:true});
  const owned={pid:1000,port:42001,executable,directory:recorder.directory};
  Object.assign(recorder.lifecycle,{findOwned:async()=>owned,isAlive:()=>true,availablePort:()=>assert.fail('must reuse existing core')});
  assert.equal(await recorder.start(),true);assert.equal(recorder.port,owned.port);assert.equal(state.spawnCount,0);
});

test('自动端口发生竞态冲突时不并行启动写入核心，旧子进程退出后才重选',async t=>{
  const {recorder,state,children}=await fixture(t,{port:0,startupMs:20});state.keepPortClosed=true;
  let allocations=0;
  Object.assign(recorder.lifecycle,{findOwned:async()=>null,availablePort:async()=>43000+(++allocations),isAlive:()=>recorder.childRunning});
  await recorder.start();await new Promise(resolve=>setTimeout(resolve,70));assert.equal(state.spawnCount,1);
  children[0].exit();state.keepPortClosed=false;
  await until(()=>recorder.online,'automatic core did not recover');assert.equal(state.spawnCount,2);assert.equal(recorder.port,43002);
});

test('完整退出先停空闲监控，保留监控设置供下次打开恢复，不杀正在录制的核心',async t=>{
  const {recorder,state,settings}=await fixture(t,{port:0,healthMs:10000});
  let stopped=0;
  Object.assign(recorder.lifecycle,{findOwned:async()=>null,availablePort:async()=>44001,isAlive:()=>true,stopProcess:async endpoint=>{assert.equal(endpoint.directory,recorder.directory);stopped++;return true;}});
  state.rooms=[{roomId:42,recording:true,autoRecord:true,recordingEnabled:true}];await recorder.start();
  assert.equal(await recorder.stopIdle(),false);assert.equal(stopped,0);
  state.rooms[0].recording=false;
  assert.equal(await recorder.stopIdle(),true);assert.equal(stopped,1);assert.deepEqual(settings.get('recorder-resume-rooms'),[42]);
  assert.equal(settings.get('recorder-endpoint'),null);assert.equal(recorder.quitting,true);
});

test('启动时自动恢复完整退出前启用的监控房间',async t=>{
  const {recorder,settings,calls}=await fixture(t,{available:true});settings.set('recorder-resume-rooms',[42]);
  await recorder.start();assert.ok(calls.some(call=>new URL(call.url).pathname==='/api/room/42/start'));
  assert.equal(settings.get('recorder-resume-rooms'),null);
});
