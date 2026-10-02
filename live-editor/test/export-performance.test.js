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
import {detectExportEncoder,softwareEncoder,encoderArguments} from '../server/export-encoding.js';

const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',ffprobe=process.env.FFPROBE_PATH||'ffprobe';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-export-performance-'));
const fixture=path.join(root,'black.flv');
execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=black:size=480x270:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','5','-c:v','libx264','-preset','ultrafast','-g','60','-bf','0','-c:a','aac','-y',fixture]);
await fs.writeFile(fixture.replace('.flv','.xml'),'<i><d p="0.1,1,25,16777215,0,0,0,0">Moving danmaku test</d></i>');
const opened=[];
async function setup(name) {
  const store=new Store(path.join(root,name));opened.push(store);
  const session=store.createSession({title:'性能验证',status:'finished'});
  store.addSource(session.id,fixture,0,new Date().toISOString(),true);
  const ingest=new Ingestor(store);for(let i=0;i<3;i++)await ingest.tick();
  return {store,session,media:new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software'})};
}
const inspect=file=>JSON.parse(execFileSync(ffprobe,['-v','error','-show_entries','format=duration:stream=codec_type,r_frame_rate','-of','json',file],{windowsHide:true,encoding:'utf8'}));

test('省略帧率选项时弹幕版默认 60 帧：每帧重新绘制，纯净版保持源帧率与音频',async()=>{
  const {store,session,media}=await setup('smooth');
  try {
    media.work=async()=>{};
    const queued=await media.enqueue(session.id,{ranges:[{start:.1,end:3.1}]});
    assert.equal(queued.mode,'dual');assert.equal(Object.hasOwn(queued,'danmakuFps'),false);
    const job=JSON.parse(store.get('SELECT data FROM jobs WHERE id=?',queued.id).data);
    const file=await media.exportJob(job);
    const pure=inspect(file),baked=inspect(clipFile(file,'danmaku'));
    assert.equal(pure.streams.find(s=>s.codec_type==='video').r_frame_rate,'30/1');
    assert.equal(baked.streams.find(s=>s.codec_type==='video').r_frame_rate,'60/1');
    for(const info of [pure,baked]){assert.ok(info.streams.some(s=>s.codec_type==='audio'));assert.ok(Math.abs(Number(info.format.duration)-3)<.12);}
    const frames=execFileSync(ffmpeg,['-v','error','-ss','1','-i',clipFile(file,'danmaku'),'-frames:v','3','-vf','crop=480:70:0:0','-pix_fmt','gray','-f','rawvideo','pipe:1'],{windowsHide:true});
    const frameBytes=480*70;assert.equal(frames.length,frameBytes*3);
    assert.notDeepEqual(frames.subarray(0,frameBytes),frames.subarray(frameBytes,frameBytes*2));
    assert.notDeepEqual(frames.subarray(frameBytes,frameBytes*2),frames.subarray(frameBytes*2));
  } finally {media.close();store.close();}
});

test('三种导出版本保持各自文件与帧率，拒绝已停用的导出参数',async()=>{
  const {store,session,media}=await setup('retired-fps');media.work=async()=>{};
  try {
    for(const mode of ['dual','danmaku','clean']) {
      const queued=await media.enqueue(session.id,{ranges:[{start:.1,end:1.1}],mode});
      assert.equal(Object.hasOwn(queued,'danmakuFps'),false);
      const saved=JSON.parse(store.get('SELECT data FROM jobs WHERE id=?',queued.id).data);
      const file=await media.exportJob(saved),fps=target=>inspect(target).streams.find(s=>s.codec_type==='video').r_frame_rate;
      if(mode==='danmaku'){
        assert.equal(fps(file),'60/1');assert.ok(path.basename(file).startsWith('【弹幕版】'));
      } else {
        assert.equal(fps(file),'30/1');
        if(mode==='dual')assert.equal(fps(clipFile(file,'danmaku')),'60/1');
        else await assert.rejects(fs.access(clipFile(file,'danmaku')),/ENOENT/);
      }
      const stored=JSON.parse(store.get('SELECT data FROM jobs WHERE id=?',queued.id).data);
      assert.equal(Object.hasOwn(stored,'danmakuFps'),false);assert.equal(stored.output.sidecars,false);assert.equal(stored.output.namingVersion,2);
      if(mode!=='clean')assert.equal(stored.output.danmakuFile,clipFile(file,'danmaku'));
      const files=await fs.readdir(path.dirname(file));assert.equal(files.length,mode==='dual'?2:1);assert.ok(files.every(name=>name.endsWith('.mp4')));
    }
    for(const option of [{burn:true},{includeDanmaku:false},{danmakuFps:30}])await assert.rejects(media.enqueue(session.id,{ranges:[{start:.1,end:1.1}],...option}),/不支持的导出选项/);
  } finally {media.close();store.close();}
});

test('硬件编码中途失败会用软件重做所有片段，清理失败尝试并在数据库保留编码记录',async()=>{
  const {store,session,media}=await setup('fallback');
  const process=media.process.bind(media),calls=[],workDirectories=new Set();let acceleratedParts=0;
  media.exportEncoder=Promise.resolve({id:'test_hardware',label:'测试硬编',hardware:true,args:[]});
  media.process=async(args,options)=>{
    if(options?.cwd)workDirectories.add(options.cwd);
    if(args.includes('test_hardware')) {
      calls.push('hardware');acceleratedParts++;
      if(acceleratedParts===2)throw new Error('Simulated GPU device lost after the first part');
      // Test the retry flow without depending on a particular test machine GPU.
      args=[...args];const i=args.indexOf('test_hardware');args.splice(i-1,2,...encoderArguments(softwareEncoder()));
    } else if(args.includes('libx264'))calls.push('software');
    return process(args,options);
  };
  try {
    media.work=async()=>{};
    // Old persisted jobs can still contain several merged ranges.
    const {jobs}=await media.enqueue(session.id,{ranges:[{start:.1,end:1.6},{start:2.1,end:3.6}],mode:'clean'});
    const job={...jobs[0],ranges:[{start:.1,end:1.6},{start:2.1,end:3.6}]},file=await media.exportJob(job);
    assert.deepEqual(calls,['hardware','hardware','software','software']);
    const info=inspect(file);assert.ok(Math.abs(Number(info.format.duration)-3)<.12);assert.equal(info.streams.length,2);
    const manifest=JSON.parse(store.get('SELECT data FROM jobs WHERE id=?',job.id).data);
    assert.equal(manifest.encoder,'libx264');assert.equal(manifest.encoderFallback,true);
    assert.equal((await media.exportEncoder).id,'libx264');
    assert.equal(workDirectories.size,2);for(const dir of workDirectories){assert.equal(path.dirname(dir),path.join(store.root,'temp'));await assert.rejects(fs.access(dir),/ENOENT/);}
    assert.deepEqual(await fs.readdir(path.dirname(file)),[path.basename(file)]);
    execFileSync(ffmpeg,['-v','error','-xerror','-i',file,'-f','null','-'],{windowsHide:true});
  } finally {media.close();store.close();}
});

test('检测硬编使用实际双输出编码，驱动不可用时降级且关闭后不再启动任务',async()=>{
  const probes=[];
  const encoder=await detectExportEncoder(async(args)=>{probes.push(args);throw new Error('No compatible GPU');},{platform:'win32'});
  assert.equal(encoder.id,'libx264');assert.equal(probes.length,3);
  for(const args of probes){assert.equal(args.filter(v=>v==='-frames:v').length,2);assert.ok(args.includes('lavfi'));}
  const {store,session,media}=await setup('closed');media.close();
  await assert.rejects(media.exportJob({session:session.id}),/关闭/);store.close();
});

test.after(async()=>{for(const store of opened)try{store.close();}catch{};await fs.rm(root,{recursive:true,force:true});});
