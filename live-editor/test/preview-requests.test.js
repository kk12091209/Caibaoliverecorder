import test from 'node:test';
import assert from 'node:assert/strict';
import {PreviewRequests,validatePreviewRequest} from '../server/preview-requests.js';
import {Media} from '../server/media.js';
const client='window-preview-0001',other='window-preview-0002';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const cancelled=result=>assert.equal(result.reason?.code,'PREVIEW_CANCELLED');

test('rapid seeks wait for the old producer and execute only the last destination',async()=>{
  const requests=new PreviewRequests(),release=deferred(),entered=[];let oldSignal;
  const first=requests.run(client,1,'a',undefined,signal=>{oldSignal=signal;entered.push(1);return release.promise;});
  const second=requests.run(client,2,'a',undefined,()=>entered.push(2));
  const third=requests.run(client,3,'b',undefined,()=>entered.push(3));
  const last=requests.run(client,4,'b',undefined,()=>entered.push(4));
  const stale=Promise.allSettled([second,third]);
  await flush();assert.equal(oldSignal.aborted,true);assert.deepEqual(entered,[1]);
  (await stale).forEach(cancelled);release.resolve();await Promise.all([first,last]);
  assert.deepEqual(entered,[1,4]);assert.equal(requests.clients.get(client).active,null);assert.equal(requests.clients.get(client).pending,null);
});

test('stop-before-GET and reordered old requests cannot resurrect a cancelled preview',async()=>{
  const requests=new PreviewRequests();let starts=0;
  requests.stop(client,5);
  await assert.rejects(requests.run(client,5,'a',undefined,()=>starts++),{code:'PREVIEW_CANCELLED'});
  await requests.run(client,7,'a',undefined,()=>starts++);
  await assert.rejects(requests.run(client,6,'a',undefined,()=>starts++),{code:'PREVIEW_CANCELLED'});
  assert.equal(starts,1);
});

test('late stop affects only its own sequence and window; repeated native URL probes are serialized',async()=>{
  const requests=new PreviewRequests(),a=deferred(),b=deferred();let aSignal,bSignal;
  const pa=requests.run(client,9,'a',undefined,signal=>{aSignal=signal;return a.promise;});
  const pb=requests.run(other,1,'a',undefined,signal=>{bSignal=signal;return b.promise;});
  requests.stop(client,8);assert.equal(aSignal.aborted,false);assert.equal(bSignal.aborted,false);
  let replacement=false;const again=requests.run(client,9,'a',undefined,()=>{replacement=true;});
  assert.equal(aSignal.aborted,true);assert.equal(replacement,false);assert.equal(bSignal.aborted,false);
  a.resolve();await Promise.all([pa,again]);assert.equal(replacement,true);b.resolve();await pb;
});

test('disconnect cancels a queued destination immediately, while cleanup still protects the producer',async()=>{
  const requests=new PreviewRequests(),release=deferred(),controller=new AbortController();
  const first=requests.run(client,1,'a',undefined,()=>release.promise);
  const next=requests.run(client,2,'a',controller.signal,()=>assert.fail('disconnected preview must not start'));
  controller.abort();await assert.rejects(next,{code:'PREVIEW_CANCELLED'});
  assert.ok(requests.clients.get(client).active);release.resolve();await first;
});

test('cleanup timeout reports a release failure and never starts a second producer over a stuck one',async()=>{
  const requests=new PreviewRequests({releaseTimeoutMs:10}),release=deferred();
  const first=requests.run(client,1,'a',undefined,()=>release.promise);
  await assert.rejects(requests.run(client,2,'a',undefined,()=>assert.fail('must not overlap')),{code:'PREVIEW_RELEASE_TIMEOUT'});
  assert.ok(requests.clients.get(client).active);release.resolve();await first;
  await requests.run(client,3,'a',undefined,()=>{});
});

test('deleting a material cancels its pending requests, preserving a newer request for another material',async()=>{
  const requests=new PreviewRequests(),release=deferred();let ran=false;
  const first=requests.run(client,1,'old',undefined,()=>release.promise);
  const second=requests.run(client,2,'new',undefined,()=>{ran=true;});
  const cleanup=requests.cancelSession('old');assert.equal(ran,false);release.resolve();await Promise.all([first,second,cleanup]);assert.equal(ran,true);
  const held=deferred();const active=requests.run(client,3,'old',undefined,()=>held.promise);
  const queued=requests.run(client,4,'old',undefined,()=>assert.fail('deleted material must not start'));
  const stopped=Promise.allSettled([queued]);const deletion=requests.cancelSession('old');
  (await stopped).forEach(cancelled);held.resolve();await Promise.all([active,deletion]);
  await assert.rejects(requests.run(client,4,'old',undefined,()=>{}),{code:'PREVIEW_CANCELLED'});
});

test('shutdown aborts queued work; client metadata is validated and idle history is bounded',async()=>{
  let now=0;const requests=new PreviewRequests({maxClients:1,retentionMs:10,now:()=>now}),release=deferred();
  for(const pair of [['bad',1],[client,NaN],[client,0],[client,1.5],[client,Number.MAX_SAFE_INTEGER+1]])assert.throws(()=>validatePreviewRequest(...pair));
  const active=requests.run(client,1,'a',undefined,()=>release.promise);
  assert.throws(()=>requests.run(other,1,'b',undefined,()=>{}),/请求过多/);
  const queued=requests.run(client,2,'a',undefined,()=>assert.fail('closed'));
  requests.close();await assert.rejects(queued,{code:'PREVIEW_CANCELLED'});release.resolve();await active;
  await assert.rejects(requests.run(client,3,'a',undefined,()=>{}),{code:'PREVIEW_CANCELLED'});
  const idle=new PreviewRequests({maxClients:1,retentionMs:10,now:()=>now});await idle.run(client,1,'a',undefined,()=>{});now=11;
  await idle.run(other,1,'a',undefined,()=>{});assert.equal(idle.clients.size,1);assert.ok(idle.clients.has(other));
});

test('real Media preview accounting never reaches the limit for a single page, even after many rapid seeks',async()=>{
  for(const duration of [12,12600]){
    const source={id:'source',session:'material',start:0,duration};const jobs=[];
    const media=Object.assign(Object.create(Media.prototype),{closed:false,blockedSessions:new Map(),previews:new Map(),previewRequests:new PreviewRequests(),store:{session:()=>({id:source.session,duration}),sources:()=>[source],get:()=>({time:0})},process(_args,{signal}){const work=deferred();jobs.push({...work,signal});return work.promise;}});
    const calls=[];calls.push(media.preview(source.session,0,{writeHead(){}},undefined,{client,sequence:1}));
    for(let sequence=2;sequence<=30;sequence++)calls.push(media.preview(source.session,Math.min(sequence/10,duration-.1),{writeHead(){}},undefined,{client,sequence}));
    const settled=Promise.allSettled(calls);await flush();assert.equal(jobs.length,1);assert.equal(media.previews.size,1);
    jobs[0].resolve();await flush();assert.equal(jobs.length,2);assert.equal(media.previews.size,1);
    jobs[1].resolve();const result=await settled;assert.equal(result.filter(x=>x.status==='fulfilled').length,2);assert.equal(media.previews.size,0);
    assert.ok(result.every(x=>x.status==='fulfilled'||x.reason.code==='PREVIEW_CANCELLED'));
  }
});

test('real windows retain the global limit, while a reloaded page waits for disconnected producers to finish',async()=>{
  const jobs=[],source={id:'source',session:'material',start:0,duration:120};
  const media=Object.assign(Object.create(Media.prototype),{closed:false,blockedSessions:new Map(),previews:new Map(),previewRequests:new PreviewRequests(),store:{session:()=>({id:source.session}),sources:()=>[source],get:()=>({time:0})},process(_args,{signal}){const work=deferred();jobs.push({...work,signal});return work.promise;}});
  const signals=Array.from({length:3},()=>new AbortController());
  const active=signals.map((controller,i)=>media.preview(source.session,0,{writeHead(){}},controller.signal,{client:client+i,sequence:1}));
  assert.equal(media.previews.size,3);
  await assert.rejects(media.preview(source.session,1,{writeHead(){}},undefined,{client:other,sequence:1}),/同时预览/);
  signals[0].abort();
  const reloaded=media.preview(source.session,1,{writeHead(){}},undefined,{client:other,sequence:2});
  await flush();assert.equal(jobs.length,3);jobs[0].resolve();await flush();
  assert.equal(jobs.length,4);assert.equal(media.previews.size,3);
  jobs.forEach(job=>job.resolve());await Promise.all([...active,reloaded]);assert.equal(media.previews.size,0);
});
