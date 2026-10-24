import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../server/store.js';
import {Media} from '../server/media.js';
import {saveRetryFixture,collideSave} from './helpers/save-retry-fixture.js';
import {minimalMp4} from './helpers/mp4-fixture.js';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-fault-recovery-')),store=new Store(path.join(root,'data'));
  const f=await saveRetryFixture(store);
  t.after(async()=>{f.media.close();await f.media.waitForSaves();store.close();await fs.rm(root,{recursive:true,force:true});});
  return {...f,root,row:()=>store.get('SELECT * FROM jobs WHERE id=?',f.job.id),data:()=>JSON.parse(store.get('SELECT data FROM jobs WHERE id=?',f.job.id).data)};
}
test('missing publication manifest after full-disk failure is rebuilt from retained intent without encoding again',async t=>{
  const f=await fixture(t),write=f.media.publication.write.bind(f.media.publication);
  const fault=t.mock.method(f.media.publication,'write',async()=>{throw Object.assign(Error('temp disk full'),{code:'ENOSPC'});});
  await f.run();assert.equal(f.row().status,'save_failed');const job=f.data(),directory=job.pendingPublication.directory,count=f.calls.length;
  assert.equal(job.canRetrySave,true);for(const name of ['final.mp4','final-danmaku.mp4'])assert.deepEqual(await fs.readFile(path.join(directory,name)),minimalMp4);
  await assert.rejects(fs.access(path.join(directory,'.bili-export-publication.json')),{code:'ENOENT'});
  fault.mock.restore();f.media.publication.write=write;
  await f.media.retrySave(f.job.id);await f.media.waitForSaves();assert.equal(f.row().status,'done');assert.equal(f.calls.length,count);
  assert.deepEqual(await fs.readFile(f.data().output.file),minimalMp4);
});
test('torn staging record can recover, but a replaced finished video is never accepted',async t=>{
  const f=await fixture(t),write=f.media.publication.write.bind(f.media.publication);
  const fault=t.mock.method(f.media.publication,'write',async()=>{throw Object.assign(Error('write failed'),{code:'ENOSPC'});});
  await f.run();fault.mock.restore();f.media.publication.write=write;
  const job=f.data(),directory=job.pendingPublication.directory,file=path.join(directory,'final.mp4');
  await fs.writeFile(path.join(directory,'.bili-export-publication.json'),'{torn');
  await f.media.publication.recoverStage(job);await fs.writeFile(file,Buffer.concat([minimalMp4,Buffer.from('replacement')]));
  await f.media.retrySave(f.job.id);await f.media.waitForSaves();assert.match(f.row().error,/更改|变化/);await fs.access(file);assert.equal(f.row().status,'save_failed');
});
test('missing publication record after destination work began is preserved for inspection, without claiming user files',async t=>{
  const f=await fixture(t),occupied=await collideSave(f),job=f.data(),directory=job.pendingPublication.directory,count=f.calls.length;
  await fs.unlink(path.join(directory,'.bili-export-publication.json'));
  await assert.rejects(f.media.retrySave(f.job.id),{code:'RECOVERY_REVIEW'});
  assert.equal(await fs.readFile(occupied,'utf8'),'用户已有的视频，不能覆盖');assert.equal(f.calls.length,count);
  for(const name of ['final.mp4','final-danmaku.mp4'])await fs.access(path.join(directory,name));
});
test('a temporary renderer IO failure retries a fresh render and completes with the same output settings',async t=>{
  const f=await fixture(t),process=f.media.process.bind(f.media);let failures=0;
  f.media.process=(args,options)=>{if(args.includes('-filter_complex')&&!failures++){throw Object.assign(Error('busy input'),{code:'EBUSY'});}return process(args,options);};
  await f.run();assert.equal(f.row().status,'done');assert.equal(f.data().automaticRetries,1);assert.equal(f.data().encoderFallback,undefined);
});
test('an exhausted transient unit stays recoverable and manual retry keeps its original selection',async t=>{
  const f=await fixture(t),process=f.media.process.bind(f.media);let count=0;
  f.media.process=()=>{count++;throw Object.assign(Error('input is busy'),{code:'EBUSY'});};
  await f.run();assert.equal(f.row().status,'failed');assert.equal(count,3);assert.ok(f.data().processingRecovery);
  const before=f.data();f.media.process=process;
  await f.media.retryExport(f.job.id);assert.equal(f.row().status,'queued');await f.run();
  assert.equal(f.row().status,'done');assert.deepEqual(f.data().ranges,before.ranges);assert.equal(f.data().mode,before.mode);
});
test('permanent storage failure does not retry encoders and explicit task deletion releases processing files',async t=>{
  const f=await fixture(t);let count=0;
  f.media.process=()=>{count++;throw Object.assign(Error('full disk'),{code:'ENOSPC'});};
  await f.run();assert.equal(count,1);assert.equal(f.row().status,'failed');const job=f.data(),directory=job.processingRecovery.directory;
  await f.media.checkpoints.discard(job);await assert.rejects(fs.access(directory),{code:'ENOENT'});await fs.access(f.original);
});
for(const code of ['ENOSPC','EBUSY'])test(`${code} from an exhausted original-copy stage never triggers an expensive full encode fallback`,async t=>{
  const f=await fixture(t);let calls=0;
  f.media.encodeJob=async()=>{calls++;throw Object.assign(Error('original copy failed'),{code,originalCopyFailure:true});};
  await f.run();assert.equal(f.row().status,'failed');assert.equal(calls,1);assert.equal(f.data().encoderFallback,undefined);
  const cached=await fixture(t);cached.media.renderCache.hasReady=async()=>true;
  cached.media.renderer.exportJob=async()=>{throw Object.assign(Error('chunk IO failed'),{code});};
  cached.media.encodeJob=()=>assert.fail('chunk IO errors must not restart the whole video');
  await cached.run();assert.equal(cached.row().status,'failed');assert.equal(cached.data().preparationFallback,undefined);
});
