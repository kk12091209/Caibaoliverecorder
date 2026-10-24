import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {Store} from '../server/store.js';
import {Media} from '../server/media.js';
import {Ingestor} from '../server/ingest.js';
import {CPU_EXPORT_ROUTE,CPU_CHECKPOINT_SECONDS,checkpointSpans,cleanCheckpointParts,frameSpan} from '../server/render-plan.js';
import {softwareEncoder,encoderArguments,checkpointEncoderArguments} from '../server/export-encoding.js';
import {sourceReaderCount} from '../server/storage-files.js';
import {hardCrash} from './helpers/hard-crash.js';

const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',ffprobe=process.env.FFPROBE_PATH||'ffprobe';
const run=(tool,args)=>execFileSync(tool,args,{encoding:'utf8',maxBuffer:8*1024**2});
const streams=file=>JSON.parse(run(ffprobe,['-v','error','-show_streams','-of','json',file])).streams;
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('CPU checkpoints cover the exact frame grid for a three-hour recording and arbitrary clip edges',()=>{
  for(const fps of [30,60,30000/1001])for(const [from,to] of [[0,10800],[1.347,7213.527],[.213,60.214],[.1,.101]]){
    const parts=checkpointSpans(from,to,fps),span=frameSpan(from,to,fps);
    assert.equal(parts.reduce((sum,p)=>sum+frameSpan(p.from,p.to,fps).frames,0),span.frames);
    for(let i=0;i<parts.length;i++){
      assert.ok(parts[i].to-parts[i].from<=CPU_CHECKPOINT_SECONDS+.000001);
      if(i)assert.equal(parts[i].from,parts[i-1].to);
    }
    if(parts.length){assert.equal(parts[0].from,span.from);assert.equal(parts.at(-1).to,span.to);}
  }
  const encoder=softwareEncoder(),args=checkpointEncoderArguments(encoder);
  assert.deepEqual(args.slice(0,encoderArguments(encoder).length),encoderArguments(encoder));
  assert.equal(args.includes('-bf'),false,'keep the regular CPU encoder B frames and quality settings');
  assert.equal(args[args.indexOf('-movie_timescale')+1],'60000','B-frame edit lists must preserve fractional-frame durations on FFmpeg 8');
  const segments=Array.from({length:7200},(_,i)=>({source:{id:'clock'},from:i*1.5+.06,to:i*1.5+1.077}));
  for(const fps of [30,30000/1001]){
    const parts=cleanCheckpointParts(segments,60,fps),duration=segments.reduce((sum,p)=>sum+frameSpan(p.from,p.to,60).duration,0);
    assert.equal(parts.reduce((sum,p)=>sum+frameSpan(p.from,p.to,fps).frames,0),Math.round(duration*fps));
    assert.ok(parts.every(p=>p.to-p.from<=60.000001&&p.readTo<=p.to));
  }
});

async function fixture(t,{duration=131,fps='30',audio=true}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-cpu-checkpoint-')),data=path.join(root,'data');
  let store=new Store(data),media,closed=false;store.projectRoot=root;
  const file=path.join(root,'input.flv');
  run(ffmpeg,['-v','error','-f','lavfi','-i',`testsrc2=size=160x90:rate=${fps}`,...(audio?['-f','lavfi','-i','sine=frequency=440:sample_rate=48000']:[]),
    '-t',String(duration),'-c:v','libx264','-preset','veryfast','-g','30','-bf','2','-pix_fmt','yuv420p',...(audio?['-c:a','aac']:['-an']),'-y',file]);
  const session=store.createSession({status:'finished'}),original=store.addSource(session.id,file,1.347,session.created,true);
  await fs.writeFile(original.xml,'<i>'+Array.from({length:Math.ceil(duration)},(_,i)=>`<d p="${i+.1},1,25,16777215,0,0,0,0">TIME ${i}</d>`).join('')+'</i>');
  const ingest=new Ingestor(store);for(let i=0;i<8;i++)await ingest.tick();
  const open=()=>{media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software'});media.work=async()=>{};return media;};open();
  const source=store.sources(session.id)[0];
  const enqueue=mode=>media.enqueue(session.id,{scope:'clips',ranges:[{start:source.start+.213,end:source.start+duration-.3}],mode,exportDirectory:path.join(root,'outputs')});
  const close=async()=>{if(closed)return;media.close();await media.waitForSaves();store.close();closed=true;};
  t.after(async()=>{await close();await fs.rm(root,{recursive:true,force:true});});
  return {root,data,session,source,enqueue,get store(){return store;},get media(){return media;},async restart(){await close();store=new Store(data);closed=false;store.projectRoot=root;open();return media;},close};
}

for(const mode of ['danmaku','dual','clean'])test(`${mode}: a single long CPU source survives SIGKILL in its second video block`,async t=>{
  const f=await fixture(t),job=await f.enqueue(mode);await f.close();
  const marker=path.join(f.root,'checkpoint.json');
  const script=`
    import fs from 'node:fs/promises';
    import {Store} from ${JSON.stringify(new URL('../server/store.js',import.meta.url).href)};
    import {Media} from ${JSON.stringify(new URL('../server/media.js',import.meta.url).href)};
    const store=new Store(${JSON.stringify(f.data)});store.projectRoot=${JSON.stringify(f.root)};
    const media=new Media(store,{ffmpeg:${JSON.stringify(ffmpeg)},ffprobe:${JSON.stringify(ffprobe)},exportAcceleration:'software'});
    let blocks=0,crashing=false;const spawn=media.spawnTracked.bind(media);
    media.spawnTracked=(tool,args,...rest)=>{const child=spawn(tool,args,...rest);
      if(args.includes('-vf')&&++blocks===2)child.once('spawn',()=>setTimeout(()=>{crashing=true;child.kill('SIGKILL');process.send({testEvent:'crash-now'});},25));return child;};
    const open=media.checkpoints.open.bind(media.checkpoints);
    media.checkpoints.open=async(...args)=>{const cp=await open(...args),run=cp.run.bind(cp);cp.run=async(...values)=>{
      const result=await run(...values);if(Array.isArray(values[2])&&values[2].some(n=>/^part-0(?:-danmaku)?\\.mp4$/.test(n)))
        await fs.writeFile(${JSON.stringify(marker)},JSON.stringify({directory:cp.directory,files:values[2]}));return result;};return cp;};
    const row=store.get('SELECT * FROM jobs WHERE id=?',${JSON.stringify(job.id)});store.run("UPDATE jobs SET status='running' WHERE id=?",row.id);
    try {await media.exportJob(JSON.parse(row.data));}catch(error){if(!crashing)throw error;}
    if(crashing)await new Promise(()=>{});throw Error('crash point not reached');
  `;
  await hardCrash(script,{timeout:90000});
  const crash=JSON.parse(await fs.readFile(marker,'utf8')),first=path.join(crash.directory,crash.files[0]);
  const savedBytes=await fs.readFile(first);assert.equal(Number(streams(first)[0].duration),60);
  await f.restart();const rendered=[],render=f.media.renderer.renderVideo.bind(f.media.renderer);
  f.media.renderer.renderVideo=(plan,source,from,to,...args)=>{rendered.push({clean:!!plan.cleanVideo,from,to});return render(plan,source,from,to,...args);};
  // A persisted CPU route must not be displaced by a newly available cache.
  f.media.renderCache.hasReady=async()=>true;
  f.media.selectExportEncoder=()=>assert.fail('keep the persisted CPU profile even if a GPU becomes available');
  await f.media.recoverPendingSaves();await f.media.recoverInterruptedExports();
  const row=f.store.get('SELECT * FROM jobs WHERE id=?',job.id),restored=JSON.parse(row.data);
  assert.equal(restored.processingRecovery.route,CPU_EXPORT_ROUTE);
  assert.deepEqual(await fs.readFile(first),savedBytes);
  await f.media.exportJob(restored);await f.media.waitForSaves();
  assert.ok(restored.resumedExportSteps>=1);assert.equal(restored.cpuCheckpointSeconds,60);
  const own=rendered.filter(r=>r.clean===(mode==='clean'));
  assert.equal(own.length,2,'only the unfinished second and tail blocks should render');
  assert.ok(own.every(r=>r.from>=frameSpan(job.ranges[0].start,job.ranges[0].end,mode==='clean'?30:60).from+60-.000001));
  assert.ok(rendered.every(r=>r.to-r.from<=60.000001));
  for(const output of [restored.output.file,restored.output.danmakuFile].filter(p=>p&&!(mode==='danmaku'&&p===restored.output.file))){
    run(ffmpeg,['-v','error','-xerror','-i',output,'-f','null','-']);
    const tracks=streams(output),video=tracks.find(s=>s.codec_type==='video'),audio=tracks.find(s=>s.codec_type==='audio');
    const fps=output===restored.output.danmakuFile?60:30,audioFrames=frameSpan(job.ranges[0].start,job.ranges[0].end,60).frames,frames=Math.round(audioFrames*fps/60);
    assert.equal(Number(video.nb_frames),frames);assert.ok(Math.abs(Number(video.duration)-frames/fps)<.001);
    assert.equal(video.codec_name,'h264');assert.equal(video.width,160);assert.equal(video.height,90);assert.ok(video.has_b_frames>0);
    assert.ok(audio&&Math.abs(Number(audio.duration)-Number(video.duration))<.04);
    const pcm=execFileSync(ffmpeg,['-v','error','-ss','59.98','-i',output,'-t','0.04','-map','0:a:0','-ar','48000','-ac','1','-f','f32le','pipe:1']);
    let sum=0;for(let i=0;i<pcm.length;i+=4)sum+=pcm.readFloatLE(i)**2;
    assert.ok(Math.sqrt(sum/(pcm.length/4))>.03,'no silence at the audio checkpoint join');
  }
  assert.equal(restored.processingRecovery,undefined);assert.equal(f.media.children.size,0);assert.equal(sourceReaderCount(f.store,f.source.id),0);
  assert.ok([...f.media.renderer.encodedInfo.keys()].every(file=>path.dirname(file)!==crash.directory),'temporary block metadata must not accumulate across long exports');
  assert.deepEqual(await fs.readdir(crash.directory).catch(e=>{if(e.code==='ENOENT')return [];throw e;}),[]);
});

test('CPU clean checkpoints preserve fractional source fps and have no silent audio track',async t=>{
  const f=await fixture(t,{duration:62,fps:'30000/1001',audio:false}),job=await f.enqueue('clean');
  await f.media.exportJob(job);await f.media.waitForSaves();
  const tracks=streams(job.output.file),video=tracks.find(s=>s.codec_type==='video');
  assert.equal(video.r_frame_rate,'30000/1001');assert.equal(tracks.length,1);
  const frames=Math.round(frameSpan(job.ranges[0].start,job.ranges[0].end,60).frames*(30000/1001)/60);
  assert.equal(Number(video.nb_frames),frames);
  assert.ok(Math.abs(Number(video.duration)-frames/(30000/1001))<.00002,'the MP4 edit list must not truncate a fractional-frame tail to milliseconds');
  run(ffmpeg,['-v','error','-xerror','-i',job.output.file,'-f','null','-']);
});

test('a failed CPU chunk keeps completed progress and never retries the whole-source encoder',async t=>{
  const f=await fixture(t),job=await f.enqueue('danmaku'),render=f.media.renderer.renderVideo.bind(f.media.renderer);let calls=0;
  f.media.encodeJob=()=>assert.fail('must not restart the entire CPU encode');
  f.media.renderer.renderVideo=(...args)=>{if(++calls===2)throw Error('injected encoder failure');return render(...args);};
  await assert.rejects(f.media.exportJob(job),/injected encoder failure/);
  assert.equal(job.processingRecovery.completedSteps,1);assert.equal(job.processingRecovery.route,CPU_EXPORT_ROUTE);
  assert.equal(f.media.children.size,0);await turn();
  f.media.renderer.renderVideo=render;await f.media.exportJob(job);await f.media.waitForSaves();
  assert.ok(job.resumedExportSteps>=1);assert.equal(job.processingRecovery,undefined);
});

test('CPU chunk joins keep the global picture and danmaku clock with regular B frames',async t=>{
  const f=await fixture(t),job=await f.enqueue('danmaku'),encoder=softwareEncoder();
  job.danmakuStyle={...job.danmakuStyle,areaTop:45,areaHeight:40};
  const plan=await f.media.renderer.describe(f.session.id,job,encoder,{cpuCheckpoints:true});
  const from=job.ranges[0].start,to=job.ranges[0].end,reference=path.join(f.root,'reference.mp4');
  await f.media.renderer.renderVideo(plan,f.source,from,to,reference);
  const parts=await f.media.renderer.foregroundParts(plan,[{source:f.source,from,to}],[]);
  const result=await f.media.renderer.renderForegroundParts(plan,parts,f.root);
  await f.media.renderer.mux(result.files,null,'joined.mp4',f.root,'concat.txt');
  const actual=path.join(f.root,'joined.mp4'),expected=frameSpan(from,to,60);
  assert.equal(Number(streams(actual)[0].nb_frames),expected.frames);
  const packets=JSON.parse(run(ffprobe,['-v','error','-select_streams','v:0','-show_packets','-show_entries','packet=pts_time,dts_time','-of','json',actual])).packets;
  assert.equal(new Set(packets.map(p=>p.pts_time)).size,expected.frames,'no duplicate presentation timestamps');
  for(let i=1;i<packets.length;i++)assert.ok(Math.abs(Number(packets[i].dts_time)-Number(packets[i-1].dts_time)-1/60)<.00002,'decode clock must be continuous across the B-frame joins');
  const comparison=spawnSync(ffmpeg,['-v','info','-i',actual,'-i',reference,'-lavfi','psnr','-f','null','-'],{encoding:'utf8',maxBuffer:2*1024**2});
  assert.equal(comparison.status,0,comparison.stderr);
  const quality=comparison.stderr.match(/average:([\d.]+|inf)/);assert.ok(quality,comparison.stderr);
  assert.ok(quality[1]==='inf'||Number(quality[1])>38,quality[0]);
  // GOP resets can change CRF pixels around a join. Verify the underlying
  // frame/danmaku clock separately with lossless H.264, rather than mistaking
  // compression differences for a dropped or shifted source frame.
  const lossless={...plan,profile:{...plan.profile,arguments:[...plan.profile.arguments,'-crf','0']}};
  const directory=path.join(f.root,'lossless');await fs.mkdir(directory);
  const losslessReference=path.join(directory,'reference.mp4');
  await f.media.renderer.renderVideo(lossless,f.source,from,to,losslessReference);
  const pieces=await f.media.renderer.renderForegroundParts(lossless,parts,directory);
  await f.media.renderer.mux(pieces.files,null,'joined.mp4',directory,'concat.txt');
  const hashes=file=>run(ffmpeg,['-v','error','-i',file,'-map','0:v:0','-f','framemd5','-']).split('\n').filter(s=>s&&!s.startsWith('#')).map(s=>s.split(',').at(-1).trim());
  assert.deepEqual(hashes(path.join(directory,'joined.mp4')),hashes(losslessReference),'every source picture and danmaku position must match across both minute joins');
});

for(const code of ['ENOSPC','EIO','EBUSY'])test(`${code}: CPU preserves finished blocks and bounds automatic retries`,async t=>{
  const f=await fixture(t),job=await f.enqueue('danmaku'),render=f.media.renderer.renderVideo.bind(f.media.renderer);let calls=0;
  f.media.encodeJob=()=>assert.fail('must not restart the entire CPU encode');
  f.media.renderer.renderVideo=(...args)=>{if(++calls>1)throw Object.assign(Error('injected storage fault'),{code});return render(...args);};
  await assert.rejects(f.media.exportJob(job),{code});
  assert.equal(job.processingRecovery.completedSteps,1);assert.equal(calls,code==='EBUSY'?4:2);
  assert.equal(job.automaticRetries||0,code==='EBUSY'?2:0);assert.equal(f.media.children.size,0);
  f.media.renderer.renderVideo=render;await f.media.exportJob(job);await f.media.waitForSaves();assert.ok(job.resumedExportSteps>=1);
});

test('a modified completed CPU block is re-encoded without discarding the other verified blocks',async t=>{
  const f=await fixture(t),job=await f.enqueue('danmaku'),render=f.media.renderer.renderVideo.bind(f.media.renderer);let calls=0;
  f.media.renderer.renderVideo=(...args)=>{if(++calls===3)throw Error('tail failure');return render(...args);};
  await assert.rejects(f.media.exportJob(job),/tail failure/);assert.equal(job.processingRecovery.completedSteps,2);
  await fs.appendFile(path.join(job.processingRecovery.directory,'part-0.mp4'),'changed');
  const resumed=[];f.media.renderer.renderVideo=(...args)=>{resumed.push(args[2]);return render(...args);};
  await f.media.exportJob(job);await f.media.waitForSaves();
  assert.equal(resumed.length,2,'redo the modified first block and missing tail, keeping the second block');
  assert.ok(job.resumedExportSteps>=1);run(ffmpeg,['-v','error','-xerror','-i',job.output.danmakuFile,'-f','null','-']);
});

test('cancelling a CPU export discards its checkpoints and settles source readers and children',async t=>{
  const f=await fixture(t),job=await f.enqueue('danmaku'),render=f.media.renderer.renderVideo.bind(f.media.renderer);let calls=0,started;
  const ready=new Promise(resolve=>started=resolve);
  f.media.renderer.renderVideo=async(...args)=>{
    if(++calls===2){started();const signal=f.media.exportSignal(args[5]?.signal);
      await new Promise((resolve,reject)=>{const abort=()=>reject(Object.assign(Error('cancelled'),{code:'EXPORT_CANCELLED'}));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}
    return render(...args);
  };
  f.store.run("UPDATE jobs SET status='running' WHERE id=?",job.id);
  const work=f.media.exportJob(job),rejected=assert.rejects(work,{code:'EXPORT_CANCELLED'});await ready;
  const directory=job.processingRecovery.directory;await f.media.cancelExport(job.id);await rejected;
  assert.equal(f.store.get('SELECT status FROM jobs WHERE id=?',job.id).status,'cancelled');
  await assert.rejects(fs.access(directory),{code:'ENOENT'});assert.equal(f.media.children.size,0);assert.equal(sourceReaderCount(f.store,f.source.id),0);await fs.access(f.source.path);
});

for(const fps of [30,60])test(`a one-frame CPU tail at ${fps} fps joins without changing codec configuration`,async t=>{
  const f=await fixture(t,{duration:62,audio:false}),job=await f.enqueue('danmaku'),start=1.5;
  job.ranges=[{start,end:start+60+1/fps}];job.danmakuStyle={...job.danmakuStyle,fps};
  await f.media.exportJob(job);await f.media.waitForSaves();
  assert.equal(Number(streams(job.output.danmakuFile)[0].nb_frames),60*fps+1);
  run(ffmpeg,['-v','error','-xerror','-i',job.output.danmakuFile,'-f','null','-']);
});

test('a completed whole-source CPU checkpoint from the older route is preserved through upgrade',async t=>{
  const f=await fixture(t,{duration:62}),job=await f.enqueue('danmaku'),publish=f.media.publishFiles.bind(f.media);
  job.encoder='libx264';f.media.publishFiles=()=>{throw Error('interrupted before publication');};
  await assert.rejects(f.media.encodeJob(job,softwareEncoder()),/interrupted before publication/);
  assert.equal(job.processingRecovery.route,'regular-v1');assert.ok(job.processingRecovery.completedSteps>=2);
  job.processingRecovery.completedSteps=0; // The DB counter may lag the fsynced manifest after a crash.
  f.media.publishFiles=publish;f.media.renderer.exportJob=()=>assert.fail('must not discard completed legacy video');
  f.media.selectExportEncoder=()=>assert.fail('must keep the legacy CPU encoder');f.media.renderCache.hasReady=async()=>true;
  f.media.process=(...args)=>assert.fail('finished legacy video must only be published, never encoded again');
  await f.media.exportJob(job);await f.media.waitForSaves();
  assert.ok(job.resumedExportSteps>=2);assert.equal(job.processingRecovery,undefined);await fs.access(job.output.danmakuFile);
});

test('an unrelated cache does not divert a cold long CPU export into the background budget',async t=>{
  const f=await fixture(t,{duration:62}),job=await f.enqueue('danmaku');
  f.media.renderCache.hasReady=async()=>true;const profiles=[],render=f.media.renderer.renderVideo.bind(f.media.renderer);
  f.media.renderer.renderVideo=(plan,...args)=>{profiles.push(plan.profile.arguments);return render(plan,...args);};
  await f.media.exportJob(job);await f.media.waitForSaves();
  assert.equal(job.cpuCheckpointSeconds,60);assert.equal(job.preparedBlocks,0);
  assert.ok(profiles.length>=2);assert.ok(profiles.every(args=>Number(args[args.indexOf('-threads')+1])===softwareEncoder().threads));
});

test('CPU dual precise clips share one accumulated audio/video clock across different frame rates',async t=>{
  const f=await fixture(t),job=await f.enqueue('dual');
  job.ranges=Array.from({length:4},(_,i)=>({start:1.56+i*20,end:1.56+i*20+15.017}));
  await f.media.exportJob(job);await f.media.waitForSaves();
  const duration=job.ranges.reduce((sum,r)=>sum+frameSpan(r.start,r.end,60).duration,0);
  for(const [file,fps] of [[job.output.file,30],[job.output.danmakuFile,60]]){
    const tracks=streams(file),video=tracks.find(s=>s.codec_type==='video'),audio=tracks.find(s=>s.codec_type==='audio');
    assert.equal(Number(video.nb_frames),Math.round(duration*fps));
    assert.ok(Math.abs(Number(video.duration)-Number(audio.duration))<1/fps+.005);
    run(ffmpeg,['-v','error','-xerror','-i',file,'-f','null','-']);
  }
});
