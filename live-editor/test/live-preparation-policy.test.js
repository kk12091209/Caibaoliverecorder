import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { LivePreparationPolicy } from '../server/live-preparation-policy.js';
import { liveSystemResources,liveResourceHelperPath } from '../server/live-system-resources.js';

const GiB=1024**3,base={recordingIdentity:'one',recordingCount:1,recordingHealthy:true,sourceReady:true,foreground:false,hardwareAvailable:true};
function fixture(options={}) {
  let time=0,resource={supported:true,acPower:true,lowPowerMode:false,thermal:'nominal',totalMemoryBytes:16*GiB,availableMemoryBytes:6*GiB,cpuUsage:.2};
  const policy=new LivePreparationPolicy({now:()=>time,resources:async()=>({...resource,sampledAt:time}),...options});
  return {policy,setTime:value=>{time=value;},advance:value=>{time+=value;},resource,
    evaluate:(context={})=>policy.evaluate({...base,...context}),ready:async()=>{await policy.evaluate(base);time+=30000;return policy.evaluate(base);}};
}

test('live work starts only after a healthy observation and grants one global token',async()=>{
  const f=fixture();assert.equal((await f.evaluate()).reason,'health-observation');f.advance(29999);assert.equal((await f.evaluate()).allowed,false);
  f.advance(1);assert.equal((await f.evaluate()).allowed,true);const token=f.policy.start('one');assert.ok(token);
  assert.equal(f.policy.start('one'),null);assert.equal((await f.evaluate()).reason,'already-processing');
  assert.equal((await f.evaluate({recordingIdentity:'two'})).urgent,true);
  assert.equal(f.policy.finish({identity:'one'}),false);assert.equal(f.policy.finish(token),true);assert.equal(f.policy.finish(token),false);
});

test('actual work and cancelled work repay their complete duty budget through rest',async()=>{
  const f=fixture();await f.ready();const token=f.policy.start('one');f.advance(13000);f.policy.finish(token);
  let result=await f.evaluate();assert.equal(result.reason,'work-budget');assert.equal(result.usedMs,13000);assert.equal(result.urgent,false);
  f.advance(31000);assert.equal((await f.evaluate()).allowed,true);const next=f.policy.start('one');f.advance(5000);f.policy.finish(next,{outcome:'interrupted'});
  result=await f.evaluate();assert.equal(result.reason,'work-budget');assert.equal(result.usedMs,18000);
  assert.equal(f.policy.state('one').failures,0);
});

test('a long block is allowed to finish and cannot create immediate follow-up work',async()=>{
  const f=fixture();await f.ready();const token=f.policy.start('one');f.advance(40000);
  assert.equal((await f.evaluate()).reason,'already-processing');assert.equal((await f.evaluate()).urgent,false);
  f.policy.finish(token);const result=await f.evaluate();assert.equal(result.usedMs,40000);assert.ok(result.retryAfterMs>90000);
  f.advance(result.retryAfterMs);assert.equal((await f.evaluate()).allowed,true);
});

test('foreground, readiness and busy CPU are pauses without failure escalation',async()=>{
  const f=fixture();await f.ready();assert.equal((await f.evaluate({foreground:true})).urgent,false);
  assert.equal((await f.evaluate({sourceReady:false})).reason,'source-not-ready');
  f.resource.cpuUsage=.8;assert.equal((await f.evaluate()).reason,'cpu-busy');
  f.resource.cpuUsage=.2;f.resource.thermal='fair';assert.equal((await f.evaluate()).reason,'thermal-warm');
  assert.equal(f.policy.state('one').failures,0);
});

test('recording incidents latch once, cool down, and disable the third incident for that recording',async()=>{
  const f=fixture();await f.ready();const token=f.policy.start('one');
  for(let incident=1;incident<=3;incident++){
    const bad=await f.evaluate({recordingHealthy:false});assert.equal(bad.urgent,true);assert.equal(f.policy.state('one').failures,incident);
    await f.evaluate({recordingHealthy:false});assert.equal(f.policy.state('one').failures,incident);
    if(incident===1)f.policy.finish(token,{outcome:'interrupted'});
    if(incident<3){assert.equal((await f.evaluate()).reason,'recovery-cooldown');f.advance(incident===1?60000:120000);assert.equal((await f.evaluate()).reason,'health-observation');f.advance(30000);assert.equal((await f.evaluate()).allowed,true);}
  }
  f.advance(1000000);assert.equal((await f.evaluate()).reason,'disabled-for-recording');
  assert.equal((await f.evaluate({recordingIdentity:'new'})).reason,'health-observation');f.advance(30000);assert.equal((await f.evaluate({recordingIdentity:'new'})).allowed,true);
});

test('processing errors use the same bounded fallback, interruption does not',async()=>{
  const f=fixture();await f.ready();const token=f.policy.start('one');f.advance(1000);f.policy.finish(token,{outcome:'failure'});
  assert.equal(f.policy.state('one').failures,1);assert.equal((await f.evaluate()).reason,'recovery-cooldown');
});

test('initial or missing recorder telemetry observes without consuming the incident budget',async()=>{
  const f=fixture();for(let i=0;i<5;i++){assert.equal((await f.evaluate({recordingHealthy:false,recordingState:'observing'})).reason,'recording-observation');f.advance(30000);}
  assert.equal(f.policy.state('one').failures,0);assert.equal((await f.evaluate({recordingHealthy:undefined})).reason,'recording-observation');
  assert.equal((await f.evaluate()).reason,'health-observation');f.advance(30000);assert.equal((await f.evaluate()).allowed,true);
});

test('unsafe recorder, ingest, loop, thermal and memory signals request urgent cancellation',async()=>{
  for(const context of [{recordingWriteHealthy:false},{ingestLagMs:16000},{loopDelayMs:300}]){
    const f=fixture();await f.ready();assert.equal((await f.evaluate(context)).urgent,true);assert.equal(f.policy.state('one').failures,1);
  }
  for(const update of [{thermal:'serious'},{thermal:'critical'},{availableMemoryBytes:GiB}]){
    const f=fixture();await f.ready();Object.assign(f.resource,update);assert.equal((await f.evaluate()).urgent,true);
  }
});

test('unknown, stale, unsupported and low-power resources fail closed without inventing a thermal state',async()=>{
  for(const update of [{supported:false},{acPower:null},{lowPowerMode:undefined},{thermal:'unknown'},{totalMemoryBytes:undefined},{availableMemoryBytes:undefined}]){
    const f=fixture();await f.ready();const token=f.policy.start('one');Object.assign(f.resource,update);
    const result=await f.evaluate();assert.equal(result.allowed,false);assert.equal(result.urgent,true);f.policy.finish(token,{outcome:'interrupted'});
  }
  for(const sample of [{sampledAt:-31000},{sampledAt:1001}]){
    const f=fixture({resources:async()=>({supported:true,...sample})});assert.equal((await f.evaluate()).reason,'resources-stale');
  }
  const f=fixture({resources:async()=>{throw Error('helper unavailable');}});assert.equal((await f.evaluate()).allowed,false);
});

test('grants expire, clock changes pause, and simultaneous checks cannot restore obsolete permission',async()=>{
  const f=fixture();await f.ready();f.advance(1001);assert.equal(f.policy.start('one'),null);
  f.setTime(1);assert.equal((await f.evaluate()).reason,'clock-changed');assert.equal(f.policy.start('one'),null);
  let resolve;const queued=fixture({healthyMs:0,resources:()=>new Promise(r=>{resolve=r;})});
  const pending=queued.evaluate();await queued.evaluate({recordingCount:2});resolve({...queued.resource,sampledAt:0});
  assert.equal((await pending).reason,'superseded');assert.equal(queued.policy.start('one'),null);
});

function samplerFixture() {
  let now=0,calls=0,mode='ok',tick=0;
  const sampler=liveSystemResources({platform:'darwin',now:()=>now,totalMemory:()=>16*GiB,
    cpus:()=>[{times:{idle:++tick*80,user:tick*20,sys:0,nice:0,irq:0}}],
    query:async(file)=>{calls++;await Promise.resolve();if(mode==='error')throw Error('unavailable');
      if(file==='/usr/bin/memory_pressure')return {stdout:mode==='memory-invalid'?'unknown':'System-wide memory free percentage: 40%'};
      return {stdout:JSON.stringify({version:1,sampledAt:mode==='stale'?now-6000:now,acPower:true,lowPowerMode:false,thermal:mode==='thermal-unknown'?'unknown':'nominal'})};}});
  return {sampler,calls:()=>calls,setMode:value=>{mode=value;},advance:value=>{now+=value;}};
}

test('system resources coalesce, refresh infrequently and never reuse healthy samples after a failed refresh',async()=>{
  const f=samplerFixture();const samples=await Promise.all([f.sampler(),f.sampler(),f.sampler()]);assert.equal(f.calls(),2);assert.equal(samples[0].supported,true);
  assert.equal(samples[0].availableMemoryBytes,16*GiB*.4);assert.equal(samples[0].cpuUsage,null);
  f.advance(9999);await f.sampler();assert.equal(f.calls(),2);f.advance(1);assert.ok(Math.abs((await f.sampler()).cpuUsage-.2)<1e-9);
  f.setMode('error');f.advance(10000);assert.equal((await f.sampler()).supported,false);assert.equal(f.calls(),6);
  await f.sampler();assert.equal(f.calls(),6,'failed probes also have a bounded retry interval');
});

test('malformed native or memory samples and unsupported platforms cannot enable live work',async()=>{
  for(const mode of ['memory-invalid','thermal-unknown','stale']){const f=samplerFixture();f.setMode(mode);assert.equal((await f.sampler()).supported,false);}
  const unsupported=liveSystemResources({platform:'win32',query:()=>assert.fail('must not launch a Mac helper')});
  assert.deepEqual((await unsupported()).reason,'platform-unavailable');
  assert.equal(liveResourceHelperPath({root:'/source/live-editor',env:{}}),path.join('/source','.tools/runtime/resources/live-system-resources'));
  assert.equal(liveResourceHelperPath({root:'/App.app/Contents/Resources/live-editor',env:{}}),path.join('/App.app/Contents/Resources','runtime/resources/live-system-resources'));
});
