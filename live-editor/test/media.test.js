import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Store, validateRanges } from '../server/store.js';
import { Ingestor, tags, sourceStream, seekBase } from '../server/ingest.js';
import { Media, assText } from '../server/media.js';
import { Recorder, roomNumber } from '../server/recorder.js';
import { createApp } from '../server/index.js';
import { outputSpan, clipFile } from '../server/output-names.js';

const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',ffprobe=process.env.FFPROBE_PATH||'ffprobe';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-editor-test-'));
const fixture=path.join(root,'fixture.flv');
execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','12','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','90','-keyint_min','90','-sc_threshold','0','-bf','0','-c:a','aac','-f','flv','-y',fixture]);
await fs.writeFile(fixture.replace('.flv','.xml'),'<?xml version="1.0"?><i><d p="1.2,1,25,16777215,0,0,0,0" user="观众A">保留这条</d><d p="4.8,1,25,16777215,0,0,0,0" user="观众B">不想显示</d><d p="6.1,1,25,16777215,0,0,0,0" user="观众C">精彩瞬间</d></i>');
const fingerprint=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const probe=p=>JSON.parse(execFileSync(ffprobe,['-v','error','-show_entries','format=duration:stream=codec_type,duration','-of','json',p]).toString());
const opened=[];
async function setup(name,file=fixture,closed=true){const store=new Store(path.join(root,name));opened.push(store);const session=store.createSession({title:'测试直播',status:closed?'finished':'recording'});const source=store.addSource(session.id,file,0,new Date().toISOString(),closed);const ingest=new Ingestor(store);for(let n=0;n<10;n++)await ingest.tick();assert.equal(store.get('SELECT error FROM sources WHERE id=?',source.id).error,'');return {store,session,source,ingest,media:new Media(store,{ffmpeg,ffprobe,exportAcceleration:'software'})};}
function traceExportWork(media) {
  const run=media.process.bind(media),directories=new Set(),subtitles=[];
  media.process=async(args,options={})=>{
    if(options.cwd&&path.basename(options.cwd).startsWith('bili-export-')) {
      assert.equal(path.dirname(options.cwd),path.join(media.store.root,'temp'));
      directories.add(options.cwd);
      for(const name of await fs.readdir(options.cwd))if(name.endsWith('.ass'))subtitles.push(await fs.readFile(path.join(options.cwd,name),'utf8'));
    }
    return run(args,options);
  };
  return {directories,subtitles,async cleaned(){assert.ok(directories.size);for(const dir of directories)await assert.rejects(fs.access(dir),/ENOENT/);}};
}

test('ASS 序列化保留时间与文本，并处理特殊字符',()=>{
  const messages=[{time:1.85,user:'甲&乙',text:'精彩<&>瞬间',color:16777215},{time:4.2,user:'丙',text:'换行\n与{标签}\\文本'}];
  const ass=assText(messages,640,360);
  assert.ok(ass.includes('PlayResX: 640'));assert.ok(ass.includes('Dialogue: 0,0:00:01.85,0:00:07.85'));assert.ok(ass.includes('换行 与 标签  文本'));
});

test('一秒内部片段可依赖三秒间隔的关键帧，连续重建仍可解码',async()=>{
  const {store,session,source}=await setup('chunks');
  const chunks=store.all('SELECT * FROM chunks WHERE source=? ORDER BY seq',source.id);
  assert.equal(chunks.length,Math.ceil(Number(probe(fixture).format.duration)));for(const c of chunks)assert.ok(c.end-c.start<=1.05,`${c.end-c.start}`);
  const keys=store.all('SELECT * FROM keyframes WHERE source=? ORDER BY time',source.id);assert.equal(keys.length,4);assert.ok(chunks.length>keys.length);
  const rebuilt=path.join(root,'reconstructed.flv'),buffers=[];for await(const b of sourceStream(store,source.id,0,13))buffers.push(b);await fs.writeFile(rebuilt,Buffer.concat(buffers));
  const info=probe(rebuilt);assert.ok(Math.abs(Number(info.format.duration)-12)<.15);assert.equal(info.streams.length,2);
  execFileSync(ffmpeg,['-v','error','-i',rebuilt,'-f','null','-']);
  assert.ok(seekBase(store,source.id,4.25)>2.9&&seekBase(store,source.id,4.25)<3.2);assert.ok(store.session(session.id).duration>11.9);store.close();
});

test('正在写入时只发布完整数据，重启后继续索引且已有编辑不变',async()=>{
  const bytes=await fs.readFile(fixture),growing=path.join(root,'growing.flv'),cut=Math.floor(bytes.length*.43);
  await fs.writeFile(growing,bytes.subarray(0,cut));
  const {store,session,source,ingest}=await setup('growing',growing,false);
  const before=store.session(session.id).duration;assert.ok(before>2&&before<10);
  const edit=store.saveEdit(session.id,{revision:0,ranges:[{start:.5,end:2}],excluded:[],undo:[]});
  const priorChunks=store.all('SELECT path FROM chunks WHERE source=?',source.id);const hashes=await Promise.all(priorChunks.map(c=>fingerprint(c.path)));
  await fs.appendFile(growing,bytes.subarray(cut));store.run('UPDATE sources SET closed=1 WHERE id=?',source.id);
  const restarted=new Ingestor(store);for(let n=0;n<4;n++)await restarted.tick();
  assert.ok(store.session(session.id).duration>11.9);assert.equal(store.get('SELECT closed FROM sources WHERE id=?',source.id).closed,2);assert.deepEqual(store.edit(session.id),edit);
  assert.deepEqual(await Promise.all(priorChunks.map(c=>fingerprint(c.path))),hashes);store.close();
});

test('跨内部片段精确导出、排除弹幕与完整原片互不影响',async()=>{
  const original=await fingerprint(fixture),xmlOriginal=await fingerprint(fixture.replace('.flv','.xml'));
  const {store,session,media}=await setup('export');const trace=traceExportWork(media),dm=store.messages(session.id);assert.equal(dm.length,3);
  for(const type of ['gift','guard','sc'])store.run('INSERT INTO danmaku VALUES(?,?,?,?,?,?,?,?)','legacy-'+type,session.id,'old-source',4.5,'送礼观众','不可导出的'+type,type,'16777215');
  const exclude=dm.find(d=>d.text==='不想显示').id;
  const edit=store.saveEdit(session.id,{revision:0,ranges:[{start:4.25,end:6.75},{start:.5,end:2}],excluded:[exclude],undo:[exclude]});
  const destination=path.join(root,'自定义导出 with spaces');
  const job={id:'verified-clip',session:session.id,ranges:edit.ranges,excluded:edit.excluded,revision:edit.revision,mode:'danmaku',outputRoot:destination};
  const output=await media.exportJob(job),info=probe(output);assert.ok(Math.abs(Number(info.format.duration)-4)<.25);assert.equal(info.streams.length,2);
  assert.equal(path.dirname(path.dirname(path.dirname(output))),path.join(destination,'导出片段'));
  assert.equal(path.basename(output),'【弹幕版】'+outputSpan(session,store.sources(session.id),edit.ranges).stem+'.mp4');
  const subtitles=trace.subtitles.join('\n');assert.ok(!subtitles.includes('不想显示'));assert.ok(subtitles.includes('保留这条'));assert.ok(subtitles.includes('精彩瞬间'));assert.ok(!subtitles.includes('不可导出'));
  assert.deepEqual(await fs.readdir(path.dirname(output)),[path.basename(output)]);await trace.cleaned();
  assert.deepEqual(store.edit(session.id),edit);assert.equal(store.messages(session.id).length,3);
  assert.equal(typeof media.archive,'undefined');
  assert.equal(await fingerprint(fixture),original);assert.equal(await fingerprint(fixture.replace('.flv','.xml')),xmlOriginal);store.close();
});

test('双版本共用选段，弹幕实际烧入第二份视频且在非关键帧切点仍对齐',async()=>{
  const {store,session,media}=await setup('dual-output');
  const trace=traceExportWork(media);
  // Keep only the 6.1 s message in this pixel comparison: the 1.2 s
  // message otherwise still has its six-second tail at clip start + 0.3 s.
  // The before frame must be genuinely blank to measure the later text.
  const excluded=store.messages(session.id).filter(m=>m.text!=='精彩瞬间').map(m=>m.id);
  const job={id:'dual',session:session.id,ranges:[{start:4.25,end:7.5}],excluded,revision:0,mode:'dual'};
  const clean=await media.exportJob(job),baked=clipFile(clean,'danmaku');
  // Different frame rates round the final video frame differently; their
  // timelines should still agree within one source frame.
  assert.ok(Math.abs(Number(probe(clean).format.duration)-Number(probe(baked).format.duration))<1/30+.005);assert.equal(probe(baked).streams.length,2);
  const pixels=(file,time)=>execFileSync(ffmpeg,['-v','error','-ss',String(time),'-i',file,'-frames:v','1','-vf','crop=640:75:0:0','-pix_fmt','gray','-f','rawvideo','pipe:1']);
  const difference=(time,file=baked)=>{const a=pixels(clean,time),b=pixels(file,time);assert.equal(a.length,b.length);return a.reduce((sum,value,i)=>sum+Math.abs(value-b[i]),0)/a.length;};
  const before=difference(.3),during=difference(2.8);assert.ok(during>before+.2,`expected visible baked text, diff before=${before}, during=${during}`);
  const subtitles=trace.subtitles.join('\n');assert.ok(!subtitles.includes('不想显示'));assert.ok(!subtitles.includes('保留这条'));assert.ok(subtitles.includes('精彩瞬间'));
  assert.deepEqual((await fs.readdir(path.dirname(clean))).sort(),[path.basename(clean),path.basename(baked)].sort());
  const only=await media.exportJob({...job,id:'clean-only',mode:'clean',output:undefined});
  await assert.rejects(fs.access(clipFile(only,'danmaku')),/ENOENT/);
  assert.deepEqual(await fs.readdir(path.dirname(only)),[path.basename(only)]);
  const bakedOnly=await media.exportJob({...job,id:'danmaku-only',mode:'danmaku',output:undefined});
  assert.ok(path.basename(bakedOnly).startsWith('【弹幕版】'));assert.deepEqual(await fs.readdir(path.dirname(bakedOnly)),[path.basename(bakedOnly)]);
  assert.ok(Math.abs(Number(probe(bakedOnly).format.duration)-Number(probe(clean).format.duration))<1/30+.005);assert.ok(difference(2.8,bakedOnly)>difference(.3,bakedOnly)+.2);
  await trace.cleaned();store.close();
});

test('第二份合并失败不会发布半成品，项目临时文件清理且无关文件与编辑不变',async t=>{
  const {store,session,media}=await setup('failed-merge');media.work=async()=>{};media.exportAcceleration='software';
  const systemTemp=t.mock.method(os,'tmpdir',()=> 'C:\\must-not-use-system-temp');
  const dm=store.messages(session.id),edit=store.saveEdit(session.id,{revision:0,ranges:[{start:1,end:2},{start:3,end:4}],excluded:[dm[0].id],undo:[dm[0].id]});
  const job=await media.enqueue(session.id,{mode:'dual'}),note=path.join(job.output.dir,'用户文件.txt');await fs.writeFile(note,'保留');
  const trace=traceExportWork(media),run=media.process.bind(media);
  media.process=async(args,options)=>{if(args.at(-1)==='final-danmaku.mp4')throw new Error('Simulated final merge failure');return run(args,options);};
  await assert.rejects(media.exportJob(job),/Simulated final merge failure/);
  assert.deepEqual(await fs.readdir(job.output.dir),['用户文件.txt']);assert.equal(await fs.readFile(note,'utf8'),'保留');await trace.cleaned();
  assert.equal(systemTemp.mock.callCount(),0);assert.deepEqual(await fs.readdir(path.join(store.root,'temp')),[]);
  assert.deepEqual(store.edit(session.id),edit);assert.equal(store.messages(session.id).length,3);store.close();
});

test('发布第二份视频遇到同名文件时不覆盖用户文件，并保留完整成片供保存重试',async t=>{
  const {store,session,media}=await setup('publish-collision');media.work=async()=>{};media.exportAcceleration='software';
  const systemTemp=t.mock.method(os,'tmpdir',()=> 'C:\\must-not-use-system-temp');
  const job=await media.enqueue(session.id,{ranges:[{start:1,end:2}],mode:'dual'}),occupied=clipFile(job.output.file,'danmaku');
  await fs.writeFile(occupied,'用户已有文件');const trace=traceExportWork(media);
  await assert.rejects(media.exportJob(job),error=>error.code==='EEXIST');
  assert.equal(await fs.readFile(occupied,'utf8'),'用户已有文件');assert.deepEqual(await fs.readdir(job.output.dir),[path.basename(occupied)]);
  const pending=JSON.parse(store.get('SELECT data FROM jobs WHERE id=?',job.id).data);
  assert.equal(pending.canRetrySave,true);assert.ok(trace.directories.has(pending.pendingPublication.directory));
  for(const name of ['final.mp4','final-danmaku.mp4'])assert.ok(Number(probe(path.join(pending.pendingPublication.directory,name)).format.duration)>.9);
  assert.equal(systemTemp.mock.callCount(),0);assert.deepEqual(await fs.readdir(path.join(store.root,'temp')),[path.basename(pending.pendingPublication.directory)]);store.close();
});

test('系统临时目录在 C 盘时，探测和导出仍使用项目 temp，成功后只清理本任务目录',async t=>{
  const {store,session,media}=await setup('项目临时目录 with spaces'),temporaryRoot=path.join(store.root,'temp');
  const systemTemp=t.mock.method(os,'tmpdir',()=> 'C:\\must-not-use-system-temp');
  await fs.mkdir(temporaryRoot);const existing=path.join(temporaryRoot,'bili-export-existing');await fs.mkdir(existing);await fs.writeFile(path.join(existing,'keep.txt'),'other job');
  const original=await fingerprint(fixture),runProbe=media.probe.bind(media),samples=[],trace=traceExportWork(media);
  media.probe=async file=>{assert.equal(path.dirname(path.dirname(file)),temporaryRoot);assert.ok(path.basename(path.dirname(file)).startsWith('bili-probe-'));samples.push(file);return runProbe(file);};
  const output=await media.exportJob({id:'project-temp',session:session.id,ranges:[{start:1,end:2}],excluded:[],mode:'dual'});
  assert.equal(systemTemp.mock.callCount(),0);assert.equal(samples.length,1);
  for(const sample of samples)await assert.rejects(fs.access(path.dirname(sample)),/ENOENT/);await trace.cleaned();
  assert.deepEqual(await fs.readdir(temporaryRoot),['bili-export-existing']);assert.equal(await fs.readFile(path.join(existing,'keep.txt'),'utf8'),'other job');
  assert.deepEqual((await fs.readdir(path.dirname(output))).sort(),[path.basename(output),path.basename(clipFile(output,'danmaku'))].sort());
  assert.equal(await fingerprint(fixture),original);store.close();
});

test('探测失败也清理项目 temp 内的样本，不使用系统临时目录或修改原片',async t=>{
  const {store,session,media}=await setup('failed-probe'),temporaryRoot=path.join(store.root,'temp');
  const systemTemp=t.mock.method(os,'tmpdir',()=> 'C:\\must-not-use-system-temp'),original=await fingerprint(fixture);
  let sample;
  media.probe=async file=>{sample=file;assert.equal(path.dirname(path.dirname(file)),temporaryRoot);await fs.access(file);throw new Error('Simulated probe failure');};
  await assert.rejects(media.exportJob({id:'failed-probe',session:session.id,ranges:[{start:1,end:2}],excluded:[],mode:'dual'}),/Simulated probe failure/);
  assert.ok(sample);assert.equal(systemTemp.mock.callCount(),0);assert.deepEqual(await fs.readdir(temporaryRoot),[]);
  assert.equal(await fingerprint(fixture),original);store.close();
});

test('原始 FLV 移走后仍从内部片段识别视频并导出，缓存信息也可继续使用',async()=>{
  const moved=path.join(root,'moved-original.flv');await fs.copyFile(fixture,moved);
  const {store,session,source,media}=await setup('indexed-probe',moved);await fs.rename(moved,moved+'.moved');
  assert.equal(store.setting('metadata:'+source.id),undefined);
  const job={id:'without-original',session:session.id,ranges:[{start:4.25,end:6.75}],excluded:[],mode:'clean'};
  const output=await media.exportJob(job);assert.ok(Math.abs(Number(probe(output).format.duration)-2.5)<.25);assert.equal(store.setting('metadata:'+source.id).width,640);
  media.probe=()=>{throw new Error('Should use indexed metadata');};await media.exportJob({...job,id:'cached',output:undefined});store.close();
});

test('选段勾选状态保存并随排序移动，导出只使用勾选内容，空选和无效模式被拒绝',async()=>{
  const {store,session,media}=await setup('selected-export');media.work=async()=>{};
  const edit=store.saveEdit(session.id,{revision:0,ranges:[{start:1,end:2,selected:false},{start:4,end:6,selected:true}],excluded:[],undo:[]});
  assert.equal(store.edit(session.id).ranges[0].selected,false);
  const reordered=store.saveEdit(session.id,{...edit,ranges:[...edit.ranges].reverse()});assert.equal(reordered.ranges[1].selected,false);
  const job=await media.enqueue(session.id,{mode:'danmaku'});assert.deepEqual(job.ranges,[{start:4,end:6}]);assert.equal(job.mode,'danmaku');
  const row=store.get('SELECT * FROM jobs WHERE id=?',job.id);assert.ok(path.basename(row.file).startsWith('【弹幕版】'));
  await assert.rejects(media.enqueue(session.id,{ranges:[],mode:'dual'}),/片段/);await assert.rejects(media.enqueue(session.id,{ranges:[{start:1,end:2,selected:false}]}),/片段/);
  await assert.rejects(media.enqueue(session.id,{mode:'wrong'}),/版本/);store.close();
});

test('素材删除需确认，录制或导出中拦截，永久删除释放内部片段并保留外部导入文件',async()=>{
  const {store,session,source,media}=await setup('trash');
  const before=await fingerprint(fixture),edit=store.saveEdit(session.id,{revision:0,ranges:[{start:1,end:2}],excluded:[],undo:[]});
  await assert.rejects(store.deleteSession(session.id,false),/确认/);
  store.run("UPDATE sessions SET status='recording' WHERE id=?",session.id);await assert.rejects(store.deleteSession(session.id,true),/录制/);
  store.run("UPDATE sessions SET status='finished',archive_status='running' WHERE id=?",session.id);await assert.rejects(store.deleteSession(session.id,true),/归档/);
  store.run("UPDATE sessions SET archive_status='pending' WHERE id=?",session.id);
  store.run('INSERT INTO jobs(id,session,status,data) VALUES(?,?,?,?)','pending-delete',session.id,'queued','{}');await assert.rejects(store.deleteSession(session.id,true),/导出/);
  store.run("UPDATE jobs SET status='failed' WHERE id='pending-delete'");
  const deleted=await store.deleteSession(session.id,true);assert.equal(deleted.ok,true);assert.ok(deleted.freedBytes>0);assert.equal(store.session(session.id),undefined);assert.equal(store.sessions().length,0);assert.equal(store.pendingCleanup().length,0);
  await assert.rejects(media.enqueue(session.id,{ranges:[{start:1,end:2}]}),/找不到/);
  const recorder=new Recorder(store);recorder.directory=path.dirname(fixture);await recorder.reconcile();assert.equal(store.sessions().length,0);
  assert.equal(store.get('SELECT id FROM sources WHERE path=?',fixture),undefined);assert.equal(store.wasSourceDeleted(fixture),true);assert.equal(await fingerprint(fixture),before);store.close();
});

test('移除监控先结束写入，调用核心删除并保留已有素材',async()=>{
  const store=new Store(path.join(root,'remove-room'));opened.push(store);const session=store.createSession({room:42,status:'recording'});store.addSource(session.id,fixture,0,new Date().toISOString(),false);
  const recorder=new Recorder(store),calls=[];recorder.poll=async()=>{};
  recorder.api=async(route,body,method)=>{calls.push({route,body,method});return route==='room'?[{roomId:42,recording:false}]:null;};
  await assert.rejects(recorder.removeRoom(42,false),/确认/);assert.equal(calls.length,0);await recorder.removeRoom(42,true);
  assert.deepEqual(calls.map(c=>c.route),['room/42/config','room/42/stop','room','room/42']);assert.equal(calls[0].body.autoRecord,false);assert.equal(calls.at(-1).method,'DELETE');
  assert.equal(store.session(session.id).status,'finishing');assert.equal(store.sources(session.id)[0].closed,1);await fs.access(fixture);store.close();
});

test('弹幕不完整 XML 可增量读取，追加后不会重复或丢失排除记录',async()=>{
  const video=path.join(root,'xml-grow.flv');await fs.copyFile(fixture,video);const xml=video.replace('.flv','.xml');
  await fs.writeFile(xml,'<i><d p="1.2,1,25,0" user="甲">第一条</d><d p="2.3,1,25,0" user="乙">还没');
  const {store,source,session,ingest}=await setup('xml',video,false);assert.equal(store.messages(session.id).length,1);
  const first=store.messages(session.id)[0];store.saveEdit(session.id,{revision:0,ranges:[],excluded:[first.id],undo:[first.id]});
  await fs.appendFile(xml,'写完</d></i>');await ingest.tick();await ingest.tick();assert.equal(store.messages(session.id).length,2);assert.equal(store.messages(session.id)[1].text,'还没写完');assert.deepEqual(store.edit(session.id).excluded,[first.id]);store.close();
});

test('只录普通弹幕：跳过礼物、上舰和付费留言，礼物尾段和半包仍可继续增量读取',async()=>{
  const video=path.join(root,'chat-only.flv');await fs.copyFile(fixture,video);const xml=video.replace('.flv','.xml');
  await fs.writeFile(xml,'<i><gift ts="1" user="送礼" giftname="粉丝团灯牌" giftcount="1"/><guard ts="2" user="上舰" count="1"/><sc ts="3" user="付费留言">付费内容</sc><d p="4,1,25,16777215" user="聊天">粉丝团灯牌 × 1 是什么？</d><gift ts="5" giftname="礼物"/>');
  const {store,source,session,ingest}=await setup('chat-only',video,false);
  assert.deepEqual(store.messages(session.id).map(m=>[m.type,m.text]),[['d','粉丝团灯牌 × 1 是什么？']]);
  assert.equal(store.get('SELECT xmlpos FROM sources WHERE id=?',source.id).xmlpos,(await fs.stat(xml)).size);
  await fs.appendFile(xml,'<gift ts="6" giftname="未完整');await ingest.tick();
  await fs.appendFile(xml,'的礼物"/><d p="7,1,25,16777215" user="聊天">之后的聊天正常录入</d></i>');await ingest.tick();await ingest.tick();
  assert.equal(store.messages(session.id).length,2);assert.equal(store.all("SELECT * FROM danmaku WHERE type!='d'").length,0);
  store.run('INSERT INTO danmaku VALUES(?,?,?,?,?,?,?,?)','old-gift',session.id,source.id,0,'旧记录','粉丝团灯牌 × 1','gift','16777215');
  assert.deepEqual(store.messages(session.id,0,10,'',1).map(x=>x.type),['d']);assert.equal(store.messages(session.id,0,10,'粉丝团灯牌').length,1);
  store.close();
});

test('启动和重新连接录制核心时关闭全局及房间的非聊天事件采集',async()=>{
  const store=new Store(path.join(root,'chat-config'));opened.push(store);const applied=[],recorders=[];
  try{for(let n=0;n<2;n++){
    const recorder=new Recorder(store,{executable:'already-running-core'});recorders.push(recorder);
    recorder.api=async(route,body)=>{if(body)applied.push({route,body});return route==='room'?[{roomId:42}]:null;};
    await recorder.start();recorder.close();
    }
    const changes=applied.filter(x=>x.route==='config/global'||x.route==='room/42/config');assert.equal(changes.length,4);
    for(const {body} of changes){assert.equal(body.optionalRecordDanmaku.value,true);assert.equal(body.optionalRecordDanmakuGift.value,false);assert.equal(body.optionalRecordDanmakuGuard.value,false);assert.equal(body.optionalRecordDanmakuSuperChat.value,false);}
  }finally{for(const recorder of recorders)recorder.close();store.close();}
});

test('乱序和重复 webhook 不重复创建文件，非法路径被拒绝',async()=>{
  const store=new Store(path.join(root,'events')),recorder=new Recorder(store);const event={EventId:'closed',EventType:'FileClosed',EventTimestamp:'2026-09-28T10:00:02Z',EventData:{RoomId:1,RelativePath:'1/test.flv',FileOpenTime:'2026-09-28T10:00:00Z',Streaming:true}};
  await recorder.event(event);await recorder.event(event);await recorder.event({...event,EventId:'opened',EventType:'FileOpening'});
  const sources=store.all('SELECT * FROM sources');assert.equal(sources.length,1);assert.equal(sources[0].closed,1);
  await assert.rejects(recorder.event({...event,EventId:'bad',EventData:{...event.EventData,RelativePath:'../outside.flv'}}));
  assert.equal(roomNumber('https://live.bilibili.com/123?x=1'),123);assert.throws(()=>roomNumber('https://live.douyin.com/123'));store.close();
});

test('编辑版本冲突、越界选段被拒绝',async()=>{
  const {store,session}=await setup('validation');store.saveEdit(session.id,{revision:0,ranges:[{start:1,end:2}],excluded:[],undo:[]});
  assert.throws(()=>store.saveEdit(session.id,{revision:0,ranges:[],excluded:[],undo:[]}));assert.throws(()=>validateRanges([{start:5,end:50}],12));assert.throws(()=>validateRanges([{start:NaN,end:2}],12));store.close();
});

test('重连形成多个原文件时，完整手动导出同一场录像并略过断流空缺',async()=>{
  const {store,session,media,ingest}=await setup('reconnect');
  const second=path.join(root,'second.flv');await fs.copyFile(fixture,second);
  const boundary=store.session(session.id).duration+.03,secondSource=store.addSource(session.id,second,boundary,new Date().toISOString(),true);for(let n=0;n<4;n++)await ingest.tick();
  const file=await media.exportJob({id:'cross-source',session:session.id,ranges:[{start:boundary-1,end:boundary+1}],excluded:[],revision:0,mode:'clean'});
  assert.ok(Math.abs(Number(probe(file).format.duration)-2)<.2);
  store.run('UPDATE sources SET start=start+5 WHERE path=?',second);store.run('UPDATE sessions SET duration=duration+5 WHERE id=?',session.id);
  store.run('UPDATE chunks SET start=start+5,end=end+5 WHERE source=?',secondSource.id);store.run('UPDATE keyframes SET time=time+5 WHERE source=?',secondSource.id);store.run('UPDATE danmaku SET time=time+5 WHERE source=?',secondSource.id);
  await assert.rejects(media.exportJob({id:'gap',session:session.id,ranges:[{start:boundary-1,end:boundary+6}],excluded:[],revision:0,mode:'clean'}),/空缺/);
  media.work=async()=>{};const full=await media.enqueue(session.id,{scope:'full',mode:'clean'}),fullFile=await media.exportJob(full);
  assert.ok(Number(probe(fullFile).format.duration)>23.8);assert.ok(Number(probe(fullFile).format.duration)<24.5);
  const decodeLog=execFileSync(ffmpeg,['-v','error','-xerror','-i',fullFile,'-f','null','-'],{stdio:['ignore','pipe','pipe']});assert.equal(decodeLog.length,0);store.close();
});

test('编辑服务漏收事件后从原始目录找回录制，不依赖 webhook 历史',async()=>{
  const store=new Store(path.join(root,'recovery'));opened.push(store);const recorder=new Recorder(store);await fs.mkdir(recorder.directory,{recursive:true});
  const file=path.join(recorder.directory,'recovered.flv');await fs.copyFile(fixture,file);await fs.writeFile(file.replace('.flv','.xml'),'<i><BililiveRecorderRecordInfo roomid="42" title="恢复录像" start_time="2026-09-28T10:00:00Z" /></i>');
  recorder.rooms=[{roomId:42,recording:false,streaming:false}];await recorder.reconcile();await recorder.reconcile();
  const sources=store.all('SELECT * FROM sources');assert.equal(sources.length,1);assert.equal(sources[0].closed,1);assert.equal(store.session(sources[0].session).title,'恢复录像');store.close();
});

test('本机 HTTP 接口支持导入、播放数据与来源限制',async()=>{
  const app=await createApp({automaticClean:false,preparation:false,port:17968,data:path.join(root,'http'),noRecorder:true,ffmpeg,ffprobe});
  try{
    const origin='http://127.0.0.1:17968';let response=await fetch(origin+'/api/sessions/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:fixture})});assert.equal(response.status,200);const session=await response.json();
    for(let n=0;n<8;n++){await app.ingestor.tick();await new Promise(r=>setTimeout(r,100));}
    response=await fetch(origin+`/api/sessions/${session.id}/preview?start=4.25`);assert.equal(response.status,200);const output=Buffer.from(await response.arrayBuffer());assert.ok(output.length>10000);assert.ok(output.toString('ascii',4,8)==='ftyp');const preview=path.join(root,'preview.mp4');await fs.writeFile(preview,output);assert.equal(probe(preview).streams.length,2);
    response=await fetch(origin+'/api/state',{headers:{Origin:'https://untrusted.example'}});assert.equal(response.status,403);
    response=await fetch(origin+'/api/sessions/import',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'});assert.equal(response.status,415);
    const custom=path.join(root,'HTTP 导出目录');
    response=await fetch(origin+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({exportDirectory:custom})});assert.equal(response.status,200);
    assert.equal(app.store.setting('export-directory'),custom);assert.equal((await (await fetch(origin+'/api/state')).json()).paths.exports,custom);
    response=await fetch(origin+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({exportDirectory:'relative/folder'})});assert.equal(response.status,400);assert.equal(app.store.setting('export-directory'),custom);
    app.store.saveEdit(session.id,{revision:0,ranges:[{start:1,end:2}],excluded:[],undo:[]});app.media.work=async()=>{};
    response=await fetch(origin+`/api/sessions/${session.id}/export`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,200);const job=await response.json();
    app.store.setting('export-directory',path.join(root,'changed-later'));
    const saved=app.store.get('SELECT * FROM jobs WHERE id=?',job.id);assert.equal(JSON.parse(saved.data).outputRoot,custom);assert.equal(saved.file,path.join(custom,'导出片段',job.output.date,job.output.stem,job.output.stem+'.mp4'));
    const exported=await app.media.exportJob(JSON.parse(saved.data));assert.equal(exported,saved.file);app.store.run("UPDATE jobs SET status='done',progress=1 WHERE id=?",job.id);
    assert.equal(saved.mode,'dual');assert.equal(job.mode,'dual');
    const publicJob=(await(await fetch(origin+'/api/state')).json()).jobs.find(row=>row.id===job.id);
    assert.equal(publicJob.status,'done');assert.equal(Object.hasOwn(publicJob,'encoder_label'),false);assert.equal(Object.hasOwn(publicJob,'danmaku_fps'),false);
    assert.ok(JSON.parse(app.store.get('SELECT data FROM jobs WHERE id=?',job.id).data).encoder);
    for(const kind of ['video','danmaku','xml','ass','manifest'])assert.equal((await fetch(origin+`/api/jobs/${job.id}/${kind}`)).status,404);
    for(const file of [exported,publicJob.danmaku_file])assert.ok((await fs.stat(file)).size>0);
    assert.equal(publicJob.danmaku_file,clipFile(exported,'danmaku'));
    for(const route of ['archive/video','archive/xml','archive/manifest'])assert.equal((await fetch(origin+`/api/sessions/${session.id}/${route}`)).status,404);
    response=await fetch(origin+`/api/sessions/${session.id}/restore`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,404);
    response=await fetch(origin+`/api/sessions/${session.id}/delete`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,400);
    response=await fetch(origin+`/api/sessions/${session.id}/delete`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"confirmed":true}'});assert.equal(response.status,200);
    assert.equal((await(await fetch(origin+'/api/state')).json()).sessions.length,0);
    assert.equal((await fetch(origin+`/api/sessions/${session.id}/messages`)).status,404);
    response=await fetch(origin+`/api/sessions/${session.id}/restore`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,404);
    assert.equal((await(await fetch(origin+'/api/state')).json()).sessions.length,0);
  }finally{await app.close();}
});

test.after(async()=>{for(const store of opened)try{store.close();}catch{}if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('bili-editor-test-'))await fs.rm(root,{recursive:true,force:true});});
