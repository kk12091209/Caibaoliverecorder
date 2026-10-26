import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.js';
import {RecordingClock, timestamp} from '../server/flv-clock.js';
import {FLV_HEADER, Ingestor, sourceStream, tags} from '../server/ingest.js';
import {CompactStorage} from '../server/compact-storage.js';
import {Recorder} from '../server/recorder.js';
import {flvTag} from './helpers/source-stream-fixture.js';

const collect=async stream=>{const parts=[];for await(const p of stream)parts.push(p);return Buffer.concat(parts);};
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'flv-clock-')),store=new Store(root);
  t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
  await fs.mkdir(path.join(root,'originals'));
  const created='2026-10-26T12:00:00.000Z',session=store.createSession({created,status:'finished'});
  async function source(name,{negative=true,leading=false,start=0,wall=created,live=false}={}) {
    const file=path.join(root,'originals',name+'.flv');
    const packets=[flvTag(9,0,24,{header:true}),flvTag(8,0,8,{header:true}),
      ...(leading?[flvTag(8,-20,20)]:[]),flvTag(9,0,60,{key:true}),flvTag(8,0,20),
      flvTag(9,1000,60,{key:true}),flvTag(8,1000,20),flvTag(9,2000,60,{key:true}),flvTag(8,2000,20),
      ...(negative?[flvTag(8,-20,20)]:[])];
    await fs.writeFile(file,Buffer.concat([FLV_HEADER,...packets]));
    const s=store.addSource(session.id,file,start,wall,!live),ingest=new Ingestor(store);await ingest.tick();
    return {source:store.get('SELECT * FROM sources WHERE id=?',s.id),file,ingest,packets};
  }
  return {root,store,session,source};
}

test('small negative timestamps are distinguished from genuine unsigned long-recording timestamps',()=>{
  const normal=new RecordingClock();assert.equal(normal.read(flvTag(8,-20,20)),null);
  assert.equal(normal.read(flvTag(9,29601,20)),29601);
  assert.equal(normal.read(flvTag(8,-20,20)),null);assert.equal(normal.latest,29601);
  for(const milliseconds of [-40,-1001,-60000,-2147483648])assert.equal(normal.read(flvTag(8,milliseconds,20)),null);
  const boundary=new RecordingClock(2**31-2000);assert.equal(boundary.read(flvTag(9,2**31+20,20)),2**31+20);
  const long=new RecordingClock(2**32-1500);assert.equal(long.read(flvTag(9,2**32-20,20)),2**32-20);
});

test('new ingestion preserves original media bytes but excludes negative preroll/tails from time and playback',async t=>{
  const f=await fixture(t),a=await f.source('negative',{leading:true});
  assert.equal(a.source.duration,2);assert.equal(f.store.session(f.session.id).duration,2);
  assert.equal(f.store.all('SELECT * FROM chunks WHERE end>100').length,0);
  const raw=await fs.readFile(a.file),stored=[];
  for(const c of f.store.all('SELECT * FROM chunks WHERE source=? ORDER BY seq',a.source.id))stored.push(await fs.readFile(c.path));
  assert.deepEqual(Buffer.concat(stored),Buffer.concat(a.packets.filter(p=>p[12]!==0)));
  const stream=await collect(sourceStream(f.store,a.source.id,0,2.1));
  assert.ok(tags(stream.subarray(13)).items.every(({tag})=>timestamp(tag)<=2100));
  assert.equal(tags(stream.subarray(13)).items.filter(({tag})=>tag[12]!==0).length,6);
  assert.deepEqual(await fs.readFile(a.file),raw);
});

test('live ingestion and a fresh ingestor retain a bounded duration after a negative packet',async t=>{
  const f=await fixture(t),a=await f.source('live',{live:true});
  await fs.appendFile(a.file,Buffer.concat([flvTag(9,3000,60,{key:true}),flvTag(8,3000,20)]));
  await a.ingest.tick();assert.equal(f.store.get('SELECT duration FROM sources WHERE id=?',a.source.id).duration,2);
  f.store.run('UPDATE sources SET closed=1 WHERE id=?',a.source.id);await a.ingest.tick();
  assert.equal(f.store.get('SELECT duration FROM sources WHERE id=?',a.source.id).duration,3);
  await new Ingestor(f.store).tick();assert.equal(f.store.session(f.session.id).duration,3);
});

test('a reconnect after a negative tail starts at its real wall-clock gap rather than 1193 hours',async t=>{
  const f=await fixture(t);await f.source('first');
  f.store.run("UPDATE sessions SET status='recording',room=42 WHERE id=?",f.session.id);
  const recorder=new Recorder(f.store);
  try {
    await recorder.event({EventId:'new-connection',EventType:'FileOpening',EventTimestamp:'2026-10-26T12:00:05Z',EventData:{RoomId:42,RelativePath:'next.flv',FileOpenTime:'2026-10-26T12:00:05Z'}});
    assert.equal(f.store.get('SELECT start FROM sources WHERE path=?',path.join(f.root,'originals','next.flv')).start,5);
  } finally {recorder.close();}
});

test('new negative-tail recordings compact without changing original bytes or playback output',async t=>{
  const f=await fixture(t),a=await f.source('direct');
  const before=await fs.readFile(a.file),streamBefore=await collect(sourceStream(f.store,a.source.id,0,2.1));
  f.store.run('INSERT INTO source_storage(source,eligible) VALUES(?,1)',a.source.id);
  const storage=new CompactStorage(f.store,{isBusy:()=>false});
  try {
    await storage.verifyAndCommit(a.source);await storage.cleanup(a.source);
    assert.equal(f.store.get('SELECT mode FROM source_storage WHERE source=?',a.source.id).mode,'direct');
    assert.deepEqual(await collect(sourceStream(f.store,a.source.id,0,2.1)),streamBefore);
    assert.deepEqual(await fs.readFile(a.file),before);
    assert.equal(f.store.session(f.session.id).duration,2);
  } finally {await storage.close();}
});

test('closed historical indexes are not migrated or rewritten',async t=>{
  const f=await fixture(t),a=await f.source('old'),bad=(2**32-20)/1000;
  f.store.run('UPDATE sources SET duration=? WHERE id=?',bad,a.source.id);
  f.store.run('UPDATE sessions SET duration=? WHERE id=?',bad,f.session.id);
  const before=f.store.all('SELECT * FROM chunks WHERE source=?',a.source.id);
  await new Ingestor(f.store).tick();
  assert.equal(f.store.session(f.session.id).duration,bad);
  assert.deepEqual(f.store.all('SELECT * FROM chunks WHERE source=?',a.source.id),before);
  assert.equal(await fs.stat(path.join(f.root,'recovery')).then(()=>true,()=>false),false);
});
