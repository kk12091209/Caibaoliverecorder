import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createApp,fetch} from './helpers/authenticated-app.js';
import {CompactStorage} from '../server/compact-storage.js';

const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',ffprobe=process.env.FFPROBE_PATH||'ffprobe';
const hash=data=>createHash('sha256').update(data).digest('hex');
for(const mode of ['chunks','direct'])test(`${mode}: previously recorded video previews and exports after metadata change and backend restart`,{timeout:60000},async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'caibo old material 旧素材-'));let app;
 const options={data:path.join(root,'data'),noRecorder:true,port:0,preparation:false,compact:false,updatesAutoCheck:false,ffmpeg,ffprobe};
 t.after(async()=>{await app?.close();await fs.rm(root,{recursive:true,force:true});});
 app=await createApp(options);await app.startupRecovery;
 const recorded=path.join(app.recorder.directory,'old.flv');await fs.mkdir(path.dirname(recorded),{recursive:true});
 execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=25','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','6','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','50','-bf','0','-c:a','aac','-y',recorded],{windowsHide:true});
 const xml=recorded.replace('.flv','.xml');await fs.writeFile(xml,'<i><d p="1.2,1,25,16777215,0,0,0,0" user="旧素材观众">保留原始弹幕</d></i>');
 const session=app.store.createSession({status:'finished',title:'升级前已录制'}),source=app.store.addSource(session.id,recorded,0,'2026-11-04T12:00:00Z',true);
 for(let n=0;n<8;n++)await app.ingestor.tick();
 const edits=app.store.saveEdit(session.id,{revision:0,ranges:[{start:1,end:2.5}],excluded:[],undo:[]});
 if(mode==='direct'){
  app.store.run('INSERT INTO source_storage(source,eligible) VALUES(?,1)',source.id);const storage=new CompactStorage(app.store,{isBusy:()=>false});try{await storage.tick();}finally{await storage.close();}
  assert.equal(app.store.get('SELECT mode FROM source_storage WHERE source=?',source.id).mode,'direct');
 }
 const preview=async start=>{const response=await fetch(`${app.runtime.origin}/api/sessions/${session.id}/preview?start=${start}`);assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.toString('ascii',4,8),'ftyp');return bytes;};
 const decode=bytes=>execFileSync(ffmpeg,['-v','error','-i','pipe:0','-map','0','-f','framemd5','pipe:1'],{input:bytes,windowsHide:true,maxBuffer:4*1024*1024}).toString();
 const before=decode(await preview(1.5)),rawHash=hash(await fs.readFile(recorded)),xmlHash=hash(await fs.readFile(xml));
 const files=mode==='direct'?[recorded]:app.store.all('SELECT path FROM chunks WHERE source=?',source.id).map(x=>x.path);
 for(const f of files){const mode=(await fs.stat(f)).mode&0o777;await fs.chmod(f,mode^0o200);await fs.chmod(f,mode);}
 await app.close();app=null;
 app=await createApp(options);await app.startupRecovery;
 assert.equal(decode(await preview(1.5)),before,'reopened preview decodes to the same video and audio frames');
 const output=await app.media.exportJob({id:'old-material-export',session:session.id,ranges:edits.ranges,excluded:[],revision:edits.revision,mode:'clean',outputRoot:path.join(root,'exports')});
 const info=JSON.parse(execFileSync(ffprobe,['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',output],{windowsHide:true}).toString());
 assert.ok(Math.abs(Number(info.format.duration)-1.5)<.15);assert.deepEqual(info.streams.map(x=>x.codec_type).sort(),['audio','video']);
 assert.deepEqual(app.store.edit(session.id),edits);
 assert.equal(hash(await fs.readFile(recorded)),rawHash);assert.equal(hash(await fs.readFile(xml)),xmlHash);
 assert.equal(app.store.messages(session.id)[0].text,'保留原始弹幕');
});
