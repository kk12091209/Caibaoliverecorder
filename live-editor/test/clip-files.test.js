import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createApp} from '../server/index.js';
import {Ingestor} from '../server/ingest.js';

test('HTTP export of three clips produces six independent dual-mode MP4s in selection order',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-clip-files-'));
  const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',ffprobe=process.env.FFPROBE_PATH||'ffprobe';
  const file=path.join(root,'source.flv');
  execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','10','-c:v','libx264','-preset','ultrafast','-g','30','-c:a','aac','-f','flv',file]);
  await fs.writeFile(file.replace('.flv','.xml'),'<i><d p="1,1,25,16777215,0,0,0,0">独立选段测试</d></i>');
  const app=await createApp({data:path.join(root,'data'),projectRoot:root,port:0,noRecorder:true,ffmpeg,ffprobe,preparation:false,compact:false,exportAcceleration:'software'});
  t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
  const session=app.store.createSession({status:'finished',title:'三个片段'});
  app.store.addSource(session.id,file,0,new Date().toISOString(),true);
  const ingestor=new Ingestor(app.store);for(let i=0;i<10;i++)await ingestor.tick();
  const ranges=[{start:6,end:7},{start:0,end:2},{start:3,end:5}];
  const seen=[];let active=0,peak=0;const exportJob=app.media.exportJob.bind(app.media);
  app.media.exportJob=async job=>{seen.push(job.ranges[0]);active++;peak=Math.max(active,peak);try{return await exportJob(job);}finally{active--;}};
  const response=await fetch(app.runtime.origin+`/api/sessions/${session.id}/export`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ranges,mode:'dual'})});
  assert.equal(response.status,200);const {jobs}=await response.json();assert.equal(jobs.length,3);
  const until=Date.now()+30000;
  while(app.media.processing&&Date.now()<until)await new Promise(r=>setTimeout(r,20));
  assert.equal(app.media.processing,false);assert.equal(peak,1);assert.deepEqual(seen,ranges);
  const rows=app.store.all('SELECT * FROM jobs ORDER BY rowid');assert.deepEqual(rows.map(j=>j.status),['done','done','done']);
  for(let i=0;i<rows.length;i++){
    const files=await fs.readdir(path.dirname(rows[i].file));assert.equal(files.length,2);
    for(const name of files){
      const probe=JSON.parse(execFileSync(ffprobe,['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',path.join(path.dirname(rows[i].file),name)]));
      assert.ok(Math.abs(Number(probe.format.duration)-(ranges[i].end-ranges[i].start))<.15);
      assert.ok(probe.streams.some(s=>s.codec_type==='video'));assert.ok(probe.streams.some(s=>s.codec_type==='audio'));
    }
  }
  const state=await (await fetch(app.runtime.origin+'/api/state')).json();assert.deepEqual(state.jobs.map(j=>j.clipIndex),[1,2,3]);
});
