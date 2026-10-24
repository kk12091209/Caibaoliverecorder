import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync,execFileSync} from 'node:child_process';
import {Store} from '../server/store.js';
import {Media} from '../server/media.js';
import {Ingestor} from '../server/ingest.js';

const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',ffprobe=process.env.FFPROBE_PATH||'ffprobe';
const run=(tool,args)=>execFileSync(tool,args,{encoding:'utf8',maxBuffer:4*1024**2});
for(const route of ['regular-v1','prepared-v9'])test(`${route} SIGKILL after a real FFmpeg block: restart reuses completed work and publishes both MP4s`,async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-export-crash-')),data=path.join(root,'data');let store=new Store(data),media;
  t.after(async()=>{media?.close();await media?.waitForSaves();store.close();await fs.rm(root,{recursive:true,force:true});});store.projectRoot=root;
  const file=path.join(root,'input.flv');
  run(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000',
    '-t','12','-c:v','libx264','-preset','veryfast','-g','30','-bf','2','-c:a','aac','-y',file]);
  const session=store.createSession({status:'finished'}),ingest=new Ingestor(store);
  for(let i=0;i<2;i++){
    const original=path.join(root,`source-${i}.flv`);await fs.copyFile(file,original);
    const source=store.addSource(session.id,original,i*14,session.created,true);await fs.writeFile(source.xml,'<i><d p="1,1,25,16777215,0,0,0,0">RECOVERY</d></i>');
    for(let tick=0;tick<10;tick++)await ingest.tick();
  }
  media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software'});media.work=async()=>{};
  const job=await media.enqueue(session.id,{scope:'full',mode:'dual',exportDirectory:path.join(root,'outputs')});media.close();store.close();
  const script=`
    import fs from 'node:fs/promises';
    import {Store} from ${JSON.stringify(new URL('../server/store.js',import.meta.url).href)};
    import {Media} from ${JSON.stringify(new URL('../server/media.js',import.meta.url).href)};
    const store=new Store(${JSON.stringify(data)});store.projectRoot=${JSON.stringify(root)};
    const media=new Media(store,{ffmpeg:${JSON.stringify(ffmpeg)},ffprobe:${JSON.stringify(ffprobe)},exportAcceleration:'software'});
    ${route==='prepared-v9'?'media.renderCache.hasReady=async()=>true;':''}
    const open=media.checkpoints.open.bind(media.checkpoints);
    media.checkpoints.open=async(...args)=>{const cp=await open(...args),run=cp.run.bind(cp);
      cp.run=async(...values)=>{const result=await run(...values);if(Array.isArray(values[2])&&values[2].includes('part-0.mp4')){
        await fs.writeFile(${JSON.stringify(path.join(root,'crash-checkpoint.json'))},JSON.stringify({directory:cp.directory}));process.kill(process.pid,'SIGKILL');
      }return result;};return cp;};
    const row=store.get('SELECT * FROM jobs WHERE id=?',${JSON.stringify(job.id)});store.run("UPDATE jobs SET status='running' WHERE id=?",row.id);
    await media.exportJob(JSON.parse(row.data));throw Error('crash point not reached');
  `;
  const killed=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:30000});
  assert.equal(killed.signal,'SIGKILL',killed.stderr);
  const crash=JSON.parse(await fs.readFile(path.join(root,'crash-checkpoint.json'),'utf8'));
  await fs.access(path.join(crash.directory,'part-0.mp4'));
  store=new Store(data);store.projectRoot=root;media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software'});
  let renders=0;const render=media.renderer.renderVideo.bind(media.renderer);
  media.renderer.renderVideo=(...args)=>{renders++;return render(...args);};
  const processMedia=media.process.bind(media);media.process=(args,...options)=>{if(args.includes('-filter_complex'))renders++;return processMedia(args,...options);};
  await media.recoverPendingSaves();await media.recoverInterruptedExports();await media.work();await media.waitForSaves();
  const completed=store.get('SELECT * FROM jobs WHERE id=?',job.id),saved=JSON.parse(completed.data);
  assert.equal(completed.status,'done',completed.error);assert.equal(renders,1,'only the unfinished source should render again');assert.ok(saved.resumedExportSteps>=1);
  for(const [index,output] of [saved.output.file,saved.output.danmakuFile].entries()){
    run(ffmpeg,['-v','error','-xerror','-i',output,'-f','null','-']);
    const streams=JSON.parse(run(ffprobe,['-v','error','-show_entries','stream=codec_type,r_frame_rate,duration,nb_frames','-of','json',output])).streams;
    const video=streams.find(s=>s.codec_type==='video'),audio=streams.find(s=>s.codec_type==='audio');
    assert.equal(video.r_frame_rate,index?'60/1':'30/1');assert.ok(Math.abs(Number(video.duration)-24)<.15);assert.ok(audio&&Math.abs(Number(audio.duration)-24)<.15);
  }
  const remaining=await fs.readdir(crash.directory).catch(e=>{if(e.code==='ENOENT')return [];throw e;});assert.deepEqual(remaining,[],'completed export must release its own temporary files');assert.equal(saved.processingRecovery,undefined);assert.equal(media.children.size,0);
});
