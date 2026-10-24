#!/usr/bin/env node
// ABBA CPU-only comparison. Copies input into isolated stores; never opens a
// user's recording database. Timings include enqueue through final publication.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const exec=promisify(execFile),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,key,i,all)=>i%2?pairs:[...pairs,[key.replace(/^--/,''),all[i+1]]],[]));
assert.ok(args.before&&args.source&&args.output,'--before --source --output are required');
const output=path.resolve(args.output),before=path.resolve(args.before),seconds=Number(args.seconds||125);
assert.ok(seconds>=61&&seconds<=600);
const ffmpeg=process.env.FFMPEG_PATH||path.join(root,'../.tools/runtime/ffmpeg/ffmpeg'),ffprobe=process.env.FFPROBE_PATH||path.join(root,'../.tools/runtime/ffmpeg/ffprobe');
const font=process.env.CAIBO_TEST_FONT||path.join(root,'../.tools/ci-fonts/NotoSansCJKsc-Regular.otf');
const run=async(tool,argv,options={})=>(await exec(tool,argv,{encoding:'utf8',maxBuffer:32*1024**2,...options})).stdout;
const inspect=async file=>JSON.parse(await run(ffprobe,['-v','error','-show_streams','-show_format','-of','json',file]));
await fs.mkdir(output,{recursive:true});
await fs.writeFile(path.join(output,'config.json'),JSON.stringify({before,after:root,seconds,source:path.resolve(args.source),cpu:os.cpus()[0].model,cpus:os.availableParallelism(),memory:os.totalmem()},null,2),{flag:'wx'});
const input=path.join(output,'input.flv');
await run(ffmpeg,['-v','error','-i',path.resolve(args.source),'-t',String(seconds),'-map','0:v:0','-map','0:a:0?','-c','copy','-y',input]);
const reports=[];
for(const [index,variant] of ['before','after','after','before'].entries()){
  const implementation=variant==='before'?before:root,folder=await fs.mkdtemp(path.join(output,`${variant}-${index}-`));
  const [{Store},{Media},{Ingestor}]=await Promise.all(['store','media','ingest'].map(name=>import(pathToFileURL(path.join(implementation,'server',name+'.js')))));
  const store=new Store(path.join(folder,'data'));store.projectRoot=folder;
  const media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software'});media.work=async()=>{};
  try{
    const session=store.createSession({status:'finished',title:'CPU checkpoints ABBA'}),file=path.join(folder,'source.flv');await fs.copyFile(input,file);
    const source=store.addSource(session.id,file,0,session.created,true);
    await fs.writeFile(source.xml,'<i>'+Array.from({length:seconds*3},(_,i)=>`<d p="${i/3+.1},1,25,16777215,0,0,0,0">分块恢复画质测试 ${i}</d>`).join('')+'</i>');
    const ingest=new Ingestor(store);for(let i=0;i<1000;i++){await ingest.tick();const current=store.sources(session.id)[0];assert.equal(current.error,'');if(current.closed===2)break;if(i===999)assert.fail('ingest timeout');}
    await media.fonts.import(await fs.readFile(font));
    const commands=[],processMedia=media.process.bind(media);media.process=(argv,options)=>{commands.push(argv);return processMedia(argv,options);};
    const start=performance.now(),job=await media.enqueue(session.id,{scope:'full',mode:'dual',exportDirectory:path.join(folder,'exports')});
    await media.exportJob(job);await media.waitForSaves();const elapsedMs=performance.now()-start;
    const validation=[];
    for(const outputFile of [job.output.file,job.output.danmakuFile]){
      const info=await inspect(outputFile);await run(ffmpeg,['-v','error','-xerror','-i',outputFile,'-f','null','-']);
      const samples=[];
      for(const time of [.2,59.95,60,60.05,119.95,120,120.05,seconds-.3].filter(t=>t<seconds-.1)){
        const pixels=await run(ffmpeg,['-v','error','-ss',String(time),'-i',outputFile,'-frames:v','1','-vf','scale=160:90','-pix_fmt','gray','-f','rawvideo','-'],{encoding:'buffer'});
        samples.push({time,gray:pixels.toString('base64')});
      }
      const audio=await run(ffmpeg,['-v','error','-i',outputFile,'-map','0:a:0','-c','copy','-f','adts','-'],{encoding:'buffer'});
      validation.push({info,samples,audioHash:createHash('sha256').update(audio).digest('hex')});
    }
    assert.equal(validation[0].audioHash,validation[1].audioHash);
    const duration=store.sources(session.id)[0].duration;
    for(const [i,v] of validation.entries()){
      const video=v.info.streams.find(s=>s.codec_type==='video'),audio=v.info.streams.find(s=>s.codec_type==='audio');
      assert.equal(video.width,1920);assert.equal(video.height,1080);assert.equal(video.r_frame_rate,i?'60/1':'30/1');
      assert.ok(Math.abs(Number(video.duration)-duration)<.1);assert.ok(audio&&Math.abs(Number(audio.duration)-duration)<.15);
    }
    const row={variant,index,elapsedMs,duration,encoder:job.encoder,checkpointSeconds:job.cpuCheckpointSeconds,cleanStreamCopy:job.cleanStreamCopy,audioStreamCopy:job.audioStreamCopy,
      videoEncodeProcesses:commands.filter(c=>c.includes('libx264')).length,qualityArguments:commands.filter(c=>c.includes('libx264')).map(c=>({crf:c[c.indexOf('-crf')+1],preset:c[c.indexOf('-preset')+1],threads:c[c.lastIndexOf('-threads')+1]})),validation};
    reports.push(row);await fs.writeFile(path.join(output,`run-${index}.json`),JSON.stringify(row,null,2));
    console.log(JSON.stringify({variant,index,elapsedMs,videoEncodeProcesses:row.videoEncodeProcesses}));
  }finally{media.close();await media.waitForSaves();store.close();await fs.rm(folder,{recursive:true,force:true});}
}
const average=variant=>{const values=reports.filter(r=>r.variant===variant).map(r=>r.elapsedMs);return values.reduce((a,b)=>a+b,0)/values.length;};
const old=average('before'),next=average('after'),duration=reports[0].duration;
const comparisons=reports.filter(r=>r.variant==='after').map(report=>({index:report.index,samples:report.validation[1].samples.map((s,i)=>{
  const a=Buffer.from(s.gray,'base64'),b=Buffer.from(reports[0].validation[1].samples[i].gray,'base64');let square=0;
  for(let j=0;j<a.length;j++)square+=(a[j]-b[j])**2;
  return {time:s.time,psnr:square?10*Math.log10(255**2/(square/a.length)):null,identical:square===0};
})}));
const summary={beforeMs:old,afterMs:next,changePercent:(next/old-1)*100,comparisons,
  twoHours:{beforeMs:old/duration*7200,afterMs:next/duration*7200},threeHours:{beforeMs:old/duration*10800,afterMs:next/duration*10800},
  limitations:['One M5 Mac, 1080p30 to 1080p60, 3 comments/s, two runs each in ABBA order; no Windows measurements.','Linear extrapolation is not a measured two/three-hour run; checkpoint recovery benefit depends on where failure occurs.']};
await fs.writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
