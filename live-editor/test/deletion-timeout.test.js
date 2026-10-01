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
  const app=await createApp({data:root,port:0,noRecorder:true,preparation:false,compact:false,deletionIdleMs:150,ffmpeg:'not-launched',ffprobe:'not-launched'});
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

test('等待资源卡住返回删除失败，释放操作锁后能重试且原片未提前删除',async t=>{
  const app=await application(t),f=await material(app),hold=deferred(),previous=app.waveform.cancelSession.bind(app.waveform);
  app.waveform.cancelSession=()=>hold.promise;
  try{
    const response=await remove(app,f.session.id);assert.equal(response.status,408);assert.equal((await response.json()).error,DELETION_FAILED);
    await until(()=>app.snapshot().deletions.length===0);assert.ok(app.store.session(f.session.id));assert.equal(app.store.deletions?.size||0,0);
    assert.equal((await fs.stat(f.original)).size,8);assert.equal(app.activity().busy,false);
    app.waveform.cancelSession=previous;assert.equal((await remove(app,f.session.id)).status,200);
  }finally{app.waveform.cancelSession=previous;hold.resolve();}
});

test('客户端断开也停止等待，旧请求恢复后不会继续删除原片',async t=>{
  const app=await application(t),f=await material(app),hold=deferred(),entered=deferred(),previous=app.waveform.cancelSession.bind(app.waveform);
  app.waveform.cancelSession=()=>{entered.resolve();return hold.promise;};
  const controller=new AbortController();
  try{
    const request=remove(app,f.session.id,{signal:controller.signal});const observed=request.catch(error=>error);await entered.promise;controller.abort();assert.equal((await observed).name,'AbortError');
    await until(()=>app.snapshot().deletions.length===0);hold.resolve();await delay(20);assert.ok(await fs.stat(f.original));
    app.waveform.cancelSession=previous;assert.equal((await remove(app,f.session.id)).status,200);
  }finally{controller.abort();hold.resolve();app.waveform.cancelSession=previous;}
});

test('文件操作卡住停止后续批次，保留清单和成片，结束后手动重试清理剩余文件',async t=>{
  const app=await application(t),f=await material(app,{chunks:20}),other=await material(app),hold=deferred(),unlink=fs.unlink;
  let started=0;
  const exported=path.join(app.root,'exports','clean.mp4');await fs.mkdir(path.dirname(exported),{recursive:true});await fs.writeFile(exported,'completed export');
  app.store.run('INSERT INTO jobs(id,session,status,mode,file,data) VALUES(?,?,?,?,?,?)','saved',f.session.id,'done','clean',exported,'{}');
  fs.unlink=async file=>{if(path.dirname(String(file))===f.folder){started++;await hold.promise;}return unlink(file);};
  try{
    const response=await remove(app,f.session.id);assert.equal(response.status,408);assert.equal((await response.json()).error,DELETION_FAILED);
    assert.equal(started,8);assert.equal(app.store.deletions.has(f.session.id),true);assert.ok(app.store.pendingCleanup().find(row=>row.id===f.session.id));
    assert.equal((await remove(app,f.session.id)).status,400);assert.equal((await remove(app,other.session.id)).status,200);
    assert.ok(await fs.stat(exported));hold.resolve();await until(()=>!app.store.deletions.has(f.session.id));
    assert.equal(started,8);assert.equal(app.store.pendingCleanup().find(row=>row.id===f.session.id).purge_error,DELETION_FAILED);
    app.deletionMaintenance.next=0;await app.deletionMaintenance.tick();assert.ok(app.store.pendingCleanup().find(row=>row.id===f.session.id));
    fs.unlink=unlink;assert.equal((await remove(app,f.session.id)).status,200);assert.equal(app.store.get('SELECT id FROM sessions WHERE id=?',f.session.id),undefined);
    await assert.rejects(fs.stat(f.folder),{code:'ENOENT'});assert.ok(await fs.stat(exported));assert.equal(app.store.get('SELECT session FROM jobs WHERE id=?','saved').session,null);
  }finally{hold.resolve();fs.unlink=unlink;await until(()=>app.snapshot().deletions.length===0);}
});
