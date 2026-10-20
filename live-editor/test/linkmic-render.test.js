import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../server/store.js';
import { Ingestor } from '../server/ingest.js';
import { Media } from '../server/media.js';
import { softwareEncoder } from '../server/export-encoding.js';
import { clipFile } from '../server/output-names.js';
import { normalizeAvatar } from '../server/linkmic-avatars.js';
import { createHash } from 'node:crypto';

const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',ffprobe=process.env.FFPROBE_PATH||'ffprobe';
test('names are burned into clean, danmaku, dual and prepared output at the right time and source rectangle',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-linkmic-render-')),file=path.join(root,'source.flv');
  execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=black:size=640x360:rate=30','-t','4','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','60','-bf','0','-f','flv',file]);
  const store=new Store(path.join(root,'data')),session=store.createSession({status:'finished'}),source=store.addSource(session.id,file,0,undefined,true);
  const ingest=new Ingestor(store);for(let i=0;i<4;i++)await ingest.tick();
  const media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software',renderBlockSeconds:2});
  t.after(async()=>{media.close();await media.waitForSaves();store.close();await fs.rm(root,{recursive:true,force:true});});
  const events=[{source:source.id,time:1.2,end:2.2,participants:[
    {x:0,y:.2,w:.5,h:.4,id:'1',name:'ANCHOR A'},{x:.5,y:0,w:.5,h:1,id:'2',name:'ANCHOR B'}]}];
  const pixels=(file,time)=>execFileSync(ffmpeg,['-v','error','-ss',String(time),'-i',file,'-frames:v','1','-pix_fmt','gray','-f','rawvideo','pipe:1'],{maxBuffer:1024*1024});
  const count=(bytes,left,top,right,bottom)=>{let n=0;for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)if(bytes[y*640+x]>64)n++;return n;};
  function check(file,offset) {
    const before=pixels(file,.3-offset),during=pixels(file,1.5-offset),after=pixels(file,2.8-offset);
    assert.equal(count(before,0,0,640,360),0);
    assert.ok(count(during,200,190,320,217)>20,'left name stays at the bottom of the cropped participant');
    assert.ok(count(during,500,335,640,360)>20,'right name stays inside the right participant');
    assert.equal(count(during,0,0,640,170),0,'no name is placed at the whole player top');
    assert.equal(count(after,0,0,640,360),0,'name is removed after the event ends');
  }
  for(const mode of ['clean','danmaku','dual']) {
    const job={id:'labels-'+mode,session:session.id,scope:'full',ranges:[{start:0,end:store.session(session.id).duration}],excluded:[],mode,linkmicEvents:events};
    const output=await media.exportJob(job);check(output,0);
    if(mode==='dual')check(clipFile(output,'danmaku'),0);
    if(mode==='clean')assert.notEqual(job.cleanStreamCopy,true,'a full clean export must encode its name overlays');
  }
  const job={id:'prepared-labels',session:session.id,scope:'clips',ranges:[{start:.2,end:3.2}],excluded:[],mode:'dual',linkmicEvents:events,outputRoot:path.join(root,'exports')};
  job.output=await media.reserveOutput(job,store.session(session.id),store.sources(session.id));
  const plan=await media.renderer.describe(session.id,job,softwareEncoder());
  const first=await media.renderer.spec(plan,plan.blocks[0]);
  const different=await media.renderer.spec({...plan,linkmicEvents:[]},plan.blocks[0]);
  assert.notEqual(first.assHash,different.assHash,'cache key includes the names and their time ranges');
  const output=await media.renderer.exportJob(job,softwareEncoder());check(output,.2);check(clipFile(output,'danmaku'),.2);
});

test('offline voice avatars follow seat changes and camera state in clean, danmaku, dual and prepared exports',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-avatar-render-')),file=path.join(root,'source.flv');
  execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=black:size=640x360:rate=30','-t','4','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','30','-bf','0','-f','flv',file]);
  const white=execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=white:size=32x32','-frames:v','1','-f','image2pipe','-c:v','png','pipe:1']);
  const png=await normalizeAvatar(white,ffmpeg),avatar=createHash('sha256').update(png).digest('hex');
  const store=new Store(path.join(root,'data')),session=store.createSession({status:'finished'}),source=store.addSource(session.id,file,0,undefined,true);
  const ingest=new Ingestor(store);for(let i=0;i<4;i++)await ingest.tick();
  store.run('INSERT INTO linkmic_avatars VALUES(?,?,?)',source.id,avatar,png);
  const media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software',renderBlockSeconds:2});
  t.after(async()=>{media.close();await media.waitForSaves();store.close();await fs.rm(root,{recursive:true,force:true});});
  const person={x:.6,y:.1,w:.3,h:.4,id:'1',name:'VOICE',avatar,audioOnly:true};
  const events=[
    {source:source.id,time:.5,end:1.5,participants:[person]},
    {source:source.id,time:1.5,end:2.5,participants:[{...person,y:.5}]},
    {source:source.id,time:2.5,end:3.5,participants:[{...person,y:.5,audioOnly:false}]}];
  const pixels=(file,time)=>execFileSync(ffmpeg,['-v','error','-ss',String(time),'-i',file,'-frames:v','1','-pix_fmt','gray','-f','rawvideo','pipe:1'],{maxBuffer:1024*1024});
  function check(file,offset=0) {
    const before=pixels(file,.2-offset),first=pixels(file,1-offset),moved=pixels(file,2-offset),video=pixels(file,3-offset);
    assert.ok(before[90*640+480]<10);
    assert.ok(first[90*640+480]>200,'real cached image appears in upper seat');
    assert.ok(first[90*640+400]<80,'circle is bounded inside its tile');
    assert.ok(moved[90*640+480]<10,'old seat is cleared');
    assert.ok(moved[235*640+480]>200,'avatar follows lower seat');
    assert.ok(video[235*640+480]<10,'camera-on frame is not covered by an avatar');
  }
  for(const mode of ['clean','danmaku','dual']) {
    const output=await media.exportJob({id:'avatar-'+mode,session:session.id,scope:'full',ranges:[{start:0,end:4}],excluded:[],mode,linkmicEvents:events});
    check(output);if(mode==='dual')check(clipFile(output,'danmaku'));
  }
  const job={id:'prepared-avatar',session:session.id,scope:'clips',ranges:[{start:.1,end:3.8}],excluded:[],mode:'dual',linkmicEvents:events,outputRoot:path.join(root,'exports')};
  job.output=await media.reserveOutput(job,store.session(session.id),store.sources(session.id));
  const output=await media.renderer.exportJob(job,softwareEncoder());check(output,.1);check(clipFile(output,'danmaku'),.1);
});
