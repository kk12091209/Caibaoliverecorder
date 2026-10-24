import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaScheduler } from '../server/media-scheduler.js';
import { RenderPipeline, visibleComments } from '../server/render-plan.js';
import { Media } from '../server/media.js';
import { spawn } from 'node:child_process';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function gate(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}

test('media watchdog honors real stderr progress, kills frozen counters and releases resources',async()=>{
  const media=new Media({root:'/private/tmp/caibao-watchdog-test'});
  media.spawnTracked=(_exe,args,options)=>spawn(process.execPath,['-e',args.includes('frozen')
    ? 'setInterval(()=>process.stderr.write("frame=1\\n"),20)'
    : 'let n=0;const t=setInterval(()=>process.stderr.write("frame="+(++n)+"\\n"),20);setTimeout(()=>{clearInterval(t)},1200)'],options);
  try {
    // Full-suite process startup can exceed 100 ms under FFmpeg/Swift load.
    // Run for more than two idle windows, so success still proves progress
    // refreshes the deadline rather than merely finishing before it expires.
    await media.process(['-progress','pipe:2'],{idleMs:500});
    await assert.rejects(media.process(['-progress','pipe:2','frozen'],{idleMs:100}),{code:'MEDIA_STALLED'});
    assert.equal(media.children.size,0);assert.equal(media.scheduler.active.size,0);
  } finally {media.close();}
});

test('media scheduling reserves interactive capacity, bounds render processes and cancels waiting work',async()=>{
  const scheduler=new MediaScheduler(),block=gate(),order=[];let running=0,peak=0;
  const work=name=>async()=>{order.push(name);peak=Math.max(peak,++running);await block.promise;running--;};
  const a=scheduler.run('foreground',null,work('a')),b=scheduler.run('foreground',null,work('b'));
  const cancel=new AbortController(),removed=scheduler.run('foreground',cancel.signal,()=>assert.fail('cancelled worker ran'));
  const rejected=assert.rejects(removed,{name:'AbortError'});cancel.abort();
  const c=scheduler.run('foreground',null,work('c')),preview=scheduler.run('interactive',null,work('preview'));
  await tick();assert.deepEqual(order,['a','b','preview']);assert.equal(peak,3);
  block.resolve();await Promise.all([a,b,c,preview,rejected]);await tick();assert.equal(scheduler.active.size,0);assert.equal(scheduler.queue.length,0);scheduler.close();
});

test('shutdown prevents a reserved process from starting and rejects later media requests',async()=>{
  const scheduler=new MediaScheduler(),task=scheduler.run('foreground',null,()=>assert.fail('started after shutdown'));
  scheduler.close();await assert.rejects(task,{name:'AbortError'});assert.equal(scheduler.active.size,0);
  const media=new Media({root:'/private/tmp/caibao-closed-scheduler-test'});media.close();
  await assert.rejects(media.probe('/private/tmp/unused-media'),/已关闭/);assert.equal(media.scheduler,undefined);
});

test('recording reduces foreground load and queued background work wakes safely after recording ends',async()=>{
  let recording=true;const scheduler=new MediaScheduler({recording:()=>recording}),block=gate(),order=[];
  const first=scheduler.run('foreground',null,async()=>{order.push('first');await block.promise;});
  const next=scheduler.run('foreground',null,()=>order.push('next'));
  const background=scheduler.run('background',null,()=>order.push('background'));
  const preview=scheduler.run('interactive',null,()=>order.push('preview'));
  await tick();assert.deepEqual(order,['first','preview']);block.resolve();await Promise.all([first,next,preview]);await tick();assert.equal(order.includes('background'),false);
  recording=false;scheduler.drain();await background;scheduler.close();
});

test('indexed comment windows exactly match full filtering including long tails, ties, exclusions and shuffled inputs',()=>{
  const layout=Array.from({length:180000},(_,i)=>({id:String(i),time:i/50,end:i/50+(i%997===0?80:6),lottery:i%13===0}));
  const snapshot={excluded:new Set(['1','50','60001']),filterLottery:true};
  for(const events of [layout,[...layout.slice(0,100)].reverse()])for(const [from,to] of [[0,1],[1,6],[1190,1200],[3590,3600],[4000,4010]]) {
    const expected=events.filter(m=>m.time<to&&m.end>from&&!snapshot.excluded.has(m.id)&&!m.lottery);
    assert.deepEqual(visibleComments(events,snapshot,from,to),expected);
  }
});

test('preparation cursor avoids rebuilding all block specs but rechecks pins and source changes',async()=>{
  const source={id:'source',start:0,duration:600},layout=[],blocks=Array.from({length:10},(_,i)=>({source,startMs:i*60000,endMs:(i+1)*60000}));
  const cache={revision:0,ready:new Set(),acquire:async spec=>cache.ready.has(spec)?{bytes:10,release(){}}:null};
  const renderer=new RenderPipeline({store:{edit:()=>({})},renderCache:cache},()=>{});let specs=0,identity='original';
  renderer.describe=async()=>({sources:[source],blocks,layout,snapshot:{excluded:new Set()},profileHash:'profile'});
  renderer.sourceFingerprint=async()=>identity;
  renderer.spec=async(_plan,block)=>{specs++;return block.startMs;};
  renderer.acquire=async(_plan,block)=>{cache.ready.add(block.startMs);cache.revision++;return {bytes:10,release(){}};};
  for(let i=0;i<10;i++)assert.equal((await renderer.prepareNext('session')).done,i===9);
  assert.equal(specs,20); // ten initial checks, then one new spec per completed block
  identity='replaced';await renderer.prepareNext('session');assert.equal(specs,30);
  cache.ready.delete(0);await renderer.prepareNext('session');assert.equal(cache.ready.has(0),true);
  renderer.invalidate('session');assert.equal(renderer.preparationPlans.size,0);
});

test('serial recovery keeps completed compatible blocks and still rejects mixed encoder signatures',async()=>{
  const renderer=new RenderPipeline({store:{},closed:false,assertExportActive(){}},()=>{}),calls=new Map(),first=gate();
  renderer.renderVideo=async(_plan,_source,from,_to,file)=>{
    calls.set(from,(calls.get(from)||0)+1);
    if(from===0){first.resolve();return;}
    if(from===60&&calls.get(from)===1){await first.promise;await tick();throw Error('encoder busy');}
  };
  renderer.inspect=async()=>({encodingSignature:'same'});
  const plan={profile:{encoder:{hardware:true},fps:60}},parts=[0,60,120].map(from=>({from,to:from+60,source:{id:'s'}}));
  const result=await renderer.renderForegroundParts(plan,parts,'/private/tmp/checkpoint-fixture');
  assert.equal(result.serialRetry,true);assert.equal(calls.get(0),1);assert.equal(calls.get(60),2);assert.equal(result.files.length,3);
  renderer.inspect=async file=>({encodingSignature:file.includes('part-1')?'different':'same'});
  await assert.rejects(renderer.renderForegroundParts(plan,parts,'/private/tmp/checkpoint-fixture'),{code:'PREP_INCOMPATIBLE'});
});
