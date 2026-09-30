import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {Store} from '../server/store.js';
import {Ingestor} from '../server/ingest.js';
import {Media} from '../server/media.js';
import {directories,directoryToOpen} from '../server/directories.js';
import {clipFile,reserveFull,outputSpan} from '../server/output-names.js';

const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',ffprobe=process.env.FFPROBE_PATH||'ffprobe';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-full-export-')),fixture=path.join(root,'fixture.flv');
execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=black:size=320x180:rate=30','-t','3','-c:v','libx264','-preset','ultrafast','-g','30','-bf','0','-y',fixture],{windowsHide:true});
await fs.writeFile(fixture.replace('.flv','.xml'),'<i><d p="0.1,1,25,16777215,0,0,0,0">exclude me</d><d p="1,1,25,16777215,0,0,0,0">keep me</d></i>');
const opened=[];
async function setup(name) {
  const store=new Store(path.join(root,name,'data'));opened.push(store);store.projectRoot=path.join(root,name);
  const session=store.createSession({status:'finished',created:'2026-09-28T23:59:59+08:00'});
  const source=store.addSource(session.id,fixture,0,session.created,true),ingest=new Ingestor(store);
  for(let n=0;n<3;n++)await ingest.tick();
  const media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software'});media.work=async()=>{};
  return {store,session:store.session(session.id),source,media};
}
const inspect=file=>JSON.parse(execFileSync(ffprobe,['-v','error','-show_entries','format=duration:stream=r_frame_rate','-of','json',file],{windowsHide:true,encoding:'utf8'}));

test('完整素材手动导出三版本，忽略选段并保留弹幕排除，跨夜仍归开始日期',async()=>{
  const {store,session,media}=await setup('modes'),excluded=store.messages(session.id).find(m=>m.text==='exclude me').id;
  const edit=store.saveEdit(session.id,{revision:0,ranges:[{start:1,end:2,selected:false}],excluded:[excluded],undo:[]});
  const run=media.process.bind(media),ass=[];
  media.process=async(args,options={})=>{if(options.cwd)for(const name of await fs.readdir(options.cwd))if(name.endsWith('.ass'))ass.push(await fs.readFile(path.join(options.cwd,name),'utf8'));return run(args,options);};
  try {
    for(const mode of ['clean','danmaku','dual']) {
      const job=await media.enqueue(session.id,{scope:'full',mode,ranges:'ignored'});
      assert.equal(job.scope,'full');assert.deepEqual(job.ranges,[{start:0,end:session.duration}]);assert.deepEqual(job.excluded,[excluded]);
      assert.equal(job.output.date,'20260928');assert.match(job.output.stem,/^202609282359-202609290000(?:_\d+)?$/);
      const file=await media.exportJob(job),info=inspect(file);
      assert.equal(path.dirname(file),path.join(directories(store).full,'20260928'));assert.ok(Math.abs(Number(info.format.duration)-3)<.1);
      assert.equal(info.streams[0].r_frame_rate,mode==='danmaku'?'60/1':'30/1');
      if(mode==='dual')assert.equal(inspect(clipFile(file,'danmaku')).streams[0].r_frame_rate,'60/1');
      const saved=JSON.parse(store.get('SELECT data FROM jobs WHERE id=?',job.id).data);assert.equal(saved.scope,'full');assert.equal(saved.output.sidecars,false);
      await assert.rejects(fs.access(job.output.reservation),/ENOENT/);
      store.run("UPDATE jobs SET status='done',file=? WHERE id=?",file,job.id);
      assert.equal(directoryToOpen(store,{sessionId:session.id,kind:'full'}),path.dirname(file));
    }
    assert.equal((await fs.readdir(path.join(directories(store).full,'20260928'))).length,4);
    assert.ok((await fs.readdir(path.join(directories(store).full,'20260928'))).every(name=>name.endsWith('.mp4')));
    assert.ok(ass.join('\n').includes('keep me'));assert.ok(!ass.join('\n').includes('exclude me'));assert.deepEqual(store.edit(session.id),edit);
  } finally {media.close();store.close();}
});

test('整场导出等待结束和索引就绪，旧任务默认片段；仅原文件缺失不阻断内部素材导出',async()=>{
  const {store,session,source,media}=await setup('ready');
  try {
    for(const status of ['recording','finishing','importing']) {
      store.run('UPDATE sessions SET status=? WHERE id=?',status,session.id);
      await assert.rejects(media.enqueue(session.id,{scope:'full'}),/整理完成/);
    }
    store.run("UPDATE sessions SET status='finished' WHERE id=?",session.id);store.run('UPDATE sources SET closed=1 WHERE id=?',source.id);
    await assert.rejects(media.enqueue(session.id,{scope:'full'}),/整理完成/);store.run('UPDATE sources SET closed=2 WHERE id=?',source.id);
    await assert.rejects(media.enqueue(session.id,{scope:'invalid'}),/范围/);
    const old=await media.enqueue(session.id,{ranges:[{start:.1,end:1.1}],mode:'clean'});delete old.scope;
    const oldFile=await media.exportJob(old);assert.equal(old.scope,'clips');assert.ok(oldFile.startsWith(directories(store).clips+path.sep));
    store.run("UPDATE sources SET path=?,error='原始文件已移走' WHERE id=?",path.join(root,'missing.flv'),source.id);
    const full=await media.enqueue(session.id,{scope:'full',mode:'clean'});await media.exportJob(full);
  } finally {media.close();store.close();}
});

test('默认导出目录位于程序目录，自定义根保持，完整素材打开最近成品或默认目录',async()=>{
  const {store,session}=await setup('directories');
  try {
    const expected=path.join(store.projectRoot,'导出视频默认路径');assert.equal(directories(store).exports,expected);
    store.setting('export-directory',path.join(store.root,'exports'));assert.equal(directories(store).exports,path.join(store.root,'exports'));
    const custom=path.join(root,'my-exports');store.setting('export-directory',custom);assert.equal(directories(store).exports,custom);
    assert.equal(directoryToOpen(store,{sessionId:session.id,kind:'full'}),path.join(custom,'完整素材'));
    assert.equal(directoryToOpen(store,{kind:'clips'}),path.join(custom,'导出片段'));
    for(const [id,created,data,file] of [['legacy','2030-01-01','bad json','old.mp4'],['newer-clip','2028-01-01','{}','clip.mp4'],['full','2026-01-01','{"scope":"full"}',path.join(root,'actual','full.mp4')]])store.run('INSERT INTO jobs(id,session,created,status,data,file,mode) VALUES(?,?,?,?,?,?,?)',id,session.id,created,'done',data,file,'clean');
    assert.equal(directoryToOpen(store,{sessionId:session.id}),path.join(root,'actual'));
    store.setting('export-directory','');delete store.projectRoot;assert.equal(directories(store).exports,path.join(path.dirname(store.root),'导出视频默认路径'));
  } finally {store.close();}
});

test('整场并发命名占位只在内部临时目录，既有单弹幕版本也不会被覆盖',async()=>{
  const folder=path.join(root,'reserve'),temporary=path.join(root,'reservation-temp'),span=outputSpan({created:'2026-09-28T21:30:00+08:00',duration:600},[]);
  const reservations=await Promise.all(Array.from({length:4},()=>reserveFull(folder,span,temporary)));
  assert.equal(new Set(reservations.map(r=>r.file)).size,4);assert.deepEqual(await fs.readdir(path.join(folder,span.date)),[]);
  const first=reservations.find(r=>r.stem===span.stem);await fs.writeFile(clipFile(first.file,'danmaku'),'keep');await fs.rmdir(first.reservation);
  const next=await reserveFull(folder,span,temporary);assert.equal(next.stem,span.stem+'_5');assert.equal(await fs.readFile(clipFile(first.file,'danmaku'),'utf8'),'keep');
});

test('删除素材先取消预览并等退出，同时阻止新预览和异步排队中的导出',async()=>{
  const {store,session,media}=await setup('cancel');let release,aborted=false;
  media.process=async(_args,{signal})=>{signal.addEventListener('abort',()=>{aborted=true;},{once:true});await new Promise(resolve=>{release=resolve;});};
  try {
    const pending=media.preview(session.id,.1,{writeHead(){}},new AbortController().signal);assert.equal(media.previews.size,1);
    const queued=media.enqueue(session.id,{ranges:[{start:.1,end:1}],mode:'clean'});
    let finished=false;const cancelling=media.cancelPreviews(session.id).then(()=>{finished=true;});
    const secondCancellation=media.cancelPreviews(session.id);
    assert.equal(aborted,true);await Promise.resolve();assert.equal(finished,false);
    await assert.rejects(media.preview(session.id,.1,{},undefined),/删除/);await assert.rejects(media.enqueue(session.id,{ranges:[{start:.1,end:1}]}),/删除/);
    await assert.rejects(queued,/删除/);assert.equal(store.all('SELECT * FROM jobs').length,0);
    release();await pending;await cancelling;await secondCancellation;assert.equal(media.previews.size,0);
    media.allowSession(session.id);await assert.rejects(media.enqueue(session.id,{ranges:[{start:.1,end:1}]}),/删除/);
    media.allowSession(session.id);const job=await media.enqueue(session.id,{ranges:[{start:.1,end:1}],mode:'clean'});assert.equal(job.scope,'clips');
  } finally {release?.();media.close();store.close();}
});

test('删除会等待异步素材探测结束，探测结果不会在删除期间重新写入缓存',async()=>{
  const {store,session,source,media}=await setup('probe-cancel');let release,started;
  const probing=new Promise(resolve=>{started=resolve;});
  media.probe=async()=>{started();return new Promise(resolve=>{release=resolve;});};
  try {
    const pending=media.probeSource(store.get('SELECT * FROM sources WHERE id=?',source.id));await probing;
    let cancelled=false;const cancelling=media.cancelPreviews(session.id).then(()=>{cancelled=true;});
    await Promise.resolve();assert.equal(cancelled,false);
    await assert.rejects(media.probeSource(store.get('SELECT * FROM sources WHERE id=?',source.id)),/删除/);
    release({width:320,height:180,fps:30});await pending;await cancelling;
    assert.equal(store.setting('metadata:'+source.id),undefined);assert.equal(media.probes.size,0);media.allowSession(session.id);
  } finally {release?.({width:320,height:180,fps:30});media.close();store.close();}
});

test('完整导出早期校验或编码器检测失败仍释放内部命名占位',async()=>{
  const {store,session,media}=await setup('reservation-failure');
  try {
    for(const reason of ['closed','unfinished','encoder']) {
      // Full clean remux no longer needs an encoder. Exercise detection failure
      // with a baked export, and observe the injected rejection during probing.
      const job=await media.enqueue(session.id,{scope:'full',mode:reason==='encoder'?'danmaku':'clean'});await fs.access(job.output.reservation);
      if(reason==='closed')media.closed=true;
      if(reason==='unfinished')store.run("UPDATE sessions SET status='recording' WHERE id=?",session.id);
      if(reason==='encoder'){media.exportEncoder=Promise.reject(new Error('encoder detection failed'));void media.exportEncoder.catch(()=>{});}
      await assert.rejects(media.exportJob(job),reason==='encoder'?/encoder detection failed/:undefined);await assert.rejects(fs.access(job.output.reservation),/ENOENT/);
      media.closed=false;store.run("UPDATE sessions SET status='finished' WHERE id=?",session.id);
    }
  } finally {media.close();store.close();}
});

test.after(async()=>{for(const store of opened)try{store.close();}catch{};if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('bili-full-export-'))await fs.rm(root,{recursive:true,force:true});});
