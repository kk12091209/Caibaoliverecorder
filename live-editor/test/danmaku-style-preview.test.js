import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {Store} from '../server/store.js';
import {Media} from '../server/media.js';
import {Ingestor} from '../server/ingest.js';
import {DanmakuStylePreview,stylePreviewMessages,stylePreviewEvents,stylePreviewTime,STYLE_PREVIEW_WIDTH,STYLE_PREVIEW_HEIGHT} from '../server/danmaku-style-preview.js';
import {layoutComments} from '../server/render-plan.js';
import {danmakuGeometry,DANMAKU_SIZE_STEPS} from '../shared/danmaku-style.js';
import {videoGeometryFilter} from '../server/export-encoding.js';

test('sample count follows density and export layouts honor the captured per-second rate',()=>{
  const events=stylePreviewEvents(50,{size:0.6,opacity:100});assert.equal(events.length,50);
  assert.equal(stylePreviewEvents(7,{size:5,opacity:60}).length,7);
  assert.ok(events.filter(event=>event.y>STYLE_PREVIEW_HEIGHT/2).length>15);
  const raw=Array.from({length:50},(_,index)=>({id:String(index),time:index*.01,type:'d',text:'unique '+index}));
  assert.equal(layoutComments(raw,{rate:8}).length,8);assert.equal(layoutComments(raw,{rate:50}).length,50);
});
test('all preset sizes and densities retain every chosen sample, including wide fonts and clipped long text',()=>{
  for(const size of DANMAKU_SIZE_STEPS)for(const font of [null,{advanceRatio:3.5}]){
    const full=stylePreviewEvents(50,{size,opacity:100},font);
    assert.equal(full.length,50);
    for(const rate of [1,7,17,50]){
      const events=stylePreviewEvents(rate,{size,opacity:100},font);
      assert.equal(events.length,rate);
      assert.deepEqual(events,full.filter(event=>Number(event.id)<rate));
      const rects=events.map(e=>({...e,left:Math.max(0,STYLE_PREVIEW_WIDTH+e.time*e.speed),right:Math.min(STYLE_PREVIEW_WIDTH,STYLE_PREVIEW_WIDTH+e.time*e.speed+e.textWidth)}));
      for(const a of rects)assert.ok(a.right>a.left,`size ${size}, sample ${a.id} enters the preview`);
    }
  }
});
test('preview uses actual export rendering, zero opacity preserves the exact background and temporary files are removed',async t=>{
  const ffmpeg=process.env.FFMPEG_PATH||path.resolve('../../程序组件/runtime/ffmpeg/ffmpeg.exe');
  try{await fs.access(ffmpeg);}catch{t.skip('FFmpeg is unavailable');return;}
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-style-preview-')),store=new Store(path.join(root,'data'));
  const media=new Media(store,{ffmpeg,ffprobe:process.env.FFPROBE_PATH||'unused'});
  t.after(async()=>{media.close();await media.waitForSaves();store.close();await fs.rm(root,{recursive:true,force:true});});
  const assets=path.join(root,'assets');await fs.mkdir(assets);const background=path.join(assets,'danmaku-style-preview-test.png');
  await fs.copyFile(fileURLToPath(new URL('../src/assets/danmaku-style-preview.png',import.meta.url)),background);
  const preview=new DanmakuStylePreview(media,{imageRoot:assets});
  const decode=bytes=>execFileSync(ffmpeg,['-v','error','-i','pipe:0','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{input:bytes,maxBuffer:16*1024*1024,windowsHide:true});
  const signal=AbortSignal.timeout(15000),hiddenResult=await preview.render({style:{size:1.5,opacity:0},rate:17,font:null},signal),hidden=hiddenResult.bytes;
  assert.equal(hiddenResult.samples,stylePreviewEvents(17,{size:1.5,opacity:0}).length);
  assert.equal(hidden.readUInt32BE(16),STYLE_PREVIEW_WIDTH);assert.equal(hidden.readUInt32BE(20),STYLE_PREVIEW_HEIGHT);
  const normalized=execFileSync(ffmpeg,['-v','error','-i',background,'-vf',videoGeometryFilter({width:1672,height:941,sampleAspectRatio:'1:1'},STYLE_PREVIEW_WIDTH,STYLE_PREVIEW_HEIGHT)+',format=yuv420p','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{maxBuffer:16*1024*1024,windowsHide:true});
  assert.deepEqual(decode(hidden),normalized);
  const shown=await preview.render({style:{size:1.5,opacity:60},rate:17,font:null},signal);assert.notDeepEqual(decode(shown.bytes),decode(hidden));
  assert.equal(media.children.size,0);assert.deepEqual(await fs.readdir(media.temporaryRoot),[]);
  preview.busy=true;await assert.rejects(preview.render({style:{size:0.6,opacity:100},rate:50,font:null},signal),{status:409});
});
test('preview and real H264 export retain matching glyph positions across both image halves, size, opacity and imported fonts',async t=>{
  const ffmpeg=process.env.FFMPEG_PATH,ffprobe=process.env.FFPROBE_PATH;
  if(!ffmpeg||!ffprobe){t.skip('FFmpeg runtime is unavailable');return;}
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-style-export-')),store=new Store(path.join(root,'data'));
  const media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software'});media.work=async()=>{};
  t.after(async()=>{media.close();await media.waitForSaves();store.close();await fs.rm(root,{recursive:true,force:true});});
  const run=args=>execFileSync(ffmpeg,['-v','error',...args],{maxBuffer:16*1024*1024,windowsHide:true});
  const assets=path.join(root,'assets');await fs.mkdir(assets);
  run(['-f','lavfi','-i','color=c=black:size=1672x942','-vf','crop=1672:941:0:0:exact=1','-frames:v','1','-threads','1',path.join(assets,'danmaku-style-preview-test.png')]);
  const footage=path.join(root,'source.flv');run(['-f','lavfi','-i','color=c=black:size=1672x940:rate=60','-t','6','-c:v','libx264','-preset','ultrafast','-g','60','-pix_fmt','yuv420p',footage]);
  const session=store.createSession({status:'finished'});store.addSource(session.id,footage,0,session.created,true);
  const ingestor=new Ingestor(store);for(let i=0;i<3;i++)await ingestor.tick();
  const preview=new DanmakuStylePreview(media,{imageRoot:assets});
  let imported=null;
  const fontPath=process.platform==='darwin'?'/System/Library/Fonts/Supplemental/Arial.ttf':path.join(process.env.WINDIR||'C:\\Windows','Fonts','arial.ttf');
  try{imported=await media.fonts.import(await fs.readFile(fontPath),'Arial.ttf',{select:false});}catch{}
  const scenarios=[{size:.6,opacity:100,font:null},{size:1.5,opacity:60,font:null},{size:2,opacity:100,font:null},{size:5,opacity:100,font:null},...(imported?[{size:.6,opacity:100,font:imported.id}]:[])];
  for(const scenario of scenarios){
    const {font:fontId,...style}=scenario,rate=50,font=await media.fonts.selection(fontId);
    const plan=await media.renderer.describe(session.id,{danmakuStyle:style,danmakuPerSecond:rate,font});
    plan.layout=layoutComments(stylePreviewMessages(rate,style,font),{rate,width:plan.profile.width,height:plan.profile.height,style,font});
    const time=stylePreviewTime(style,font);
    assert.deepEqual(stylePreviewEvents(rate,style,font),plan.layout.filter(event=>event.time<=time&&event.end>time).map(event=>({...event,time:event.time-time,end:event.end-time})));
    const rendered=await preview.render({style,rate,font:fontId},AbortSignal.timeout(15000)),file=path.join(root,`output-${style.size}-${fontId||'default'}.mp4`);
    await media.renderer.renderVideo(plan,plan.sources[0],time,time+1/60,file);
    const expected=execFileSync(ffmpeg,['-v','error','-i','pipe:0','-frames:v','1','-f','rawvideo','-pix_fmt','gray','pipe:1'],{input:rendered.bytes,maxBuffer:16*1024*1024,windowsHide:true});
    const actual=run(['-i',file,'-frames:v','1','-f','rawvideo','-pix_fmt','gray','pipe:1']);
    let union=0,intersection=0,lower=0,error=0;
    for(let i=0;i<expected.length;i++){
      const a=expected[i]>50,b=actual[i]>50;if(a||b){union++;if(a&&b)intersection++;error+=Math.abs(expected[i]-actual[i]);}
      if(b&&i>=STYLE_PREVIEW_WIDTH*STYLE_PREVIEW_HEIGHT/2)lower++;
    }
    const overlap=intersection/union;
    t.diagnostic(`size=${style.size}, opacity=${style.opacity}, font=${fontId?'imported':'default'}, bright mask overlap=${(overlap*100).toFixed(2)}%, mean glyph error=${(error/union).toFixed(2)}, lower-half pixels=${lower}`);
    assert.ok(union>100);assert.ok(lower>100);assert.ok(overlap>.94,`preview/export mask overlap ${overlap}`);assert.ok(error/union<12);
  }
  assert.equal(media.children.size,0);assert.deepEqual(await fs.readdir(media.temporaryRoot),[]);
});
