import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {sourceExportPlan} from '../server/export-plan.js';
import {Store} from '../server/store.js';
import {Ingestor} from '../server/ingest.js';
import {Media} from '../server/media.js';
import {clipFile} from '../server/output-names.js';
import {sourceReaderCount} from '../server/storage-files.js';
import {CompactStorage} from '../server/compact-storage.js';

const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',ffprobe=process.env.FFPROBE_PATH||'ffprobe';
const run=(tool,args)=>execFileSync(tool,args,{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
const packets=(file,stream)=>JSON.parse(run(ffprobe,['-v','error','-select_streams',stream,'-show_packets','-show_data_hash','sha256','-show_entries','packet=pts_time,dts_time,data_hash','-of','json',file])).packets;
const inspect=file=>JSON.parse(run(ffprobe,['-v','error','-count_frames','-show_entries','stream=codec_type,r_frame_rate,nb_read_frames,start_time,duration:format=duration','-of','json',file]));
const frameHashes=file=>run(ffmpeg,['-v','error','-i',file,'-map','0:v:0','-f','framemd5','-']).split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>line.split(',').at(-1).trim());

async function fixture(t,{mismatch=false,silent=false,count=2,bframes=2,delay=.12,managed=false}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-source-export-'));
  const store=new Store(path.join(root,'data'));store.projectRoot=root;
  const session=store.createSession({status:'finished'}),ingest=new Ingestor(store);
  const media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software',renderBlockSeconds:2,renderCacheOptions:{minFreeBytes:0,maxBytes:512*1024*1024}});media.work=async()=>{};
  t.after(async()=>{media.close();await media.waitForSaves();store.close();assert.ok(path.basename(root).startsWith('bili-source-export-'));await fs.rm(root,{recursive:true,force:true});});
  const files=[];
  for(let i=0;i<count;i++){
    const directory=managed?path.join(store.root,'originals'):root;await fs.mkdir(directory,{recursive:true});
    const file=path.join(directory,`source-${i}.flv`);files.push(file);
    run(ffmpeg,['-v','error','-f','lavfi','-i',`testsrc2=size=${mismatch&&i?'192x108':'160x90'}:rate=30`,
      ...(!silent?['-itsoffset',String(delay),'-f','lavfi','-i',`sine=frequency=${440+i*220}:sample_rate=48000`]:[]),
      '-t','3.4','-c:v','libx264','-preset','veryfast','-g','30','-bf',String(bframes),'-pix_fmt','yuv420p',...(!silent?['-c:a','aac']:['-an']),'-y',file]);
    const source=store.addSource(session.id,file,i?store.session(session.id).duration+5:0,session.created,true);
    await fs.writeFile(source.xml,'<i><d p="0.3,1,25,16777215,0,0,0,0">reconnect boundary</d></i>');
    for(let n=0;n<3;n++)await ingest.tick();
  }
  const calls=[],process=media.process.bind(media);media.process=async(args,options)=>{calls.push(args);return process(args,options);};
  const exported=async(mode='clean',options={})=>{const job=await media.enqueue(session.id,{scope:'full',mode,exportDirectory:path.join(root,'exports'),...options});return {job,file:await media.exportJob(job)};};
  const prepare=async()=>{for(let i=0;i<20;i++)if((await media.prepareNext(session.id,{})).done)return;assert.fail('preparation did not finish');};
  return {root,store,session,media,files,calls,process,exported,prepare};
}

test('multi-source original export copies video/AAC payloads, omits the real outage and preserves delay at the reconnect',async t=>{
  const f=await fixture(t),result=await f.exported(),sources=f.store.sources(f.session.id);
  assert.equal(result.job.cleanStreamCopy,true);assert.equal(result.job.audioStreamCopy,true);
  assert.equal(f.calls.filter(args=>args.includes('libx264')).length,0);
  assert.ok(f.calls.every(args=>args.includes('copy')));
  const expected=sources.reduce((sum,s)=>sum+s.duration,0),metadata=inspect(result.file);
  assert.ok(Math.abs(Number(metadata.format.duration)-expected)<.1);
  assert.equal(metadata.streams.find(s=>s.codec_type==='video').r_frame_rate,'30/1');
  for(const stream of ['v:0','a:0']){
    const actual=packets(result.file,stream),original=f.files.flatMap(file=>packets(file,stream));
    // concat's automatic H.264 bitstream filter may repeat SPS/PPS on IDRs.
    // Compare every decoded picture; AAC payloads remain byte-for-byte equal.
    if(stream==='a:0')assert.deepEqual(actual.map(p=>p.data_hash),original.map(p=>p.data_hash));
    else assert.deepEqual(frameHashes(result.file),f.files.flatMap(frameHashes));
    for(let i=1;i<actual.length;i++)assert.ok(Number(actual[i].dts_time)>=Number(actual[i-1].dts_time),'monotonic decode timestamps');
  }
  const audio=packets(result.file,'a:0'),offset=packets(f.files[0],'a:0').length;
  assert.ok(Number(audio[0].pts_time)>.05);
  assert.ok(Math.abs(Number(audio[offset].pts_time)-sources[0].duration-Number(audio[0].pts_time))<.003);
  run(ffmpeg,['-v','error','-xerror','-i',result.file,'-f','null','-']);
  for(const source of sources)assert.equal(sourceReaderCount(f.store,source.id),0);
});

for(const count of [1,2])test(`whole-source copy retains leading AAC before a 21ms video keyframe (${count} source)`,async t=>{
  const f=await fixture(t,{count,bframes:0,delay:0}),sources=f.store.sources(f.session.id);
  const job={scope:'full',ranges:[{start:0,end:f.store.session(f.session.id).duration}],linkmicEvents:[]};
  const plan=await sourceExportPlan(f.media,job,sources);
  assert.ok(plan.entries.every(entry=>entry.wholeFromSource));assert.equal(plan.canCopyOriginal,true);
  const result=await f.exported();assert.equal(result.job.cleanStreamCopy,true);
  assert.equal(f.calls.some(args=>args.includes('libx264')),false);
  assert.deepEqual(frameHashes(result.file),f.files.flatMap(frameHashes));
  // Export intervals are half-open. Ingest duration is the last packet's
  // timestamp, so a packet beginning exactly at that end is outside the range.
  const expected=f.files.flatMap((file,index)=>packets(file,'a:0').filter(p=>Number(p.dts_time)<sources[index].duration));
  assert.deepEqual(packets(result.file,'a:0').map(p=>p.data_hash),expected.map(p=>p.data_hash));
  const metadata=inspect(result.file),video=metadata.streams.find(s=>s.codec_type==='video'),audio=metadata.streams.find(s=>s.codec_type==='audio');
  assert.ok(Math.abs(Number(video.start_time)-Number(audio.start_time)-.021)<.002);
  run(ffmpeg,['-v','error','-xerror','-i',result.file,'-f','null','-']);
});

test('whole-source reading also retains leading audio after verified compact storage removes transient chunks',async t=>{
  const f=await fixture(t,{bframes:0,delay:0,managed:true}),storage=new CompactStorage(f.store,{isBusy:()=>false});
  try{
    for(const source of f.store.sources(f.session.id))f.store.run('INSERT INTO source_storage(source,eligible) VALUES(?,1)',source.id);
    for(let i=0;i<3;i++)await storage.tick();
    for(const source of f.store.sources(f.session.id))assert.equal(f.store.get('SELECT mode FROM source_storage WHERE source=?',source.id).mode,'direct');
    const result=await f.exported();assert.equal(result.job.cleanStreamCopy,true);
    assert.deepEqual(frameHashes(result.file),f.files.flatMap(frameHashes));
    assert.equal(Number(packets(result.file,'a:0')[0].pts_time),0);
  }finally{await storage.close();}
});

test('prepared dual export reuses every baked block and the copied original AAC for both final files',async t=>{
  const f=await fixture(t);await f.prepare();f.calls.length=0;
  const result=await f.exported('dual'),baked=clipFile(result.file,'danmaku');
  assert.ok(result.job.preparedBlocks>0);assert.equal(result.job.preparationFallback,undefined);
  assert.equal(result.job.cleanStreamCopy,true);assert.equal(result.job.audioStreamCopy,true);
  assert.ok(!f.calls.some(args=>args.includes('libx264')||args.includes('flac')||args.includes('aac')));
  assert.deepEqual(packets(baked,'a:0'),packets(result.file,'a:0'));
  for(const file of [result.file,baked])run(ffmpeg,['-v','error','-xerror','-i',file,'-f','null','-']);
  assert.equal(inspect(baked).streams.find(s=>s.codec_type==='video').r_frame_rate,'60/1');
});

test('different reconnect geometry rejects original copying and keeps the established normalized export',async t=>{
  const f=await fixture(t,{mismatch:true}),result=await f.exported();
  assert.equal(result.job.cleanStreamCopyEligible,false);assert.notEqual(result.job.cleanStreamCopy,true);
  assert.match(result.job.cleanEncodingReason,/编码/);assert.ok(f.calls.some(args=>args.includes('libx264')));
  run(ffmpeg,['-v','error','-xerror','-i',result.file,'-f','null','-']);
});

test('a failed multi-source remux restarts the complete clean output consistently and releases every input',async t=>{
  const f=await fixture(t);let fail=true,encoderSelections=0;
  const select=f.media.selectExportEncoder.bind(f.media);f.media.selectExportEncoder=()=>{encoderSelections++;return select();};
  f.media.process=async(args,options)=>{f.calls.push(args);if(fail&&args.includes('original-concat.txt')){fail=false;throw new Error('injected mux failure');}return f.process(args,options);};
  const result=await f.exported();assert.equal(result.job.streamCopyFallback,true);assert.equal(result.job.cleanStreamCopy,false);
  assert.equal(f.calls.filter(args=>args.includes('libx264')).length,2);
  assert.equal(encoderSelections,1,'select an available encoder after copy failure');
  run(ffmpeg,['-v','error','-xerror','-i',result.file,'-f','null','-']);
  for(const source of f.store.sources(f.session.id))assert.equal(sourceReaderCount(f.store,source.id),0);
});

test('a failed original mux in a prepared dual export keeps the validated baked blocks',async t=>{
  const f=await fixture(t);await f.prepare();f.calls.length=0;let fail=true;
  f.media.process=async(args,options)=>{f.calls.push(args);if(fail&&args.includes('original-concat.txt')){fail=false;throw new Error('injected original mux failure');}return f.process(args,options);};
  const result=await f.exported('dual');assert.ok(result.job.preparedBlocks>0);assert.equal(result.job.preparationFallback,undefined);
  assert.equal(result.job.streamCopyFallback,true);assert.equal(result.job.cleanStreamCopy,false);
  assert.equal(f.calls.some(args=>args.includes('-frames:v')),false,'do not render any burned-in block twice');
  for(const file of [result.file,clipFile(result.file,'danmaku')])run(ffmpeg,['-v','error','-xerror','-i',file,'-f','null','-']);
});

test('cancellation between original parts publishes nothing and releases source leases and processes',async t=>{
  const f=await fixture(t),job=await f.media.enqueue(f.session.id,{scope:'full',mode:'clean',exportDirectory:path.join(f.root,'exports')});
  f.media.process=async(args,options)=>{
    const value=await f.process(args,options);
    if(args.includes('original-0.mp4'))f.media.exportOperations.get(job.id).controller.abort();
    return value;
  };
  await assert.rejects(f.media.exportJob(job),{code:'EXPORT_CANCELLED'});
  await assert.rejects(fs.stat(job.output.file),{code:'ENOENT'});
  assert.equal(f.media.children.size,0);
  for(const source of f.store.sources(f.session.id))assert.equal(sourceReaderCount(f.store,source.id),0);
});

test('an explicit AAC mux rejection repairs only audio and retains the prepared pictures',async t=>{
  const f=await fixture(t,{count:1});await f.prepare();f.calls.length=0;let fail=true;
  f.media.process=async(args,options)=>{f.calls.push(args);if(fail&&args.includes('final.mp4')&&args.includes('copy')){fail=false;throw new Error('malformed AAC bitstream');}return f.process(args,options);};
  const result=await f.exported('dual');assert.equal(result.job.audioStreamCopyFallback,true);
  assert.ok(result.job.preparedBlocks>0);assert.equal(result.job.preparationFallback,undefined);
  assert.equal(f.calls.some(args=>args.includes('-frames:v')),false);
  assert.ok(f.calls.some(args=>args.includes('flac')));
  for(const file of [result.file,clipFile(result.file,'danmaku')])run(ffmpeg,['-v','error','-xerror','-i',file,'-f','null','-']);
});

test('silent multi-source clean and prepared dual exports keep both outputs video-only',async t=>{
  const f=await fixture(t,{silent:true});await f.prepare();const result=await f.exported('dual');
  assert.equal(result.job.cleanStreamCopy,true);
  for(const file of [result.file,clipFile(result.file,'danmaku')])assert.deepEqual(inspect(file).streams.map(s=>s.codec_type),['video']);
});

test('source plan rejects exact clips, overlays and an internal codec epoch even when the first probe matches',async t=>{
  const f=await fixture(t),sources=f.store.sources(f.session.id),info=await f.media.probeSource(sources[0]);
  const job={scope:'full',ranges:[{start:0,end:f.store.session(f.session.id).duration}],linkmicEvents:[]};
  assert.equal((await sourceExportPlan(f.media,job,sources,info)).canCopyOriginal,true);
  assert.equal((await sourceExportPlan(f.media,{...job,scope:'clips',ranges:[{start:.3,end:2}]},sources,info)).canCopyOriginal,false);
  await assert.rejects(sourceExportPlan(f.media,{...job,scope:'clips'},sources,info),/断流空缺/);
  assert.equal((await sourceExportPlan(f.media,{...job,linkmicEvents:[{participants:[{}]}]},sources,info)).canCopyOriginal,false);
  const header=JSON.parse(f.store.get('SELECT header FROM chunk_identities WHERE source=? LIMIT 1',sources[1].id).header);
  const tag=Buffer.from(header.video,'base64');tag[13]^=1;header.video=tag.toString('base64');
  f.store.run('UPDATE chunk_identities SET header=? WHERE source=? AND seq=(SELECT MAX(seq) FROM chunk_identities WHERE source=?)',JSON.stringify(header),sources[1].id,sources[1].id);
  assert.equal((await sourceExportPlan(f.media,job,sources,info)).canCopyOriginal,false);
});
