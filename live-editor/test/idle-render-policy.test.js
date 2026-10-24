import test from 'node:test';
import assert from 'node:assert/strict';
import { IdleRenderPolicy, idleResourceSampler } from '../server/idle-render-policy.js';
import { preparedEncoderArguments, softwareEncoder } from '../server/export-encoding.js';
import { MediaScheduler } from '../server/media-scheduler.js';
import { RenderPipeline } from '../server/render-plan.js';
import { Media } from '../server/media.js';

const GiB=1024**3,resources=async()=>({cores:10,total:16*GiB,available:8*GiB});
const plan={profile:{width:1920,height:1080}},blocks=[0,60000,120000,180000].map(startMs=>({startMs,endMs:startMs+60000}));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function gate(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}

test('idle policy requires two serial samples and a measured gain before retaining parallel work',async()=>{
  const policy=new IdleRenderPolicy({resources});
  for(let i=0;i<2;i++){const choice=await policy.choose('one','profile',plan,blocks);assert.equal(choice.concurrency,1);policy.observe('one','profile',choice,60,6000);}
  const trial=await policy.choose('one','profile',plan,blocks);assert.equal(trial.concurrency,2);
  policy.observe('one','profile',trial,120,7000);assert.equal(policy.state('one','profile').decision,'parallel');
  assert.equal((await policy.choose('one','profile',plan,blocks)).concurrency,2);
  policy.observe('one','profile',trial,120,13000);policy.observe('one','profile',trial,120,13000);
  assert.equal((await policy.choose('one','profile',plan,blocks)).concurrency,1);
  assert.equal(policy.state('one','new-profile').singles.length,0);
});

test('resource and disk pressure always cap forced parallel mode at a single block',async()=>{
  for(const [sample,reason] of [[{cores:4,total:16*GiB,available:8*GiB},'small-device'],[{cores:10,total:16*GiB,available:GiB},'memory-pressure']]){
    const policy=new IdleRenderPolicy({mode:'parallel',resources:async()=>sample});
    assert.equal((await policy.choose('id','profile',plan,blocks)).reason,reason);
  }
  const policy=new IdleRenderPolicy({mode:'parallel',resources});
  assert.equal((await policy.choose('id','profile',plan,blocks,{entries:new Map(),maxBytes:1024})).reason,'cache-budget');
  assert.equal((await policy.choose('id','profile',plan,blocks,{freeSpace:async()=>{throw Error('disk full');}})).reason,'disk-pressure');
  assert.equal((await policy.choose('id','profile',plan,[blocks[0]])).reason,'last-block');
  assert.equal((await policy.choose('id','profile',plan,[blocks[0],{startMs:60000,endMs:61000}])).reason,'short-block');
  const choice=await policy.choose('id','profile',plan,blocks);policy.observe('id','profile',choice,120,1000);
  assert.equal((await policy.choose('id','profile',plan,blocks)).concurrency,2,'benchmark parallel mode is not judged against an absent serial baseline');
});

test('macOS resource samples coalesce and expire without spawning a command for every block',async()=>{
  let now=0,calls=0;const sampler=idleResourceSampler({platform:'darwin',now:()=>now,query:async()=>{calls++;await tick();return {stdout:'System-wide memory free percentage: 35%\n'};}});
  const values=await Promise.all([sampler(),sampler(),sampler()]);assert.equal(calls,1);
  assert.equal(values[0].available,values[0].total*.35);assert.equal(values[0].source,'memory-pressure');
  now=20000;await sampler();assert.equal(calls,1);now=30000;await sampler();assert.equal(calls,2);
  const unavailable=await idleResourceSampler({platform:'darwin',query:async()=>{throw Error('no command');}})();
  assert.equal(unavailable.source,'free-memory');assert.ok(unavailable.available>=0);
});

test('adaptive mode keeps cached encoding arguments unchanged and never changes FPS or quality',()=>{
  const encoder=softwareEncoder(),adaptive=new IdleRenderPolicy({resources});
  assert.deepEqual(preparedEncoderArguments(encoder,adaptive.threads),preparedEncoderArguments(encoder));
  const single=new IdleRenderPolicy({mode:'single',threads:4,resources});
  const args=preparedEncoderArguments({...encoder,threads:6},single.threads);
  assert.equal(args[args.indexOf('-threads')+1],'4');assert.equal(args[args.indexOf('-crf')+1],'20');
  assert.equal(args.includes('-r'),false);
});

test('bounded background batch permits two workers and still reserves a preview slot',async()=>{
  const block=gate(),scheduler=new MediaScheduler({backgroundLimit:()=>2});let running=0,peak=0;
  const work=async()=>{peak=Math.max(peak,++running);await block.promise;running--;};
  const jobs=[scheduler.run('background',null,work),scheduler.run('background',null,work),scheduler.run('background',null,work),scheduler.run('interactive',null,work)];
  await tick();assert.equal(peak,3);assert.equal(scheduler.active.size,3);assert.equal(scheduler.queue.length,1);
  block.resolve();await Promise.all(jobs);assert.equal(scheduler.active.size,0);scheduler.close();
});

function rendererFixture(){
  const source={id:'source',start:0,duration:240},held=new Set(),cached=new Set(),layout=[];
  const cache={revision:0,acquire:async spec=>cached.has(spec)?{bytes:10,release(){held.delete(spec);}}:null};
  const media={store:{edit:()=>({})},renderCache:cache,idlePolicy:new IdleRenderPolicy({mode:'parallel',resources}),withBackgroundBatch:async(_capacity,work)=>work()};
  const renderer=new RenderPipeline(media,()=>{});
  renderer.describe=async()=>({sources:[source],blocks:blocks.map(block=>({...block,source})),layout,snapshot:{excluded:new Set()},profileHash:'profile',profile:{...plan.profile,fps:60}});
  renderer.sourceFingerprint=async()=> 'source';renderer.spec=async(_plan,block)=>block.startMs;
  const finish=block=>{cached.add(block.startMs);held.add(block.startMs);cache.revision++;return {bytes:10,release(){held.delete(block.startMs);}};};
  return {renderer,media,cache,held,cached,finish};
}

test('parallel preparation settles siblings, retains successful blocks and retries only failed blocks serially',async()=>{
  const f=rendererFixture(),completed=gate(),calls=new Map();let active=0,peak=0;
  f.renderer.acquire=async(_plan,block)=>{
    peak=Math.max(peak,++active);calls.set(block.startMs,(calls.get(block.startMs)||0)+1);
    try{
      if(block.startMs===0){await tick();const lease=f.finish(block);completed.resolve();return lease;}
      if(calls.get(block.startMs)===1){await completed.promise;await tick();assert.equal(f.held.has(0),true);throw Error('one hardware session unavailable');}
      assert.equal(active,1);return f.finish(block);
    }finally{active--;}
  };
  const result=await f.renderer.prepareNext('session');assert.equal(result.preparedSeconds,120);
  assert.equal(calls.get(0),1);assert.equal(calls.get(60000),2);assert.equal(f.held.size,0);assert.equal(active,0);assert.equal(peak,2);
  assert.equal(f.media.idlePolicy.state('session',f.renderer.preparationPlans.get('session').signature).decision,'serial');
});

test('cancelling a batch waits for both workers to settle and releases all plan pins',async()=>{
  const f=rendererFixture(),controller=new AbortController();let active=0,settled=0;
  f.renderer.acquire=async(_plan,_block,{signal})=>{
    active++;try{await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));await tick();throw Object.assign(Error('cancelled'),{name:'AbortError'});}
    finally{active--;settled++;}
  };
  const pending=f.renderer.prepareNext('session',{signal:controller.signal});await tick();assert.equal(active,2);controller.abort();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(active,0);assert.equal(settled,2);assert.equal(f.held.size,0);assert.equal(f.renderer.operations.size,0);
});

test('preparation diagnostics include background stages and duplicate prepare requests share one operation',async()=>{
  const media=new Media({root:'/private/tmp/caibao-idle-timing-test'},{idleRenderOptions:{mode:'legacy'}});let calls=0;
  media.renderer.prepareNext=async()=>{calls++;await media.scheduled('background',null,()=>tick(),'render');return {done:true};};
  try{
    const first=media.prepareNext('same'),second=media.prepareNext('same');assert.equal(first,second);
    const result=await first;assert.equal(calls,1);assert.equal(result.performance.stages.render.count,1);assert.equal(media.preparationCalls.size,0);
  }finally{media.close();}
});

test('shutdown aborts preparation, waits for its settlement and keeps final diagnostics independent of Store',async()=>{
  const media=new Media({root:'/private/tmp/caibao-idle-shutdown-test'},{idleRenderOptions:{mode:'legacy'}});
  media.renderer.prepareNext=async(_id,{signal})=>{
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));await tick();
    throw Object.assign(Error('cancelled'),{name:'AbortError'});
  };
  const task=media.prepareNext('session');await tick();media.close();
  media.store=new Proxy({},{get(){assert.fail('diagnostics touched a closed Store');}});
  await assert.rejects(task,{name:'AbortError'});assert.equal(media.preparationCalls.size,0);assert.ok(media.preparationMetrics.has('session'));
  await assert.rejects(media.prepareNext('session'),{name:'AbortError'});
});
