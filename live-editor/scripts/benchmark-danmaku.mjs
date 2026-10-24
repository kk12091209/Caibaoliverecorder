#!/usr/bin/env node
// Node 24+. Isolated fixtures only; source video and supplied baseline are read-only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const exec=promisify(execFile),self=fileURLToPath(import.meta.url),current=path.resolve(path.dirname(self),'..');
const options={};
for(let i=2;i<process.argv.length;i+=2){assert.ok(process.argv[i].startsWith('--')&&process.argv[i+1]);options[process.argv[i].slice(2)]=process.argv[i+1];}
const load=(root,file)=>import(pathToFileURL(path.join(root,file)).href);
const run=async(tool,args,extra={})=>exec(tool,args,{encoding:'utf8',maxBuffer:32*1024**2,...extra});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize=rows=>rows.map(m=>[m.id,m.time,m.text,m.color,m.lane,m.y,m.textWidth,m.paintWidth,m.entryDelay,m.speed,m.end]);
const log=message=>console.log(`[${new Date().toISOString()}] ${message}`);

async function layoutBenchmark(root,directory){
  const [{Store},{RenderPipeline}]=await Promise.all([load(root,'server/store.js'),load(root,'server/render-plan.js')]);
  const store=new Store(directory),session=store.createSession({id:'benchmark'}),pipeline=new RenderPipeline({store},()=>''),hashes=[];
  let layoutMs=0,insertMs=0,readRows=0,maxLayoutMs=0;
  const all=store.all.bind(store);
  store.all=(sql,...args)=>{const result=all(sql,...args);if(sql.includes('SELECT d.rowid AS rowid,d.*'))readRows+=result.length;return result;};
  try{
    for(let checkpoint=0;checkpoint<120;checkpoint++){
      let start=performance.now();
      store.transaction(()=>{for(let i=checkpoint*180;i<(checkpoint+1)*180;i++)store.run('INSERT INTO danmaku VALUES(?,?,?,?,?,?,?,?)',String(i).padStart(8,'0'),session.id,'source',i/3,'viewer','这是性能验证弹幕 '+i,'d','16777215');});
      insertMs+=performance.now()-start;start=performance.now();
      const rows=await pipeline.layout(session.id,undefined,50,{width:1920,height:1080,style:{size:.6,opacity:100,speed:1,fps:60,areaTop:0,areaHeight:1}});
      const elapsed=performance.now()-start;layoutMs+=elapsed;maxLayoutMs=Math.max(maxLayoutMs,elapsed);
      assert.equal(rows.length,(checkpoint+1)*180);hashes.push(digest(normalize(rows)));
    }
    return {layoutMs,insertMs,readRows,maxLayoutMs,comments:21600,checkpoints:120,hashes};
  }finally{store.close();}
}

if(options['layout-worker']){
  console.log(JSON.stringify(await layoutBenchmark(options['layout-worker'],options.directory)));
}else{
  for(const key of ['before','source','font','ffmpeg','ffprobe','output'])assert.ok(options[key],`Missing --${key}`);
  const out=path.resolve(options.output);await fs.mkdir(out); // Never reuse or erase an existing result directory.
  const before=path.resolve(options.before),ffmpeg=path.resolve(options.ffmpeg),ffprobe=path.resolve(options.ffprobe),source=path.resolve(options.source);
  const report={created:new Date().toISOString(),environment:{platform:process.platform,arch:process.arch,node:process.version,cpu:os.cpus()[0]?.model,cores:os.availableParallelism(),memory:os.totalmem(),load:os.loadavg(),ffmpeg:(await run(ffmpeg,['-version'])).stdout.split('\n')[0]},layout:[],drawing:[],pending:[]};
  const save=()=>fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  for(const [i,kind] of ['before','after','after','before'].entries()){
    log(`2-hour append layout ${i+1}/4: ${kind}`);
    const result=await run(process.execPath,[self,'--layout-worker',kind==='before'?before:current,'--directory',path.join(out,`layout-${i}`)]);
    const data=JSON.parse(result.stdout);if(report.layout.length)assert.deepEqual(data.hashes,report.layout[0].hashes);
    report.layout.push({kind,...data});await save();
  }

  const [{layoutComments},{assText},{fontMetadata},{preparedEncoderArguments}]=await Promise.all([
    load(current,'server/render-plan.js'),load(current,'server/media.js'),load(current,'server/danmaku-font.js'),load(current,'server/export-encoding.js')]);
  const font=fontMetadata(await fs.readFile(options.font)),style={size:.6,opacity:100,speed:1,fps:60,areaTop:0,areaHeight:1};
  const encoder=process.platform==='darwin'?{id:'h264_videotoolbox',hardware:true,args:['-allow_sw','0','-q:v','65']}:{id:'libx264',hardware:false,threads:2};
  report.encoder=encoder;report.duration=60;report.font=font;
  await fs.mkdir(path.join(out,'fonts'));await fs.copyFile(options.font,path.join(out,'fonts','font'+font.extension));
  for(const [kind,rate] of [['empty',0],['ordinary',3],['dense',30]]){
    const messages=Array.from({length:60*rate},(_,i)=>({id:String(i).padStart(8,'0'),time:i/rate,text:'画质和弹幕数量保持不变，测试跨帧绘制 '+i,type:'d',color:'16777215'}));
    const layout=layoutComments(messages,{width:1920,height:1080,font,style});assert.equal(layout.length,messages.length);
    await fs.writeFile(path.join(out,kind+'.ass'),assText(layout,1920,1080,font,style));
  }
  async function render(kind,file,instrument=false){
    const chain=['format=yuv420p','fps=fps=60:start_time=0:round=near',...(instrument?['bench=start']:[]),
      ...(kind==='none'?[]:[`ass=${kind}.ass:fontsdir=fonts`]),...(instrument?['bench=stop']:[]),'trim=start=0:end=60','setpts=PTS-STARTPTS'].join(',');
    const start=performance.now();
    const result=await run(ffmpeg,['-hide_banner','-nostats','-loglevel',instrument?'repeat+info':'error','-threads','2','-i',source,'-map','0:v:0','-an',
      '-filter_threads','2','-vf',chain,...preparedEncoderArguments(encoder,2),'-frames:v','3600','-r','60','-movflags','+faststart','-y',file],{cwd:out});
    const elapsedMs=performance.now()-start;
    const timings=[...result.stderr.matchAll(/\bt:([\d.]+) avg:([\d.]+) max:([\d.]+) min:([\d.]+)/g)];
    const bench=timings.length?{samples:timings.length,sumSeconds:timings.reduce((sum,m)=>sum+Number(m[1]),0),lastAverageSeconds:Number(timings.at(-1)[2])}:null;
    if(instrument){await fs.writeFile(file+'.log',result.stderr);assert.ok(bench?.samples>=3600,'Expected bench samples for every output frame');}
    const meta=JSON.parse((await run(ffprobe,['-v','error','-show_entries','stream=codec_name,width,height,nb_frames,pix_fmt,r_frame_rate:format=duration,size','-of','json',file])).stdout);
    const video=meta.streams[0];assert.equal(video.codec_name,'h264');assert.equal(video.width,1920);assert.equal(video.height,1080);assert.equal(video.nb_frames,'3600');assert.equal(video.r_frame_rate,'60/1');assert.equal(video.pix_fmt,'yuv420p');
    return {elapsedMs,bench,metadata:meta};
  }
  // Warm up the encoder; exclude initialization and system warmup from comparisons.
  log('Encoder warmup');await render('empty',path.join(out,'warmup.mp4'));await fs.unlink(path.join(out,'warmup.mp4'));
  for(const [i,kind] of ['none','empty','ordinary','dense','dense','ordinary','empty','none'].entries()){
    log(`Drawing ${i+1}/8: ${kind}`);const file=path.join(out,`drawing-${i}-${kind}.mp4`);
    report.drawing.push({kind,...await render(kind,file,true)});await save();await fs.unlink(file);
  }
  const spec={version:1,sessionId:'benchmark',sourceId:'source',startMs:0,endMs:60000,sourceFingerprint:'unchanged-source',profileHash:'same-profile',assHash:'same-danmaku'};
  // Deterministically inject a temporary verification wait after a real encode.
  // This measures wasted work avoided, not the frequency of real network/index lag.
  for(const kind of ['before','after']){
    log(`Completed-block verification retry: ${kind}`);
    const {RenderCache}=await load(kind==='before'?before:current,'server/render-cache.js');
    const cache=new RenderCache(path.join(out,'pending-'+kind),{minFreeBytes:0}),renders=[];
    try{
      const start=performance.now(),produce=async file=>{renders.push(await render('ordinary',file));};
      await assert.rejects(cache.build(spec,produce,{verifySource:()=>kind==='before'?false:{pending:true}}),error=>error.code===(kind==='before'?'PREP_STALE':'PREP_PENDING'));
      assert.equal(await cache.hasReady('benchmark'),false);
      const lease=await cache.build(spec,produce,{verifySource:()=>true});
      try{
        assert.equal(renders.length,kind==='before'?2:1);
        const elapsedMs=performance.now()-start;
        const frameHash=(await run(ffmpeg,['-v','error','-i',lease.file,'-vf',"select='eq(n,60)+eq(n,1799)+eq(n,3599)'",'-fps_mode','passthrough','-f','framemd5','-'])).stdout.split('\n').filter(line=>line&&!line.startsWith('#'));
        report.pending.push({kind,elapsedMs,renders,frameHash});await save();
      }finally{lease.release();}
    }finally{await cache.close();}
  }
  assert.deepEqual(report.pending[0].frameHash,report.pending[1].frameHash);
  report.verified={layoutCheckpointsIdentical:480,retryFrameHashesIdentical:true};await save();log(`Saved ${path.join(out,'report.json')}`);
}
