import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Store } from '../server/store.js';
import { Ingestor } from '../server/ingest.js';
import { Media, assText } from '../server/media.js';
import { RenderPipeline,layoutComments,visibleComments,commentSignature,frameSpan } from '../server/render-plan.js';
import { clipFile } from '../server/output-names.js';
import { DANMAKU_STYLE_SETTING, normalizedDanmakuStyle } from '../shared/danmaku-style.js';

const runtime=path.resolve('..','..','程序组件','runtime','ffmpeg');
const ffmpeg=process.env.FFMPEG_PATH||path.join(runtime,'ffmpeg.exe'),ffprobe=process.env.FFPROBE_PATH||path.join(runtime,'ffprobe.exe');
const run=(tool,args,encoding)=>execFileSync(tool,args,{windowsHide:true,maxBuffer:64*1024*1024,...(encoding?{encoding}:{})});
const inspect=file=>JSON.parse(run(ffprobe,['-v','error','-count_frames','-show_entries','stream=codec_type,r_frame_rate,nb_read_frames,start_time,duration:format=duration','-of','json',file],'utf8'));
const message=(id,time,text='EDGE')=>({id,time,text,type:'d',color:'16777215'});

test('preparation holds every current-plan ready block through a budget failure and releases all leases',async()=>{
  const held=new Set(),blocks=[0,60000,120000].map(startMs=>({startMs,endMs:startMs+60000}));
  const renderer=new RenderPipeline({store:{edit:()=>({})},renderCache:{async acquire(spec){if(spec===60000)return null;held.add(spec);return {bytes:10,release:async()=>held.delete(spec)};}}},assText);
  renderer.describe=async()=>({blocks});renderer.spec=async(_plan,block)=>block.startMs;
  renderer.acquire=async()=>{assert.deepEqual([...held],[0,120000]);throw Object.assign(new Error('budget'),{code:'PREP_SPACE'});};
  await assert.rejects(renderer.prepareNext('session'),{code:'PREP_SPACE'});
  assert.equal(held.size,0);assert.equal(renderer.operations.size,0);
});

test('cache build verifies the same frame-aligned source interval for millisecond reconnect offsets',async()=>{
  const ranges=[],renderer=new RenderPipeline({store:{},renderCache:{acquire:async()=>null,build:async(_spec,_render,options)=>{assert.equal(await options.verifySource(),true);return {release(){}};}}},assText);
  renderer.sourceFingerprint=async(_source,from,to)=>{ranges.push([from,to]);return JSON.stringify([from,to]);};
  const block={source:{id:'source'},startMs:60007,endMs:120007};
  await renderer.acquire({id:'session',layout:[],snapshot:{},profileHash:'profile'},block);
  assert.deepEqual(ranges,[[60,120],[60,120]]);
});

test('stable global lanes retain six-second tails and hidden messages never reflow unrelated blocks',()=>{
  const raw=[message('a',.2),message('b',.3),message('c',4.1),message('d',6.1)];
  const layout=layoutComments(raw),before=visibleComments(layout,{excluded:[]},0,2),after=visibleComments(layout,{excluded:['c']},0,2);
  assert.equal(commentSignature(before),commentSignature(after));
  assert.deepEqual(visibleComments(layout,{excluded:['c']},6,8).map(m=>[m.id,m.lane]),visibleComments(layout,{excluded:[]},6,8).filter(m=>m.id!=='c').map(m=>[m.id,m.lane]));
  assert.ok(visibleComments(layout,{},2,4).some(m=>m.id==='a'));
  assert.equal(visibleComments(layout,{},6.2,8).some(m=>m.id==='a'),false);
  const full=assText(visibleComments(layout,{},0,8),320,180);
  const block=assText(visibleComments(layout,{},2,4),320,180);
  assert.equal(full.split('\n').find(line=>line.endsWith('EDGE')),block.split('\n').find(line=>line.endsWith('EDGE')));
  assert.match(assText([{...message('old',-2),lane:3}],320,180),/0:00:00\.00,0:00:04\.00/);
  assert.equal(frameSpan(1.101,3.099).frames,120);
});

async function fixture(t,{duration=6.4,blockSeconds=2,comments}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-preparation-render-'));let store,media;
  t.after(async()=>{media?.close();if(media)await media.waitForSaves();store?.close();const relative=path.relative(await fs.realpath(os.tmpdir()),await fs.realpath(root));assert.ok(relative.startsWith('bili-preparation-render-')&&!relative.includes(path.sep));await fs.rm(root,{recursive:true,force:true});});
  const file=path.join(root,'source.flv');
  run(ffmpeg,['-v','error','-f','lavfi','-i','color=c=black:size=320x180:rate=60','-itsoffset','0.12','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t',String(duration),'-c:v','libx264','-preset','ultrafast','-g','60','-bf','2','-pix_fmt','yuv420p','-c:a','aac','-y',file]);
  store=new Store(path.join(root,'data'));store.projectRoot=root;
  const session=store.createSession({status:'finished',created:'2026-09-30T01:00:00+08:00'}),source=store.addSource(session.id,file,0,session.created,true);
  const lines=comments||[{time:.4,text:'EDGE'},{time:4.1,text:'REMOVE'}];
  await fs.writeFile(source.xml,'<i>'+lines.map(m=>`<d p="${m.time},1,25,16777215,0,0,0,0">${m.text}</d>`).join('')+'</i>');
  const ingest=new Ingestor(store);for(let i=0;i<3;i++)await ingest.tick();
  const calls=[],createMedia=()=>{
    media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software',renderBlockSeconds:blockSeconds,renderCacheOptions:{minFreeBytes:0,maxBytes:1024*1024*1024}});media.work=async()=>{};
    const process=media.process.bind(media);media.process=async(args,options)=>{calls.push({args,background:options?.background});return process(args,options);};return media;
  };
  return {root,store,session,source,media:createMedia(),calls,restart:async()=>{media.close();await media.waitForSaves();return createMedia();}};
}
const videoRenders=calls=>calls.filter(call=>call.args.includes('-frames:v')).length;
async function prepare(f) {
  for(let i=0;i<100;i++){const result=await f.media.prepareNext(f.session.id,{});if(result.done)return result;}
  assert.fail('preparation did not finish');
}
async function exported(f,input) {
  const job=await f.media.enqueue(f.session.id,{mode:'danmaku',exportDirectory:path.join(f.root,'exports'),...input});
  const file=await f.media.exportJob(job);
  assert.equal(job.preparationFallback,undefined,job.preparationFallback);
  return {job,file};
}
function frame(file,time){return run(ffmpeg,['-v','error','-ss',String(time),'-i',file,'-frames:v','1','-pix_fmt','gray','-f','rawvideo','pipe:1']);}
function brightCenter(bytes) {let sum=0,count=0;for(let y=15;y<48;y++)for(let x=0;x<320;x++)if(bytes[y*320+x]>180){sum+=x;count++;}assert.ok(count>5);return sum/count;}
function audio(file){return run(ffmpeg,['-v','error','-i',file,'-map','0:a:0','-ac','1','-ar','48000','-f','f32le','pipe:1']);}
function longestQuiet(bytes,from,to) {let run=0,longest=0;for(let i=Math.round(from*48000);i<Math.min(bytes.length/4,Math.round(to*48000));i++){if(Math.abs(bytes.readFloatLE(i*4))<.001)longest=Math.max(longest,++run);else run=0;}return longest/48000;}

test('30/60 fps ordinary and cached exports preserve slow motion, clipped tails and continuous audio',async t=>{
  const f=await fixture(t,{duration:10.4,comments:[{time:.4,text:'EDGE'}]});
  let previousHash,previousCenter;
  for(const fps of [30,60]){
    const style={size:.6,opacity:100,speed:.5,fps};f.store.setting(DANMAKU_STYLE_SETTING,style);f.media.invalidatePreparation(f.session.id);
    const plan=await f.media.renderer.describe(f.session.id,f.store.edit(f.session.id));
    assert.equal(plan.profile.fps,fps);assert.notEqual(plan.profileHash,previousHash);previousHash=plan.profileHash;
    // Force the normal encoder first; then build and reuse the new profile.
    const ordinaryJob=await f.media.enqueue(f.session.id,{scope:'full',mode:'dual',exportDirectory:path.join(f.root,'exports')});
    await f.media.encodeJob(ordinaryJob,await f.media.renderer.encoder());
    const ordinary=ordinaryJob.output.danmakuFile,ordinaryInfo=inspect(ordinary);
    assert.equal(ordinaryInfo.streams.find(s=>s.codec_type==='video').r_frame_rate,`${fps}/1`);
    assert.equal(inspect(ordinaryJob.output.file).streams.find(s=>s.codec_type==='video').r_frame_rate,'60/1','clean video retains source frame rate');
    await prepare(f);
    const whole=await exported(f,{scope:'full'});assert.ok(whole.job.preparedBlocks>0);
    const info=inspect(whole.file),video=info.streams.find(s=>s.codec_type==='video');
    assert.equal(video.r_frame_rate,`${fps}/1`);assert.equal(Number(video.nb_read_frames),Math.round(Number(video.duration)*fps));
    const clip=await exported(f,{ranges:[{start:8.11,end:9.41}]});
    assert.equal(inspect(clip.file).streams.find(s=>s.codec_type==='video').r_frame_rate,`${fps}/1`);
    const aligned=frameSpan(8.11,9.41,fps),center=brightCenter(frame(whole.file,aligned.from+.4));
    assert.ok(Math.abs(center-brightCenter(frame(clip.file,.4)))<2,'a comment older than six seconds survives the clip boundary');
    assert.ok(Math.abs(brightCenter(frame(ordinary,8.5))-brightCenter(frame(whole.file,8.5)))<2,'ordinary and cached paths agree');
    const sameTimeCenter=brightCenter(frame(whole.file,8.5));
    if(previousCenter!==undefined)assert.ok(Math.abs(sameTimeCenter-previousCenter)<2,'frame rate does not change travel speed');
    previousCenter=sameTimeCenter;
    const pcm=audio(whole.file);for(const boundary of [2,4,6,8])assert.ok(longestQuiet(pcm,boundary-.05,boundary+.05)<.005);
  }
});

test('style changes build a new cache profile while a queued export keeps its captured size and opacity',async t=>{
  const f=await fixture(t,{duration:4.4,comments:[{time:.4,text:'STYLE'}]});
  await prepare(f);const before=videoRenders(f.calls);
  const oldProfile=(await f.media.renderer.describe(f.session.id,f.store.edit(f.session.id))).profileHash;
  const style={size:1.5,opacity:50};f.store.setting(DANMAKU_STYLE_SETTING,style);f.media.invalidatePreparation(f.session.id);
  await prepare(f);assert.ok(videoRenders(f.calls)>before);
  const changed=(await f.media.renderer.describe(f.session.id,f.store.edit(f.session.id))).profileHash;assert.notEqual(changed,oldProfile);
  const job=await f.media.enqueue(f.session.id,{scope:'full',mode:'danmaku',exportDirectory:path.join(f.root,'exports')});
  f.store.setting(DANMAKU_STYLE_SETTING,{size:0.6,opacity:0});
  const renders=videoRenders(f.calls),file=await f.media.exportJob(job);
  assert.deepEqual(job.danmakuStyle,normalizedDanmakuStyle(style));assert.equal(videoRenders(f.calls),renders);assert.ok(job.preparedBlocks>0);
  const translucent=frame(file,1.2);assert.ok(Math.max(...translucent)>80);assert.ok(Math.max(...translucent)<190);
  const hidden=await exported(f,{scope:'full'});assert.ok(Math.max(...frame(hidden.file,1.2))<10);
});

test('background builds one block per call, exports reuse across restart, precise clip edges keep lanes and audio continuous',async t=>{
  const f=await fixture(t);
  let result=await f.media.prepareNext(f.session.id,{});assert.equal(result.done,false);assert.equal(videoRenders(f.calls),1);assert.equal(f.media.hasForegroundWork(),false);
  result=await prepare(f);assert.equal(result.done,true);assert.ok(result.preparedSeconds>=6);assert.equal(videoRenders(f.calls),4);
  const before=videoRenders(f.calls),whole=await exported(f,{scope:'full'});
  assert.equal(videoRenders(f.calls),before);assert.equal(whole.job.preparedBlocks,4);
  const all=inspect(whole.file),duration=all.streams.find(s=>s.codec_type==='video').duration;
  assert.equal(all.streams.find(s=>s.codec_type==='video').r_frame_rate,'60/1');
  assert.equal(Number(all.streams.find(s=>s.codec_type==='video').nb_read_frames),Math.round(Number(duration)*60));
  const pcm=audio(whole.file);for(const boundary of [2,4,6])assert.ok(longestQuiet(pcm,boundary-.05,boundary+.05)<.005);
  const clip=await exported(f,{ranges:[{start:1.1,end:5.1}]});assert.equal(videoRenders(f.calls)-before,2);assert.equal(clip.job.preparedBlocks,1);
  assert.ok(Math.abs(Number(inspect(clip.file).format.duration)-4)<.05);
  const centerFull=brightCenter(frame(whole.file,2.1)),centerClip=brightCenter(frame(clip.file,1));
  assert.ok(Math.abs(centerFull-centerClip)<2,`${centerFull} / ${centerClip}`);
  const count=videoRenders(f.calls);f.media.invalidatePreparation(f.session.id);await prepare(f);assert.equal(videoRenders(f.calls),count);
  const id=f.store.messages(f.session.id).find(m=>m.text==='REMOVE').id;
  f.store.saveEdit(f.session.id,{...f.store.edit(f.session.id),excluded:[id]});f.media.invalidatePreparation(f.session.id);
  await prepare(f);assert.equal(videoRenders(f.calls)-count,2);
  const profiles=f.media.renderer.encodedInfo.size;assert.ok(profiles>0);
  f.media=await f.restart();assert.equal(await f.media.renderCache.hasReady(f.session.id),true);
  const last=f.calls.length;
  const changed=await exported(f,{scope:'full',mode:'dual'});assert.equal(videoRenders(f.calls)-count,2);
  const copied=(flag)=>f.calls.slice(last).some(call=>call.args[call.args.indexOf(flag)+1]==='copy');
  assert.equal(copied('-c:v'),true);assert.equal(copied('-c:a'),true);
  assert.equal(f.calls.slice(last).some(call=>call.args.includes('flac')),false);
  assert.ok((await fs.stat(clipFile(changed.file,'danmaku'))).size>0);
  const origin=inspect(f.source.path),clean=inspect(changed.file);
  const offset=info=>Number(info.streams.find(s=>s.codec_type==='audio').start_time)-Number(info.streams.find(s=>s.codec_type==='video').start_time);
  assert.ok(Math.abs(offset(origin)-offset(clean))<.002,`${offset(origin)} / ${offset(clean)}`);
  assert.equal(clean.streams.find(s=>s.codec_type==='video').nb_read_frames,origin.streams.find(s=>s.codec_type==='video').nb_read_frames);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM danmaku').n,2);
});

test('real default sixty-second boundary retains the same moving comment through cached full and cut exports',async t=>{
  const f=await fixture(t,{duration:62.4,blockSeconds:60,comments:[{time:58.5,text:'EDGE'}]});
  const begin=performance.now();await prepare(f);const prepared=performance.now();assert.equal(videoRenders(f.calls),2);
  const whole=await exported(f,{scope:'full'}),finished=performance.now(),clip=await exported(f,{ranges:[{start:59,end:61.5}]});
  t.diagnostic(`62.4s 320x180 fixture: background preparation ${(prepared-begin).toFixed(0)}ms, cached full export ${(finished-prepared).toFixed(0)}ms`);
  // Neither edge contains an entire cached block, so the short cut is rendered
  // once rather than splitting it at a boundary that cannot provide reuse.
  assert.equal(videoRenders(f.calls),3);
  const x=brightCenter(frame(whole.file,60.1)),y=brightCenter(frame(clip.file,1.1));assert.ok(Math.abs(x-y)<2,`${x} / ${y}`);
  assert.ok(longestQuiet(audio(whole.file),59.95,60.05)<.005);
  assert.ok(Math.abs(Number(inspect(clip.file).format.duration)-2.5)<.05);
});

test('cold foreground policy renders two balanced parts, publishes dual files and never spends cache capacity',async t=>{
  const f=await fixture(t,{duration:65,blockSeconds:60,comments:[{time:30,text:'EDGE'}]});
  // Exercise the hardware scheduling policy with tiny real CPU encodes, without
  // opening a GPU session or competing with the production recorder.
  f.media.exportEncoder=Promise.resolve({id:'libx264',label:'test scheduling',hardware:true,args:['-preset','veryfast','-crf','20','-threads','2']});
  f.media.renderCache.build=async()=>{throw new Error('foreground must not reserve background cache space');};
  const render=f.media.renderer.renderVideo.bind(f.media.renderer),spans=[];let active=0,peak=0;
  f.media.renderer.renderVideo=async(plan,source,from,to,file,options)=>{
    spans.push([from,to]);peak=Math.max(peak,++active);
    try{return await render(plan,source,from,to,file,options);}finally{active--;}
  };
  assert.equal(await f.media.renderCache.hasReady(f.session.id),false);
  const duration=f.store.session(f.session.id).duration,whole=await exported(f,{scope:'full',mode:'dual'}),baked=clipFile(whole.file,'danmaku');
  assert.equal(peak,2);assert.equal(spans.length,2);assert.ok(Math.abs((spans[0][1]-spans[0][0])-(spans[1][1]-spans[1][0]))<=1/60);
  assert.equal(spans[0][1],spans[1][0]);assert.equal(whole.job.preparedBlocks,0);
  const info=inspect(baked);assert.equal(info.streams.find(s=>s.codec_type==='video').r_frame_rate,'60/1');
  assert.equal(Number(info.streams.find(s=>s.codec_type==='video').nb_read_frames),Math.round(duration*60));
  assert.ok(longestQuiet(audio(baked),32.45,32.55)<.005);
  const x=brightCenter(frame(baked,32.45)),y=brightCenter(frame(baked,32.55));assert.ok(y<x&&x-y<15,`${x} / ${y}`);
  assert.equal(f.store.get('SELECT status FROM jobs WHERE id=?',whole.job.id).status,'done');
  assert.equal(await f.media.renderCache.hasReady(f.session.id),false);
  assert.deepEqual(await fs.readdir(path.join(f.store.root,'temp')),[]);
});
