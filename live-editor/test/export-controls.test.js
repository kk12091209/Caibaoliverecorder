import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {Store} from '../server/store.js';
import {Media} from '../server/media.js';
import {JobDeletion} from '../server/job-deletion.js';

const until=async check=>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw Error('Timed out');await new Promise(r=>setTimeout(r,10));}};
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-export-controls-')),store=new Store(path.join(root,'data'));store.projectRoot=root;
  const media=new Media(store);const session=store.createSession({status:'finished'});
  const add=(id,status='queued',file=path.join(root,'exports',id+'.mp4'))=>{
    const data={id,session:session.id,mode:'clean',scope:'full',ranges:[{start:0,end:60}],outputRoot:path.join(root,'exports'),output:{file,dir:path.dirname(file),sidecars:false}};
    store.run('INSERT INTO jobs(id,session,created,status,file,mode,data) VALUES(?,?,?,?,?,?,?)',id,session.id,id,status,file,'clean',JSON.stringify(data));return data;
  };
  t.after(async()=>{media.close();await Promise.allSettled([...media.exportOperations.values()].map(x=>x.done));await until(()=>!media.processing&&media.children.size===0);store.close();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
  return {root,store,media,session,add};
}

test('cancelling a queued job never runs it and releases only its reservation',async t=>{
  const f=await fixture(t),job=f.add('queued');
  job.output.reservation=path.join(f.media.temporaryRoot,'bili-full-test');await fs.mkdir(job.output.reservation,{recursive:true});
  f.store.run('UPDATE jobs SET data=? WHERE id=?',JSON.stringify(job),job.id);
  await f.media.cancelExport(job.id);assert.equal(f.store.get('SELECT status FROM jobs WHERE id=?',job.id).status,'cancelled');
  await assert.rejects(fs.stat(job.output.reservation),{code:'ENOENT'});
  await f.media.cancelExport(job.id);
});

test('cancelling an active export waits for its child, preserves unrelated work and lets the next job run',async t=>{
  const f=await fixture(t),children=[];
  f.media.spawnTracked=(_executable,_args,options)=>{const child=spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],options);children.push(child);return child;};
  const unrelated=f.media.process([]).catch(()=>{});
  let entered=false;
  f.media.performExportJob=async job=>{
    if(job.id==='a'){entered=true;await f.media.process([]);throw Error('Cancelled work must not reach publication');}
    f.store.run("UPDATE jobs SET status='done' WHERE id=?",job.id);
  };
  f.add('a');f.add('b');const work=f.media.work();await until(()=>entered&&children.length===2);
  const response=await f.media.cancelExport('a');await work;
  assert.equal(response.status,'cancelled');assert.notEqual(children[1].exitCode===null&&children[1].signalCode===null,true);
  assert.equal(children[0].exitCode,null);assert.equal(children[0].signalCode,null);
  assert.equal(f.store.get("SELECT status FROM jobs WHERE id='b'").status,'done');
  assert.equal(f.media.exportOperations.size,0);children[0].kill();await unrelated;
});

test('saving or save_failed jobs cannot be cancelled and their files remain untouched',async t=>{
  const f=await fixture(t);await fs.mkdir(path.join(f.root,'exports'));
  for(const status of ['saving','save_failed','done']){
    const job=f.add(status,status);await fs.writeFile(job.output.file,'keep');
    await assert.rejects(f.media.cancelExport(job.id));assert.equal(await fs.readFile(job.output.file,'utf8'),'keep');
  }
});

test('failed task may be removed while another export uses the same path, without deleting that export',async t=>{
  const f=await fixture(t),file=path.join(f.root,'exports','reused.mp4');await fs.mkdir(path.dirname(file));
  const failed=f.add('failed','failed',file);f.add('active','running',file);await fs.writeFile(file,'other task video');
  const deletion=new JobDeletion(f.store),preview=await deletion.preview(failed.id);
  assert.equal(preview.blocked,false);assert.equal(preview.files.length,0);assert.equal(preview.preserved.length,1);
  await deletion.delete(failed.id,{confirmed:true,token:preview.token});
  assert.equal(f.store.get('SELECT id FROM jobs WHERE id=?',failed.id),undefined);
  assert.equal(await fs.readFile(file,'utf8'),'other task video');
  assert.equal(f.store.get("SELECT status FROM jobs WHERE id='active'").status,'running');
});
