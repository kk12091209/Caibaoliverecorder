import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Store} from '../server/store.js';
import {Ingestor} from '../server/ingest.js';
import {Media} from '../server/media.js';
import {softwareEncoder} from '../server/export-encoding.js';
import {clipFile} from '../server/output-names.js';
import {RECORDING_STYLE_SETTING} from '../shared/recording-style.js';

const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',ffprobe=process.env.FFPROBE_PATH||'ffprobe';
const run=(tool,args)=>execFileSync(tool,args,{maxBuffer:4*1024*1024});
test('camera timeline is identical in clean, dual, prepared and CPU checkpoint output; queued styles and cached blocks stay frozen',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'camera-render-')),file=path.join(root,'source.flv');
  run(ffmpeg,['-v','error','-f','lavfi','-i','color=black:size=320x180:rate=30',
    '-vf','drawbox=x=0:y=44:w=160:h=90:color=blue:t=fill,drawbox=x=240:y=44:w=80:h=60:color=white:t=fill',
    '-t','6','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','30','-bf','0','-f','flv',file]);
  const store=new Store(path.join(root,'data'));store.projectRoot=root;
  const session=store.createSession({status:'finished'}),source=store.addSource(session.id,file,0,undefined,true);
  const ingest=new Ingestor(store);for(let i=0;i<3;i++)await ingest.tick();
  const events=[{source:source.id,time:1.2,end:4.2,layout:{main:{x:0,y:44/180,w:.5,h:.5},camera:{x:.75,y:44/180,w:.25,h:1/3}}}];
  store.linkmic={ensure:async()=>{},events:()=>[],cameraEvents:()=>structuredClone(events)};
  store.setting(RECORDING_STYLE_SETTING,{cameraPosition:'top-right',cameraSize:24});
  const media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software',renderBlockSeconds:2,renderCacheOptions:{minFreeBytes:0,maxBytes:1024*1024*1024}});
  media.work=async()=>{};t.after(async()=>{media.close();await media.waitForSaves();store.close();await fs.rm(root,{recursive:true,force:true});});
  const make=mode=>media.enqueue(session.id,{scope:'full',mode,exportDirectory:path.join(root,'exports')});
  const pixel=(file,time,x,y)=>{
    const bytes=run(ffmpeg,['-v','error','-ss',String(time),'-i',file,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
    assert.equal(bytes.length,320*180*3);return [...bytes.subarray((y*320+x)*3,(y*320+x)*3+3)];
  };
  const white=rgb=>rgb.every(n=>n>200),blue=rgb=>rgb[2]>180&&rgb[0]<70&&rgb[1]<70;
  function check(file,offset=0) {
    assert.ok(white(pixel(file,.5-offset,300,90)),'before metadata the untouched right camera is visible');
    assert.ok(white(pixel(file,2-offset,280,20)),'independent camera moves to top right');
    assert.ok(blue(pixel(file,2-offset,300,90)),'old right-side camera is replaced with the complete main picture');
    assert.ok(blue(pixel(file,2-offset,20,20)),'main crop fills the output without letterboxing');
    assert.ok(white(pixel(file,5-offset,300,90)),'after metadata ends the original layout returns');
  }
  for(const mode of ['clean','dual']) {
    const job=await make(mode),output=await media.exportJob(job);check(output);
    if(mode==='dual')check(clipFile(output,'danmaku'));
    assert.notEqual(job.cleanStreamCopy,true);
  }
  let ready=false;for(let i=0;i<8;i++){const result=await media.prepareNext(session.id);if(result.done){ready=true;break;}}assert.equal(ready,true);
  const queued=await make('dual');
  store.setting(RECORDING_STYLE_SETTING,{cameraPosition:'bottom-left',cameraSize:35});
  const output=await media.exportJob(queued);assert.equal(queued.preparationFallback,undefined);assert.ok(queued.preparedBlocks>0);check(output);check(clipFile(output,'danmaku'));
  assert.equal(queued.recordingStyle.cameraPosition,'top-right','later changes do not rewrite queued jobs');
  const plan=await media.renderer.describe(session.id,queued,softwareEncoder()),spec=await media.renderer.spec(plan,plan.blocks[0]);
  const moved=await media.renderer.describe(session.id,{...queued,recordingStyle:{cameraPosition:'bottom-left',cameraSize:35}},softwareEncoder());
  assert.notEqual(plan.profileHash,moved.profileHash);
  const cleared=await media.renderer.spec({...plan,cameraEvents:[]},plan.blocks[0]);assert.notEqual(spec.assHash,cleared.assHash);
  const extended=await media.renderer.spec({...plan,cameraEvents:events.map(e=>({...e,end:10}))},plan.blocks[0]);assert.equal(spec.assHash,extended.assHash,'live metadata after a block cannot invalidate that block');
  const cpu={...queued,id:'camera-cpu',ranges:[{start:.2,end:5.5}],scope:'clips',output:undefined,processingRecovery:undefined};
  cpu.output=await media.reserveOutput(cpu,store.session(session.id),store.sources(session.id));
  const cpuFile=await media.renderer.exportJob(cpu,softwareEncoder(),undefined,{cpuCheckpoints:true});check(cpuFile,.2);check(clipFile(cpuFile,'danmaku'),.2);
  store.setting(RECORDING_STYLE_SETTING,{cameraPosition:'original',cameraSize:24});
  const original=await make('clean'),originalFile=await media.exportJob(original);assert.equal(original.cleanStreamCopy,true);assert.ok(white(pixel(originalFile,2,300,90)));
});
