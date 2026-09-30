import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {Store} from '../server/store.js';
import {Recorder} from '../server/recorder.js';
import {Ingestor,sourceStream,tags} from '../server/ingest.js';
import {CompactStorage} from '../server/compact-storage.js';
import {chunkReaderCount} from '../server/storage-files.js';

const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-compact-'));
const fixture=path.join(root,'fixture.flv'),silent=path.join(root,'silent.flv');
for(const [file,audio] of [[fixture,true],[silent,false]])execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=30',...(audio?['-f','lavfi','-i','sine=frequency=400:sample_rate=48000']:[]),'-t','4','-c:v','libx264','-preset','ultrafast','-g','45','-bf','0',...(audio?['-c:a','aac']:[]),'-y',file],{windowsHide:true});
const opened=[];
const collect=async stream=>{const buffers=[];for await(const buffer of stream)buffers.push(buffer);return Buffer.concat(buffers);};
const state=(store,id)=>store.get('SELECT * FROM source_storage WHERE source=?',id);
async function setup(name,{eligible=true,external=false,live=false,videoOnly=false,options={}}={}) {
  const store=new Store(path.join(root,name,'data'));opened.push(store);const storage=new CompactStorage(store,{isBusy:()=>false,...options});
  const recorder=new Recorder(store),file=external?path.join(root,name,'external.flv'):path.join(recorder.directory,'room','video.flv');await fs.mkdir(path.dirname(file),{recursive:true});
  let session,source;
  if(eligible&&!external) {
    await recorder.event({EventId:name+'-open',EventType:'FileOpening',EventTimestamp:new Date().toISOString(),EventData:{RoomId:1,RelativePath:path.relative(recorder.directory,file),FileOpenTime:new Date().toISOString()}});
    source=store.get('SELECT * FROM sources WHERE path=?',file);session=store.session(source.session);assert.equal(state(store,source.id).eligible,1);
  } else {session=store.createSession({status:'recording'});source=store.addSource(session.id,file,0,new Date().toISOString(),false);}
  const bytes=await fs.readFile(videoOnly?silent:fixture);await fs.writeFile(file,live?bytes.subarray(0,Math.floor(bytes.length*.65)):bytes);
  await fs.writeFile(source.xml,'<i><d p="1,1,25,16777215">原始弹幕</d></i>');
  const ingest=new Ingestor(store);
  if(!live)store.run('UPDATE sources SET closed=1 WHERE id=?',source.id);
  for(let n=0;n<6;n++)await ingest.tick();
  if(!live)store.run("UPDATE sessions SET status='finished' WHERE id=?",session.id);
  const chunks=store.all('SELECT * FROM chunks WHERE source=? ORDER BY seq',source.id);
  return {store,storage,recorder,file,session,source,ingest,chunks,bytes,async close(){await storage.close();store.close();}};
}

test('未来录制验证后释放过渡文件，流字节、随机seek、画面和音频与重启读取保持一致',async()=>{
  for(const videoOnly of [false,true]) {
    const t=await setup('equivalence-'+videoOnly,{videoOnly});
    const ranges=[[0,10],[.08,.25],[1.73,2.25],[2.6,3.9],[3.95,10]],before=[];
    for(const [from,to] of ranges)before.push(await collect(sourceStream(t.store,t.source.id,from,to)));
    const original=await fs.readFile(t.file),xml=await fs.readFile(t.source.xml),result=await t.storage.tick();
    assert.equal(state(t.store,t.source.id).status,'done',JSON.stringify(result));assert.equal(state(t.store,t.source.id).mode,'direct');
    assert.equal(result.freedBytes,t.chunks.reduce((sum,chunk)=>sum+chunk.bytes,0));
    for(const chunk of t.chunks)await assert.rejects(fs.access(chunk.path),/ENOENT/);
    assert.deepEqual(await fs.readFile(t.file),original);assert.deepEqual(await fs.readFile(t.source.xml),xml);
    for(let n=0;n<ranges.length;n++)assert.deepEqual(await collect(sourceStream(t.store,t.source.id,...ranges[n])),before[n]);
    const decode=bytes=>execFileSync(ffmpeg,['-v','error','-f','flv','-i','pipe:0','-map','0','-f','framemd5','pipe:1'],{input:bytes,windowsHide:true,maxBuffer:8*1024*1024});
    assert.deepEqual(decode(await collect(sourceStream(t.store,t.source.id,0,10))),decode(before[0]));
    await t.close();const reopened=new Store(t.store.root);opened.push(reopened);
    assert.deepEqual(await collect(sourceStream(reopened,t.source.id,1.73,2.25)),before[2]);
    await reopened.deleteSession(t.session.id,true);assert.equal(reopened.get('SELECT COUNT(*) AS n FROM direct_keyframes').n,0);assert.equal(reopened.get('SELECT COUNT(*) AS n FROM source_storage').n,0);reopened.close();
  }
});

test('旧chunk reader首次yield即持租约，新reader走原片，旧reader结束后才清理且不饿死其他素材',async()=>{
  const t=await setup('lease',{live:true}),old=sourceStream(t.store,t.source.id,0,10,{follow:true});
  const first=await old.next();assert.equal(chunkReaderCount(t.store,t.source.id),1);
  await fs.writeFile(t.file,t.bytes);t.store.run('UPDATE sources SET closed=1 WHERE id=?',t.source.id);for(let n=0;n<6;n++)await t.ingest.tick();t.store.run("UPDATE sessions SET status='finished' WHERE id=?",t.session.id);
  const before=await collect(sourceStream(t.store,t.source.id,0,10));assert.equal((await t.storage.tick()).pendingReaders,true);assert.equal(state(t.store,t.source.id).mode,'direct');
  for(const chunk of t.store.all('SELECT * FROM chunks WHERE source=?',t.source.id))await fs.access(chunk.path);
  assert.deepEqual(await collect(sourceStream(t.store,t.source.id,0,10)),before);
  await assert.rejects(t.store.deleteSession(t.session.id,true),/读取|整理/);
  assert.deepEqual(Buffer.concat([first.value,await collect(old)]),before);assert.equal(chunkReaderCount(t.store,t.source.id),0);
  await t.storage.tick();assert.equal(state(t.store,t.source.id).status,'done');await t.close();
});

test('reader return和abort释放租约，只有首next而非创建iterator决定模式',async()=>{
  const t=await setup('return'),idle=sourceStream(t.store,t.source.id,0,10),old=sourceStream(t.store,t.source.id,0,10);await old.next();
  await t.storage.tick();await old.return();await t.storage.tick();assert.equal(state(t.store,t.source.id).status,'done');assert.ok((await collect(idle)).length>100);
  const signal=new AbortController(),reader=sourceStream(t.store,t.source.id,0,10,{signal:signal.signal});await reader.next();signal.abort();await collect(reader);assert.equal(chunkReaderCount(t.store,t.source.id),0);await t.close();
});

test('中断的已验证清理可重启继续，缺失的已删文件不会重复计算释放空间',async()=>{
  let calls=0;const t=await setup('retry',{options:{unlink:async file=>{if(++calls===2)throw Object.assign(new Error('文件暂被占用'),{code:'EBUSY'});await fs.unlink(file);}}});
  const before=await collect(sourceStream(t.store,t.source.id,0,10));await t.storage.tick();assert.equal(state(t.store,t.source.id).status,'pending');assert.ok(state(t.store,t.source.id).freed_bytes>0);await t.close();
  const store=new Store(t.store.root);opened.push(store);assert.deepEqual(await collect(sourceStream(store,t.source.id,0,10)),before);
  const storage=new CompactStorage(store,{now:()=>Date.now()+60000,isBusy:()=>false});await storage.tick();assert.equal(state(store,t.source.id).status,'done');assert.equal(state(store,t.source.id).freed_bytes,t.chunks.reduce((sum,chunk)=>sum+chunk.bytes,0));await storage.close();store.close();
});

test('升级前历史、导入和reconcile不获得自动清理资格，trash与异常源始终保留',async()=>{
  for(const kind of ['history','external','trash','error']) {
    const t=await setup('retain-'+kind,{eligible:!['history','external'].includes(kind),external:kind==='external'});
    if(kind==='trash')t.store.run('UPDATE sessions SET deleted_at=? WHERE id=?',new Date().toISOString(),t.session.id);
    if(kind==='error')t.store.run("UPDATE sources SET error='录制不完整' WHERE id=?",t.source.id);
    await t.storage.tick();for(const chunk of t.chunks)await fs.access(chunk.path);assert.notEqual(state(t.store,t.source.id)?.mode,'direct');
    if(kind==='history'){await t.recorder.event({EventId:'late-opening',EventType:'FileOpening',EventTimestamp:new Date().toISOString(),EventData:{RoomId:1,RelativePath:path.relative(t.recorder.directory,t.file)}});assert.equal(state(t.store,t.source.id),undefined);}
    await t.close();
  }
  const store=new Store(path.join(root,'late-events'));opened.push(store);const recorder=new Recorder(store);
  for(const [id,openTime] of [['old','2020-01-01T00:00:00Z'],['missing',undefined],['invalid','bad']]) {
    await recorder.event({EventId:id,EventType:'FileOpening',EventTimestamp:new Date().toISOString(),EventData:{RoomId:1,RelativePath:id+'.flv',FileOpenTime:openTime}});
    const source=store.get('SELECT * FROM sources WHERE path=?',path.join(recorder.directory,id+'.flv'));assert.equal(state(store,source.id),undefined);
  }
  store.close();
});

test('原片缺失、截断或内容改变，以及chunk和关键帧不匹配时保留全部过渡片段并说明原因',async()=>{
  for(const kind of ['missing','truncated','changed','chunk','index']) {
    const t=await setup('mismatch-'+kind);
    if(kind==='missing')await fs.rename(t.file,t.file+'.saved');
    if(kind==='truncated')await fs.truncate(t.file,t.bytes.length-9);
    if(kind==='changed'){const bytes=Buffer.from(t.bytes),tag=tags(bytes.subarray(13)).items.find(item=>item.tag[0]===9&&item.tag[12]===1);bytes[13+tag.offset+18]^=1;await fs.writeFile(t.file,bytes);}
    if(kind==='chunk'){const bytes=await fs.readFile(t.chunks[0].path);bytes[18]^=1;await fs.writeFile(t.chunks[0].path,bytes);}
    if(kind==='index')t.store.run('UPDATE keyframes SET offset=offset+1 WHERE source=?',t.source.id);
    await t.storage.tick();assert.equal(state(t.store,t.source.id).mode,'chunks');assert.equal(state(t.store,t.source.id).status,'blocked');assert.ok(state(t.store,t.source.id).reason);for(const chunk of t.chunks)await fs.access(chunk.path);await t.close();
  }
});

test('验证期间替换原路径不能利用旧filehandle通过提交，封存后mtime改变读取明确拒绝',async()=>{
  const t=await setup('replace'),check=t.storage.checkedChunks.bind(t.storage);let calls=0;
  t.storage.checkedChunks=async(...args)=>{const result=await check(...args);if(++calls===2){await fs.rename(t.file,t.file+'.saved');await fs.writeFile(t.file,t.bytes);}return result;};
  await t.storage.tick();assert.equal(state(t.store,t.source.id).status,'blocked');assert.match(state(t.store,t.source.id).reason,/替换|改变/);for(const chunk of t.chunks)await fs.access(chunk.path);await t.close();
  const d=await setup('sealed');await d.storage.tick();const stat=await fs.stat(d.file);await fs.utimes(d.file,stat.atime,new Date(stat.mtimeMs+1000));await assert.rejects(collect(sourceStream(d.store,d.source.id,0,10)),/发生变化/);await d.close();
});

test('额外文件、共享引用、硬链接和junction不会被整理删除',async()=>{
  for(const kind of ['extra','shared','hardlink','junction']) {
    const t=await setup('paths-'+kind),folder=path.dirname(t.chunks[0].path);
    if(kind==='extra')await fs.writeFile(path.join(folder,'用户笔记.txt'),'keep');
    if(kind==='shared'){const other=t.store.createSession({status:'finished'}),source=t.store.addSource(other.id,path.join(root,'shared.flv'),0,new Date().toISOString(),true);t.store.run('INSERT INTO chunks VALUES(?,?,?,?,?,?)',source.id,0,0,1,t.chunks[0].path,t.chunks[0].bytes);}
    if(kind==='hardlink')await fs.link(t.chunks[0].path,path.join(root,'shared-hardlink.flvpart'));
    if(kind==='junction'){const moved=folder+'-saved';await fs.rename(folder,moved);await fs.symlink(moved,folder,process.platform==='win32'?'junction':'dir');}
    await t.storage.tick();assert.equal(state(t.store,t.source.id).status,'blocked');assert.equal(state(t.store,t.source.id).mode,'chunks');for(const chunk of t.chunks)await fs.access(chunk.path);await t.close();
  }
});

test('close取消扫描释放句柄，录制忙时不启动新扫描，显式delete不能与compaction竞争',async()=>{
  let busy=true;const t=await setup('cancel',{options:{isBusy:()=>busy}});assert.equal(await t.storage.tick(),undefined);assert.equal(state(t.store,t.source.id).mode,'chunks');busy=false;
  let entered,release;const checkpoint=new Promise(resolve=>{entered=resolve;}),original=t.storage.cooperate.bind(t.storage);let first=true;
  t.storage.cooperate=async source=>{if(first){first=false;entered();await new Promise(resolve=>{release=resolve;});}await original(source);};
  const tick=t.storage.tick();await checkpoint;await assert.rejects(t.store.deleteSession(t.session.id,true),/整理/);const closing=t.storage.close();release();await tick;await closing;
  assert.equal(state(t.store,t.source.id).mode,'chunks');for(const chunk of t.chunks)await fs.access(chunk.path);await fs.rename(t.file,t.file+'.unlocked');t.store.close();
});

test('共享引用检查缓存不随每片段自有更新失效，但清理中新增引用仍会拦截',async()=>{
  const t=await setup('reference-cache'),all=t.store.all.bind(t.store);let scans=0;
  t.store.all=(sql,...args)=>{if(sql==='SELECT path FROM chunks WHERE source<>?')scans++;return all(sql,...args);};
  await t.storage.tick();assert.equal(state(t.store,t.source.id).status,'done');assert.equal(scans,1);await t.close();
  let inserted=false,concurrent;
  const u=await setup('reference-race',{options:{unlink:async file=>{
    await fs.unlink(file);
    if(!inserted){inserted=true;const session=concurrent.store.createSession({status:'finished'}),source=concurrent.store.addSource(session.id,path.join(root,'later-reference.flv'),0,new Date().toISOString(),true),target=concurrent.chunks[1];concurrent.store.run('INSERT INTO chunks VALUES(?,?,?,?,?,?)',source.id,0,0,1,target.path,target.bytes);}
  }}});concurrent=u;
  await u.storage.tick();assert.equal(state(u.store,u.source.id).status,'pending');assert.match(state(u.store,u.source.id).reason,/引用/);await fs.access(u.chunks[1].path);await u.close();
});

test.after(async()=>{for(const store of opened){try{await store.storage?.close();}catch{}try{store.close();}catch{}}if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('bili-compact-'))await fs.rm(root,{recursive:true,force:true});});
