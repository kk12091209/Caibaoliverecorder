import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Store } from '../server/store.js';
import { Media } from '../server/media.js';
import { BackgroundPreparation } from '../server/background-preparation.js';
import { Ingestor } from '../server/ingest.js';
import { createApp } from '../server/index.js';
import { directories } from '../server/directories.js';
import { RenderCache } from '../server/render-cache.js';
import { TemporaryWorkspaces } from '../server/temp-workspaces.js';
import { JobDeletion } from '../server/job-deletion.js';
import { minimalMp4 } from './helpers/mp4-fixture.js';
import { createHash } from 'node:crypto';

const runtime=path.resolve('..','..','程序组件','runtime','ffmpeg');
const ffmpeg=process.env.FFMPEG_PATH||path.join(runtime,'ffmpeg.exe'),ffprobe=process.env.FFPROBE_PATH||path.join(runtime,'ffprobe.exe');
const run=(tool,args)=>execFileSync(tool,args,{windowsHide:true,encoding:'utf8'});
const missing=file=>assert.rejects(fs.stat(file),{code:'ENOENT'});
const wait=()=>new Promise(resolve=>setTimeout(resolve,10));
async function write(file,bytes){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);return file;}
async function setup(t,{sar='1/1'}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-clean-export-')),f={root};
  t.after(async()=>{
    await f.preparation?.close();f.media?.close();
    while(f.media?.processing)await wait();f.store?.close();
    assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(os.tmpdir()));
    await fs.rm(root,{recursive:true,force:true});
  });
  f.store=new Store(path.join(root,'data'));f.store.projectRoot=root;
  f.session=f.store.createSession({status:'finished',created:'2026-09-29T21:30:00+08:00'});
  f.file=path.join(f.store.root,'originals','source.flv');await fs.mkdir(path.dirname(f.file),{recursive:true});
  run(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=30','-f','lavfi','-i','sine=sample_rate=48000',
    '-t','2.4','-vf',`setsar=${sar}`,'-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-g','30','-bf','2','-c:a','aac','-y',f.file]);
  f.source=f.store.addSource(f.session.id,f.file,0,f.session.created,true);
  await fs.writeFile(f.source.xml,'<i><d p="0.4,1,25,16777215,0,0,0,0">comment</d></i>');
  const ingest=new Ingestor(f.store);for(let n=0;n<3;n++)await ingest.tick();
  attach(f);return f;
}
function attach(f) {
  f.media=new Media(f.store,{ffmpeg,ffprobe,exportAcceleration:'software'});f.media.work=async()=>{};
  f.preparation=new BackgroundPreparation(f.store,f.media,{idleGraceMs:0});
  f.media.preparation=f.preparation;f.store.preparation=f.preparation;f.store.renderCache=f.media.renderCache;
  f.store.temporaryWorkspaces=f.media.temporaryWorkspaces;
}
const jobs=f=>f.store.all('SELECT * FROM jobs WHERE session=?',f.session.id);

test('手动整场纯净版码流复制；blocked 片段保留；输出包与原片直接封装一致',async t=>{
  const f=await setup(t),duration=f.store.session(f.session.id).duration;
  f.store.run("INSERT INTO source_storage(source,mode,status,reason,eligible) VALUES(?,'chunks','blocked','完整原片内容与过渡片段不一致',1)",f.source.id);
  const chunks=f.store.all('SELECT path FROM chunks WHERE source=?',f.source.id);
  const calls=[],process=f.media.process.bind(f.media);
  f.media.process=(args,options)=>{calls.push(args);return process(args,options);};
  await f.media.enqueue(f.session.id,{scope:'full',mode:'clean'});await Media.prototype.work.call(f.media);
  const row=jobs(f)[0],job=JSON.parse(row.data);assert.equal(row.status,'done',row.error);
  assert.equal(job.cleanStreamCopy,true);assert.equal(calls.length,1);assert.ok(calls[0].includes('copy'));assert.ok(!calls[0].includes('libx264'));
  assert.equal(path.dirname(path.dirname(row.file)),directories(f.store).full);
  await missing(path.join(f.store.root,'archives'));
  const expected=path.join(f.root,'expected.mp4');
  run(ffmpeg,['-v','error','-fflags','+genpts','-i',f.file,'-t',String(duration),'-map','0:v:0','-map','0:a:0?','-c','copy','-movflags','+faststart','-y',expected]);
  const packets=file=>JSON.parse(run(ffprobe,['-v','error','-show_packets','-show_data_hash','sha256','-show_entries','packet=stream_index,pts_time,dts_time,data_hash','-of','json',file]));
  assert.deepEqual(packets(row.file),packets(expected));
  for(const chunk of chunks)await fs.stat(chunk.path);
  assert.equal(f.store.get('SELECT status FROM source_storage WHERE source=?',f.source.id).status,'blocked');
  assert.equal(jobs(f).length,1);
});

test('复制及现有编码回退均失败会进入 failed，原片保留且预处理可以继续',async t=>{
  const f=await setup(t);let calls=0,prepared=0;
  f.media.process=async()=>{calls++;throw new Error('simulated copy and fallback failure');};
  f.media.prepareNext=async()=>{prepared++;return {done:true,preparedSeconds:2.4,totalSeconds:2.4,bytes:0};};
  await f.preparation.enqueue(f.session.id);
  await f.media.enqueue(f.session.id,{scope:'full',mode:'clean'});await Media.prototype.work.call(f.media);
  const row=jobs(f)[0];assert.equal(row.status,'failed');assert.match(row.error,/simulated/);assert.equal(calls,2);
  assert.equal(JSON.parse(row.data).cleanStreamCopy,false);assert.equal(JSON.parse(row.data).streamCopyFallback,true);
  assert.equal(f.media.hasForegroundWork(),false);assert.equal(f.preparation.gate(),'');
  await f.preparation.tick();assert.equal(prepared,1);assert.equal(f.preparation.row(f.session.id).status,'ready');
  assert.equal(jobs(f).length,1);
  await fs.stat(f.file);await fs.stat(f.store.get('SELECT path FROM chunks WHERE source=? LIMIT 1',f.source.id).path);
});

test('不兼容的 SAR 沿用完整导出编码并持久记录未码流复制，保持源分辨率和帧率',async t=>{
  const f=await setup(t,{sar:'4/3'}),calls=[],process=f.media.process.bind(f.media);
  f.media.process=(args,options)=>{calls.push(args);return process(args,options);};
  await f.media.enqueue(f.session.id,{scope:'full',mode:'clean'});await Media.prototype.work.call(f.media);
  const row=jobs(f)[0],job=JSON.parse(row.data);
  assert.equal(row.status,'done',row.error);assert.equal(job.cleanStreamCopyEligible,false);assert.equal(job.cleanStreamCopy,false);assert.ok(job.cleanEncodingReason);
  assert.equal(calls.length,1);assert.ok(calls[0].includes('libx264'));assert.equal(calls[0][calls[0].indexOf('-crf')+1],'20');
  const info=await f.media.probe(row.file);assert.equal(info.width,320);assert.equal(info.height,180);assert.equal(info.fps,30);
});

test('队列中的损坏旧任务进入 failed，不会让随后手动纯净版卡在 running',async t=>{
  const f=await setup(t);
  f.store.run("INSERT INTO jobs(id,session,created,status,mode,data) VALUES(?,?,'2000-01-01','queued','clean','{invalid')",'damaged',f.session.id);
  await f.media.enqueue(f.session.id,{scope:'full',mode:'clean'});await Media.prototype.work.call(f.media);
  assert.equal(f.store.get("SELECT status FROM jobs WHERE id='damaged'").status,'failed');
  assert.equal(jobs(f).find(row=>row.id!=='damaged').status,'done');assert.equal(f.media.processing,false);
});

test('删除 blocked 素材释放原片/过渡片段/缓存/临时文件和 DB；保留已导出纯净版及弹幕版',async t=>{
  const f=await setup(t);
  f.store.run("INSERT INTO source_storage(source,mode,status,eligible) VALUES(?,'chunks','blocked',1)",f.source.id);
  await f.media.enqueue(f.session.id,{scope:'full',mode:'clean'});await Media.prototype.work.call(f.media);
  const clean=jobs(f)[0];assert.equal(clean.status,'done',clean.error);
  const baked=await f.media.enqueue(f.session.id,{scope:'full',mode:'danmaku'});await Media.prototype.work.call(f.media);
  const bakedRow=f.store.get('SELECT * FROM jobs WHERE id=?',baked.id);assert.equal(bakedRow.status,'done',bakedRow.error);
  const checksum=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const before=await Promise.all([clean.file,bakedRow.file].map(checksum));
  const digest=createHash('sha256').update('test').digest('hex');
  const cache=new RenderCache(f.store.root,{statfs:async()=>({bavail:100*2**30,bsize:1})});f.store.renderCache=cache;
  const cached=await cache.build({sessionId:f.session.id,sourceId:f.source.id,startMs:0,endMs:1000,sourceFingerprint:digest,assHash:digest,profileHash:digest,version:1},file=>fs.writeFile(file,minimalMp4));
  cached.release();
  const work=f.media.temporaryWorkspaces,temporary=await work.create('bili-export-',f.session.id);
  await write(path.join(temporary,'part-0.mp4'),minimalMp4);
  // A stopped predecessor's work directory remains attributable after restart.
  work.active.clear();f.store.temporaryWorkspaces=new TemporaryWorkspaces(work.root,{processAlive:()=>false});
  const other=await f.store.temporaryWorkspaces.create('bili-probe-','other-session');await write(path.join(other,'sample.flv'),'other data');
  const archive=await write(path.join(f.store.root,'archives','old.flv'),'old archive');
  f.store.run("UPDATE sessions SET archive=?,archive_status='done' WHERE id=?",archive,f.session.id);
  await f.store.deleteSession(f.session.id,true);
  for(const file of [f.file,f.source.xml,path.join(f.store.root,'chunks',f.source.id),cached.file,temporary,archive])await missing(file);
  assert.deepEqual(await Promise.all([clean.file,bakedRow.file].map(checksum)),before);
  for(const file of [clean.file,bakedRow.file,path.dirname(clean.file),path.dirname(bakedRow.file),other])await fs.stat(file);
  for(const table of ['sessions','sources','chunks','source_storage','danmaku','edits','preparation_jobs','preparation_seen'])assert.equal(f.store.get(`SELECT COUNT(*) AS n FROM ${table}`).n,0,table);
  assert.equal(f.store.all('SELECT id FROM jobs').length,2);assert.equal(f.store.get('SELECT session FROM jobs WHERE id=?',clean.id).session,null);
  // A later explicit export-task deletion is still independent and owns only its file.
  const service=new JobDeletion(f.store),preview=await service.preview(baked.id);
  await service.delete(baked.id,{confirmed:true,token:preview.token});
  await missing(bakedRow.file);await fs.stat(clean.file);
});

test('正式服务完成录制和重启均不自动导出；弹幕仍能登记预处理',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-manual-export-'));
  const options={port:0,data:path.join(root,'data'),projectRoot:root,noRecorder:true,compact:false,preparation:false,ffmpeg,ffprobe};
  let app=await createApp(options);
  t.after(async()=>{await app.close();assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
  app.media.work=async()=>{};
  const session=app.store.createSession({status:'finishing'}),source=app.store.addSource(session.id,path.join(root,'not-read.flv'),0,session.created,true);
  app.store.run('UPDATE sessions SET duration=10 WHERE id=?',session.id);app.store.run('UPDATE sources SET closed=2,duration=10 WHERE id=?',source.id);
  await new Promise(resolve=>setTimeout(resolve,5500));
  assert.equal(app.store.session(session.id).status,'finished');
  assert.equal(app.store.sources(session.id)[0].closed,2);
  assert.equal(app.store.all('SELECT * FROM jobs').length,0);
  app.preparation.discover();assert.equal(app.preparation.row(session.id).status,'queued');
  await app.close();app=await createApp(options);app.media.work=async()=>{};
  await new Promise(resolve=>setTimeout(resolve,1100));
  assert.equal(app.store.all('SELECT * FROM jobs').length,0);
  assert.equal(app.preparation.row(session.id).status,'queued');
});
