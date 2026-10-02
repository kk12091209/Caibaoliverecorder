import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../server/index.js';
import {DeletionControl,DELETION_FAILED} from '../server/deletion-control.js';
import {deletionWork} from '../server/deletion-work.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function until(check){for(let n=0;n<200;n++){if(check())return;await delay(10);}assert.fail('deletion did not settle');}
async function application(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-delete-timeout-'));
  const app=await createApp({data:root,port:0,noRecorder:true,preparation:false,compact:false,deletionIdleMs:150,deletionRetryMs:20,ffmpeg:'not-launched',ffprobe:'not-launched'});
  app.ingestor.stop();
  t.after(async()=>{await app.close();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('caibo-delete-timeout-'));await fs.rm(root,{recursive:true,force:true});});
  return app;
}
async function material(app,{chunks=1}={}){
  const session=app.store.createSession({status:'finished',room:42}),original=path.join(app.root,'originals',session.id+'.flv');
  await fs.mkdir(path.dirname(original),{recursive:true});await fs.writeFile(original,'original');await fs.writeFile(original.replace('.flv','.xml'),'<i/>');
  const source=app.store.addSource(session.id,original,0,session.created,true);app.store.run('UPDATE sources SET closed=2 WHERE id=?',source.id);
  const folder=path.join(app.root,'chunks',source.id);await fs.mkdir(folder,{recursive:true});
  for(let n=0;n<chunks;n++)await fs.writeFile(path.join(folder,String(n).padStart(8,'0')+'.flvpart'),'chunk');
  return {session,original,source,folder};
}
const remove=(app,id,options={})=>fetch(app.runtime.origin+`/api/sessions/${id}/delete`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"confirmed":true}',...options});

test('无进展时退出等待，后续进展不能重新激活已停止的删除',async()=>{
  const control=new DeletionControl({idleMs:30});
  try{await assert.rejects(control.wait(delay(80)),{code:'DELETION_STOPPED',message:DELETION_FAILED});assert.throws(()=>control.progress(),{code:'DELETION_STOPPED'});await delay(80);}
  finally{control.close();}
});

test('正常清理持续有进展，总耗时超过空闲上限仍可完成',async()=>{
  const control=new DeletionControl({idleMs:150});
  try{for(let n=0;n<4;n++)await control.wait(delay(60));assert.equal(control.signal.aborted,false);}
  finally{control.close();}
});

test('取消后不再安排下一批，已开始的操作结束前不释放删除任务',async()=>{
  const control=new DeletionControl({idleMs:5000}),hold=deferred(),entered=deferred(),started=[];
  const task=deletionWork([0,1,2,3],async index=>{started.push(index);if(started.length===2)entered.resolve();await hold.promise;},2,{control});
  try{
    await entered.promise;control.stop();await assert.rejects(control.respond(task),{code:'DELETION_STOPPED'});
    let settled=false;const observed=task.catch(error=>{settled=true;return error;});await delay(20);assert.equal(settled,false);assert.deepEqual(started,[0,1]);
    hold.resolve();assert.equal((await observed).code,'DELETION_STOPPED');assert.deepEqual(started,[0,1]);
  }finally{hold.resolve();await task.catch(()=>{});control.close();}
});

test('确认后立即受理并阻止新读取，资源卡住时界面可继续操作，释放后自动恢复',async t=>{
  const app=await application(t),f=await material(app),other=await material(app),hold=deferred();
  const previous=app.waveform.cancelSession.bind(app.waveform);
  const seen=[];
  app.waveform.cancelSession=id=>{seen.push('waveform');return id===f.session.id?hold.promise:previous(id);};
  const cancel=app.media.cancelPreviews.bind(app.media);
  app.media.cancelPreviews=id=>{seen.push('preview');return cancel(id);};
  try{
    const response=await fetch(app.runtime.origin+`/api/sessions/${f.session.id}/delete`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmed:true,background:true})});
    assert.equal(response.status,202);assert.equal((await response.json()).accepted,true);
    assert.deepEqual(seen.slice(0,2),['waveform','preview']);
    assert.equal(app.store.session(f.session.id),undefined);
    assert.ok(app.store.pendingCleanup().find(row=>row.id===f.session.id));
    await assert.rejects(app.media.probeSource(f.source),/删除/);
    await assert.rejects(app.media.enqueue(f.session.id,{}),/删除/);
    await delay(180);assert.equal(app.snapshot().deletions.find(row=>row.id===f.session.id).phase,'waiting');
    assert.ok(await fs.stat(f.original));
    assert.equal((await remove(app,other.session.id)).status,200);
    hold.resolve();await until(()=>!app.store.get('SELECT id FROM sessions WHERE id=?',f.session.id));
    await assert.rejects(fs.stat(f.original),{code:'ENOENT'});
  }finally{hold.resolve();app.waveform.cancelSession=previous;}
});

test('断开或重复提交不取消已确认任务，不启动重叠删除',async t=>{
  const app=await application(t),f=await material(app),hold=deferred();
  const previous=app.waveform.cancelSession.bind(app.waveform);let calls=0;
  app.waveform.cancelSession=()=>{calls++;return hold.promise;};
  try{
    const task=app.deletingSessions.start(f.session.id);
    assert.equal(app.deletingSessions.start(f.session.id),task);
    assert.equal(calls,1);
    await delay(180);assert.equal(app.deletingSessions.has(f.session.id),true);
    assert.ok(await fs.stat(f.original));hold.resolve();
    await until(()=>!app.store.get('SELECT id FROM sessions WHERE id=?',f.session.id));
    assert.equal(app.store.pendingCleanup().length,0);
  }finally{hold.resolve();app.waveform.cancelSession=previous;}
});

test('文件操作超时仍持锁，旧 unlink 结束后自动重试，成片及其他素材不受影响',async t=>{
  const app=await application(t),f=await material(app,{chunks:20}),other=await material(app),hold=deferred(),unlink=fs.unlink;
  let started=0,active=0,peak=0;
  const exported=path.join(app.root,'exports','clean.mp4');await fs.mkdir(path.dirname(exported),{recursive:true});await fs.writeFile(exported,'completed export');
  app.store.run('INSERT INTO jobs(id,session,status,mode,file,data) VALUES(?,?,?,?,?,?)','saved',f.session.id,'done','clean',exported,'{}');
  fs.unlink=async file=>{if(path.dirname(String(file))===f.folder){started++;active++;peak=Math.max(peak,active);await hold.promise;try{return await unlink(file);}finally{active--;}}return unlink(file);};
  try{
    const response=await remove(app,f.session.id);assert.equal(response.status,408);
    assert.equal(started,8);assert.equal(app.store.deletions.has(f.session.id),true);
    assert.equal((await remove(app,f.session.id)).status,400);
    assert.equal((await remove(app,other.session.id)).status,200);
    assert.ok(await fs.stat(exported));hold.resolve();
    await until(()=>!app.store.get('SELECT id FROM sessions WHERE id=?',f.session.id));
    assert.equal(started,20);assert.equal(peak,8);assert.equal(active,0);
    await assert.rejects(fs.stat(f.folder),{code:'ENOENT'});assert.ok(await fs.stat(exported));
    assert.equal(app.store.get('SELECT session FROM jobs WHERE id=?','saved').session,null);
  }finally{hold.resolve();fs.unlink=unlink;await until(()=>app.snapshot().deletions.length===0);}
});

test('历史超时失败记录在同一进程自动维护重试，无需退出重开',async t=>{
  const app=await application(t),f=await material(app);
  app.store.confirmDeletion(f.session.id);
  app.store.run('UPDATE sessions SET purge_error=? WHERE id=?',DELETION_FAILED,f.session.id);
  app.deletionMaintenance.next=0;await app.deletionMaintenance.tick();
  assert.equal(app.store.get('SELECT id FROM sessions WHERE id=?',f.session.id),undefined);
  await assert.rejects(fs.stat(f.original),{code:'ENOENT'});
});
