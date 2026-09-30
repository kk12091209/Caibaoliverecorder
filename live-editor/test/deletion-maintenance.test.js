import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { RenderCache } from '../server/render-cache.js';
import { DeletionMaintenance } from '../server/deletion-maintenance.js';
import { minimalMp4 } from './helpers/mp4-fixture.js';

async function setup(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-delete-maintenance-'));
  const f={root,store:new Store(root),caches:[]};
  t.after(async()=>{
    for(const cache of f.caches)await cache.close();f.store.close();
    assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('bili-delete-maintenance-'));
    await fs.rm(root,{recursive:true,force:true});
  });
  return f;
}
async function write(file,data='fixture') { await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,data);return file; }
const missing=file=>assert.rejects(fs.stat(file),{code:'ENOENT'});
async function recording(f) {
  const s=f.store.createSession({status:'finished'}),file=await write(path.join(f.root,'originals','room',s.id+'.flv'));
  const source=f.store.addSource(s.id,file,0,s.created,true);
  f.store.run('UPDATE sources SET closed=2 WHERE id=?',source.id);
  const xml=await write(source.xml),log=await write(file.replace('.flv','.txt'));
  const chunk=await write(path.join(f.root,'chunks',source.id,'00000000.flvpart'));
  f.store.run('INSERT INTO chunks VALUES(?,?,?,?,?,?)',source.id,0,0,1,chunk,7);
  f.store.run("INSERT INTO source_storage(source,status) VALUES(?,'blocked')",source.id);
  return {s,source,file,xml,log,chunk};
}
function cache(f) { const c=new RenderCache(f.root,{statfs:async()=>({bavail:100*2**30,bsize:1})});f.caches.push(c);f.store.renderCache=c;return c; }

test('文件占用保留清理记录，重启空闲时重试；不处理未确认的删除',async t=>{
  const f=await setup(t),r=await recording(f),untouched=await recording(f);
  f.store.run("UPDATE sessions SET deleted_at='unconfirmed' WHERE id=?",untouched.s.id);
  const unlink=fs.unlink.bind(fs),mock=t.mock.method(fs,'unlink',async file=>{
    if(file===r.file)throw Object.assign(new Error('locked'),{code:'EBUSY'});return unlink(file);
  });
  await assert.rejects(f.store.deleteSession(r.s.id,true),/EBUSY/);mock.mock.restore();
  f.store.close();f.store=new Store(f.root);
  let busy=true,clock=1;
  const maintenance=new DeletionMaintenance(f.store,{busy:()=>busy,now:()=>clock});
  await maintenance.tick();await fs.stat(r.file);
  busy=false;await maintenance.tick();
  for(const file of [r.file,r.xml,r.log,path.dirname(r.chunk)])await missing(file);
  await fs.stat(untouched.file);assert.equal(f.store.pendingCleanup().length,0);
  assert.equal(f.store.wasSourceDeleted(r.file),true);
  await maintenance.close();clock+=60001;await maintenance.tick();await fs.stat(untouched.file);
});

test('缓存逐步删除在任一步元数据 unlink 失败后，冷启动仍可安全完成',async t=>{
  const f=await setup(t);
  for(const failedName of ['manifest.json','owner.json','.deleting.json']) {
    const r=await recording(f),c=cache(f);
    const lease=await c.build({version:1,sessionId:r.s.id,sourceId:r.source.id,startMs:0,endMs:1000,sourceFingerprint:'source',profileHash:'60fps',assHash:'chat'},file=>fs.writeFile(file,minimalMp4));lease.release();
    const output=await write(path.join(f.root,'exports',r.s.id+'.mp4'),minimalMp4);
    f.store.run('INSERT INTO jobs(id,session,status,mode,file,data) VALUES(?,?,?,?,?,?)',r.s.id,r.s.id,'done','danmaku',output,'{}');
    const unlink=fs.unlink.bind(fs),mock=t.mock.method(fs,'unlink',async file=>{
      if(path.dirname(file)===path.dirname(lease.file)&&path.basename(file)===failedName)throw Object.assign(new Error('locked'),{code:'EPERM'});return unlink(file);
    });
    const result=await f.store.deleteSession(r.s.id,true);mock.mock.restore();
    assert.equal(result.pending,true);assert.ok(f.store.pendingCleanup().some(item=>item.id===r.s.id));
    await c.close();f.store.close();f.store=new Store(f.root);cache(f);
    const maintenance=new DeletionMaintenance(f.store);await maintenance.tick();await maintenance.close();
    await missing(path.join(f.root,'render-cache','v1',r.s.id));
    assert.equal(f.store.get('SELECT id FROM sessions WHERE id=?',r.s.id),undefined);
    assert.deepEqual(await fs.readFile(output),minimalMp4);
  }
});

test('未知缓存文件保持可见且重试限频，移除未知项后才完成；正常缓存可复用检查不放宽',async t=>{
  const f=await setup(t),r=await recording(f),c=cache(f);
  const lease=await c.build({version:1,sessionId:r.s.id,sourceId:r.source.id,startMs:0,endMs:1000,sourceFingerprint:'s',profileHash:'p',assHash:'a'},file=>fs.writeFile(file,minimalMp4));lease.release();
  const unknown=await write(path.join(path.dirname(lease.file),'my-note.txt'));
  assert.equal((await f.store.deleteSession(r.s.id,true)).pending,true);
  let attempts=0,clock=0;
  const maintenance=new DeletionMaintenance(f.store,{now:()=>clock,remove:id=>{attempts++;return f.store.deleteSession(id,true);}});
  await maintenance.tick();await maintenance.tick();assert.equal(attempts,1);
  await fs.stat(unknown);await fs.stat(lease.file);assert.ok(f.store.pendingCleanup()[0].purge_error);
  await fs.unlink(unknown);clock+=60001;await maintenance.tick();assert.equal(attempts,2);
  await missing(lease.file);assert.equal(f.store.pendingCleanup().length,0);await maintenance.close();
});

test('已确认的清理重试移除数据库行，成片、配置、备份保持；活跃任务拒绝删除',async t=>{
  const f=await setup(t),r=await recording(f);
  const config=await write(path.join(f.root,'originals','config.json'),'settings');
  const backup=await write(path.join(f.root,'editor-backup.sqlite'),'backup');
  const output=await write(path.join(f.root,'exports','clean.mp4'),minimalMp4);
  f.store.run('INSERT INTO jobs(id,session,status,mode,file,data) VALUES(?,?,?,?,?,?)','clean',r.s.id,'running','clean',output,'{}');
  await assert.rejects(f.store.deleteSession(r.s.id,true),/导出/);await fs.stat(r.file);
  f.store.run("UPDATE jobs SET status='done'");
  f.store.run("UPDATE sessions SET deleted_at='confirmed',purge_started_at='confirmed' WHERE id=?",r.s.id);
  const maintenance=new DeletionMaintenance(f.store);await maintenance.tick();await maintenance.close();
  assert.equal(f.store.all('SELECT * FROM sources').length,0);
  for(const file of [r.file,r.log,r.chunk])await missing(file);
  assert.equal(await fs.readFile(config,'utf8'),'settings');assert.equal(await fs.readFile(backup,'utf8'),'backup');await fs.stat(output);
  assert.equal(f.store.get("SELECT session FROM jobs WHERE id='clean'").session,null);
});

test('重复录制/删除后空库回收数据库页和 WAL，保留设置、删除凭据与成片任务',async t=>{
  const f=await setup(t);f.store.setting('test-preference','keep');
  const sizes=[];
  for(let cycle=0;cycle<3;cycle++) {
    const r=await recording(f);
    f.store.transaction(()=>{
      for(let i=0;i<1800;i++)f.store.run('INSERT INTO danmaku VALUES(?,?,?,?,?,?,?,?)',r.s.id+i,r.s.id,r.source.id,i,'viewer','x'.repeat(2048),'d','white');
    });
    const maintenance=new DeletionMaintenance(f.store);
    maintenance.reclaimEmptyDatabase();assert.ok(f.store.session(r.s.id),'nonempty library must not be removed');
    await f.store.deleteSession(r.s.id,true);await maintenance.tick();await maintenance.close();
    sizes.push((await fs.stat(path.join(f.root,'editor.sqlite'))).size);
    assert.equal((await fs.stat(path.join(f.root,'editor.sqlite-wal'))).size,0);
    assert.equal(f.store.setting('test-preference'),'keep');assert.equal(f.store.wasSourceDeleted(r.file),true);
    for(const table of ['sessions','sources','chunks','danmaku','source_storage'])assert.equal(f.store.get(`SELECT count(*) AS n FROM ${table}`).n,0);
  }
  assert.ok(Math.max(...sizes)<512*1024,JSON.stringify(sizes));
  assert.ok(Math.max(...sizes)-Math.min(...sizes)<32768,JSON.stringify(sizes));
});
