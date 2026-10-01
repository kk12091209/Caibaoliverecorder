import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.js';
import {Ingestor} from '../server/ingest.js';
import {DensityService} from '../server/density.js';
import {setImmediate as yieldTurn} from 'node:timers/promises';

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-chat-density-'));
  const store=new Store(root);
  store.createSession({id:'one',status:'finished'});
  await fs.mkdir(path.join(root,'originals'),{recursive:true});
  const original=path.join(root,'originals','sample.flv'); await fs.writeFile(original,'test original');
  const source=store.addSource('one',original,12.5,new Date().toISOString(),2);
  const ingestor=new Ingestor(store);
  t.after(async()=>{store.close();assert.ok(path.basename(root).startsWith('bili-chat-density-'));await fs.rm(root,{recursive:true,force:true});});
  return{root,store,source,ingestor,read:()=>ingestor.readDanmaku(store.get('SELECT * FROM sources WHERE id=?',source.id))};
}

test('XML indexes sampling counters once, keeps old chat shapes and resumes after restart',async t=>{
  const f=await fixture(t);
  await fs.writeFile(f.source.xml,'<i><density ts="0" count="10000" kept="50"/><d p="0.2,1,25,16777215,0,0,0,0">哈哈哈</d>');
  await f.read(); await f.read();
  assert.equal(f.store.get('SELECT count(*) n FROM danmaku_density').n,1);
  assert.deepEqual({...f.store.get('SELECT time,extra FROM danmaku_density')},{time:12.5,extra:9950});
  assert.equal(f.store.get('SELECT count(*) n FROM danmaku').n,1);
  await fs.appendFile(f.source.xml,'<density ts="1" count="100" kept="50"/><d p="1.2,1,25,16777215,0,0,0,0">哈哈哈</d></i>');
  await new Ingestor(f.store).readDanmaku(f.store.get('SELECT * FROM sources WHERE id=?',f.source.id));
  assert.equal(f.store.get('SELECT sum(extra) n FROM danmaku_density').n,10000);
  assert.equal(f.store.get('SELECT count(*) n FROM danmaku').n,2);
});

test('partial and invalid density events cannot corrupt counters or stop ordinary chat ingestion',async t=>{
  const f=await fixture(t);
  await fs.writeFile(f.source.xml,'<i><density ts="0" count="1000"');await f.read();
  assert.equal(f.store.get('SELECT count(*) n FROM danmaku_density').n,0);
  await fs.appendFile(f.source.xml,' kept="50"/>');await f.read();
  for(const attrs of ['ts="-1" count="3" kept="1"','ts="1" count="NaN" kept="1"','ts="2" count="1000000001" kept="1"','ts="3" count="3" kept="4"','ts="4" count="3" kept="-1"'])await fs.appendFile(f.source.xml,`<density ${attrs}/>`);
  await fs.appendFile(f.source.xml,'<d p="2,1,25,16777215,0,0,0,0">正常聊天</d></i>');await f.read();
  assert.equal(f.store.get('SELECT count(*) n FROM danmaku_density').n,1);
  assert.equal(f.store.get('SELECT text FROM danmaku').text,'正常聊天');
});

test('deleting material cleans density metadata while retaining exported video and job',async t=>{
  const f=await fixture(t);
  f.store.run('INSERT INTO danmaku_density VALUES(?,?,?,?)','one',f.source.id,12.5,1000);
  const output=path.join(f.root,'exported.mp4');await fs.writeFile(output,'finished output');
  f.store.run("INSERT INTO jobs(id,session,status,data,file,mode) VALUES('export','one','done',?,?,?)",JSON.stringify({scope:'full',output:{danmaku:output}}),output,'danmaku');
  const density=new DensityService(f.store);t.after(()=>density.close());f.store.density=density;
  assert.equal(density.request('one',{to:20}).status,'building');
  await f.store.deleteSession('one',true);
  await yieldTurn();
  assert.equal(f.store.get('SELECT count(*) n FROM danmaku_density').n,0);
  assert.equal(f.store.get('SELECT count(*) n FROM sources').n,0);
  assert.equal(f.store.get("SELECT session FROM jobs WHERE id='export'").session,null);
  assert.ok((await fs.stat(output)).isFile());
  await assert.rejects(fs.stat(f.source.path),error=>error.code==='ENOENT');
  assert.equal(density.cache.has('one'),false);
});
