import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.js';
import {Ingestor,FLV_HEADER} from '../server/ingest.js';
import {flvTag} from './helpers/source-stream-fixture.js';

async function fixture(t,options={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ingest-budget-')),store=new Store(root);
  let now=1000;
  const ingest=new Ingestor(store,{now:()=>now,...options});
  t.after(async()=>{ingest.stop();store.close();await fs.rm(root,{recursive:true,force:true});});
  async function add(name,packets) {
    const session=store.createSession({status:'recording'}),file=path.join(root,name+'.flv');
    await fs.writeFile(file,Buffer.concat([FLV_HEADER,...packets]));
    return store.addSource(session.id,file,0,new Date().toISOString(),false);
  }
  const source=id=>store.get('SELECT * FROM sources WHERE id=?',id);
  return {root,store,ingest,add,source,advance(ms){now+=ms;}};
}
test('frozen timestamps hit a per-source budget, release memory and preserve original media',async t=>{
  const f=await fixture(t,{maxBufferedBytes:256});
  const broken=await f.add('stalled',Array.from({length:8},()=>flvTag(9,0,80,{key:true})));
  const healthy=await f.add('healthy',[flvTag(9,0,60,{key:true}),flvTag(9,1000,60,{key:true})]);
  const before=await fs.readFile(broken.path);
  await f.ingest.tick();
  assert.match(f.source(broken.id).error,/缓存/);
  assert.equal(f.ingest.states.has(broken.id),false);
  assert.equal(f.source(healthy.id).error,'');
  assert.ok(f.store.all('SELECT * FROM chunks WHERE source=?',healthy.id).length);
  assert.deepEqual(await fs.readFile(broken.path),before);
});
test('multiple rooms share the total pending budget and deleting a source releases it',async t=>{
  const f=await fixture(t,{maxBufferedBytes:512,maxTotalBufferedBytes:256});
  const a=await f.add('a',[flvTag(9,0,160,{key:true})]),b=await f.add('b',[flvTag(9,0,160,{key:true})]);
  await f.ingest.tick();
  assert.equal(f.ingest.states.size,1);
  const failed=[a,b].find(s=>f.source(s.id).error);
  assert.match(f.source(failed.id).error,/总缓存/);
  const retained=[a,b].find(s=>s.id!==failed.id);
  f.store.run("UPDATE sessions SET deleted_at='test' WHERE id=?",retained.session);
  await f.ingest.tick();assert.equal(f.ingest.states.size,0);
  f.store.run("UPDATE sources SET error='' WHERE id=?",failed.id);
  await f.ingest.tick();assert.equal(f.ingest.states.has(failed.id),true);
});
test('continued packets without forward media time expire but a normal reconnect can progress',async t=>{
  const f=await fixture(t,{stalledMediaMs:1000});
  const frozen=await f.add('frozen',[flvTag(9,100,60,{key:true})]),normal=await f.add('normal',[flvTag(9,100,60,{key:true})]);
  await f.ingest.tick();f.advance(1200);
  await fs.appendFile(frozen.path,flvTag(9,90,60,{key:true}));
  await fs.appendFile(normal.path,flvTag(9,1300,60,{key:true}));
  await f.ingest.tick();assert.match(f.source(frozen.id).error,/时间戳/);assert.equal(f.source(normal.id).error,'');
  assert.equal(f.ingest.states.has(frozen.id),false);
});
test('many tiny tags cannot exhaust object overhead and a closed tail frees its state',async t=>{
  const f=await fixture(t,{maxBufferedTags:3});
  const source=await f.add('tiny',Array.from({length:4},()=>flvTag(8,0,4)));
  await f.ingest.tick();assert.match(f.source(source.id).error,/数据包/);
  const good=await f.add('tail',[flvTag(9,0,50,{key:true})]);
  await fs.appendFile(good.path,Buffer.from([9,0]));
  f.store.run('UPDATE sources SET closed=1 WHERE id=?',good.id);
  await f.ingest.tick();assert.equal(f.ingest.states.has(good.id),false);
});
