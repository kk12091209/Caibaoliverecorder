import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../server/store.js';
import { Media } from '../server/media.js';
import { prepareDeletion } from '../server/deletion.js';
import { stopChild } from '../server/child-stop.js';

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-delete-recovery-')),store=new Store(root);
  t.after(async()=>{store.close();assert.ok(path.basename(root).startsWith('caibo-delete-recovery-'));await fs.rm(root,{recursive:true,force:true});});
  const session=store.createSession({status:'finished'}),file=path.join(root,'originals','test.flv');
  await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'source');
  const source=store.addSource(session.id,file,0,session.created,true);store.run('UPDATE sources SET closed=2 WHERE id=?',source.id);
  return {root,store,session,source};
}

test('10800 条已不存在的分片只核对一次目录，目录存在或已移除都不逐条查盘',async t=>{
  const f=await fixture(t),folder=path.join(f.root,'chunks',f.source.id);
  f.store.transaction(()=>{for(let n=0;n<10800;n++)f.store.run('INSERT INTO chunks VALUES(?,?,?,?,?,?)',f.source.id,n,n,n+1,path.join(folder,String(n).padStart(8,'0')+'.flvpart'),1);});
  const lstat=fs.lstat;let checks=0;
  const mock=t.mock.method(fs,'lstat',(...args)=>{checks++;return lstat(...args);});
  for(const exists of [false,true]) {
    if(exists)await fs.mkdir(folder,{recursive:true});
    checks=0;const plan=await prepareDeletion(f.store,f.session.id);
    assert.ok(checks<100,`unexpected path checks: ${checks}`);
    assert.equal(plan.files.length,1);assert.equal(plan.files[0].file,f.source.path);
    t.diagnostic(`${exists?'existing':'absent'} directory, 10800 obsolete entries: ${checks} lstat calls`);
  }
  mock.mock.restore();
});

test('缺失分片目录的优化仍拒绝越界索引，保留目录外文件',async t=>{
  const f=await fixture(t),other=path.join(f.root,'originals','keep.flv');await fs.writeFile(other,'keep');
  f.store.run('INSERT INTO chunks VALUES(?,?,?,?,?,?)',f.source.id,0,0,1,other,4);
  await assert.rejects(prepareDeletion(f.store,f.session.id),/超出/);
  assert.equal(await fs.readFile(other,'utf8'),'keep');
});

test('取消某素材时立即中止其视频信息读取，不等待工具自身超时',async t=>{
  const f=await fixture(t),media=new Media(f.store);
  let signal,started;const ready=new Promise(resolve=>started=resolve);
  media.probeSourceInternal=async(source,time,options)=>{signal=options.signal;started();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));};
  const task=media.probeSource(f.source);await ready;
  await media.cancelPreviews(f.session.id);await task;
  assert.equal(signal.aborted,true);assert.equal(media.probes.size,0);media.allowSession(f.session.id);media.close();
});

test('取消后拒绝正常退出的自有子进程会被回收，其他子进程保持运行',async t=>{
  const code="process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)";
  const child=spawn(process.execPath,['-e',code],{stdio:['ignore','pipe','pipe']}),other=spawn(process.execPath,['-e',code],{stdio:['ignore','pipe','pipe']});
  t.after(()=>{child.kill('SIGKILL');other.kill('SIGKILL');});
  await Promise.all([once(child.stdout,'data'),once(other.stdout,'data')]);
  const ended=once(child,'close');stopChild(child,30);
  await Promise.race([ended,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('cancelled child leaked')),2000);timer.unref();})]);
  assert.notEqual(child.exitCode===null&&child.signalCode===null,true);
  assert.equal(other.exitCode,null);assert.equal(other.signalCode,null);
});
