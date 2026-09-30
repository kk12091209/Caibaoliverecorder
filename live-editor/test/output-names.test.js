import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { outputSpan, reserveClip, reserveFull, clipFile, archiveFile, exportedJobFile } from '../server/output-names.js';
import { createApp } from '../server/index.js';

test('时间段以北京时间和素材时钟命名，切片使用内容日期而非导出日期',()=>{
  const session={created:'2026-09-28T13:30:00Z',duration:600};
  assert.deepEqual(outputSpan(session,[]),{date:'20260928',stem:'202609282130-2140',start:session.created.replace('Z','.000Z'),end:'2026-09-28T13:40:00.000Z',timeZone:'Asia/Shanghai'});
  assert.equal(outputSpan(session,[],[{start:120,end:180}]).stem,'202609282132-2133');
  assert.equal(outputSpan(session,[],[{start:300,end:600},{start:0,end:60}]).stem,'202609282130-2140');
  const sources=[{start:0,duration:60,wall:session.created},{start:300,duration:300,wall:'2026-09-28T21:35:02+08:00'}];
  assert.equal(outputSpan(session,sources,[{start:358,end:418}]).stem,'202609282136-2137');
});
test('跨午夜、跨年归入开始日期，午夜后的切片归入自己的开始日期',()=>{
  const session={created:'2026-09-28T23:50:00+08:00',duration:1200};
  assert.equal(outputSpan(session,[]).date,'20260928');assert.equal(outputSpan(session,[]).stem,'202609282350-202609290010');
  const clip=outputSpan(session,[],[{start:660,end:720}]);assert.equal(clip.date,'20260929');assert.equal(clip.stem,'202609290001-0002');
  assert.equal(outputSpan({created:'2026-12-31T23:59:00+08:00',duration:120},[]).stem,'202612312359-202701010001');
  assert.throws(()=>outputSpan({created:'bad',duration:1},[]),/时间无效/);
});
test('重复和同时导出分配独立名称，已有文件不会被覆盖',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-output-names-'));
  try{
    const span=outputSpan({created:'2026-09-28T21:30:00+08:00',duration:600},[]);
    const clips=await Promise.all(Array.from({length:6},()=>reserveClip(path.join(root,'clips'),span)));
    assert.equal(new Set(clips.map(c=>c.file)).size,6);assert.ok(clips.some(c=>c.stem===span.stem));assert.ok(clips.some(c=>c.stem===span.stem+'_6'));
    const first=await reserveFull(path.join(root,'full'),span,path.join(root,'temp'));await fs.writeFile(first.file,'original');
    const second=await reserveFull(path.join(root,'full'),span,path.join(root,'temp'));assert.equal(second.stem,span.stem+'_2');assert.equal(await fs.readFile(first.file,'utf8'),'original');
    assert.equal(path.dirname(first.file),path.join(root,'full','20260928'));
    assert.equal(clipFile(clips[0].file,'xml'),clips[0].file.replace('.mp4','.xml'));
    assert.equal(archiveFile(first.file,'manifest'),first.file.replace('.mp4','.originals.json'));
    assert.equal(clipFile(path.join(root,'old','clip.mp4'),'ass'),path.join(root,'old','clip.ass'));
    assert.equal(archiveFile(path.join(root,'old','full.flv'),'xml'),path.join(root,'old','full-chat.xml'));
    assert.equal(archiveFile(path.join(root,'old','full.mkv'),'manifest'),path.join(root,'old','originals.json'));
  }finally{if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('bili-output-names-'))await fs.rm(root,{recursive:true,force:true});}
});
test('弹幕名统一使用前缀，重复调用与旧名称不会叠加标记',()=>{
  const dir=path.join('exports','20260928','202609282130-2140'),stem='202609282130-2140';
  const clean=path.join(dir,stem+'.mp4'),baked=path.join(dir,'【弹幕版】'+stem+'.mp4');
  for(const file of [clean,baked,path.join(dir,stem+'_弹幕版.mp4'),path.join(dir,'【弹幕版】【弹幕版】'+stem+'_弹幕版_弹幕版.mp4')]){
    assert.equal(clipFile(file,'danmaku'),baked);
    assert.equal(clipFile(file,'xml'),path.join(dir,stem+'.xml'));
    assert.equal(clipFile(file,'ass'),path.join(dir,stem+'.ass'));
    assert.equal(clipFile(file,'manifest'),path.join(dir,'edit.json'));
  }
  assert.equal(clipFile(clean,'video'),clean);
  assert.equal(clipFile(baked,'video'),baked);
});
test('新任务使用实际输出路径，不提供已停用的附属文件',()=>{
  const file=path.join('exports','clip.mp4'),baked=clipFile(file,'danmaku');
  const data=JSON.stringify({output:{namingVersion:2,sidecars:false,danmakuFile:baked}});
  assert.equal(exportedJobFile({file,mode:'dual',data},'danmaku'),baked);
  assert.equal(exportedJobFile({file,mode:'dual',data},'video'),file);
  assert.equal(exportedJobFile({file:baked,mode:'danmaku',data},'video'),baked);
  for(const kind of ['xml','ass','manifest'])assert.equal(exportedJobFile({file,mode:'dual',data},kind),null);
  assert.equal(exportedJobFile({file,mode:'clean',data},'danmaku'),null);
  const explicit=path.join('exports','custom-name.mp4');
  assert.equal(exportedJobFile({file,mode:'dual',data:{output:{namingVersion:2,danmakuFile:explicit}}},'danmaku'),explicit);
  assert.equal(exportedJobFile({file,mode:'dual',data:{output:{namingVersion:2}}},'danmaku'),null);
});
test('缺失输出记录时不猜测旧后缀或附属文件，不修改已存在的输出',()=>{
  const file=path.join('old-exports','clip.mp4'),baked=path.join('old-exports','clip_弹幕版.mp4');
  for(const data of [undefined,'{}','bad json',JSON.stringify({output:{file}})]){
    const job={file,mode:'dual',data};
    assert.equal(exportedJobFile(job,'danmaku'),null);
    assert.equal(exportedJobFile(job,'video'),file);
    for(const kind of ['xml','ass','manifest'])assert.equal(exportedJobFile(job,kind),null);
  }
  assert.equal(exportedJobFile({file:baked,mode:'danmaku'},'video'),baked);
  assert.equal(exportedJobFile({file:baked,mode:'danmaku'},'danmaku'),baked);
  assert.equal(exportedJobFile({file,mode:'legacy'},'danmaku'),null);
  assert.equal(exportedJobFile({file:'',mode:'dual'},'danmaku'),null);
});
test('任务快照保留成片路径，移除浏览器下载接口',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-output-api-'));
  const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  let app;
  try{
    // No media process is needed: this exercises completed job metadata and downloads.
    app=await createApp({automaticClean:false,preparation:false,data:root,port,noRecorder:true,ffmpeg:process.execPath,ffprobe:process.execPath});
    const session=app.store.createSession({status:'recording'}),legacy=path.join(root,'old.mp4'),fresh=path.join(root,'new.mp4');
    const oldBaked=path.join(root,'old_弹幕版.mp4'),newBaked=clipFile(fresh,'danmaku');
    for(const [file,text] of [[legacy,'old clean'],[oldBaked,'old baked'],[clipFile(legacy,'xml'),'old xml'],[fresh,'new clean'],[newBaked,'new baked'],[clipFile(fresh,'xml'),'must not download']])await fs.writeFile(file,text);
    for(const job of [{id:'old-dual',file:legacy,data:{}},{id:'new-dual',file:fresh,data:{output:{namingVersion:2,sidecars:false,danmakuFile:newBaked}}}])app.store.run('INSERT INTO jobs(id,session,created,status,data,file,mode) VALUES(?,?,?,?,?,?,?)',job.id,session.id,new Date().toISOString(),'done',JSON.stringify(job.data),job.file,'dual');
    const origin=`http://127.0.0.1:${port}`;
    const state=await (await fetch(origin+'/api/state')).json();
    assert.equal(state.jobs.find(j=>j.id==='old-dual').danmaku_file,'');
    assert.equal(state.jobs.find(j=>j.id==='new-dual').danmaku_file,newBaked);
    assert.ok(state.jobs.every(j=>!Object.hasOwn(j,'data')));
    for(const id of ['old-dual','new-dual'])for(const kind of ['video','danmaku','xml','ass','manifest']){
      const response=await fetch(origin+'/api/jobs/'+id+'/'+kind);assert.equal(response.status,404);
    }
    assert.equal(await fs.readFile(oldBaked,'utf8'),'old baked');
    await assert.rejects(fs.access(clipFile(legacy,'danmaku')),/ENOENT/);
  }finally{
    if(app)await app.close();
    if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('bili-output-api-'))await fs.rm(root,{recursive:true,force:true});
  }
});
