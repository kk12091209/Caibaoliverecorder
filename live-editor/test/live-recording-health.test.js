import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveRecordingHealth} from '../server/live-recording-health.js';

function fixture(t,{platform='darwin'}={}){
  let now=100000,probes=0,blocked=false,enabled=0,disabled=0,resets=0;
  const room={roomId:123,platform:'bilibili',recording:true,recordingObservedAt:now,recordingStats:{totalOutputBytes:1000,sessionMaxTimestamp:1000}};
  const session={id:'recording',room:123,status:'recording',duration:180,error:''};
  const source={id:'source',session:'recording',closed:0,duration:180,error:'',header:JSON.stringify({video:'video',audio:'audio'})};
  const ingest={observedAt:now,unreadBytes:0,lastProgressAt:now,lastIngestAt:now,writeLatencyMs:1,inFlightWriteSince:null};
  const resource={supported:true,acPower:true,lowPowerMode:false,thermal:'nominal',sampledAt:now,totalMemoryBytes:16*1024**3,availableMemoryBytes:8*1024**3};
  const monitor={max:20e6,enable(){enabled++;},disable(){disabled++;},reset(){resets++;}};
  const sessions=[session],rooms=[room],sources=[source],settings=new Map();
  const health=new LiveRecordingHealth({store:{all:()=>sessions,sources:()=>sources,setting:key=>settings.get(key)},recorder:{rooms},
    ingestor:{healthSnapshot:()=>ingest},media:{liveHardwareAvailable:async()=>{probes++;return true;}},blocked:()=>blocked,
    resources:async()=>resource,now:()=>now,platform,loopMonitor:()=>monitor});
  t.after(()=>health.close());
  function tick(ms=1000,{progress=true}={}){
    now+=ms;room.recordingObservedAt=now;ingest.observedAt=now;resource.sampledAt=now;
    if(progress){room.recordingStats.totalOutputBytes+=100;room.recordingStats.sessionMaxTimestamp+=ms;ingest.lastProgressAt=now;}
    return health.context();
  }
  return {health,room,session,source,ingest,resource,monitor,sessions,rooms,sources,settings,tick,
    get now(){return now;},get probes(){return probes;},get disabled(){return disabled;},get enabled(){return enabled;},get resets(){return resets;},block:()=>{blocked=true;}};
}

test('live admission waits for actual bytes and media progress and releases its lazy monitor',async t=>{
  const f=fixture(t);assert.equal(f.enabled,0);
  assert.equal((await f.health.context()).recordingState,'observing');assert.equal(f.probes,0);
  const active=await f.tick();assert.equal(active.recordingHealthy,true);assert.equal(active.recordingWriteHealthy,true);
  assert.equal(active.hardwareAvailable,true);assert.equal(active.sourceReady,true);assert.equal(active.recordingIdentity,'recording');assert.equal(f.enabled,1);
  f.health.close();assert.equal(f.disabled,1);assert.equal((await f.health.context()).recordingHealthy,false);
});

test('unmatched or multiple rooms never borrow another recording identity',async t=>{
  const f=fixture(t);f.room.roomId=456;
  assert.equal((await f.health.context()).sessionId,undefined);assert.equal(f.probes,0);
  f.room.roomId=123;f.sessions.push({...f.session,id:'other'});
  const context=await f.health.context();assert.equal(context.recordingCount,2);assert.equal(context.sessionId,undefined);
});

test('missing stats or an unopened source stay in observation rather than claiming safety',async t=>{
  const f=fixture(t);delete f.room.recordingStats;
  assert.equal((await f.health.context()).recordingState,'observing');assert.equal(f.probes,0);
  f.sources.length=0;assert.equal((await f.health.context()).recordingState,'observing');
});

test('frozen media, recovery status and waiting sessions suppress work even with incoming bytes',async t=>{
  const f=fixture(t);await f.health.context();await f.tick();
  f.room.recordingStats.totalOutputBytes+=10000;
  const frozen=await f.tick(9000,{progress:false});assert.equal(frozen.recordingState,'unhealthy');
  await f.tick();f.room.recordingHealth={state:'recovering'};
  assert.equal((await f.health.context()).recordingState,'unhealthy');
  f.room.recordingHealth=null;f.session.status='waiting';assert.equal((await f.health.context()).recordingState,'unhealthy');
});

test('new source or reset recording counters needs fresh progress',async t=>{
  const f=fixture(t);await f.health.context();await f.tick();
  f.source.id='replacement';assert.equal((await f.health.context()).recordingState,'observing');
  await f.tick();f.room.recordingStats.totalOutputBytes=1;f.room.recordingStats.sessionMaxTimestamp=1;
  assert.equal((await f.health.context()).recordingState,'observing');
});

test('stale index samples, persistent backlog and slow/in-flight writes are visible to policy',async t=>{
  const f=fixture(t);await f.health.context();await f.tick();
  f.ingest.observedAt=f.now-9000;assert.equal((await f.health.context()).recordingState,'unhealthy');
  f.ingest.unreadBytes=2*1024**2;await f.tick();
  assert.equal((await f.tick(16000)).ingestLagMs,16000);
  f.ingest.unreadBytes=0;f.ingest.writeLatencyMs=501;
  let context=await f.tick();assert.equal(context.ingestLagMs,0);assert.equal(context.recordingWriteHealthy,false);
  f.ingest.writeLatencyMs=1;f.ingest.inFlightWriteSince=f.now-1000;
  assert.equal((await f.health.context()).recordingWriteHealthy,false);
});

test('unpowered, unsupported, busy or hot devices do not launch a new hardware probe',async t=>{
  for(const condition of ['battery','thermal','memory','foreground','windows'])await t.test(condition,async t=>{
    const f=fixture(t,{platform:condition==='windows'?'win32':'darwin'});await f.health.context();
    if(condition==='battery')f.resource.acPower=false;
    if(condition==='thermal')f.resource.thermal='serious';
    if(condition==='memory')f.resource.availableMemoryBytes=1024**3;
    if(condition==='foreground')f.block();
    const result=await f.tick();assert.equal(result.hardwareAvailable,false);assert.equal(f.probes,0);
  });
});

test('active hardware capability remains known so fair thermal state can pause without pretending hardware failed',async t=>{
  const f=fixture(t);await f.health.context();await f.tick();assert.equal(f.probes,1);
  f.resource.thermal='fair';assert.equal((await f.tick()).hardwareAvailable,true);assert.equal(f.probes,1);
  f.monitor.max=300e6;assert.equal((await f.tick()).loopDelayMs,300);assert.equal(f.probes,1);
});

test('Douyin maps only its namespaced session and considers actual original writer pressure',async t=>{
  const f=fixture(t);f.session.room=0;Object.assign(f.room,{roomId:'douyin:123',webRid:'123',platform:'douyin',recordingProgress:{observedAt:f.now,bytes:1000,mediaMs:1000,writeLatencyMs:1,inFlightWriteSince:null}});
  assert.equal((await f.health.context()).sessionId,undefined);
  f.settings.set('douyin-session:recording',{webRid:'123'});await f.health.context();
  f.room.recordingProgress.bytes+=100;f.room.recordingProgress.mediaMs+=1000;
  assert.equal((await f.health.context()).recordingHealthy,true);
  f.room.recordingProgress.inFlightWriteSince=f.now-1000;
  assert.equal((await f.health.context()).recordingWriteHealthy,false);
});

test('health is rechecked after the first asynchronous hardware probe',async t=>{
  const f=fixture(t);await f.health.context();
  f.health.media.liveHardwareAvailable=async()=>{await Promise.resolve();f.room.recordingHealth={state:'recovering'};return true;};
  const context=await f.tick();assert.equal(context.hardwareAvailable,true);assert.equal(context.recordingHealthy,false);assert.equal(context.recordingState,'unhealthy');
});
