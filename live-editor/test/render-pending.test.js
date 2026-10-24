import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {RenderCache} from '../server/render-cache.js';
import {minimalMp4} from './helpers/mp4-fixture.js';

const spec={sessionId:'session',sourceId:'source',startMs:0,endMs:60000,sourceFingerprint:'source',profileHash:'profile',assHash:'ass',version:1};
const waiting=error=>error.code==='PREP_PENDING';
const missing=file=>assert.rejects(fs.access(file),error=>error.code==='ENOENT');
async function fixture(t,options={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-pending-'));
  const cache=new RenderCache(root,{minFreeBytes:0,statfs:async()=>({bavail:1024**3,bsize:1}),...options});
  let renders=0;
  const render=async file=>{renders++;await fs.writeFile(file,minimalMp4);};
  t.after(async()=>{await cache.close();await fs.rm(root,{recursive:true,force:true});});
  return {root,cache,get renders(){return renders;},build:(key=spec,verifySource=()=>({pending:true}),extra={})=>cache.build(key,render,{estimatedBytes:minimalMp4.length,verifySource,...extra})};
}

test('pending is never a cache hit; later verification publishes the same pixels without rendering again',async t=>{
  const f=await fixture(t);await assert.rejects(f.build(),waiting);
  const pending=[...f.cache.pending.values()][0];
  assert.equal(f.cache.building.size,0);assert.equal(f.cache.busySession(spec.sessionId),false);
  assert.equal(await f.cache.acquire(spec),null);assert.equal(await f.cache.hasReady(spec.sessionId),false);
  assert.equal(f.cache.reserved,minimalMp4.length);await fs.access(pending.file);
  const lease=await f.build(spec,()=>true);assert.equal(f.renders,1);assert.deepEqual(await fs.readFile(lease.file),minimalMp4);lease.release();
  assert.equal(f.cache.pending.size,0);assert.equal(f.cache.reserved,0);await missing(pending.file);
});

test('pending retries have an absolute deadline; expiry causes fresh work, not indefinite extension',async t=>{
  let now=100;const f=await fixture(t,{now:()=>now,pendingTtlMs:10000});
  await assert.rejects(f.build(),waiting);const first=[...f.cache.pending.values()][0];
  now=1000;await assert.rejects(f.build(),waiting);assert.equal(f.renders,1);assert.equal([...f.cache.pending.values()][0].expires,first.expires);
  now=20000;const lease=await f.build(spec,()=>true);lease.release();assert.equal(f.renders,2);await missing(first.file);assert.equal(f.cache.reserved,0);
});

test('actual input change rejects a pending result, and a changed key removes its stale range',async t=>{
  const f=await fixture(t);await assert.rejects(f.build(),waiting);
  const first=[...f.cache.pending.values()][0];await assert.rejects(f.build(spec,()=>false),error=>error.code==='PREP_STALE');
  assert.equal(f.renders,1);assert.equal(f.cache.reserved,0);await missing(first.file);
  await assert.rejects(f.build(),waiting);const next=[...f.cache.pending.values()][0];
  const lease=await f.build({...spec,assHash:'changed'},()=>true);lease.release();assert.equal(f.renders,3);await missing(next.file);assert.equal(await f.cache.acquire(spec),null);
});

test('pending file tampering is not reused or deleted as if it were the original',async t=>{
  const f=await fixture(t);await assert.rejects(f.build(),waiting);const entry=[...f.cache.pending.values()][0];
  await fs.writeFile(entry.file,Buffer.from('foreign file'));
  const lease=await f.build(spec,()=>true);lease.release();assert.equal(f.renders,2);
  assert.equal(await fs.readFile(entry.file,'utf8'),'foreign file');assert.equal(f.cache.reserved,0);
});

test('pending storage is globally bounded even when several different keys finish together',async t=>{
  const f=await fixture(t,{maxPendingBytes:minimalMp4.length*2});
  const results=await Promise.allSettled(Array.from({length:5},(_,i)=>f.build({...spec,startMs:i*60000,endMs:(i+1)*60000})));
  for(const r of results)assert.ok(r.status==='rejected'&&waiting(r.reason));
  assert.equal(f.cache.pending.size,2);assert.equal(f.cache.reserved,minimalMp4.length*2);
  await f.cache.cancelSession(spec.sessionId);assert.equal(f.cache.pending.size,0);assert.equal(f.cache.reserved,0);
});

test('oversize pending results are discarded and do not reserve disk indefinitely',async t=>{
  const f=await fixture(t,{maxPendingBytes:1});await assert.rejects(f.build(),error=>error.code==='PREP_STALE');
  assert.equal(f.cache.pending.size,0);assert.equal(f.cache.reserved,0);
});

test('pending timer and close both release owned files and reservations',async t=>{
  const f=await fixture(t,{pendingTtlMs:150});await assert.rejects(f.build(),waiting);const entry=[...f.cache.pending.values()][0];
  for(let i=0;i<50&&f.cache.reserved;i++)await delay(20);
  assert.equal(f.cache.pending.size,0);assert.equal(f.cache.reserved,0);await missing(entry.file);
  await assert.rejects(f.build(),waiting);const next=[...f.cache.pending.values()][0];await f.cache.close();assert.equal(f.cache.reserved,0);await missing(next.file);
});

test('cancellation during resumed verification waits for settlement and clears pending storage',async t=>{
  const f=await fixture(t);await assert.rejects(f.build(),waiting);
  let resume,entered;const enteredPromise=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>resume=resolve);
  const controller=new AbortController();
  const task=f.build(spec,async()=>{entered();await held;return {pending:true};},{signal:controller.signal});
  await enteredPromise;controller.abort();resume();await assert.rejects(task,error=>error.code==='PREP_CANCELLED');
  assert.equal(f.cache.pending.size,0);assert.equal(f.cache.reserved,0);assert.equal(f.renders,1);
});

test('another cache instance cannot delete a live process pending result',async t=>{
  const f=await fixture(t);await assert.rejects(f.build(),waiting);const entry=[...f.cache.pending.values()][0];
  const other=new RenderCache(f.root);assert.equal(await other.acquire(spec),null);await fs.access(entry.file);await other.close();
  const lease=await f.build(spec,()=>true);lease.release();assert.equal(f.renders,1);
});

test('restart discards only an owned dead-process pending generation and never promotes it',async t=>{
  const f=await fixture(t);
  const code=`import fs from 'node:fs/promises';import {RenderCache} from ${JSON.stringify(new URL('../server/render-cache.js',import.meta.url).href)};import {minimalMp4} from ${JSON.stringify(new URL('./helpers/mp4-fixture.js',import.meta.url).href)};
    const cache=new RenderCache(process.argv[1],{minFreeBytes:0});try{await cache.build(${JSON.stringify(spec)},file=>fs.writeFile(file,minimalMp4),{verifySource:()=>({pending:true})});}catch(e){if(e.code!=='PREP_PENDING')throw e;}`;
  await promisify(execFile)(process.execPath,['--input-type=module','-e',code,f.root]);
  const sessionRoot=path.join(f.cache.root,spec.sessionId),key=f.cache.getKey(spec),generations=await fs.readdir(path.join(sessionRoot,key));
  const directory=path.join(sessionRoot,key,generations[0]);await fs.access(path.join(directory,'pending.json'));
  assert.equal(await f.cache.acquire(spec),null);await missing(directory);
  const lease=await f.build(spec,()=>true);lease.release();assert.equal(f.renders,1);
});
