import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {Store} from '../server/store.js';
import {Ingestor,seekBase,tags,timestamp} from '../server/ingest.js';
import {Media} from '../server/media.js';
import {frameSpan} from '../server/render-plan.js';
import {sourceReaderCount} from '../server/storage-files.js';

const runtime=path.resolve('..','..','程序组件','runtime','ffmpeg');
const ffmpeg=process.env.FFMPEG_PATH||path.join(runtime,'ffmpeg.exe'),ffprobe=process.env.FFPROBE_PATH||path.join(runtime,'ffprobe.exe');
const run=(tool,args)=>execFileSync(tool,args,{windowsHide:true,maxBuffer:16*1024*1024});
const pcm=file=>run(ffmpeg,['-v','error','-i',file,'-map','0:a:0','-ar','48000','-ac','1','-f','f32le','pipe:1']);
const inspect=file=>JSON.parse(run(ffprobe,['-v','error','-show_entries','stream=codec_name,sample_rate,channels,start_time,duration','-of','json',file]));
const packets=file=>JSON.parse(run(ffprobe,['-v','error','-select_streams','a:0','-show_packets','-show_data_hash','sha256','-show_entries','packet=pts_time,data_hash','-of','json',file])).packets;
function rms(bytes,from,to) {
  let sum=0,count=0;
  for(let i=Math.round(from*48000);i<Math.min(bytes.length/4,Math.round(to*48000));i++){const value=bytes.readFloatLE(i*4);sum+=value*value;count++;}
  return Math.sqrt(sum/Math.max(1,count));
}

async function fixture(t,{audio=true,delay=.25,gap=false,bframes=2}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-direct-audio-'));
  const store=new Store(path.join(root,'data'));store.projectRoot=root;
  const media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software'});media.work=async()=>{};
  t.after(async()=>{media.close();await media.waitForSaves();store.close();assert.ok(path.basename(root).startsWith('bili-direct-audio-'));await fs.rm(root,{recursive:true,force:true});});
  const file=path.join(root,'source.flv');
  run(ffmpeg,['-v','error','-f','lavfi','-i','color=c=black:size=160x90:rate=30',
    ...(audio?['-itsoffset',String(delay),'-f','lavfi','-i','sine=frequency=440:sample_rate=48000']:[]),
    '-t','3.2','-c:v','libx264','-preset','ultrafast','-g','30','-bf',String(bframes),'-pix_fmt','yuv420p',...(audio?['-c:a','aac']:['-an']),'-y',file]);
  if(gap) {
    const bytes=await fs.readFile(file);
    const keep=tags(bytes.subarray(13)).items.filter(({tag})=>!(tag[0]===8&&tag[12]===1&&timestamp(tag)>=1200&&timestamp(tag)<1700));
    await fs.writeFile(file,Buffer.concat([bytes.subarray(0,13),...keep.map(({tag})=>tag)]));
  }
  const session=store.createSession({status:'finished'}),original=store.addSource(session.id,file,0,session.created,true);
  await fs.writeFile(original.xml,'<i></i>');
  const ingest=new Ingestor(store);for(let i=0;i<3;i++)await ingest.tick();
  const source=store.sources(session.id)[0],info=await media.probeSource(source,0);
  const plan={sources:[source],info,profile:{fps:60}},calls=[],process=media.process.bind(media);
  media.process=async(args,options)=>{calls.push({args,options});return process(args,options);};
  const prepare=async(ranges,{scope='clips',suffix='output',actualPlan=plan}={})=>{
    const directory=path.join(root,suffix);await fs.mkdir(directory);
    const segments=ranges.map(({from,to,source: selected=source})=>({source:selected,from,to}));
    const job={scope,ranges:ranges.map(({from,to})=>({start:from,end:to}))};
    const name=await media.renderer.audio(segments,actualPlan,directory,job);
    return {file:name&&path.join(directory,name),directory,segments,job};
  };
  return {root,store,media,source,session,plan,calls,process,prepare};
}

test('single precise audio preserves delayed onset, repairs a timestamp gap and keeps the established conversion path',async t=>{
  const f=await fixture(t,{gap:true}),range={from:.1,to:2.8};
  const result=await f.prepare([range]);
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].args[f.calls[0].args.indexOf('-c:a')+1],'flac');
  assert.deepEqual((await fs.readdir(result.directory)).sort(),['audio-0.flac','audio-concat.txt','audio.m4a']);
  const metadata=inspect(result.file).streams[0],span=frameSpan(range.from,range.to,60);
  assert.equal(metadata.codec_name,'aac');assert.equal(metadata.sample_rate,'48000');assert.equal(metadata.channels,2);
  assert.ok(Math.abs(Number(metadata.duration)-span.duration)<.025);
  const actual=pcm(result.file);
  assert.ok(rms(actual,0,.08)<.001,'leading silence must not move to the end');
  assert.ok(rms(actual,.35,.6)>.04,'the delayed source tone remains audible');
  assert.ok(rms(actual,1.25,1.4)<.002,'missing audio packets remain silence at their original time');
  assert.ok(rms(actual,1.9,2.2)>.04,'sound after the timestamp gap stays at its original time');

  assert.equal(sourceReaderCount(f.store,f.source.id),0);
});

test('a 21ms first keyframe still encodes safely instead of loosening whole-source copy protection',async t=>{
  const f=await fixture(t,{delay:0,bframes:0});
  assert.ok(seekBase(f.store,f.source.id,0)>.001);
  const result=await f.prepare([{from:0,to:f.source.duration}],{scope:'full'});
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].args[f.calls[0].args.indexOf('-c:a')+1],'flac');
  assert.ok(Math.abs(Number(inspect(result.file).streams[0].duration)-frameSpan(0,f.source.duration,60).duration)<.025);
  assert.ok(rms(pcm(result.file),.1,.3)>.04);
});

test('eligible full AAC audio still copies its packet payload and original positive delay',async t=>{
  const f=await fixture(t),result=await f.prepare([{from:0,to:f.source.duration}],{scope:'full'});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].args[f.calls[0].args.indexOf('-c:a')+1],'copy');
  const actual=packets(result.file),source=packets(f.source.path);
  assert.ok(Number(actual[0].pts_time)>.1);
  assert.deepEqual(actual.map(packet=>packet.data_hash),source.map(packet=>packet.data_hash));
  assert.equal(sourceReaderCount(f.store,f.source.id),0);
});

test('a source with no audio returns no track without starting FFmpeg',async t=>{
  const f=await fixture(t,{audio:false}),result=await f.prepare([{from:.2,to:2.6}]);
  assert.equal(result.file,null);assert.equal(f.calls.length,0);assert.deepEqual(await fs.readdir(result.directory),[]);
});

test('multiple disconnected ranges retain lossless stitching and exact clip duration',async t=>{
  const f=await fixture(t),ranges=[{from:.4,to:1.1},{from:2,to:2.8}],result=await f.prepare(ranges);
  assert.equal(f.calls.length,3);assert.equal(f.calls.filter(({args})=>args.includes('flac')).length,2);
  const expected=ranges.reduce((sum,range)=>sum+frameSpan(range.from,range.to,60).duration,0);
  const actual=Number(inspect(result.file).streams[0].duration);
  assert.ok(Math.abs(actual-expected)<.025,`${actual} / ${expected}`);
  const bytes=pcm(result.file);assert.ok(rms(bytes,.68,.72)>.04,'AAC is encoded once across the stitched boundary');
  assert.equal(sourceReaderCount(f.store,f.source.id),0);
});

test('30/60 fps stitching retains a one-frame piece and a silent source between audible pieces',async t=>{
  const f=await fixture(t),silentFile=path.join(f.root,'silent.flv');
  run(ffmpeg,['-v','error','-f','lavfi','-i','color=c=black:size=160x90:rate=30','-t','1','-c:v','libx264','-preset','ultrafast','-g','30','-an','-y',silentFile]);
  const added=f.store.addSource(f.session.id,silentFile,10,f.session.created,true);await fs.writeFile(added.xml,'<i></i>');
  const ingest=new Ingestor(f.store);for(let i=0;i<3;i++)await ingest.tick();
  const silent=f.store.sources(f.session.id).find(source=>source.id===added.id);
  for(const fps of [30,60]) {
    const ranges=[{from:.4,to:.4+1/fps},{from:.6,to:1.3},{source:silent,from:10,to:10.2},{from:2,to:2.8}];
    const plan={...f.plan,sources:[f.source,silent],profile:{fps}};
    const result=await f.prepare(ranges,{suffix:`mixed-${fps}`,actualPlan:plan});
    const expected=ranges.reduce((sum,range)=>sum+frameSpan(range.from,range.to,fps).duration,0);
    assert.ok(Math.abs(Number(inspect(result.file).streams[0].duration)-expected)<.025);
    const bytes=pcm(result.file),silentStart=frameSpan(.4,.4+1/fps,fps).duration+.7;
    assert.ok(rms(bytes,.1,.3)>.04);
    assert.ok(rms(bytes,silentStart+.05,silentStart+.15)<.002,'missing source audio must occupy its own time span');
    assert.ok(rms(bytes,silentStart+.3,silentStart+.5)>.04,'the last audible source must survive concatenation');
  }
  assert.equal(sourceReaderCount(f.store,f.source.id),0);assert.equal(sourceReaderCount(f.store,silent.id),0);
});

test('a decoder-rejected lossless boundary fails instead of reporting a truncated audio file as complete',async t=>{
  const f=await fixture(t),process=f.media.process.bind(f.media);
  f.media.process=async(args,options)=>{
    await process(args,options);
    if(args.at(-1)==='audio-0.flac') {
      // Inject incompatible STREAMINFO precision in our temporary first file,
      // independently of the installed FFmpeg version's tail handling.
      const file=path.join(options.cwd,args.at(-1)),bytes=await fs.readFile(file);
      assert.equal(bytes.toString('ascii',0,4),'fLaC');
      const packed=bytes.readBigUInt64BE(18),precisionMask=31n<<36n;
      bytes.writeBigUInt64BE((packed&~precisionMask)|(15n<<36n),18);await fs.writeFile(file,bytes);
    }
  };
  await assert.rejects(f.prepare([{from:.4,to:1.1},{from:2,to:2.8}]),/blocksize|decode|Invalid data/i);
  assert.equal(f.media.children.size,0);assert.equal(sourceReaderCount(f.store,f.source.id),0);
});

test('cancelled single audio settles its process and source lease without starting a follow-up encode',async t=>{
  const f=await fixture(t),controller=new AbortController();let started;
  const processStarted=new Promise(resolve=>{started=resolve;}),spawn=f.media.spawnTracked.bind(f.media);
  f.media.spawnTracked=(...args)=>{const child=spawn(...args);started();return child;};
  const directory=path.join(f.root,'cancel');await fs.mkdir(directory);
  const promise=f.media.exportContext.run({controller,stages:{}},()=>f.media.renderer.audio(
    [{source:f.source,from:.1,to:2.8}],f.plan,directory,{scope:'clips',ranges:[{start:.1,end:2.8}]}));
  await processStarted;controller.abort();
  await assert.rejects(promise,error=>error.code==='EXPORT_CANCELLED'||error.name==='AbortError');
  assert.equal(f.calls.length,1);assert.equal(f.media.children.size,0);assert.equal(f.media.scheduler.active.size,0);
  assert.equal(sourceReaderCount(f.store,f.source.id),0);
});
