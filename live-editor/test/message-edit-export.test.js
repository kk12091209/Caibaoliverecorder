import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Store} from '../server/store.js';
import {Ingestor} from '../server/ingest.js';
import {Media} from '../server/media.js';
import {HIGHLIGHT_SETTING} from '../shared/highlight-style.js';

test('real video export burns frozen corrected nickname/text while keeping original XML and the clean video intact',async t=>{
  const ffmpeg=process.env.FFMPEG_PATH,ffprobe=process.env.FFPROBE_PATH;
  if(!ffmpeg||!ffprobe){t.skip('FFmpeg runtime is unavailable');return;}
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'message-edit-export-')),file=path.join(root,'source.flv');
  execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=0x101820:size=320x180:rate=15','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','7','-c:v','libx264','-preset','ultrafast','-g','15','-pix_fmt','yuv420p','-c:a','aac','-f','flv','-y',file]);
  const store=new Store(path.join(root,'data')),session=store.createSession({status:'finished',title:'edited-comment'}),source=store.addSource(session.id,file,0,'2026-10-31T00:00:00Z',true),ingest=new Ingestor(store),media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software'});
  t.after(async()=>{await media.close();store.close();await fs.rm(root,{recursive:true,force:true});});
  const xml='<i><d p="1,1,25,16777215,0,0,123,0" user="ORIGINAL">MISTAKE</d></i>';await fs.writeFile(source.xml,xml);
  for(let n=0;n<12;n++)await ingest.tick();const message=store.messages(session.id)[0],patches={[message.id]:{user:'SAFE',text:'FIXED'}};
  store.saveEdit(session.id,{...store.edit(session.id),messageEdits:patches,highlighted:[message.id]});store.setting(HIGHLIGHT_SETTING,{scale:2,showSender:true,color:'#00FF00'});
  const layout=media.renderer.layout.bind(media.renderer),rendered=[];media.renderer.layout=async(...args)=>{const rows=await layout(...args);rendered.push(...rows.map(row=>row.text));return rows;};
  const work=media.work.bind(media);media.work=()=>{};
  const result=await media.enqueue(session.id,{scope:'full',mode:'dual',exportDirectory:path.join(root,'out')}),id=result.id||result.jobs[0].id;
  const submitted=JSON.parse(store.get('SELECT data FROM jobs WHERE id=?',id).data);assert.deepEqual(submitted.messageEdits,patches);
  store.saveEdit(session.id,{...store.edit(session.id),messageEdits:{[message.id]:{user:'LATER',text:'CHANGED AFTER QUEUE'}}});
  media.work=work;await media.work();const job=store.get('SELECT * FROM jobs WHERE id=?',id);assert.equal(job.status,'done',job.error);
  assert.ok(rendered.includes('SAFE：FIXED'),JSON.stringify(rendered));assert.ok(rendered.every(text=>!text.includes('ORIGINAL')&&!text.includes('MISTAKE')&&!text.includes('LATER')));
  assert.equal(await fs.readFile(source.xml,'utf8'),xml);assert.equal(store.get('SELECT text FROM danmaku WHERE id=?',message.id).text,'MISTAKE');
  const baked=JSON.parse(job.data).output.danmakuFile,pixels=name=>execFileSync(ffmpeg,['-v','error','-ss','3','-i',name,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
  const green=bytes=>{let n=0;for(let i=0;i<bytes.length;i+=3)if(bytes[i+1]>100&&bytes[i+1]>bytes[i]*1.8&&bytes[i+1]>bytes[i+2]*1.8)n++;return n;};
  assert.equal(green(pixels(job.file)),0);assert.ok(green(pixels(baked))>100,'corrected highlighted glyphs appear in the encoded frame');
  if(process.env.CAIBO_MESSAGE_EDIT_EVIDENCE){await fs.mkdir(process.env.CAIBO_MESSAGE_EDIT_EVIDENCE,{recursive:true});execFileSync(ffmpeg,['-v','error','-ss','3','-i',baked,'-frames:v','1','-y',path.join(process.env.CAIBO_MESSAGE_EDIT_EVIDENCE,'edited-export.png')]);}
});
