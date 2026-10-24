import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../server/store.js';
import {BackgroundPreparation} from '../server/background-preparation.js';
import {MediaScheduler} from '../server/media-scheduler.js';
import {LivePreparationPolicy} from '../server/live-preparation-policy.js';
import {Media} from '../server/media.js';
import {spawn} from 'node:child_process';

const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:value=>resolve(value)};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){for(let i=0;i<100;i++){if(check())return;await turn();}throw Error('condition not reached');}
const complete={done:true,preparedSeconds:60,totalSeconds:180,bytes:100};
async function fixture(t,{enabled=true}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-live-background-')),store=new Store(root);
  const state={now:100000,busy:'recording',calls:[],decisions:{allowed:true,tailSeconds:90},context:{sessionId:'live',recordingIdentity:'run',recordingCount:1,recordingHealthy:true,sourceReady:true,hardwareAvailable:true},finishes:[],started:[],foreground:false};
  const add=(id,status='recording')=>{const session=store.createSession({id,title:id,status});const source=store.addSource(id,path.join(root,id+'.flv'),0,session.created,status==='finished');store.run('UPDATE sources SET duration=180,closed=? WHERE id=?',status==='finished'?2:0,source.id);store.run('UPDATE sessions SET duration=180 WHERE id=?',id);return session;};
  add('live');add('finished','finished');
  const policy={async evaluate(context){state.contexts??=[];state.contexts.push(context);return state.decisions;},start(id){state.started.push(id);return {id};},finish(token,outcome){state.finishes.push({token,...outcome});}};
  const media={hasForegroundWork:()=>state.foreground,async prepareNext(id,options){state.calls.push({id,options});return state.prepare ? state.prepare(id,options) : complete;}};
  const scheduler=new BackgroundPreparation(store,media,{now:()=>state.now,busyReason:()=>state.busy,idleGraceMs:0,pollMs:10,liveOptions:{context:()=>state.context,policy,enabled}});
  t.after(async()=>{await scheduler.close();store.close();await fs.rm(root,{recursive:true,force:true});});
  return {root,store,state,media,policy,scheduler,add};
}

test('live admission only processes its exact recording session and never marks a growing source ready',async t=>{
  const {scheduler,state,store}=await fixture(t);scheduler.enqueue('finished');
  await scheduler.tick();assert.equal(state.calls.length,1);assert.equal(state.calls[0].id,'live');assert.deepEqual(state.calls[0].options.live,{tailSeconds:90});assert.equal(scheduler.status('live').status,'queued');assert.equal(scheduler.status('live').preparedSeconds,60);
  assert.deepEqual(state.started,['run']);assert.equal(state.finishes[0].outcome,'success');
  state.prepare=async()=>({...complete,preparedSeconds:120,totalSeconds:240,done:false});store.run("UPDATE sessions SET duration=240 WHERE id='live'");
  await scheduler.tick();assert.equal(scheduler.status('live').preparedSeconds,120);assert.equal(scheduler.status('live').totalSeconds,240);
  assert.equal(scheduler.status('finished').preparedSeconds,0);
});

test('live option is opt-in and preserves legacy recording gate, persisted enable state and pause',async t=>{
  const {scheduler,state,store}=await fixture(t,{enabled:false});await scheduler.tick();assert.equal(state.calls.length,0);assert.equal(scheduler.snapshot().liveEnabled,false);
  await scheduler.setLiveEnabled(true);assert.equal(store.setting('livePreparationEnabled'),true);await scheduler.pause('live');await scheduler.tick();assert.equal(state.calls.length,0);
  scheduler.resume('live');await scheduler.tick();assert.equal(state.calls.length,1);
  await assert.rejects(scheduler.setLiveEnabled('yes'),/布尔值/);
});

test('pause, disable, cancellation and shutdown discard pending blocks even between active tasks',async t=>{
  const {scheduler,media}=await fixture(t),discarded=[];
  media.discardPendingPreparation=async id=>discarded.push(id??'all');
  await scheduler.pause('live');await scheduler.setLiveEnabled(false);await scheduler.setEnabled(false);
  await scheduler.cancelSession('live');await scheduler.close();
  assert.deepEqual(discarded,['live','all','all','live','all']);
});

test('budget denial does not kill the current block and prevents another one',async t=>{
  const {scheduler,state}=await fixture(t);const block=deferred();let signal;
  state.prepare=async(_id,options)=>{signal=options.signal;await block.promise;state.now+=19000;return {...complete,done:false};};
  const work=scheduler.tick();await until(()=>signal);state.decisions={allowed:false,urgent:false,reason:'budget',budgetMs:18000,usedMs:19000};
  const other=scheduler.tick();await turn();assert.equal(signal.aborted,false);assert.equal(scheduler.status('live').status,'preparing');
  block.resolve();await Promise.all([work,other]);await scheduler.tick();assert.equal(state.calls.length,1);assert.equal(scheduler.status('live').reason,'budget');assert.equal(state.finishes[0].elapsedMs,19000);
});

test('unsafe recording signal cancels and waits for the child to stop before releasing the slot',async t=>{
  const {scheduler,state}=await fixture(t);const block=deferred();let signal,finished=false;
  state.prepare=async(_id,options)=>{signal=options.signal;await block.promise;finished=true;return complete;};
  const work=scheduler.tick();await until(()=>signal);state.decisions={allowed:false,urgent:true,reason:'recording-health'};
  let settled=false;const stop=scheduler.tick().then(()=>{settled=true;});await until(()=>signal.aborted);assert.equal(settled,false);assert.equal(finished,false);
  block.resolve();await Promise.all([work,stop]);assert.equal(finished,true);assert.equal(state.finishes[0].outcome,'interrupted');assert.equal(scheduler.status('live').reason,'recording-health');
});

test('context failure, multiple recordings and foreign session identity fail closed',async t=>{
  const {scheduler,state}=await fixture(t);
  for(const patch of [{recordingCount:2},{recordingCount:1,sessionId:'finished'},{recordingCount:1,sessionId:'missing'}]){state.context={...state.context,...patch};await scheduler.tick();}
  assert.equal(state.calls.length,0);scheduler.liveContext=async()=>{throw Error('resource check failed');};await scheduler.tick();assert.equal(state.calls.length,0);assert.equal(scheduler.lastError,'resource check failed');
});

test('closed service never starts work when delayed resource checks settle',async t=>{
  const {scheduler,state,policy}=await fixture(t);const check=deferred();policy.evaluate=()=>check.promise;
  const running=scheduler.tick();await turn();await scheduler.close();check.resolve({allowed:true});await running;assert.equal(state.calls.length,0);assert.equal(state.started.length,0);
});

test('recording completion hands the tail to the existing idle path without live options',async t=>{
  const {scheduler,state,store}=await fixture(t);state.prepare=async()=>({...complete,done:false,waiting:true,reason:'source'});
  await scheduler.tick();assert.equal(scheduler.status('live').status,'waiting');assert.notEqual(scheduler.status('live').status,'ready');
  store.run("UPDATE sessions SET status='finished' WHERE id='live'");store.run("UPDATE sources SET closed=2 WHERE session='live'");state.busy='';state.now+=10;state.prepare=null;
  await scheduler.tick();assert.equal(state.calls.length,2);assert.equal(state.calls[1].options.live,undefined);assert.equal(scheduler.status('live').status,'ready');
});

test('tail waits retain a media-time boundary and keep health checks running without probing every second',async t=>{
  const {scheduler,state,store}=await fixture(t);
  state.prepare=async()=>({...complete,done:false,waiting:'tail',nextEligibleAt:240,retryAfterMs:30000});
  await scheduler.tick();assert.equal(store.get("SELECT next_retry,live_next_source_seconds FROM preparation_jobs WHERE session='live'").next_retry,state.now+30000);
  for(let i=0;i<120;i++){state.now+=1000;await scheduler.tick();}
  assert.equal(state.calls.length,1);assert.equal(state.contexts.length,121,'health evaluation remains on every tick');
  state.decisions={allowed:false,urgent:true,reason:'recording-unhealthy'};await scheduler.tick();assert.equal(scheduler.status('live').reason,'recording-unhealthy');assert.equal(state.calls.length,1);
  state.decisions={allowed:true,tailSeconds:90};store.run("UPDATE sessions SET duration=239 WHERE id='live'");await scheduler.tick();assert.equal(state.calls.length,1);
  store.run("UPDATE sessions SET duration=240 WHERE id='live'");await scheduler.tick();assert.equal(state.calls.length,2);
});

test('metadata waits use bounded retry time without waiting for future media, and idle finish skips live backoff',async t=>{
  const {scheduler,state,store}=await fixture(t);
  state.prepare=async()=>({...complete,done:false,waiting:'metadata',nextEligibleAt:99999,retryAfterMs:5000});
  await scheduler.tick();assert.equal(store.get("SELECT live_next_source_seconds FROM preparation_jobs WHERE session='live'").live_next_source_seconds,0);
  for(let i=0;i<4;i++){state.now+=1000;await scheduler.tick();}assert.equal(state.calls.length,1);
  state.now+=1000;await scheduler.tick();assert.equal(state.calls.length,2);
  store.run("UPDATE sessions SET status='finished' WHERE id='live'");store.run("UPDATE sources SET closed=2 WHERE session='live'");state.busy='';state.prepare=null;
  await scheduler.tick();assert.equal(state.calls.length,3);assert.equal(state.calls.at(-1).options.live,undefined);
  assert.equal(store.get("SELECT live_next_source_seconds FROM preparation_jobs WHERE session='live'").live_next_source_seconds,null);
});

test('live waiting deadlines survive restart and pre-existing preparation tables migrate without losing jobs',async t=>{
  const {scheduler,state,store,media,policy}=await fixture(t);
  state.prepare=async()=>({...complete,done:false,waiting:'tail',nextEligibleAt:240,retryAfterMs:30000});await scheduler.tick();await scheduler.close();
  const options={now:()=>state.now,busyReason:()=>state.busy,idleGraceMs:0,liveOptions:{context:()=>state.context,policy}};
  const next=new BackgroundPreparation(store,media,options);
  try{state.now+=60000;await next.tick();assert.equal(state.calls.length,1);assert.equal(next.status('live').preparedSeconds,60);}finally{await next.close();}
  store.db.exec('ALTER TABLE preparation_jobs DROP COLUMN live_next_source_seconds');
  const migrated=new BackgroundPreparation(store,media,options);
  try{assert.equal(migrated.status('live').preparedSeconds,60);assert.ok(store.all('PRAGMA table_info(preparation_jobs)').some(column=>column.name==='live_next_source_seconds'));}finally{await migrated.close();}
});

test('live render failure waits and reports policy failure while finished retry remains recoverable',async t=>{
  const {scheduler,state}=await fixture(t);state.prepare=async()=>{throw Error('encoder stopped');};await scheduler.tick();assert.equal(scheduler.status('live').status,'waiting');assert.equal(state.finishes[0].outcome,'failure');
  await scheduler.tick();assert.equal(state.calls.length,1);state.now+=60000;state.prepare=null;await scheduler.tick();assert.equal(state.calls.length,2);
});

test('a finished recording retries live processing errors through idle without inheriting the live cooldown',async t=>{
  const {scheduler,state,store}=await fixture(t);state.prepare=async()=>{throw Error('live encoder busy');};await scheduler.tick();
  store.run("UPDATE sessions SET status='finished' WHERE id='live'");store.run("UPDATE sources SET closed=2 WHERE session='live'");state.busy='';state.prepare=null;
  await scheduler.tick();assert.equal(state.calls.length,2);assert.equal(state.calls.at(-1).options.live,undefined);assert.equal(scheduler.status('live').status,'ready');
});

test('disabling and closing live preparation await cancellation and do not accept late progress',async t=>{
  const {scheduler,state}=await fixture(t);const block=deferred();let options;
  state.prepare=async(_id,input)=>{options=input;await block.promise;input.onProgress(complete);return complete;};
  const work=scheduler.tick();await until(()=>options);let disabled=false;const closing=scheduler.setLiveEnabled(false).then(()=>{disabled=true;});await turn();assert.equal(options.signal.aborted,true);assert.equal(disabled,false);
  block.resolve();await Promise.all([work,closing]);assert.equal(scheduler.status('live').preparedSeconds,0);assert.equal(state.finishes[0].outcome,'interrupted');
});

test('concurrent live ticks only start one policy token and one media task',async t=>{
  const {scheduler,state}=await fixture(t);const block=deferred();state.prepare=()=>block.promise;
  const ticks=Array.from({length:20},()=>scheduler.tick());await until(()=>state.calls.length===1);assert.equal(state.started.length,1);block.resolve(complete);await Promise.all(ticks);assert.equal(state.calls.length,1);
});

test('real policy work budget and fault cooldown retain checkpoints then finish via idle',async t=>{
  const {scheduler,state,store}=await fixture(t);
  const resource=()=>({supported:true,sampledAt:state.now,acPower:true,lowPowerMode:false,thermal:'nominal',totalMemoryBytes:16*1024**3,availableMemoryBytes:8*1024**3,cpuUsage:.2});
  scheduler.livePolicy=new LivePreparationPolicy({now:()=>state.now,resources:resource,healthyMs:0});
  state.prepare=async()=>{state.now+=14000;return {...complete,done:false};};
  await scheduler.tick();assert.equal(state.calls.length,1);await scheduler.tick();assert.equal(state.calls.length,1);assert.equal(scheduler.status('live').reason,'work-budget');
  state.now+=34000;await scheduler.tick();assert.equal(state.calls.length,2);
  state.context.recordingHealthy=false;await scheduler.tick();assert.equal(scheduler.status('live').reason,'recording-unhealthy');
  state.context.recordingHealthy=true;state.now+=1000;await scheduler.tick();assert.equal(scheduler.status('live').reason,'recovery-cooldown');
  store.run("UPDATE sessions SET status='finished' WHERE id='live'");store.run("UPDATE sources SET closed=2 WHERE session='live'");state.busy='';state.prepare=null;
  await scheduler.tick();assert.equal(state.calls.length,3);assert.equal(state.calls.at(-1).options.live,undefined);assert.equal(scheduler.status('live').status,'ready');
});

test('recording scheduler only admits one explicit live worker and gives preview and export priority',async()=>{
  let recording=true;const scheduler=new MediaScheduler({recording:()=>recording}),block=deferred(),order=[];
  const first=scheduler.run('live-background',null,async()=>{order.push('live1');await block.promise;});await turn();
  const second=scheduler.run('live-background',null,()=>order.push('live2'));
  const normal=scheduler.run('background',null,()=>order.push('ordinary'));
  const foreground=scheduler.run('foreground',null,()=>order.push('export'));
  const preview=scheduler.run('interactive',null,()=>order.push('preview'));
  await preview;assert.deepEqual(order,['live1','preview']);block.resolve();await Promise.all([first,second,foreground]);assert.deepEqual(order,['live1','preview','export','live2']);
  recording=false;scheduler.drain();await normal;scheduler.close();
});

test('live scheduler waits behind active interactive work and supports cancelled encoder probes',async()=>{
  const scheduler=new MediaScheduler({recording:()=>true}),block=deferred(),order=[];
  const preview=scheduler.run('interactive',null,async()=>{order.push('preview');await block.promise;});const controller=new AbortController();
  const cancelled=scheduler.run('live-background',controller.signal,()=>assert.fail('cancelled probe started'));const rejected=assert.rejects(cancelled,{name:'AbortError'});controller.abort();
  const probe=scheduler.run('live-background',null,()=>order.push('probe'));await turn();assert.deepEqual(order,['preview']);block.resolve();await Promise.all([preview,probe,rejected]);assert.deepEqual(order,['preview','probe']);scheduler.close();
});

test('Media live preparation routes encoder validation, source probe and render into the live lane',async()=>{
  const media=new Media({root:'/private/tmp/caibao-live-media-routing'}),calls=[];media.isRecording=()=>true;
  media.processInternal=async args=>{calls.push({stage:args.includes('lavfi')?'encoder':'render',kind:[...media.scheduler.active][0].kind});};
  media.probeInternal=async()=>{calls.push({stage:'probe',kind:[...media.scheduler.active][0].kind});return {width:1920,height:1080};};
  media.renderer.prepareNext=async(_id,{signal})=>{
    const encoder=await media.renderer.encoder({background:true,signal});assert.equal(encoder.hardware,true);
    await media.probe('private-fixture.flv',{background:true,signal});
    await media.process(['render'],{background:true,signal});return {done:false,waiting:'tail'};
  };
  try{
    const result=await media.prepareNext('live',{live:{tailSeconds:90}});assert.equal(result.waiting,'tail');
    assert.deepEqual(calls,[{stage:'encoder',kind:'live-background'},{stage:'probe',kind:'live-background'},{stage:'render',kind:'live-background'}]);
    assert.equal(media.scheduler.active.size,0);assert.equal(media.scheduler.queue.length,0);
  }finally{media.close();}
});

test('Media ordinary preparation remains queued during recording and aborts without starting a process',async()=>{
  const media=new Media({root:'/private/tmp/caibao-live-media-ordinary'}),controller=new AbortController();media.isRecording=()=>true;
  media.processInternal=async()=>assert.fail('ordinary background process started during recording');
  media.renderer.prepareNext=async(_id,{signal})=>{await media.process(['render'],{background:true,signal});return {done:true};};
  try{
    const pending=media.prepareNext('ordinary',{signal:controller.signal});await turn();assert.equal(media.scheduler.queue[0]?.kind,'background');assert.equal(media.scheduler.active.size,0);
    controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(media.scheduler.queue.length,0);assert.equal(media.preparationCalls.size,0);
  }finally{media.close();}
});

test('Media shutdown cancels a live encoder probe and awaits child cleanup before hardware detection settles',async()=>{
  const media=new Media({root:'/private/tmp/caibao-live-media-shutdown'});media.isRecording=()=>true;
  media.spawnTracked=()=>spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['pipe','ignore','pipe','pipe']});
  try{
    const pending=media.liveHardwareAvailable();await until(()=>media.children.size===1);assert.equal([...media.scheduler.active][0].kind,'live-background');
    media.close();assert.equal(await pending,false);assert.equal(media.children.size,0);assert.equal(media.backgroundChildren.size,0);assert.equal(media.scheduler.active.size,0);
  }finally{media.close();}
});
