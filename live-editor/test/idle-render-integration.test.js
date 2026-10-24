import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Media } from '../server/media.js';
import { Store } from '../server/store.js';
import { BackgroundPreparation } from '../server/background-preparation.js';
import { minimalMp4 } from './helpers/mp4-fixture.js';

const GiB=1024**3,estimate=60*2*1024**2;
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){
  const end=Date.now()+3000;
  while(!check()){if(Date.now()>end)throw Error('integration condition was not reached');await new Promise(resolve=>setTimeout(resolve,2));}
}

// Keep Media's actual scheduler, process settlement and cache publication. The
// child is deliberately controllable, so no real encoder or heavy media runs.
function controlledChild(){
  const child=new EventEmitter();
  child.pid=Number.NaN;child.exitCode=null;child.signalCode=null;child.killed=false;child.didClose=false;
  child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.stdio=[child.stdin,child.stdout,child.stderr,new PassThrough()];child.stdin.resume();
  child.kill=()=>{child.killed=true;return true;};
  child.finish=(code=0)=>{
    if(child.didClose)return;
    child.didClose=true;child.exitCode=code;child.stdin.destroy();
    child.stdout.end();child.stderr.end();child.stdio[3].end();child.emit('close',code);
  };
  return child;
}

async function fixture(t,{maxBytes=GiB,seed=false}={}){
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'bili-idle-integration-'));
  const store=new Store(path.join(root,'data')),session=store.createSession({id:'session',status:'finished'});
  const original=store.addSource(session.id,path.join(root,'source.flv'),0,session.created,true);
  store.run('UPDATE sources SET duration=240,closed=2 WHERE id=?',original.id);
  store.run('UPDATE sessions SET duration=240 WHERE id=?',session.id);
  const source=store.sources(session.id)[0],state={recording:false},children=[],calls=[];
  const media=new Media(store,{idleRenderOptions:{mode:'parallel',resources:async()=>({cores:10,total:16*GiB,available:8*GiB})},
    renderCacheOptions:{minFreeBytes:0,maxBytes,statfs:async()=>({bavail:100n*BigInt(GiB),bsize:1n})}});
  media.isRecording=()=>state.recording;
  media.spawnTracked=(_tool,args)=>{const child=controlledChild();child.from=Number(args[args.indexOf('-test-block')+1]);children.push(child);return child;};
  const blocks=[0,60000,120000,180000].map(startMs=>({source,startMs,endMs:startMs+60000})),layout=[];
  const plan={id:session.id,sources:[source],blocks,layout,snapshot:{excluded:new Set()},profileHash:'profile',profile:{width:1920,height:1080,fps:60}};
  media.renderer.describe=async()=>plan;media.renderer.sourceFingerprint=async()=> 'unchanged-source';
  media.renderer.renderVideo=async(_plan,_source,from,_to,file,options)=>{
    calls.push(from);await media.process(['-test-block',String(from)],{signal:options.signal,background:true,stage:'render'});
    await fs.writeFile(file,minimalMp4);
  };
  await fs.mkdir(media.renderCache.root,{recursive:true});
  if(seed){const lease=await media.renderCache.build(await media.renderer.spec(plan,blocks[0]),file=>fs.writeFile(file,minimalMp4),{estimatedBytes:minimalMp4.length});lease.release();}
  const preparation=new BackgroundPreparation(store,media,{idleGraceMs:0,busyReason:()=>state.recording?'recording':''});
  t.after(async()=>{
    media.close();const settled=preparation.close();
    for(const child of children)child.finish(1);
    await settled;await Promise.allSettled([...media.preparationCalls.values()]);
    store.close();assert.ok(path.basename(root).startsWith('bili-idle-integration-'));await fs.rm(root,{recursive:true,force:true});
  });
  return {root,store,session,source,state,children,calls,media,preparation,plan};
}

test('same-session prepare calls share the real two-worker scheduler and cache publication',async t=>{
  const f=await fixture(t),first=f.media.prepareNext(f.session.id),second=f.media.prepareNext(f.session.id);
  assert.equal(first,second);await until(()=>f.children.length===2);
  assert.equal(f.media.scheduler.active.size,2);assert.equal(f.media.renderCache.reserved,2*estimate);
  f.children[0].finish();await until(()=>f.media.renderCache.entries.size===1);
  assert.equal([...f.media.renderCache.entries.values()][0].leases,1,'a completed sibling remains pinned while the other is running');
  f.children[1].finish();const result=await first;
  assert.equal(result.preparedSeconds,120);assert.deepEqual([...f.calls].sort((a,b)=>a-b),[0,60]);
  assert.equal(f.media.preparationCalls.size,0);assert.equal(f.media.scheduler.active.size,0);
  assert.equal(f.media.renderCache.reserved,0);assert.ok([...f.media.renderCache.entries.values()].every(entry=>entry.leases===0));
});

test('real cache keeps the successful sibling when a parallel child fails and serial recovery runs',async t=>{
  const f=await fixture(t),pending=f.media.prepareNext(f.session.id);await until(()=>f.children.length===2);
  f.children.find(child=>child.from===0).finish();await until(()=>f.media.renderCache.entries.size===1);
  f.children.find(child=>child.from===60).finish(1);await until(()=>f.children.length===3);
  assert.equal(f.media.scheduler.active.size,1);assert.equal([...f.media.renderCache.entries.values()][0].leases,1);
  f.children[2].finish();const result=await pending;
  assert.equal(result.preparedSeconds,120);assert.deepEqual([...f.calls].sort((a,b)=>a-b),[0,60,60]);
  assert.equal(f.media.renderCache.entries.size,2);assert.equal(f.media.renderCache.reserved,0);
  assert.ok([...f.media.renderCache.entries.values()].every(entry=>entry.leases===0));
});

for(const mode of ['recording','shutdown'])test(`${mode} cancels both scheduled background children and waits for their close before unpinning`,async t=>{
  const f=await fixture(t,{seed:true});f.preparation.enqueue(f.session.id);
  const work=f.preparation.tick();await until(()=>f.children.length===2);
  const ready=[...f.media.renderCache.entries.values()][0];assert.equal(ready.leases,1);
  let settled=false,stop;
  if(mode==='recording'){f.state.recording=true;stop=f.preparation.tick();}
  else{f.media.close();stop=f.preparation.close();}
  const stopping=Promise.resolve(stop).then(()=>{settled=true;});
  await until(()=>f.children.every(child=>child.killed));
  assert.equal(settled,false);assert.equal(ready.leases,1);assert.equal(f.media.children.size,2);
  f.children[0].finish(1);await turn();await turn();
  assert.equal(settled,false);assert.equal(ready.leases,1,'the plan pin outlives the first child closing');
  f.children[1].finish(1);await Promise.all([work,stopping]);
  assert.equal(f.media.children.size,0);assert.equal(f.media.scheduler.active.size,0);assert.equal(f.media.backgroundBatches.size,0);
  assert.equal(f.media.renderCache.reserved,0);assert.equal(f.media.renderCache.building.size,0);assert.equal(ready.leases,0);
  assert.equal(f.media.renderCache.entries.size,1,'cancelled partial blocks are never cache hits');
  if(mode==='recording'){
    const count=f.children.length;await f.preparation.tick();assert.equal(f.children.length,count);
    assert.equal(f.preparation.status(f.session.id).reason,'recording');
  }
});

test('real cache budget caps a batch at one worker without discarding completed blocks',async t=>{
  const f=await fixture(t,{maxBytes:estimate+minimalMp4.length,seed:true}),pending=f.media.prepareNext(f.session.id);
  await until(()=>f.children.length===1);await turn();await turn();assert.equal(f.children.length,1);
  f.children[0].finish();const result=await pending;
  assert.equal(result.performance.policy.reason,'cache-budget');assert.equal(result.performance.policy.concurrency,1);
  assert.equal(result.preparedSeconds,120);assert.equal(f.media.renderCache.entries.size,2);assert.equal(f.media.renderCache.reserved,0);
});

test('capacity lost after the parallel decision cancels the running sibling without retrying or leaking reservations',async t=>{
  const f=await fixture(t,{seed:true}),choose=f.media.idlePolicy.choose.bind(f.media.idlePolicy);
  f.media.idlePolicy.choose=async(...args)=>{const decision=await choose(...args);assert.equal(decision.concurrency,2);f.media.renderCache.maxBytes=estimate+minimalMp4.length;return decision;};
  const outcome=f.media.prepareNext(f.session.id).then(()=>assert.fail('capacity failure was hidden'),error=>error);
  // The second reservation can fail before the first decoder starts. Both
  // schedules are valid; neither may publish a partial cache block or retry.
  await until(()=>f.children.some(child=>child.killed)||f.media.preparationCalls.size===0);
  for(const child of f.children)child.finish(1);
  const error=await outcome;assert.equal(error.code,'PREP_SPACE');assert.equal(error.capacity,true);
  assert.ok(f.children.length<=1);assert.equal(f.media.renderCache.reserved,0);assert.equal(f.media.renderCache.building.size,0);
  assert.equal(f.media.renderCache.entries.size,1);assert.ok([...f.media.renderCache.entries.values()].every(entry=>entry.leases===0));
});
