import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../server/store.js';
import {Media} from '../server/media.js';
import {minimalMp4} from './helpers/mp4-fixture.js';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-checkpoints-')),store=new Store(path.join(root,'data')),media=new Media(store),session=store.createSession({status:'finished'});
  const job={id:crypto.randomUUID(),session:session.id,mode:'dual',scope:'full',ranges:[{start:0,end:10}]};
  store.run('INSERT INTO jobs(id,session,status,data) VALUES(?,?,?,?)',job.id,session.id,'running',JSON.stringify(job));
  t.after(async()=>{media.close();store.close();await fs.rm(root,{recursive:true,force:true});});return {root,store,media,job};
}
test('a completed step survives workspace finish and is reused by a new checkpoint reader',async t=>{
  const f=await fixture(t),first=await f.media.checkpoints.open(f.job,'same');let calls=0;
  await first.run('video',async()=>{calls++;await fs.writeFile(path.join(first.directory,'part-0.mp4'),minimalMp4);return 'part-0.mp4';},['part-0.mp4']);await first.finish();
  const second=await f.media.checkpoints.open(f.job,'same');
  assert.equal(await second.run('video',()=>assert.fail('must reuse complete output'),['part-0.mp4']),'part-0.mp4');assert.equal(calls,1);assert.equal(second.resumed,1);
  await f.media.checkpoints.discard(f.job);await assert.rejects(fs.access(first.directory),{code:'ENOENT'});
});
test('changed output redoes only its own step; a signature change cannot reuse old media',async t=>{
  const f=await fixture(t),first=await f.media.checkpoints.open(f.job,'same');
  for(const i of [0,1])await first.run('part'+i,()=>fs.writeFile(path.join(first.directory,`part-${i}.mp4`),minimalMp4),[`part-${i}.mp4`]);
  await fs.writeFile(path.join(first.directory,'part-0.mp4'),'incomplete');let repaired=0;
  const second=await f.media.checkpoints.open(f.job,'same');
  await second.run('part0',async()=>{repaired++;await fs.writeFile(path.join(first.directory,'part-0.mp4'),minimalMp4);},['part-0.mp4']);
  await second.run('part1',()=>assert.fail('valid sibling must survive'),['part-1.mp4']);assert.equal(repaired,1);
  const changed=await f.media.checkpoints.open(f.job,'changed-source-or-style');assert.notEqual(changed.directory,first.directory);assert.equal(changed.resumed,0);
});
test('checkpoint write fails after encoding: retain video, preserve last record, recover safely',async t=>{
  const f=await fixture(t),cp=await f.media.checkpoints.open(f.job,'same'),rename=fs.rename;
  const mock=t.mock.method(fs,'rename',async(from,to)=>{if(to.endsWith('.bili-export-checkpoint.json'))throw Object.assign(Error('disk full'),{code:'ENOSPC'});return rename(from,to);});
  await assert.rejects(cp.run('video',()=>fs.writeFile(path.join(cp.directory,'part-0.mp4'),minimalMp4),['part-0.mp4']),{code:'ENOSPC'});await cp.finish();
  assert.deepEqual(await fs.readFile(path.join(cp.directory,'part-0.mp4')),minimalMp4);mock.mock.restore();
  const recovered=await f.media.checkpoints.open(f.job,'same');let calls=0;
  await recovered.run('video',async()=>{calls++;await fs.writeFile(path.join(cp.directory,'part-0.mp4'),minimalMp4);},['part-0.mp4']);assert.equal(calls,1);
});
test('a different live owner is never adopted and its files remain intact',async t=>{
  const f=await fixture(t),cp=await f.media.checkpoints.open(f.job,'same');
  f.media.temporaryWorkspaces.active.clear();
  await assert.rejects(f.media.checkpoints.open(f.job,'same'),/其他进程|无法确认/);await fs.access(cp.directory);
});
test('a torn current checkpoint falls back to its previous valid record and redoes only newer work',async t=>{
  const f=await fixture(t),cp=await f.media.checkpoints.open(f.job,'same');
  for(const i of [0,1])await cp.run('video'+i,()=>fs.writeFile(path.join(cp.directory,`part-${i}.mp4`),minimalMp4),[`part-${i}.mp4`]);
  await fs.writeFile(path.join(cp.directory,'.bili-export-checkpoint.json'),'{torn');
  const recovered=await f.media.checkpoints.open(f.job,'same');
  await recovered.run('video0',()=>assert.fail('the previous complete block must survive'),['part-0.mp4']);
  let rebuilt=0;await recovered.run('video1',async()=>{rebuilt++;await fs.writeFile(path.join(cp.directory,'part-1.mp4'),minimalMp4);},['part-1.mp4']);assert.equal(rebuilt,1);
});
