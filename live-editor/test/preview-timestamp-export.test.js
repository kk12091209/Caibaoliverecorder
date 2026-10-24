import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Store} from '../server/store.js';
import {Media} from '../server/media.js';
import {Ingestor} from '../server/ingest.js';

test('enabling the preview timestamp leaves clean and danmaku exported pixels and audio identical',async t=>{
  const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',ffprobe=process.env.FFPROBE_PATH||'ffprobe';
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'preview-timestamp-export-'));
  const store=new Store(path.join(root,'data'));store.projectRoot=root;
  const media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software'});media.work=async()=>{};
  t.after(async()=>{media.close();await media.waitForSaves();store.close();await fs.rm(root,{recursive:true,force:true});});
  const run=args=>execFileSync(ffmpeg,['-v','error',...args],{maxBuffer:16*1024**2});
  const file=path.join(root,'input.flv');
  run(['-f','lavfi','-i','testsrc2=size=320x180:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-c:a','aac','-y',file]);
  const original=await fs.readFile(file),session=store.createSession({status:'finished',created:'2026-10-24T08:30:00+08:00'});
  const source=store.addSource(session.id,file,0,session.created,true);
  await fs.writeFile(source.xml,'<i><d p="0.2,1,25,16777215,0,0,0,0">PREVIEW ONLY CLOCK</d></i>');
  const ingest=new Ingestor(store);for(let i=0;i<5;i++)await ingest.tick();
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),outputs=[];
  for(const enabled of [false,true]){
    store.setting('preview-timestamp',enabled);
    const job=await media.enqueue(session.id,{scope:'full',mode:'dual',exportDirectory:path.join(root,enabled?'on':'off')});
    assert.equal('previewTimestamp' in job,false);
    await media.exportJob(job);await media.waitForSaves();
    const signatures=[];
    for(const output of [job.output.file,job.output.danmakuFile]){
      signatures.push({video:hash(run(['-i',output,'-map','0:v:0','-pix_fmt','yuv420p','-f','rawvideo','pipe:1'])),audio:hash(run(['-i',output,'-map','0:a:0','-f','s16le','pipe:1']))});
    }
    outputs.push(signatures);
  }
  assert.deepEqual(outputs[1],outputs[0]);
  assert.notEqual(outputs[0][0].video,outputs[0][1].video,'fixture must exercise actual danmaku compositing');
  assert.equal(hash(await fs.readFile(file)),hash(original));
});
