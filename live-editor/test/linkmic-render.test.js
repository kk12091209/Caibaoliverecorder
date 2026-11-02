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
import { LinkmicIndex } from '../server/linkmic.js';
import { labelsAt } from '../shared/linkmic-labels.js';
import { seiTag } from './helpers/linkmic-sei.js';

const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',ffprobe=process.env.FFPROBE_PATH||'ffprobe';
test('Douyin main picture and local anchor use bottom-left names through switches, clean, danmaku and prepared dual exports',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-focus-render-')),file=path.join(root,'source.flv');
  execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=black:size=640x360:rate=30','-t','3','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','30','-bf','0','-f','flv',file]);
  const store=new Store(path.join(root,'data')),session=store.createSession({status:'finished'}),source=store.addSource(session.id,file,0,undefined,true);
  const ingest=new Ingestor(store);for(let i=0;i<4;i++)await ingest.tick();
  const media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software',renderBlockSeconds:1});
  t.after(async()=>{media.close();await media.waitForSaves();store.close();await fs.rm(root,{recursive:true,force:true});});
  const events=[{source:source.id,time:.3,end:1.2,participants:[{x:0,y:0,w:1,h:1,id:'101',name:'LOCAL HOST',owner:true,labelAlign:'left'}]},
    {source:source.id,time:1.2,end:2.2,participants:[{x:0,y:0,w:1,h:1,id:'103',name:'MAIN GUEST',main:true,labelAlign:'left'},
      {x:.8,y:0,w:.2,h:.3,id:'101',name:'LOCAL HOST',owner:true,labelAlign:'left'}]}];
  const pixels=(output,time)=>execFileSync(ffmpeg,['-v','error','-ss',String(time),'-i',output,'-frames:v','1','-pix_fmt','gray','-f','rawvideo','pipe:1'],{maxBuffer:1024*1024});
  const count=(bytes,l,t,r,b)=>{let n=0;for(let y=t;y<b;y++)for(let x=l;x<r;x++)if(bytes[y*640+x]>64)n++;return n;};
  const check=output=>{
    for(const time of [.6,1.6]){const p=pixels(output,time);assert.ok(count(p,0,330,180,360)>20,'actual main picture name is bottom-left');assert.equal(count(p,450,330,640,360),0,'old bottom-right name is absent');}
    assert.ok(count(pixels(output,1.6),510,80,640,108)>10,'local anchor stays identified inside its own small picture');
    assert.equal(count(pixels(output,2.6),0,0,640,360),0,'all labels clear after linkmic ends');
  };
  for(const mode of ['clean','danmaku'])check(await media.exportJob({id:'focus-'+mode,session:session.id,scope:'full',ranges:[{start:0,end:3}],excluded:[],mode,linkmicEvents:events}));
  const job={id:'focus-prepared',session:session.id,scope:'clips',ranges:[{start:0,end:3}],excluded:[],mode:'dual',linkmicEvents:events,outputRoot:path.join(root,'exports')};
  job.output=await media.reserveOutput(job,store.session(session.id),store.sources(session.id));
  const plan=await media.renderer.describe(session.id,job,softwareEncoder()),block=plan.blocks[0];
  const changed=await media.renderer.spec({...plan,linkmicEvents:events.map(e=>({...e,participants:e.participants.map(p=>({...p,labelAlign:'right'}))}))},block);
  assert.notEqual((await media.renderer.spec(plan,block)).assHash,changed.assHash,'alignment changes invalidate prepared cache');
  const output=await media.renderer.exportJob(job,softwareEncoder());check(output);check(clipFile(output,'danmaku'));
});
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

// Exercise actual SEI -> persisted index -> preview events -> encoded pixels,
// including the newly observed p=6 layout, rather than supplying labels by hand.
test('portrait promoted-main SEI drives the same changing names in preview and real exports',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-promoted-render-')),file=path.join(root,'source.flv');
  execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=black:size=360x640:rate=30','-t','5','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','30','-bf','0','-f','flv',file]);
  const scene=grids=>({app_data:JSON.stringify({ver:15,ui_layout:7,interactive_scene:8,hide_micseat:0,style:4,sub_scene:8,
    channel_id:'998',canvas:{width:360,height:640},grids})});
  const changes=[
    [1,scene([{p:2,type:1,uid_str:'host'},{p:6,type:1,uid_str:'guest_a'}])],
    [2,scene([{p:6,type:1,uid_str:'guest_b'},{p:2,type:1,uid_str:'host'}])],
    [3,scene([{p:0,type:1,uid_str:'guest_a'},{p:6,type:1,uid_str:'host'}])],
    [4,scene([])]
  ];
  const original=await fs.readFile(file),parts=[original.subarray(0,13)];let next=0;
  for(let offset=13;offset+15<=original.length;){
    const length=original.readUIntBE(offset+1,3)+15;let tag=original.subarray(offset,offset+length);offset+=length;
    const time=(tag.readUIntBE(4,3)+tag[7]*16777216)/1000;
    if(tag[0]===9&&tag[12]===1&&next<changes.length&&time>=changes[next][0]){
      const payload=seiTag(changes[next++][1],100,0,4,'\0').subarray(16,-4);
      tag=Buffer.concat([tag.subarray(0,16),payload,tag.subarray(16)]);
      tag.writeUIntBE(tag.length-15,1,3);tag.writeUInt32BE(tag.length-4,tag.length-4);
    }
    parts.push(tag);
  }
  assert.equal(next,4);await fs.writeFile(file,Buffer.concat(parts));
  const store=new Store(path.join(root,'data')),session=store.createSession({status:'finished'}),source=store.addSource(session.id,file,0,undefined,true);
  const ingest=new Ingestor(store);for(let i=0;i<4;i++)await ingest.tick();
  store.setting('linkmic-owner:'+source.id,{id:'101',name:'HOST',roomId:'998'});
  for(const [linkId,id,name]of [['guest_b','103','SECOND GUEST'],['host','101','HOST'],['guest_a','102','GUEST A']])
    store.run('INSERT INTO linkmic_people(source,channel,link_id,id,name) VALUES(?,?,?,?,?)',source.id,'998',linkId,id,name);
  const index=new LinkmicIndex(store);await index.ensure(session.id);const events=index.events(session.id);
  assert.deepEqual([1.5,2.5,3.5].map(time=>labelsAt(events,time).find(p=>p.main)?.name),['GUEST A','SECOND GUEST','HOST']);
  assert.deepEqual(labelsAt(events,4),[]);
  const media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software',renderBlockSeconds:1});
  t.after(async()=>{await index.close();media.close();await media.waitForSaves();store.close();await fs.rm(root,{recursive:true,force:true});});
  const crop=(output,time,rect)=>execFileSync(ffmpeg,['-v','error','-ss',String(time),'-i',output,'-frames:v','1','-vf','crop='+rect,'-pix_fmt','gray','-f','rawvideo','pipe:1']);
  const bright=bytes=>bytes.reduce((sum,value)=>sum+(value>64?1:0),0);
  const check=output=>{
    const names=[1.5,2.5,3.5].map(time=>crop(output,time,'240:32:0:608'));
    for(const bytes of names)assert.ok(bright(bytes)>20,'main name is burned at the bottom-left');
    assert.notDeepEqual(names[0],names[1],'guest-to-guest switch replaces the actual rendered text');
    assert.notDeepEqual(names[1],names[2],'return to host replaces the actual rendered text');
    assert.ok(bright(crop(output,1.5,'80:24:272:410'))>10,'host remains in its own p=2 small picture');
    assert.equal(bright(crop(output,4.5,'360:640:0:0')),0,'ended linkmic has no stale labels');
  };
  for(const mode of ['clean','danmaku'])check(await media.exportJob({id:'promoted-'+mode,session:session.id,scope:'full',ranges:[{start:0,end:5}],excluded:[],mode,linkmicEvents:events}));
  const job={id:'promoted-prepared',session:session.id,scope:'clips',ranges:[{start:0,end:5}],excluded:[],mode:'dual',linkmicEvents:events,outputRoot:path.join(root,'exports')};
  job.output=await media.reserveOutput(job,store.session(session.id),store.sources(session.id));
  const output=await media.renderer.exportJob(job,softwareEncoder());check(output);check(clipFile(output,'danmaku'));
});
