import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {Store} from '../server/store.js';
import {Ingestor} from '../server/ingest.js';
import {Media} from '../server/media.js';
import {saveGift,giftFromXml} from '../server/gifts.js';
import {GiftIcons,giftIconKey} from '../server/gift-icons.js';
import {overlayTimeExpression} from '../server/overlay-time.js';
import {DEFAULT_GIFT_STYLE} from '../shared/gifts.js';
const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',ffprobe=process.env.FFPROBE_PATH||'ffprobe';
test('real dual export keeps clean output pure, burns optional gift artwork at the right time and freezes the submitted events',async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'gift-export-')),video=path.join(root,'fixture.flv');
 execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=0x101820:size=320x180:rate=15','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','7','-c:v','libx264','-preset','ultrafast','-g','15','-pix_fmt','yuv420p','-c:a','aac','-f','flv','-y',video]);
 const store=new Store(path.join(root,'data')),session=store.createSession({status:'finished',title:'gift-export'}),source=store.addSource(session.id,video,0,'2026-10-30T00:00:00Z',true),ingest=new Ingestor(store);
 const media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software'});t.after(async()=>{await media.close();store.close();await fs.rm(root,{recursive:true,force:true});});
 for(let n=0;n<12;n++)await ingest.tick();assert.ok(store.session(session.id).duration>6);
 const icon='https://i0.hdslb.com/bfs/live/test-icon.png';
 const gift=giftFromXml('gift',{ts:'2',user:'TEST USER',giftname:'PAID GIFT',giftcount:'1',total_price:'198',icon},source,1);saveGift(store,gift);
 const png=execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=red:size=96x96','-frames:v','1','-c:v','png','-f','image2pipe','pipe:1']);
 store.run('INSERT INTO gift_icons VALUES(?,?,?)',giftIconKey(icon),png,Date.now());
 store.giftIcons=new GiftIcons(store,{ffmpeg,request:()=>assert.fail('cached artwork needs no network')});
 const run=media.work.bind(media);media.work=()=>{};
 const first=await media.enqueue(session.id,{scope:'full',mode:'dual',giftsEnabled:true,exportDirectory:path.join(root,'out')});
 const id=first.id||first.jobs[0].id;
 const submitted=JSON.parse(store.get('SELECT data FROM jobs WHERE id=?',id).data);assert.equal(submitted.gifts.length,1);assert.equal(submitted.gifts[0].name,'PAID GIFT');assert.ok(submitted.giftIcons[giftIconKey(icon)]);
 store.run("UPDATE gift_events SET name='AFTER SUBMISSION',total_price=1 WHERE id=?",gift.id);
 store.setting('gift-style',{...DEFAULT_GIFT_STYLE,preview:true,minBilibili:1000});
 media.work=run;await media.work();
 const job=store.get('SELECT * FROM jobs WHERE id=?',id);assert.equal(job.status,'done',job.error);
 const details=JSON.parse(job.data),clean=job.file,baked=details.output.danmakuFile;
 const frame=(file,time)=>execFileSync(ffmpeg,['-v','error','-ss',String(time),'-i',file,'-frames:v','1','-vf','crop=90:55:225:119','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
 const difference=(a,b)=>a.reduce((n,v,i)=>n+Math.abs(v-b[i]),0);
 const quiet=difference(frame(clean,.5),frame(baked,.5)),shown=difference(frame(clean,3),frame(baked,3));
 assert.ok(shown>10000&&shown>quiet*4,`gift pixel difference ${shown}, before event ${quiet}`);
 const colors=frame(baked,3);assert.ok(Array.from({length:colors.length/3},(_,i)=>[colors[i*3],colors[i*3+1],colors[i*3+2]]).some(([r,g,b])=>r>150&&r>g*2&&r>b*2),'actual red gift artwork is in the encoded frame');
 const probe=JSON.parse(execFileSync(ffprobe,['-v','error','-show_entries','stream=codec_type','-of','json',baked]));assert.ok(probe.streams.some(s=>s.codec_type==='audio'));
 // Preview is deliberately enabled; an omitted export switch still stays off.
 const off=await media.enqueue(session.id,{scope:'full',mode:'danmaku',exportDirectory:path.join(root,'out')});
 const offId=off.id||off.jobs[0].id;for(let n=0;n<300;n++){if(store.get('SELECT status FROM jobs WHERE id=?',offId).status!=='queued'&&!media.processing)break;await new Promise(r=>setTimeout(r,20));}
 const offJob=store.get('SELECT * FROM jobs WHERE id=?',offId);assert.equal(offJob.status,'done',offJob.error);assert.equal(JSON.parse(offJob.data).gifts,undefined);
 assert.ok(difference(frame(clean,3),frame(offJob.file,3))<shown/4);

 const marker=giftFromXml('sc',{ts:'1.2',user:'观众',price:'100',time:'8',bodycolor:'#eec44f'},source,2,'这张留言需要跨选段保留。');
 saveGift(store,marker);
 const chat=await media.enqueue(session.id,{scope:'clips',ranges:[{start:3,end:5}],mode:'danmaku',
   giftsEnabled:false,superChatEnabled:true,exportDirectory:path.join(root,'out')});
 const chatId=chat.id||chat.jobs[0].id;
 for(let n=0;n<300;n++){if(store.get('SELECT status FROM jobs WHERE id=?',chatId).status!=='queued'&&!media.processing)break;await new Promise(r=>setTimeout(r,20));}
 const chatJob=store.get('SELECT * FROM jobs WHERE id=?',chatId);
 assert.equal(chatJob.status,'done',chatJob.error);
 assert.deepEqual(JSON.parse(chatJob.data).gifts.map(event=>event.type),['sc']);
 const chatFrame=frame(chatJob.file,.08);
 assert.ok(chatFrame.some((v,i)=>i%3===0&&v>165&&chatFrame[i+1]>140&&chatFrame[i+2]<140),
   'the first exported clip frame contains the SC already in progress');
 // A classified filter error splits only the failed span. Simulate disk
 // exhaustion after block zero, then verify that the real retry reuses it.
 store.setting('gift-style',DEFAULT_GIFT_STYLE);
 const processVideo=media.processExportVideo.bind(media);
 media.work=()=>{};
 const split=await media.enqueue(session.id,{scope:'full',mode:'dual',giftsEnabled:true,exportDirectory:path.join(root,'out')});
 const splitId=split.id||split.jobs[0].id;
 const splitRow=()=>store.get('SELECT * FROM jobs WHERE id=?',splitId);
 media.processExportVideo=async(args,options)=>{
   if(args.includes('final-danmaku.mp4'))throw Object.assign(Error('filter evaluation fixture'),{code:'EXPORT_OVERLAY_EXPRESSION',filter:'overlay'});
   if(args.includes('part-0-block-1-danmaku.mp4'))throw Object.assign(Error('disk full fixture'),{code:'ENOSPC'});
   return processVideo(args,options);
 };
 await run();
 const stopped=JSON.parse(splitRow().data);
 assert.equal(splitRow().status,'failed');
 assert.equal(stopped.processingRecovery.completedSteps,1);
 media.processExportVideo=async(args,options)=>{
   assert.ok(!args.includes('part-0-block-0-danmaku.mp4'),'validated split block was kept');
   assert.ok(!args.includes('final-danmaku.mp4'),'the original failed span is not rerun');
   return processVideo(args,options);
 };
 assert.equal((await media.retryExport(splitId)).status,'queued');
 await run();
 const splitDone=JSON.parse(splitRow().data);
 assert.equal(splitRow().status,'done',splitRow().error);
 assert.ok(splitDone.resumedExportSteps>=1);
 for(const time of [2.8,3.2,5.8,6.2]){
   const pixels=frame(splitDone.output.danmakuFile,time);
   assert.ok(pixels.some((v,i)=>i%3===0&&v>150&&v>2*pixels[i+1]&&v>2*pixels[i+2]),'gift artwork survives both sides of each splice');
 }
 const streams=JSON.parse(execFileSync(ffprobe,['-v','error','-show_entries','stream=codec_type,duration','-of','json',splitDone.output.danmakuFile])).streams;
 assert.equal(streams.length,2);
 assert.ok(streams.every(stream=>Math.abs(Number(stream.duration)-7)<.15),JSON.stringify(streams));
});

test('a full recording with over 100 gift intervals resumes after the former FFmpeg failure',async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'gift-export-long-'));
 const store=new Store(path.join(root,'data'));
 const media=new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software'});
 t.after(async()=>{media.close();store.close();await fs.rm(root,{recursive:true,force:true});});
 const session=store.createSession({status:'finished',title:'Long gift export'});
 const ingest=new Ingestor(store),sourceFiles=[];
 for(const [index,seconds] of [8,625].entries()){
   const file=path.join(root,`source-${index}.flv`);
   execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=0x101820:size=160x90:rate=10','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t',String(seconds),'-c:v','libx264','-preset','ultrafast','-g','10','-pix_fmt','yuv420p','-c:a','aac','-f','flv','-y',file]);
   const start=index?store.session(session.id).duration:0;
   sourceFiles.push({file,size:(await fs.stat(file)).size});
   store.addSource(session.id,file,start,new Date(Date.UTC(2026,10,20,19,0,start)).toISOString(),true);
   for(let tick=0;tick<12&&store.sources(session.id).at(-1).closed!==2;tick++)await ingest.tick();
 }
 const source=store.sources(session.id).at(-1);
 const duration=store.session(session.id).duration;
 assert.ok(duration>630&&source.closed===2);
 const icon='https://i0.hdslb.com/bfs/live/long-export-fixture.png',times=Array.from({length:103},(_,i)=>2+6*i);
 const artwork=execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=red:size=96x96','-frames:v','1','-c:v','png','-f','image2pipe','pipe:1']);
 store.run('INSERT INTO gift_icons VALUES(?,?,?)',giftIconKey(icon),artwork,Date.now());
 for(const [index,time] of times.entries())
   saveGift(store,giftFromXml('gift',{ts:String(time),user:'TEST USER',giftname:'REPEATED GIFT',giftcount:'1',total_price:'198',icon},source,index+1));
 store.giftIcons=new GiftIcons(store,{ffmpeg,request:()=>assert.fail('cached artwork needs no network')});

 const run=media.work.bind(media),processVideo=media.processExportVideo.bind(media);
 media.work=()=>{};
 const queued=await media.enqueue(session.id,{scope:'full',mode:'dual',giftsEnabled:true,exportDirectory:path.join(root,'out')});
 const id=queued.id||queued.jobs[0].id,row=()=>store.get('SELECT * FROM jobs WHERE id=?',id);
 const flat=times.map(time=>`gte(t,${time.toFixed(4)})*lt(t,${(time+5).toFixed(4)})`).join('+');
 let legacyFailure;
 media.processExportVideo=async(args,options)=>{
   if(!args.includes('part-1-danmaku.mp4'))return processVideo(args,options);
   const graphIndex=args.indexOf('-filter_complex')+1;
   const graph=args[graphIndex].replace(/enable='[^']*'/,()=>"enable='"+flat+"'");
   const legacy=[...args];legacy[graphIndex]=graph;
   try{await processVideo(legacy,options);}
   catch(error){legacyFailure=error;throw new Error('0.4.5: 视频处理失败 (244)');}
 };
 await run();
 assert.equal(legacyFailure?.code,'EXPORT_OVERLAY_EXPRESSION');
 assert.equal(row().status,'failed');
 const failed=JSON.parse(row().data);
 assert.equal(failed.processingRecovery.completedSteps,1);

 media.processExportVideo=async(args,options)=>{
   assert.ok(!args.includes('part-0-danmaku.mp4'),'completed source part should be reused');
   return processVideo(args,options);
 };
 assert.equal((await media.retryExport(id)).status,'queued');
 await run();
 const result=row(),done=JSON.parse(result.data);
 assert.equal(result.status,'done',result.error);
 assert.ok(done.resumedExportSteps>=1);
 const baked=done.output.danmakuFile;
 const probe=file=>JSON.parse(execFileSync(ffprobe,['-v','error','-show_entries','stream=codec_type,duration:format=duration','-of','json',file]));
 for(const file of [result.file,baked]){
   const streams=probe(file).streams;
   assert.equal(streams.length,2);
   assert.ok(streams.every(stream=>Math.abs(Number(stream.duration)-duration)<0.2),JSON.stringify(streams));
 }
 const frame=(file,time)=>execFileSync(ffmpeg,['-v','error','-ss',String(time),'-i',file,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
 const red=bytes=>Array.from({length:bytes.length/3},(_,i)=>i*3).some(i=>bytes[i]>150&&bytes[i]>2*bytes[i+1]&&bytes[i]>2*bytes[i+2]);
 assert.equal(red(frame(baked,source.start+times.at(-1)+1)),true,'last gift retains its icon in the complete file');
 assert.equal(red(frame(result.file,source.start+times.at(-1)+1)),false,'clean output has no gift artwork');
 for(const {file,size} of sourceFiles)assert.equal((await fs.stat(file)).size,size,'recordings stay available during recovery');
});


test('large time filters use a file and preserve both sides of an exact frame boundary',async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'overlay-graph-'));
 const media=new Media({root}, {ffmpeg,ffprobe});
 t.after(async()=>{media.close();await fs.rm(root,{recursive:true,force:true});});
 const intervals=Array.from({length:1200},(_,index)=>[index*3+1,index*3+2]);
 const expression=overlayTimeExpression(intervals,4);
 const base=['-f','lavfi','-i','color=black:s=16x16:r=1:d=3'];
 const filter=enable=>`setpts=PTS+3597/TB,drawbox=w=16:h=16:c=white:t=fill:enable='${enable}'`;
 const expected=execFileSync(ffmpeg,['-v','error',...base,'-vf',filter('gte(t,3598)*lt(t,3599)'),'-f','framemd5','pipe:1']);
 assert.ok(expression.length>8192);
 await media.processExportVideo([...base,'-vf',filter(expression),'-f','framemd5','actual.md5'],{cwd:root});
 assert.deepEqual(await fs.readFile(path.join(root,'actual.md5')),expected);
 assert.deepEqual(await fs.readdir(root),['actual.md5']);
});
