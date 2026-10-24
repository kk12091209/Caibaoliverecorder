import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {Store} from '../server/store.js';
import {Ingestor} from '../server/ingest.js';
import {Media} from '../server/media.js';
import {BackgroundPreparation} from '../server/background-preparation.js';
import {videoReadStart,renderRendezvous} from '../server/render-sequence.js';
import {DANMAKU_STYLE_SETTING} from '../shared/danmaku-style.js';
import {sourceReaderCount} from '../server/storage-files.js';

const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',ffprobe=process.env.FFPROBE_PATH||'ffprobe';
const run=(tool,args)=>execFileSync(tool,args,{encoding:'utf8',maxBuffer:32*1024**2});
const hashes=file=>run(ffmpeg,['-v','error','-i',file,'-map','0:v:0','-f','framemd5','-']).split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').at(-1).trim());
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function atoms(file){const bytes=await fs.readFile(file),result=[];for(let i=0;i<bytes.length;){let size=bytes.readUInt32BE(i);result.push(bytes.toString('ascii',i+4,i+8));if(size===1)size=Number(bytes.readBigUInt64BE(i+8));if(!size)break;i+=size;}return result;}
async function until(check){for(let i=0;i<1000;i++){if(check())return;await new Promise(r=>setTimeout(r,3));}throw Error('condition not reached');}
async function fixture(t,{fps=60,bframes=2,start=1.347,duration=24,blocks=11,maxBytes=1024**3}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-cold-export-')),store=new Store(path.join(root,'data'));store.projectRoot=root;
  const session=store.createSession({status:'finished'}),file=path.join(root,'source.flv');
  run(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000',
    '-t',String(duration),'-c:v','libx264','-preset','veryfast','-g','30','-bf',String(bframes),'-pix_fmt','yuv420p','-c:a','aac','-y',file]);
  const source=store.addSource(session.id,file,start,session.created,true);
  await fs.writeFile(source.xml,'<i>'+Array.from({length:duration*2},(_,i)=>`<d p="${i/2},1,25,16777215,0,0,0,0">FRAME ${i}</d>`).join('')+'</i>');
  const ingest=new Ingestor(store);for(let i=0;i<8;i++)await ingest.tick();
  store.setting(DANMAKU_STYLE_SETTING,{size:.6,opacity:100,speed:1,fps});
  const media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software',renderBlockSeconds:blocks,
    idleRenderOptions:{mode:'single'},renderCacheOptions:{minFreeBytes:0,maxBytes}});media.work=async()=>{};
  const state={recording:false};media.isRecording=()=>state.recording;
  const preparation=new BackgroundPreparation(store,media,{idleGraceMs:0,busyReason:()=>media.hasForegroundWork()||media.exportOperations.size||media.preparationHandoffs.size?'export':state.recording?'recording':''});media.preparation=preparation;
  t.after(async()=>{media.close();await preparation.close();await Promise.allSettled([...media.preparationCalls.values()]);await media.waitForSaves();store.close();await fs.rm(root,{recursive:true,force:true});});
  const plan=()=>media.renderer.describe(session.id,store.edit(session.id));
  const enqueue=async(mode='dual')=>media.enqueue(session.id,{scope:'full',mode,exportDirectory:path.join(root,'exports')});
  return {root,store,session,source:store.sources(session.id)[0],media,preparation,state,plan,enqueue};
}

test('decoder preroll covers known reorder and retains six-second compatibility for old metadata',()=>{
  assert.equal(videoReadStart({start:0},10,{fps:30,bFrames:0}),9.9);
  assert.equal(videoReadStart({start:0},10,{fps:30,bFrames:8}),10-10/30);
  assert.equal(videoReadStart({start:0},10,{fps:30}),4);
});

for(const bframes of [0,2,8])test(`short video preroll preserves every decoded output frame with ${bframes} B frames`,async t=>{
  const f=await fixture(t,{bframes}),plan=await f.plan(),from=f.source.start+8.75,to=from+3.25;
  const reference=path.join(f.root,'legacy.mp4'),actual=path.join(f.root,'short.mp4');
  await f.media.renderer.renderVideo({...plan,info:{...plan.info,bFrames:undefined}},f.source,from,to,reference);
  await f.media.renderer.renderVideo(plan,f.source,from,to,actual);
  assert.equal(hashes(actual).length,195);assert.deepEqual(hashes(actual),hashes(reference));
});

for(const fps of [30,60])test(`continuous ${fps} fps blocks have exact frames and independently decode at a forced keyframe boundary`,async t=>{
  const f=await fixture(t,{fps}),plan=await f.plan(),parts=plan.blocks.slice(0,2).map((p,i)=>({from:p.startMs/1000,to:p.endMs/1000,file:path.join(f.root,`sequence-${i}.mp4`)}));
  await f.media.renderer.renderSequence(plan,f.source,parts);
  const signatures=[];
  for(const part of parts){
    const info=await f.media.probe(part.file);assert.equal(info.frames,11*fps);assert.equal(info.startTime,0);signatures.push(info.encodingSignature);
    run(ffmpeg,['-v','error','-xerror','-i',part.file,'-f','null','-']);
    const reference=part.file+'.reference.mp4';await f.media.renderer.renderVideo(plan,f.source,part.from,part.to,reference);
    const result=spawnSync(ffmpeg,['-v','info','-i',part.file,'-i',reference,'-lavfi','psnr','-f','null','-'],{encoding:'utf8',maxBuffer:4*1024**2});
    assert.equal(result.status,0,result.stderr);const quality=result.stderr.match(/average:([\d.]+|inf)/);assert.ok(quality,result.stderr);
    assert.ok(quality[1]==='inf'||Number(quality[1])>35,quality[0]);
  }
  assert.equal(signatures[0],signatures[1]);
});

test('closed-source preparation shares one decoder for two blocks and publishes verified independent cache entries',async t=>{
  const f=await fixture(t),calls=[],process=f.media.process.bind(f.media);
  f.media.process=(args,options)=>{calls.push(args);return process(args,options);};
  const result=await f.media.prepareNext(f.session.id);
  assert.equal(result.preparedSeconds,22);assert.equal(calls.filter(a=>a.includes('-vf')).length,1);
  assert.equal(f.media.renderCache.entries.size,2);assert.equal(f.media.renderCache.reserved,0);
  assert.ok([...f.media.renderCache.entries.values()].every(e=>e.leases===0));
});

test('a cache budget smaller than two blocks processes one without a rendezvous deadlock',async t=>{
  const f=await fixture(t,{maxBytes:30*1024**2}),result=await f.media.prepareNext(f.session.id);
  assert.equal(result.preparedSeconds,11);assert.equal(f.media.renderCache.entries.size,1);assert.equal(f.media.renderCache.reserved,0);
});

test('a rejected continuous output falls back to original-picture renders for both exact intervals',async t=>{
  const f=await fixture(t),plan=await f.plan(),original=f.media.renderer.renderSequence.bind(f.media.renderer),parts=plan.blocks.slice(0,2).map(p=>({source:f.source,from:p.startMs/1000,to:p.endMs/1000}));
  let rejected=false;
  f.media.renderer.renderSequence=async(...args)=>{const result=await original(...args);if(args[2].length>1){rejected=true;throw Error('injected sequence verification failure');}return result;};
  const result=await f.media.renderer.renderForegroundParts(plan,parts,f.root);
  assert.equal(rejected,true);assert.equal(result.renderedSeconds,22);
  for(const part of result.files){assert.equal(hashes(part.file).length,660);run(ffmpeg,['-v','error','-xerror','-i',part.file,'-f','null','-']);}
  assert.equal(f.media.children.size,0);assert.equal(sourceReaderCount(f.store,f.source.id),0);
});

test('cancelling an actual shared decoder drains both cache producers and every source reader',async t=>{
  const f=await fixture(t),controller=new AbortController(),spawn=f.media.spawnTracked.bind(f.media);let cancelled=false;
  f.media.spawnTracked=(tool,args,...rest)=>{const child=spawn(tool,args,...rest);if(args.includes('segment')){cancelled=true;setTimeout(()=>controller.abort(),10);}return child;};
  const pending=f.media.prepareNext(f.session.id,{signal:controller.signal});
  await assert.rejects(pending,e=>e.name==='AbortError'||e.code==='PREP_CANCELLED');
  assert.equal(cancelled,true);assert.equal(f.media.children.size,0);assert.equal(f.media.renderCache.reserved,0);assert.equal(f.media.renderCache.building.size,0);
  assert.equal(f.media.renderCache.entries.size,0);assert.equal(sourceReaderCount(f.store,f.source.id),0);
});

test('a shared decoder reservation failure or cancellation settles every waiting producer',async()=>{
  const group=renderRendezvous(2,async()=>assert.fail('decoder must not start')),controller=new AbortController();
  const one=group.render(0,'unused',{signal:controller.signal});controller.abort();await assert.rejects(one,{code:'PREP_CANCELLED'});await group.settle();
  const skipped=renderRendezvous(2,async files=>assert.deepEqual(files,[null,'part']));skipped.skip(0);await skipped.render(1,'part');await skipped.settle();
});

async function heldPreparation(f){
  let release,started=false;const original=f.media.renderer.renderVideo.bind(f.media.renderer);
  f.media.renderer.renderVideo=async(...args)=>{
    started=true;const signal=args[5]?.signal;
    await new Promise((resolve,reject)=>{
      const abort=()=>reject(Object.assign(new Error('cancelled'),{name:'AbortError'}));
      release=()=>{signal?.removeEventListener('abort',abort);resolve();};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });
    return original(...args);
  };
  f.preparation.enqueue(f.session.id);const work=f.preparation.tick();await until(()=>started);
  return {work,release:()=>release()};
}

test('a matching export takes over the running prepared block without cancelling and re-encoding it',async t=>{
  const f=await fixture(t,{duration:4,blocks:60,start:0}),held=await heldPreparation(f),active=f.preparation.active;
  const job=await f.enqueue();assert.equal(active.controller.signal.aborted,false);assert.equal(f.media.preparationHandoffs.size,1);
  let done=false;const exporting=f.media.exportJob(job).then(file=>{done=true;return file;});
  await f.preparation.tick();await turn();assert.equal(active.controller.signal.aborted,false);assert.equal(done,false);
  held.release();await held.work;await exporting;assert.equal(job.preparationHandoff,true);assert.equal(job.renderedVideoSeconds,0);
  const intermediate=await atoms([...f.media.renderCache.entries.values()][0].file);assert.ok(intermediate.indexOf('mdat')<intermediate.indexOf('moov'));
  for(const file of [job.output.file,job.output.danmakuFile]){const order=await atoms(file);assert.ok(order.indexOf('moov')<order.indexOf('mdat'));}
  assert.equal(f.media.preparationHandoffs.size,0);assert.equal(f.media.renderCache.busySession(f.session.id),false);
});

test('a style change rejects takeover and safely cancels the incompatible background render',async t=>{
  const f=await fixture(t,{duration:4,blocks:60}),held=await heldPreparation(f),active=f.preparation.active;
  f.store.setting(DANMAKU_STYLE_SETTING,{size:1.5,opacity:100,speed:1,fps:60});
  const job=await f.enqueue();await held.work;assert.equal(active.controller.signal.aborted,true);assert.equal(f.media.preparationHandoffs.size,0);
  await f.media.exportJob(job);assert.equal(job.preparationHandoff,undefined);
});

test('a short clip does not wait for the unrelated remainder of a long prepared block',async t=>{
  const f=await fixture(t,{duration:4,blocks:60,start:0}),held=await heldPreparation(f),active=f.preparation.active;
  const job=await f.media.enqueue(f.session.id,{scope:'clips',mode:'dual',ranges:[{start:1,end:2}],exportDirectory:path.join(f.root,'exports')});
  await held.work;assert.equal(active.controller.signal.aborted,true);assert.equal(f.media.preparationHandoffs.size,0);
  await f.media.exportJob(job);assert.equal(job.preparationHandoff,undefined);
});

test('a large zero-cache CPU export retains its regular full-source path rather than waiting for the first background block',async t=>{
  const f=await fixture(t);f.media.sequenceRendering=false;const held=await heldPreparation(f),active=f.preparation.active,job=await f.enqueue();
  await held.work;assert.equal(active.controller.signal.aborted,true);assert.equal(f.media.preparationHandoffs.size,0);
  await f.media.exportJob(job);assert.equal(job.preparationHandoff,undefined);assert.equal(job.preparedBlocks,undefined);
});

test('cancelling an export waiting for its prepared block releases the consumer and background reservation',async t=>{
  const f=await fixture(t,{duration:4,blocks:60}),held=await heldPreparation(f),job=await f.enqueue();
  f.store.run("UPDATE jobs SET status='running' WHERE id=?",job.id);
  const exporting=f.media.exportJob(job);const rejected=assert.rejects(exporting,{code:'EXPORT_CANCELLED'});await until(()=>f.media.exportOperations.has(job.id));
  await f.media.cancelExport(job.id);await rejected;await held.work;
  assert.equal(f.media.preparationHandoffs.size,0);assert.equal(f.media.renderCache.reserved,0);assert.equal(f.media.children.size,0);
});

test('a newly started recording preempts a block retained by an export consumer',async t=>{
  const f=await fixture(t,{duration:4,blocks:60}),held=await heldPreparation(f),job=await f.enqueue(),active=f.preparation.active;
  f.state.recording=true;await f.preparation.tick();await held.work;assert.equal(active.controller.signal.aborted,true);
  await f.media.cancelExport(job.id);assert.equal(f.media.preparationHandoffs.size,0);
});
