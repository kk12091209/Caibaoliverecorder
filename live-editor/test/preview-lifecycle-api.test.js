import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../server/index.js';
import {FLV_HEADER} from '../server/ingest.js';

const client='isolated-preview-window-01';
async function until(check){const deadline=Date.now()+3000;while(Date.now()<deadline){if(check())return;await delay(5);}assert.fail('preview lifecycle did not settle');}
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-preview-api-'));
  const app=await createApp({data:path.join(root,'data'),projectRoot:root,port:0,noRecorder:true,preparation:false,compact:false,automaticClean:false,ffmpeg:'must-not-launch',ffprobe:'must-not-launch'});
  app.ingestor.stop();const jobs=[];
  app.media.process=async(_args,{signal,output})=>{
    let release;const wait=new Promise(resolve=>{release=resolve;});jobs.push({signal,release});
    output.write('isolated preview');await wait;if(!output.destroyed)output.end();
  };
  const session=app.store.createSession({id:'material',title:'isolated material',status:'finished'});
  const file=path.join(root,'source.flv');await fs.writeFile(file,FLV_HEADER);
  const source=app.store.addSource(session.id,file,0,session.created,true);
  app.store.run('UPDATE sources SET duration=12600,closed=2 WHERE id=?',source.id);
  app.store.run('UPDATE sessions SET duration=12600 WHERE id=?',session.id);
  app.store.run('INSERT INTO keyframes VALUES(?,?,?,?)',source.id,0,0,0);
  const base=app.runtime.origin;
  t.after(async()=>{app.media.previewRequests.close();jobs.forEach(job=>job.release());await app.close();await fs.rm(root,{recursive:true,force:true});});
  return {app,jobs,base,url:sequence=>`${base}/api/sessions/material/preview?start=10534&client=${client}&sequence=${sequence}`,
    stop:(sequence,headers={})=>fetch(`${base}/api/previews/${client}/stop`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({sequence})})};
}

test('HTTP seek handoff waits for cleanup; deselection stops its page and stale GETs stay cancelled',async t=>{
  const f=await fixture(t),first=await fetch(f.url(1));assert.equal(first.status,200);
  const second=fetch(f.url(2));await until(()=>f.app.media.previewRequests.clients.get(client)?.pending?.sequence===2);
  assert.equal(f.jobs.length,1);assert.equal(f.jobs[0].signal.aborted,true);assert.equal(f.app.media.previews.size,1);
  f.jobs[0].release();const next=await second;assert.equal(next.status,200);assert.equal(f.jobs.length,2);assert.equal(f.app.media.previews.size,1);
  const stop=await f.stop(2);assert.equal(stop.status,200);assert.equal(f.jobs[1].signal.aborted,true);
  const stale=await fetch(f.url(2));assert.equal(stale.status,409);await stale.json();assert.equal(f.jobs.length,2);
  f.jobs[1].release();await first.body.cancel().catch(()=>{});await next.body.cancel().catch(()=>{});await until(()=>f.app.media.previews.size===0);
  const resumed=await fetch(f.url(3));assert.equal(resumed.status,200);f.jobs[2].release();await resumed.arrayBuffer();
});

test('disconnect releases HTTP requests; invalid or cross-origin stop requests never cancel the newer preview',async t=>{
  const f=await fixture(t),controller=new AbortController();const response=await fetch(f.url(4),{signal:controller.signal});assert.equal(response.status,200);
  assert.equal((await f.stop(3)).status,200);assert.equal(f.jobs[0].signal.aborted,false);
  assert.equal((await f.stop(4,{Origin:'https://example.invalid'})).status,403);assert.equal(f.jobs[0].signal.aborted,false);
  assert.equal((await f.stop(-1)).status,400);assert.equal(f.jobs[0].signal.aborted,false);
  controller.abort();await until(()=>f.jobs[0].signal.aborted);f.jobs[0].release();await until(()=>f.app.media.previews.size===0);
  const futureStop=await f.stop(10);assert.equal(futureStop.status,200);
  const old=await fetch(f.url(9));assert.equal(old.status,409);await old.json();assert.equal(f.jobs.length,1);
});
