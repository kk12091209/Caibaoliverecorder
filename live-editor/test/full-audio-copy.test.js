import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {Store} from '../server/store.js';
import {Ingestor} from '../server/ingest.js';
import {Media} from '../server/media.js';
import {clipFile} from '../server/output-names.js';

const runtime=path.resolve('..','..','程序组件','runtime','ffmpeg');
const ffmpeg=process.env.FFMPEG_PATH||path.join(runtime,'ffmpeg.exe'),ffprobe=process.env.FFPROBE_PATH||path.join(runtime,'ffprobe.exe');
const run=(tool,args)=>execFileSync(tool,args,{windowsHide:true,encoding:'utf8'});
const audioPackets=file=>JSON.parse(run(ffprobe,['-v','error','-select_streams','a:0','-show_packets','-show_data_hash','sha256','-show_entries','packet=pts_time,dts_time,data_hash','-of','json',file])).packets;
const streams=file=>JSON.parse(run(ffprobe,['-v','error','-show_entries','stream=codec_type,r_frame_rate,has_b_frames,start_time:format=duration','-of','json',file]));
const audioCodec=args=>args[args.indexOf('-c:a')+1];

async function fixture(t,{audio=true}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-full-audio-'));let store,media;
  t.after(async()=>{
    media?.close();if(media)await media.waitForSaves();store?.close();
    const relative=path.relative(await fs.realpath(os.tmpdir()),await fs.realpath(root));
    assert.ok(relative.startsWith('bili-full-audio-')&&!relative.includes(path.sep));await fs.rm(root,{recursive:true,force:true});
  });
  const file=path.join(root,'fixture.flv');
  run(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=30',
    ...(audio?['-itsoffset','0.12','-f','lavfi','-i','sine=frequency=440:sample_rate=48000']:[]),
    '-t','2.4','-c:v','libx264','-preset','veryfast','-g','30','-bf','2','-pix_fmt','yuv420p',...(audio?['-c:a','aac']:['-an']),'-y',file]);
  store=new Store(path.join(root,'data'));store.projectRoot=root;
  const session=store.createSession({status:'finished'}),source=store.addSource(session.id,file,0,session.created,true);
  await fs.writeFile(source.xml,'<i><d p="0.3,1,25,16777215,0,0,0,0">Audio copy test</d></i>');
  const ingest=new Ingestor(store);for(let i=0;i<3;i++)await ingest.tick();
  media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software'});media.work=async()=>{};
  const calls=[],process=media.process.bind(media);media.process=async(args,options)=>{calls.push(args);return process(args,options);};
  const exported=async input=>{const job=await media.enqueue(session.id,{scope:'full',mode:'danmaku',exportDirectory:path.join(root,'exports'),...input});return {job,file:await media.exportJob(job)};};
  return {root,file,store,source,media,calls,process,exported};
}

test('cold full baked and dual exports copy every AAC packet and its offset with B-frame video',async t=>{
  const f=await fixture(t);assert.equal(streams(f.file).streams.find(s=>s.codec_type==='video').has_b_frames,2);
  const reference=await f.exported({mode:'clean'}),expected=audioPackets(reference.file);
  assert.ok(Number(expected[0].pts_time)>.05,`fixture must retain a positive audio delay, got ${expected[0].pts_time}`);
  for(const mode of ['danmaku','dual']) {
    f.calls.length=0;const result=await f.exported({mode}),baked=mode==='dual'?clipFile(result.file,'danmaku'):result.file;
    assert.equal(f.calls.length,1);assert.equal(audioCodec(f.calls[0]),'copy');assert.equal(result.job.audioStreamCopy,true);
    const actual=audioPackets(baked);assert.deepEqual(actual.map(p=>p.data_hash),expected.map(p=>p.data_hash));
    assert.equal(actual.length,expected.length);
    for(let i=0;i<actual.length;i++)assert.ok(Math.abs(Number(actual[i].pts_time)-Number(expected[i].pts_time))<.002,`packet ${i}: ${actual[i].pts_time} / ${expected[i].pts_time}`);
    assert.equal(streams(baked).streams.find(s=>s.codec_type==='video').r_frame_rate,'60/1');
    if(mode==='dual')assert.deepEqual(audioPackets(result.file),expected);
    run(ffmpeg,['-v','error','-xerror','-i',baked,'-f','null','-']);
  }
});

test('precise clips still encode audio and audio-free full exports keep an optional audio map',async t=>{
  const f=await fixture(t),result=await f.exported({scope:'clips',ranges:[{start:.25,end:1.5}]});
  assert.equal(audioCodec(f.calls.at(-1)),'aac');assert.equal(result.job.audioStreamCopy,undefined);
  assert.ok(Math.abs(Number(streams(result.file).format.duration)-1.25)<.08);
  const silent=await fixture(t,{audio:false}),output=await silent.exported({mode:'dual'});
  assert.ok(silent.calls[0].includes('0:a:0?'));
  for(const file of [output.file,clipFile(output.file,'danmaku')])assert.deepEqual(streams(file).streams.map(s=>s.codec_type),['video']);
});

test('GPU failure retains full AAC copying on the existing software retry',async t=>{
  const f=await fixture(t);f.media.exportEncoder=Promise.resolve({id:'test_hardware',hardware:true,label:'test',args:[]});
  f.media.process=async(args,options)=>{f.calls.push(args);if(args.includes('test_hardware'))throw new Error('GPU device lost');return f.process(args,options);};
  const result=await f.exported({mode:'danmaku'});
  assert.equal(f.calls.length,2);assert.equal(audioCodec(f.calls[0]),'copy');assert.equal(audioCodec(f.calls[1]),'copy');
  assert.equal(result.job.encoderFallback,true);assert.equal(result.job.audioStreamCopy,true);assert.equal(result.job.audioStreamCopyFallback,undefined);
});

test('an explicit rejected AAC copy retries encoded audio while preserving compatible clean video copy',async t=>{
  const f=await fixture(t);let rejected=false;
  f.media.process=async(args,options)=>{f.calls.push(args);if(!rejected&&audioCodec(args)==='copy'){rejected=true;throw new Error('Malformed AAC bitstream detected');}return f.process(args,options);};
  const result=await f.exported({mode:'dual'});
  assert.equal(f.calls.length,2);assert.equal(audioCodec(f.calls[1]),'aac');
  assert.equal(f.calls[1][f.calls[1].indexOf('-c:v')+1],'copy');
  assert.equal(result.job.audioStreamCopyFallback,true);assert.equal(result.job.audioStreamCopy,undefined);
  assert.equal(result.job.cleanStreamCopy,true);
  for(const file of [result.file,clipFile(result.file,'danmaku')])assert.ok(audioPackets(file).length>0);
});
