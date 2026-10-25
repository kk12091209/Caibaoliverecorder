import test from 'node:test';
import assert from 'node:assert/strict';
import {foregroundRenderConcurrency} from '../server/foreground-render-policy.js';
import {MediaScheduler} from '../server/media-scheduler.js';
import {RenderPipeline} from '../server/render-plan.js';
import {Media} from '../server/media.js';

const GiB=1024**3,tick=()=>new Promise(resolve=>setImmediate(resolve));
const plan={profile:{width:1920,height:1080,fps:60,encoder:{id:'h264_videotoolbox',hardware:true}}};
const parts=Array.from({length:6},(_,i)=>({source:{id:'source'},from:i*60,to:(i+1)*60}));
const resources=async()=>({cores:8,total:16*GiB,available:8*GiB});
function gate(){let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:()=>resolve()};}

test('long cold exports expand only on a measured encoder with enough CPU and memory',async()=>{
  assert.equal(await foregroundRenderConcurrency(plan,parts,{resources}),4);
  assert.equal(await foregroundRenderConcurrency(plan,parts,{resources,recording:true}),1);
  assert.equal(await foregroundRenderConcurrency({...plan,profile:{...plan.profile,encoder:{hardware:false}}},parts,{resources}),1);
  assert.equal(await foregroundRenderConcurrency({...plan,profile:{...plan.profile,encoder:{hardware:true,id:'h264_nvenc'}}},parts,{resources}),2);
  assert.equal(await foregroundRenderConcurrency(plan,parts.slice(0,2),{resources}),2);
  for(const sample of [{cores:4,total:16*GiB,available:8*GiB},{cores:8,total:16*GiB,available:2*GiB}])
    assert.equal(await foregroundRenderConcurrency(plan,parts,{resources:async()=>sample}),2);
  assert.equal(await foregroundRenderConcurrency({...plan,profile:{...plan.profile,width:3840,height:2160}},parts,{resources:async()=>({cores:8,total:16*GiB,available:5*GiB})}),2);
  assert.equal(await foregroundRenderConcurrency(plan,parts,{resources:async()=>{throw Error('sample unavailable');}}),2);
});

test('four foreground workers reserve preview capacity and recording blocks additional workers',async()=>{
  let recording=false,capacity=4;const scheduler=new MediaScheduler({recording:()=>recording,foregroundLimit:()=>capacity});
  const hold=gate(),events=[];
  const work=name=>async()=>{events.push(name);await hold.promise;};
  const pending=Array.from({length:5},(_,i)=>scheduler.run('foreground',null,work(`render${i}`)));
  pending.push(scheduler.run('interactive',null,work('preview')));
  await tick();assert.equal(scheduler.active.size,5);assert.ok(events.includes('preview'));assert.equal(scheduler.queue.length,1);
  recording=true;hold.resolve();await Promise.all(pending);assert.equal(scheduler.active.size,0);
  const live=gate();const queued=[scheduler.run('foreground',null,()=>live.promise),scheduler.run('foreground',null,()=>live.promise),scheduler.run('interactive',null,()=>live.promise)];
  await tick();assert.equal(scheduler.active.size,2);assert.equal(scheduler.queue.length,1);live.resolve();await Promise.all(queued);
  scheduler.close();
});

test('a four-session failure drains siblings, keeps completed blocks and retries at two',async()=>{
  const scopes=[],media={store:{},idlePolicy:{resources},withForegroundBatch:async(capacity,work)=>{scopes.push(capacity);return work();}};
  const renderer=new RenderPipeline(media,()=>''),calls=new Map(),completed=gate();let active=0;
  renderer.inspect=async()=>({encodingSignature:'same'});
  renderer.renderVideo=async(_plan,_source,from,_to,_file,{signal})=>{
    calls.set(from,(calls.get(from)||0)+1);active++;
    try{
      if(scopes.length===1){
        if(from===0){completed.resolve();return;}
        if(from===60){await completed.promise;await tick();throw Error('GPU session limit');}
        await new Promise(resolve=>signal.aborted?resolve():signal.addEventListener('abort',resolve,{once:true}));
        throw Object.assign(Error('cancelled'),{name:'AbortError'});
      }
      assert.ok(active<=2,'the previous four-worker attempt must fully settle');await tick();
    }finally{active--;}
  };
  const result=await renderer.renderForegroundParts(plan,parts,'/unused');
  assert.deepEqual(scopes,[4,2]);assert.equal(calls.get(0),1);assert.equal(result.workers,2);assert.equal(result.parallelRetry,true);assert.equal(active,0);
  assert.equal(result.files.length,6);
});

test('foreground capacity is restored after cancellation or failure',async()=>{
  const fake={foregroundBatches:new Set(),scheduler:{drain(){}}};
  await assert.rejects(Media.prototype.withForegroundBatch.call(fake,4,async()=>{assert.equal([...fake.foregroundBatches][0].capacity,4);throw Error('cancelled');}),/cancelled/);
  assert.equal(fake.foregroundBatches.size,0);
});

test('a single available hardware session is retained after both parallel budgets fail',async()=>{
  const scopes=[],media={store:{},idlePolicy:{resources},withForegroundBatch:async(capacity,work)=>{scopes.push(capacity);return work();}};
  const renderer=new RenderPipeline(media,()=>''),rendered=[];
  renderer.inspect=async()=>({encodingSignature:'same'});
  renderer.renderVideo=async(_plan,_source,from)=>{if(scopes.at(-1)>1)throw Error('one hardware session available');rendered.push(from);};
  const result=await renderer.renderForegroundParts(plan,parts,'/unused');
  assert.deepEqual(scopes,[4,2,1]);assert.equal(result.workers,1);assert.equal(result.serialRetry,true);
  assert.deepEqual(rendered,parts.map(p=>p.from));
});

test('cancellation drains expanded workers without starting a lower-budget retry',async()=>{
  const scopes=[],media={store:{},idlePolicy:{resources},withForegroundBatch:async(capacity,work)=>{scopes.push(capacity);return work();}};
  const renderer=new RenderPipeline(media,()=>'' );let active=0;
  renderer.renderVideo=async()=>{active++;try{await tick();throw Object.assign(Error('cancelled'),{name:'AbortError'});}finally{active--;}};
  await assert.rejects(renderer.renderForegroundParts(plan,parts,'/unused'),{name:'AbortError'});
  assert.deepEqual(scopes,[4]);assert.equal(active,0);
});
