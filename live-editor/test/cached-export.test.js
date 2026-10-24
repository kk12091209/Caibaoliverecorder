import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {Store} from '../server/store.js';
import {Ingestor,tags,timestamp} from '../server/ingest.js';
import {Media} from '../server/media.js';
import {cachedVideoIndex,splitCachedVideo} from '../server/cached-video-slice.js';
import {DANMAKU_STYLE_SETTING} from '../shared/danmaku-style.js';
import {sourceReaderCount} from '../server/storage-files.js';

const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',ffprobe=process.env.FFPROBE_PATH||'ffprobe';
const run=(tool,args,encoding='utf8')=>execFileSync(tool,args,{encoding,windowsHide:true,maxBuffer:64*1024*1024});
const frames=file=>run(ffmpeg,['-v','error','-i',file,'-map','0:v:0','-f','framemd5','-']).split('\n').filter(s=>s&&!s.startsWith('#')).map(s=>s.split(',').at(-1).trim());
const audioPackets=file=>JSON.parse(run(ffprobe,['-v','error','-select_streams','a:0','-show_packets','-show_data_hash','sha256','-show_entries','packet=pts_time,data_hash','-of','json',file])).packets;
const info=file=>JSON.parse(run(ffprobe,['-v','error','-show_entries','stream=codec_type,r_frame_rate,nb_frames,start_time,duration:format=duration','-of','json',file]));
function rms(file,from,to){
  const pcm=run(ffmpeg,['-v','error','-i',file,'-map','0:a:0','-ar','48000','-ac','1','-f','f32le','-'],null);let sum=0,count=0;
  for(let i=Math.round(from*48000);i<Math.min(Math.round(to*48000),pcm.length/4);i++){sum+=pcm.readFloatLE(i*4)**2;count++;}
  return Math.sqrt(sum/Math.max(1,count));
}
async function fixture(t,{duration=14,fps=60,count=1,delay=0,bframes=0,gap=false}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-cached-export-'));
  const store=new Store(path.join(root,'data'));store.projectRoot=root;
  const session=store.createSession({status:'finished'}),ingest=new Ingestor(store);
  const media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software',renderCacheOptions:{minFreeBytes:0,maxBytes:1024**3}});media.work=async()=>{};
  t.after(async()=>{media.close();await media.waitForSaves();store.close();assert.ok(path.basename(root).startsWith('bili-cached-export-'));await fs.rm(root,{recursive:true,force:true});});
  store.setting(DANMAKU_STYLE_SETTING,{size:.6,opacity:100,speed:1,fps});
  const files=[];
  for(let i=0;i<count;i++){
    const file=path.join(root,`source-${i}.flv`);files.push(file);
    run(ffmpeg,['-v','error','-f','lavfi','-i','color=c=black:size=320x180:rate=30','-itsoffset',String(delay),'-f','lavfi','-i',`sine=frequency=${440+i*220}:sample_rate=48000`,
      '-t',String(duration),'-c:v','libx264','-preset','veryfast','-g','30','-bf',String(bframes),'-pix_fmt','yuv420p','-c:a','aac','-y',file]);
    if(gap){const bytes=await fs.readFile(file);await fs.writeFile(file,Buffer.concat([bytes.subarray(0,13),...tags(bytes.subarray(13)).items.filter(({tag})=>!(tag[0]===8&&tag[12]===1&&timestamp(tag)>=1200&&timestamp(tag)<1700)).map(({tag})=>tag)]));}
    const source=store.addSource(session.id,file,i?store.session(session.id).duration+5:0,session.created,true);
    await fs.writeFile(source.xml,'<i>'+[.4,3,5,9,11].map(time=>`<d p="${time},1,25,16777215,0,0,0,0">CACHE ${time}</d>`).join('')+'</i>');
    for(let n=0;n<4;n++)await ingest.tick();
  }
  const calls=[],renders=[],process=media.process.bind(media),render=media.renderer.renderVideo.bind(media.renderer);
  media.process=(args,options)=>{calls.push(args);return process(args,options);};
  media.renderer.renderVideo=async(plan,source,from,to,file,options)=>{renders.push([from,to]);return render(plan,source,from,to,file,options);};
  for(let n=0;n<30;n++)if((await media.prepareNext(session.id,{})).done)break;
  calls.length=0;renders.length=0;
  const exported=async(options={})=>{const job=await media.enqueue(session.id,{scope:'full',mode:'danmaku',exportDirectory:path.join(root,'exports'),...options});return {job,file:await media.exportJob(job)};};
  const cacheFile=async(index=0)=>{
    const plan=await media.renderer.describe(session.id,store.edit(session.id));
    const lease=await media.renderCache.acquire(await media.renderer.spec(plan,plan.blocks[index]));assert.ok(lease);const file=lease.file;await lease.release();return file;
  };
  return {root,store,session,media,calls,renders,files,exported,cacheFile,process};
}

test('cache slice planning requires exact no-B-frame timestamps and independently decodable intervals',()=>{
  const packets=Array.from({length:840},(_,i)=>({pts_time:String(i/60),dts_time:String(i/60),flags:i%120?'___':'K__'}));
  const metadata={codec:'h264',bFrames:0,fps:60,frames:840,encodingSignature:'verified'};
  const index=cachedVideoIndex(metadata,packets,60);assert.ok(index);
  const part={startMs:0,from:3.25,to:11.75,cacheFile:'cache.mp4'};
  assert.deepEqual(splitCachedVideo(part,index,60).map(p=>[p.from,p.to,!!p.reuse]),[[3.25,4,false],[4,10,true],[10,11.75,false]]);
  assert.equal(cachedVideoIndex({...metadata,bFrames:2},packets,60),null);
  assert.equal(cachedVideoIndex(metadata,packets.map((p,i)=>i===200?{...p,pts_time:'4'}:p),60),null);
  assert.equal(cachedVideoIndex(metadata,packets.map((p,i)=>i? p:{...p,flags:'___'}),60),null);
  assert.equal(splitCachedVideo({...part,from:1,to:1.5},index,60),null);
});

test('a precise baked cut copies verified interior frames and renders only its two short edges',async t=>{
  const f=await fixture(t),cache=await f.cacheFile(),reference=frames(cache);
  const result=await f.exported({scope:'clips',ranges:[{start:3.25,end:11.75}]});
  assert.equal(result.job.preparationFallback,undefined);assert.equal(result.job.reusedVideoSeconds,6);assert.equal(result.job.renderedVideoSeconds,2.5);
  assert.deepEqual(f.renders,[[3.25,4],[10,11.75]]);
  const actual=frames(result.file);assert.equal(actual.length,510);
  assert.deepEqual(actual.slice(45,405),reference.slice(240,600),'every copied decoded frame must remain identical');
  assert.ok(Math.abs(Number(info(result.file).format.duration)-8.5)<.05);
  run(ffmpeg,['-v','error','-xerror','-i',result.file,'-f','null','-']);
});

test('30 fps precise cuts retain their exact frame count and cached interior',async t=>{
  const f=await fixture(t,{fps:30}),result=await f.exported({scope:'clips',ranges:[{start:3.1,end:11.9}]});
  assert.equal(result.job.reusedVideoSeconds,4);assert.ok(Math.abs(result.job.renderedVideoSeconds-4.8)<.000001);
  assert.equal(frames(result.file).length,264);assert.equal(info(result.file).streams.find(s=>s.codec_type==='video').r_frame_rate,'30/1');
});

test('a precise cut after a reconnect uses the source global frame origin without shifting pictures',async t=>{
  const f=await fixture(t,{count:2}),source=f.store.sources(f.session.id)[1],cache=await f.cacheFile(1),reference=frames(cache);
  const result=await f.exported({scope:'clips',ranges:[{start:source.start+3.25,end:source.start+11.75}]});
  assert.equal(result.job.preparationFallback,undefined);assert.equal(result.job.reusedVideoSeconds,6);
  const actual=frames(result.file);assert.equal(actual.length,510);assert.deepEqual(actual.slice(45,405),reference.slice(240,600));
  run(ffmpeg,['-v','error','-xerror','-i',result.file,'-f','null','-']);
});

test('unsafe or failed cache slices rebuild only the affected interval from original pictures',async t=>{
  const f=await fixture(t);let fail=true;
  f.media.process=(args,options)=>{f.calls.push(args);if(fail&&args.includes('-ss')&&args[args.indexOf('-c:v')+1]==='copy'){fail=false;throw new Error('injected slice rejection');}return f.process(args,options);};
  const result=await f.exported({scope:'clips',ranges:[{start:3.25,end:11.75}]});
  assert.equal(result.job.preparationFallback,undefined);assert.equal(result.job.reusedVideoSeconds,0);assert.equal(result.job.renderedVideoSeconds,8.5);
  assert.equal(frames(result.file).length,510);assert.equal(f.renders.length,3);
});

test('a changed style cannot reuse pixels from the old prepared profile',async t=>{
  const f=await fixture(t);f.store.setting(DANMAKU_STYLE_SETTING,{size:1.5,opacity:75,speed:1,fps:60});f.media.invalidatePreparation(f.session.id);
  const result=await f.exported({scope:'clips',ranges:[{start:3.25,end:11.75}]});
  assert.equal(result.job.reusedVideoSeconds,0);assert.equal(result.job.renderedVideoSeconds,8.5);assert.equal(f.renders.length,1);
});

test('full baked export copies leading AAC at a late first video keyframe without another video encode',async t=>{
  const f=await fixture(t,{duration:3.2}),result=await f.exported();
  assert.equal(result.job.audioStreamCopy,true);assert.equal(result.job.audioCopyFallback,undefined);assert.equal(f.renders.length,0);
  assert.ok(!f.calls.some(a=>a.includes('flac')||a[a.indexOf('-c:a')+1]==='aac'));
  const source=f.store.sources(f.session.id)[0],expected=audioPackets(f.files[0]).filter(p=>Number(p.pts_time)<source.duration);
  assert.deepEqual(audioPackets(result.file).map(p=>p.data_hash),expected.map(p=>p.data_hash));
  assert.equal(Number(audioPackets(result.file)[0].pts_time),0);
});

test('compatible continuous AAC sources join once while retaining every selected packet',async t=>{
  const f=await fixture(t,{duration:3.2,count:2}),result=await f.exported(),sources=f.store.sources(f.session.id);
  assert.equal(result.job.audioStreamCopy,true);assert.equal(result.job.audioCopyFallback,undefined);assert.equal(f.renders.length,0);
  const expected=f.files.flatMap((file,i)=>audioPackets(file).filter(p=>Number(p.pts_time)<sources[i].duration));
  assert.deepEqual(audioPackets(result.file).map(p=>p.data_hash),expected.map(p=>p.data_hash));
  assert.ok(!f.calls.some(a=>a.includes('flac')));
  run(ffmpeg,['-v','error','-xerror','-i',result.file,'-f','null','-']);
});

test('an internal audio gap repairs the audio while preserving every prepared video block',async t=>{
  const f=await fixture(t,{duration:3.2,gap:true}),result=await f.exported();
  assert.match(result.job.audioCopyFallback,/空缺|跳变/);assert.equal(f.renders.length,0);
  assert.ok(f.calls.some(a=>a.includes('flac')));assert.ok(rms(result.file,1.3,1.45)<.002);assert.ok(rms(result.file,2,2.2)>.04);
});

test('nonzero audio onset after a reconnect retains silence through the exact repair path',async t=>{
  const f=await fixture(t,{duration:3.2,count:2,delay:.12,bframes:2}),result=await f.exported(),boundary=f.store.sources(f.session.id)[0].duration;
  assert.match(result.job.audioCopyFallback,/前置静音/);assert.equal(f.renders.length,0);
  assert.ok(rms(result.file,boundary+.02,boundary+.08)<.002);
  assert.ok(rms(result.file,boundary+.3,boundary+.5)>.04);
});

test('cancelling a cache slice drains every worker and releases cache and source leases',async t=>{
  const f=await fixture(t),job=await f.media.enqueue(f.session.id,{scope:'clips',mode:'danmaku',ranges:[{start:3.25,end:11.75}],exportDirectory:path.join(f.root,'exports')});
  f.media.process=async(args,options)=>{const value=await f.process(args,options);if(args.includes('-ss')&&args[args.indexOf('-c:v')+1]==='copy')f.media.exportOperations.get(job.id).controller.abort();return value;};
  await assert.rejects(f.media.exportJob(job),{code:'EXPORT_CANCELLED'});
  assert.equal(f.media.children.size,0);assert.equal(f.media.renderCache.busySession(f.session.id),false);
  for(const source of f.store.sources(f.session.id))assert.equal(sourceReaderCount(f.store,source.id),0);
  await assert.rejects(fs.stat(job.output.danmakuFile),{code:'ENOENT'});
});
