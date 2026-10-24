#!/usr/bin/env node
// Isolated end-to-end export benchmark. Existing source/media data is read-only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const exec=promisify(execFile),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=async(tool,args,options={})=>(await exec(tool,args,{encoding:'utf8',maxBuffer:32*1024**2,...options})).stdout;
const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,value,i,values)=>i%2?pairs:[...pairs,[value.replace(/^--/,''),values[i+1]]],[]));
const output=path.resolve(args.output),before=path.resolve(args.before),after=path.resolve(args.after||root);
const ffmpeg=path.resolve(args.ffmpeg||path.join(root,'../.tools/runtime/ffmpeg/ffmpeg'));
const ffprobe=path.resolve(args.ffprobe||path.join(root,'../.tools/runtime/ffmpeg/ffprobe'));
const font=path.resolve(args.font||path.join(root,'../.tools/ci-fonts/NotoSansCJKsc-Regular.otf'));
const duration=Number(args.seconds||120),source=path.resolve(args.source);
const cachedSuite=args.suite==='cached',coldSuite=args.suite==='cold',sourceCount=Number(args.sources||2);
assert.ok(Number.isInteger(duration)&&duration>=10&&duration<=600);
assert.ok(!cachedSuite||duration>=34,'The cached suite needs at least 34 seconds for its 30-second precise cut.');
assert.ok([1,2].includes(sourceCount));
const median=values=>{const sorted=values.toSorted((a,b)=>a-b);return (sorted[Math.floor((sorted.length-1)/2)]+sorted[Math.floor(sorted.length/2)])/2;};
const inspect=async file=>JSON.parse(await run(ffprobe,['-v','error','-show_entries','stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,start_time,duration:format=duration,size','-of','json',file]));
const hashes=async file=>createHash('sha256').update(await run(ffmpeg,['-v','error','-i',file,'-map','0:a:0','-c','copy','-f','adts','-'],{encoding:'buffer'})).digest('hex');
const frameHashes=async(file,from,to)=>(await run(ffmpeg,['-v','error','-i',file,'-map','0:v:0','-an','-vf',`trim=start=${from}:end=${to}`,'-f','framemd5','-'])).split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>line.split(',').at(-1).trim());

async function fixture(implementation,folder,count){
  const [{Store},{Ingestor},{Media}]=await Promise.all(['store','ingest','media'].map(n=>import(pathToFileURL(path.join(implementation,'server',`${n}.js`)))));
  const store=new Store(path.join(folder,'data'));store.projectRoot=folder;
  const session=store.createSession({status:'finished',title:'隔离成片导出性能对照'}),ingest=new Ingestor(store);
  for(let i=0;i<count;i++){
    const file=path.join(folder,`source-${i}.flv`);await fs.copyFile(path.join(output,'input.flv'),file,constants.COPYFILE_FICLONE);
    const item=store.addSource(session.id,file,i?store.session(session.id).duration+5:0,session.created,true);
    await fs.writeFile(item.xml,'<i>'+Array.from({length:duration*3},(_,n)=>`<d p="${n/3+.1},1,25,16777215,0,0,0,0">画质和弹幕数量保持一致 ${i}-${n}</d>`).join('')+'</i>');
    for(let tick=0;tick<1000;tick++){await ingest.tick();const state=store.sources(session.id).at(-1);assert.equal(state.error,'');if(state.closed===2)break;if(tick===999)throw new Error('ingest timeout');}
  }
  const media=new Media(store,{ffmpeg,ffprobe,renderBlockSeconds:60,renderCacheOptions:{minFreeBytes:0,maxBytes:12*1024**3}});media.work=async()=>{};
  await media.fonts.import(await fs.readFile(font));
  return {media,store,session,sources:store.sources(session.id),async close(){media.close();await media.waitForSaves();store.close();}};
}

async function measured(f,mode,extra={}){
  const calls=[],process=f.media.process.bind(f.media);f.media.process=async(argv,options)=>{calls.push(argv);return process(argv,options);};
  const start=performance.now();let result;
  try{
    const job=await f.media.enqueue(f.session.id,{scope:'full',mode,exportDirectory:path.join(f.store.projectRoot,'exports'),...extra});
    const file=await f.media.exportJob(job);
    result={elapsedMs:performance.now()-start,file,job:{encoder:job.encoder,encoderFallback:job.encoderFallback,cleanStreamCopy:job.cleanStreamCopy,audioStreamCopy:job.audioStreamCopy,
      preparedBlocks:job.preparedBlocks,preparationFallback:job.preparationFallback,audioCopyFallback:job.audioCopyFallback,
      reusedVideoSeconds:job.reusedVideoSeconds,renderedVideoSeconds:job.renderedVideoSeconds,performance:job.performance},
      commands:{total:calls.length,videoEncodes:calls.filter(a=>a.includes('libx264')||a.includes('h264_videotoolbox')).length,audioEncodes:calls.filter(a=>a.includes('flac')||a[a.indexOf('-c:a')+1]==='aac').length,
        decodeInputSeconds:calls.reduce((sum,a)=>{const filter=a[a.indexOf('-vf')+1]||'',base=filter.match(/setpts=PTS\+([\d.]+)\/TB/),clock=filter.match(/fps=fps=([\d.]+):start_time=([\d.]+)/);return sum+(base&&clock?Math.max(0,Number(clock[2])+Number(a[a.indexOf('-frames:v')+1])/Number(clock[1])-Number(base[1])):0);},0)}};
  }finally{f.media.process=process;}
  const files=mode==='dual'?[result.file,path.join(path.dirname(result.file),'【弹幕版】'+path.basename(result.file))]:[result.file];
  const validation=[];
  const expected=extra.ranges?extra.ranges.reduce((s,r)=>s+r.end-r.start,0):f.sources.reduce((s,v)=>s+v.duration,0);
  for(const [index,file] of files.entries()){
    const info=await inspect(file),video=info.streams.find(s=>s.codec_type==='video'),audio=info.streams.find(s=>s.codec_type==='audio');
    assert.equal(video.codec_name,'h264');assert.equal(video.width,1920);assert.equal(video.height,1080);
    const fps=mode==='clean'||mode==='dual'&&index===0?30:60;assert.equal(video.r_frame_rate,`${fps}/1`);
    assert.ok(Math.abs(Number(video.duration)-expected)<.12,`${video.duration} / ${expected}`);
    assert.ok(audio&&Math.abs(Number(info.format.duration)-expected)<.15);
    assert.ok(Math.abs(Number(audio.duration)+Number(audio.start_time)-expected)<.15);
    const samples=[];
    for(const time of [...new Set([.2,Math.max(.2,expected-.3),...(extra.ranges?[.733333,.75,.766667,14.2,28.733333,28.75,28.766667].filter(t=>t<expected-.1):f.sources.length>1?[f.sources[0].duration-.1,f.sources[0].duration+.1]:[]),...(coldSuite?[59.95,60,60.05,119.9,119.95,120,179.9,180,180.05].filter(t=>t<expected-.1):[])])]){
      await run(ffmpeg,['-v','error','-xerror','-ss',String(time),'-i',file,'-t','0.2','-f','null','-']);
      const pixels=await run(ffmpeg,['-v','error','-ss',String(time),'-i',file,'-frames:v','1','-vf','scale=160:90','-pix_fmt','gray','-f','rawvideo','-'],{encoding:'buffer'});
      samples.push({time,sha256:createHash('sha256').update(pixels).digest('hex'),...(cachedSuite||coldSuite?{gray:pixels.toString('base64')}:{})});
    }
    validation.push({info,samples,audioHash:await hashes(file)});
  }
  if(mode==='dual')assert.equal(validation[0].audioHash,validation[1].audioHash);
  if(cachedSuite&&extra.ranges&&mode==='danmaku'&&result.job.reusedVideoSeconds>0){
    const plan=await f.media.renderer.describe(f.session.id,f.store.edit(f.session.id));
    const lease=await f.media.renderCache.acquire(await f.media.renderer.spec(plan,plan.blocks[0]));assert.ok(lease);
    try{
      const expectedFrames=await frameHashes(lease.file,4,32),actualFrames=await frameHashes(files[0],.75,28.75);
      assert.equal(expectedFrames.length,1680);assert.deepEqual(actualFrames,expectedFrames);
      result.cacheInterior={frames:actualFrames.length,identical:true};
    }finally{await lease.release();}
  }
  // Outputs are verified and timed through publication; remove only this
  // isolated fixture's copies to keep ABBA disk usage bounded.
  for(const file of files)await fs.unlink(file);
  return {...result,file:undefined,validation,inputSeconds:expected};
}

await fs.mkdir(output,{recursive:true});
await fs.writeFile(path.join(output,'benchmark-config.json'),JSON.stringify({before,after,source,duration,sourceCount,cachedSuite,coldSuite,ffmpeg,ffprobe,font},null,2),{flag:'wx'});
await run(ffmpeg,['-v','error','-i',source,'-t',String(duration),'-map','0:v:0','-map','0:a:0?','-c','copy','-y',path.join(output,'input.flv')]);
const reports=[];
for(const [index,variant] of ['before','after','after','before'].entries()){
  const work=await fs.mkdtemp(path.join(output,`${variant}-${index}-`));
  const f=await fixture(variant==='before'?before:after,work,sourceCount);
  const report={variant,index,environment:{node:process.version,cpu:os.cpus()[0]?.model,cpus:os.availableParallelism(),memory:os.totalmem(),ffmpeg:(await run(ffmpeg,['-version'])).split('\n')[0]},stages:{}};
  try{
    if(coldSuite){
      assert.equal(await f.media.renderCache.hasReady(f.session.id),false);
      assert.equal(f.media.renderer.preparationPlans.size,0);
      report.stages.coldDual=await measured(f,'dual');console.log(`${variant} #${index} coldDual ${report.stages.coldDual.elapsedMs.toFixed(0)}ms ${JSON.stringify(report.stages.coldDual.job)}`);
      assert.equal(await f.media.renderCache.hasReady(f.session.id),false);
    }else if(!cachedSuite){report.stages.clean=await measured(f,'clean');console.log(`${variant} #${index} clean ${report.stages.clean.elapsedMs.toFixed(0)}ms`);}
    const start=performance.now();
    for(let round=0;round<30;round++){
      const state=await f.media.prepareNext(f.session.id,{});if(state.done)break;if(round===29)throw new Error('preparation timeout');
    }
    report.preparationMs=performance.now()-start;report.encoder=await f.media.renderer.encoder();
    console.log(`${variant} #${index} preparation ${report.preparationMs.toFixed(0)}ms`);
    if(!cachedSuite){report.stages.warmDual=await measured(f,'dual');console.log(`${variant} #${index} warmDual ${report.stages.warmDual.elapsedMs.toFixed(0)}ms`);}
    if(coldSuite){
      await fs.writeFile(path.join(output,`run-${index}.json`),JSON.stringify(report,null,2));reports.push(report);continue;
    }
    report.stages.warmDanmaku=await measured(f,'danmaku');console.log(`${variant} #${index} warmDanmaku ${report.stages.warmDanmaku.elapsedMs.toFixed(0)}ms`);
    if(cachedSuite){
      report.stages.clipDanmaku=await measured(f,'danmaku',{scope:'clips',ranges:[{start:3.25,end:Math.min(f.sources[0].duration-.25,33.25)}]});
      console.log(`${variant} #${index} clipDanmaku ${report.stages.clipDanmaku.elapsedMs.toFixed(0)}ms ${JSON.stringify(report.stages.clipDanmaku.job)}`);
      report.stages.clipClean=await measured(f,'clean',{scope:'clips',ranges:[{start:3.25,end:Math.min(f.sources[0].duration-.25,33.25)}]});
    }
    report.stages.clip=await measured(f,'dual',{scope:'clips',ranges:[{start:3.25,end:Math.min(f.sources[0].duration-.25,33.25)}]});
    console.log(`${variant} #${index} clipDual ${report.stages.clip.elapsedMs.toFixed(0)}ms`);
    await fs.writeFile(path.join(output,`run-${index}.json`),JSON.stringify(report,null,2));reports.push(report);
  }finally{await f.close();await fs.rm(work,{recursive:true,force:true});}
}
const stageNames=coldSuite?['coldDual','warmDual']:cachedSuite?['warmDanmaku','clipDanmaku','clipClean','clip']:['clean','warmDual','warmDanmaku','clip'];
const rows=stageNames.map(stage=>{
  const group=variant=>reports.filter(r=>r.variant===variant).map(r=>r.stages[stage]);
  const old=group('before'),next=group('after'),oldMs=median(old.map(v=>v.elapsedMs)),newMs=median(next.map(v=>v.elapsedMs));
  const seconds=median(next.map(v=>v.inputSeconds));
  return {stage,beforeMs:oldMs,afterMs:newMs,reductionPercent:(1-newMs/oldMs)*100,
    ...(!stage.startsWith('clip')?{twoHours:{beforeMs:oldMs/seconds*7200,afterMs:newMs/seconds*7200},threeHours:{beforeMs:oldMs/seconds*10800,afterMs:newMs/seconds*10800}}:{})};
});
// Baked pixels are unchanged; source-copy clean pictures intentionally avoid
// the previous lossy encoding. All paired baked samples must still match.
const comparisons=[];
for(const candidate of reports.filter(r=>r.variant==='after'))for(const stage of coldSuite?stageNames:cachedSuite?['warmDanmaku','clipDanmaku','clip']:['warmDual','warmDanmaku','clip']){
  const old=reports.find(r=>r.variant==='before').stages[stage].validation.at(-1).samples;
  const next=candidate.stages[stage].validation.at(-1).samples;
  if(!cachedSuite&&!coldSuite)assert.deepEqual(next,old);
  else{
    const samples=next.map((sample,index)=>{
      const a=Buffer.from(old[index].gray,'base64'),b=Buffer.from(sample.gray,'base64');assert.equal(a.length,b.length);
      let absolute=0,square=0;for(let i=0;i<a.length;i++){const delta=a[i]-b[i];absolute+=Math.abs(delta);square+=delta**2;}
      const mae=absolute/a.length,psnr=square?10*Math.log10(255**2/(square/a.length)):null;
      // The old cut starts a new GOP. Its pixels may differ from the original
      // cached GOP; new interior frames are checked against that cache above.
      if(stage==='warmDanmaku')assert.equal(sample.sha256,old[index].sha256);
      else assert.ok(mae<1.5&&(!psnr||psnr>40),`edge pixels differ: MAE ${mae}, PSNR ${psnr}`);
      return {time:sample.time,identical:sample.sha256===old[index].sha256,mae,psnr};
    });comparisons.push({index:candidate.index,stage,samples});
  }
}
const totalStage=cachedSuite?'warmDanmaku':'warmDual';
const total={stage:cachedSuite?'preparationAndDanmaku':'preparationAndDual',beforeMs:median(reports.filter(r=>r.variant==='before').map(r=>r.preparationMs+r.stages[totalStage].elapsedMs)),afterMs:median(reports.filter(r=>r.variant==='after').map(r=>r.preparationMs+r.stages[totalStage].elapsedMs))};
total.reductionPercent=(1-total.afterMs/total.beforeMs)*100;
const seconds=reports[0].stages[totalStage].inputSeconds;
for(const [label,span] of [['twoHours',7200],['threeHours',10800]])total[label]={beforeMs:total.beforeMs/seconds*span,afterMs:total.afterMs/seconds*span};rows.push(total);
if(coldSuite){const prior=median(reports.filter(r=>r.variant==='before').map(r=>r.preparationMs)),next=median(reports.filter(r=>r.variant==='after').map(r=>r.preparationMs));rows.push({stage:'preparation',beforeMs:prior,afterMs:next,reductionPercent:(1-next/prior)*100});}
await fs.writeFile(path.join(output,'report.json'),JSON.stringify({rows,reports,comparisons,limitations:['Short synthetic 1080p30 source, 3 comments/second, M5 hardware encoding; not two/three-hour real recordings.','Source creation/ingest and validation are outside timings; preparation, enqueue, encode/copy, audio, mux and publication are measured.','ABBA, two runs per version; OS caches not purged. Linear extrapolation includes fixed startup overhead and may overestimate long-job wait.','Full reconnect exports require compatible codec headers; precise clips use only verified cached keyframe intervals and render original-picture edges.']},null,2));
console.log(JSON.stringify(rows,null,2));
