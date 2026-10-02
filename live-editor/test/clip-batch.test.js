import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.js';
import {Media} from '../server/media.js';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-clip-batch-'));
  const store=new Store(path.join(root,'data'));store.projectRoot=root;
  const session=store.createSession({title:'独立选段',status:'finished'});
  store.run('UPDATE sessions SET duration=60 WHERE id=?',session.id);
  const media=new Media(store);media.work=async()=>{};
  t.after(async()=>{media.close();store.close();await fs.rm(root,{recursive:true,force:true});});
  return {store,media,id:session.id,root};
}
test('three selected ranges create three independent, ordered jobs with one edit snapshot',async t=>{
  const {store,media,id}=await fixture(t);
  const ranges=[{start:20,end:23},{start:0,end:4},{start:5,end:8,selected:false},{start:10,end:12}];
  const edit=store.saveEdit(id,{revision:0,ranges,excluded:['message-id'],undo:[]});
  const {jobs}=await media.enqueue(id,{mode:'dual'});
  assert.equal(jobs.length,3);assert.equal(new Set(jobs.map(j=>j.output.file)).size,3);
  assert.deepEqual(jobs.map(j=>j.ranges),[[{start:20,end:23}],[{start:0,end:4}],[{start:10,end:12}]]);
  assert.deepEqual(jobs.map(j=>j.clipIndex),[1,2,3]);assert.ok(jobs.every(j=>j.mode==='dual'&&j.clipCount===3&&j.revision===edit.revision));
  store.saveEdit(id,{...edit,ranges:[],excluded:[]});
  assert.ok(jobs.every(j=>j.excluded[0]==='message-id'));
  const seen=[];let active=0,peak=0;
  media.performExportJob=async job=>{active++;peak=Math.max(peak,active);seen.push(job.id);await new Promise(r=>setTimeout(r,5));active--;store.run("UPDATE jobs SET status='done' WHERE id=?",job.id);};
  await Media.prototype.work.call(media);
  assert.equal(peak,1);assert.deepEqual(seen,jobs.map(j=>j.id));
});
test('failure reserving a later range leaves no partial queue or reserved clip directories',async t=>{
  const {store,media,id,root}=await fixture(t),reserve=media.reserveOutput.bind(media);let count=0,first;
  media.reserveOutput=async(...args)=>{if(++count===2)throw Error('disk full');return first=await reserve(...args);};
  await assert.rejects(media.enqueue(id,{ranges:[{start:0,end:1},{start:2,end:3}],exportDirectory:root}),/disk full/);
  assert.equal(store.all('SELECT * FROM jobs').length,0);await assert.rejects(fs.access(first.dir),{code:'ENOENT'});
});
test('failed/cancelled clip does not prevent later clips from exporting',async t=>{
  const {store,media,id}=await fixture(t);
  const {jobs}=await media.enqueue(id,{ranges:[{start:0,end:1},{start:2,end:3},{start:4,end:5}]});
  await media.cancelExport(jobs[1].id);
  const seen=[];media.performExportJob=async job=>{seen.push(job.id);if(job.id===jobs[0].id)throw Error('bad clip');store.run("UPDATE jobs SET status='done' WHERE id=?",job.id);};
  await Media.prototype.work.call(media);
  assert.deepEqual(seen,[jobs[0].id,jobs[2].id]);
  assert.deepEqual(store.all('SELECT status FROM jobs ORDER BY rowid').map(x=>x.status),['failed','cancelled','done']);
});
test('batch insert failure rolls back all rows and reservations',async t=>{
  const {store,media,id}=await fixture(t),run=store.run.bind(store),outputs=[],reserve=media.reserveOutput.bind(media);let count=0;
  media.reserveOutput=async(...args)=>{const result=await reserve(...args);outputs.push(result);return result;};
  store.run=(sql,...args)=>{if(sql.startsWith('INSERT INTO jobs')&&++count===2)throw Error('insert failed');return run(sql,...args);};
  await assert.rejects(media.enqueue(id,{ranges:[{start:0,end:1},{start:2,end:3}]}),/insert failed/);
  assert.equal(store.all('SELECT * FROM jobs').length,0);for(const output of outputs)await assert.rejects(fs.access(output.dir),{code:'ENOENT'});
});
