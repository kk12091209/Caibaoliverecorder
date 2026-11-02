import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Store} from '../server/store.js';
import {Ingestor,tags,timestamp,retime} from '../server/ingest.js';
import {DouyinRecorder} from '../server/douyin-recorder.js';
import {Media} from '../server/media.js';

const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',ffprobe=process.env.FFPROBE_PATH||'ffprobe';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<400;i++){if(check())return;await delay(5);}assert.fail('recording did not settle');}
test('real AVC/AAC survives clock and resolution switches as playable sources and a continuous export',async t=>{
  for(const change of ['clock-reset','resolution'])await t.test(change,async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'douyin-transition-media-'));
    let recorder,media,store;
    t.after(async()=>{await recorder?.close();media?.close();await media?.waitForSaves();store?.close();await fs.rm(root,{recursive:true,force:true});});
    const make=async(name,color,size,offset)=>{
      const file=path.join(root,name+'.flv');
      execFileSync(ffmpeg,['-v','error','-f','lavfi','-i',`color=${color}:size=${size}:rate=30`,'-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','30','-bf','0','-c:a','aac','-f','flv',file]);
      const bytes=await fs.readFile(file),frames=tags(bytes.subarray(13)).items.map(x=>x.tag).filter(tag=>!(tag[0]===9&&tag[12]===2));
      return Buffer.concat([bytes.subarray(0,13),...frames.map(tag=>retime(tag,(tag[0]===8||tag[0]===9)&&tag[12]!==0?timestamp(tag)+offset:0))]);
    };
    const first=await make('first','red','640x360',123000),second=await make('second','blue',change==='resolution'?'480x360':'640x360',0);
    store=new Store(path.join(root,'data'));
    let requests=0;
    const metadata={webRid:'123',roomId:'998',name:'本地切换样本',streaming:true,stream:{url:'https://pull-test.douyincdn.com/stream.flv'}};
    recorder=new DouyinRecorder(store,{pollMs:60000,chat:{start(){},async stop(){},async close(){}},resolver:{async room(){return metadata;}},request:async(_url,{signal})=>{
      const index=requests++;
      return new Response(new ReadableStream({start(controller){controller.enqueue(index===0?Buffer.concat([first,second.subarray(13)]):second);signal.addEventListener('abort',()=>{try{controller.close();}catch{}},{once:true});}}));
    }});
    recorder.start();await recorder.add({webRid:'123'},true);
    const room=recorder.room('123');await until(()=>!room.active);
    assert.match(room.recoveryReason,/恢复/);assert.equal(room.blocked,undefined);
    const session=store.sessions()[0].id,ingest=new Ingestor(store);await ingest.tick();await ingest.tick();
    room.retryAt=0;await recorder.poll(true);await until(()=>requests===2&&room.progress?.mediaMs>2500);
    await recorder.stopRoom('123');await ingest.tick();await ingest.tick();
    const sources=store.sources(session);assert.equal(sources.length,2);
    for(const source of sources){
      assert.equal(source.error,'');assert.equal(source.closed,2);assert.ok(source.duration>2.8);
      execFileSync(ffmpeg,['-v','error','-xerror','-i',source.path,'-f','null','-']);
    }
    // The service's status tick marks a stopped session ready once every
    // source is fully indexed; this isolated writer has no service timer.
    assert.equal(store.session(session).status,'finishing');
    store.run("UPDATE sessions SET status='finished' WHERE id=?",session);
    media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software',renderBlockSeconds:2});
    const output=await media.exportJob({id:'recovered-'+change,session,scope:'full',ranges:[{start:0,end:store.session(session).duration}],excluded:[],mode:'clean'});
    execFileSync(ffmpeg,['-v','error','-xerror','-i',output,'-f','null','-']);
    const pixel=at=>execFileSync(ffmpeg,['-v','error','-ss',String(at),'-i',output,'-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
    const before=pixel(1),after=pixel(sources[1].start+1);
    assert.ok(before[0]>150&&before[2]<80,'first source remains visible');
    assert.ok(after[2]>150&&after[0]<80,'reconnected source is present in the export');
  });
});
