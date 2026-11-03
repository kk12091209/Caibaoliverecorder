import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp,fetch} from './helpers/authenticated-app.js';
import {minimalMp4} from './helpers/mp4-fixture.js';
import {Store} from '../server/store.js';

test('提醒阈值持久化但不限制缓存；清理只删除空闲的自有缓存，原片与租用中的缓存保留',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'preparation-cache-api-'));
 const app=await createApp({data:path.join(root,'data'),projectRoot:root,port:0,noRecorder:true,preparation:false,compact:false,automaticClean:false,ffmpeg:'must-not-launch',ffprobe:'must-not-launch'});
 await app.startupRecovery;app.ingestor.stop();t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
 const post=async(route,data={})=>{const response=await fetch(app.runtime.origin+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});return {status:response.status,value:await response.json()};};
 assert.equal(app.preparation.snapshot().cache.warningGiB,50);assert.equal(app.media.renderCache.maxBytes,Infinity);
 for(const cacheWarningGiB of [0,-1,1048577,1.2,'25'])assert.equal((await post('preparation/settings',{cacheWarningGiB})).status,400);
 assert.equal((await post('preparation/settings',{cacheWarningEnabled:'false'})).status,400);
 assert.equal((await post('preparation/settings',{cacheGiB:25})).status,400);
 const setting=await post('preparation/settings',{cacheWarningGiB:60});assert.equal(setting.status,200);assert.equal(app.store.setting('preparationCacheWarningGiB'),60);assert.equal(setting.value.cache.warningGiB,60);assert.equal(app.media.renderCache.maxBytes,Infinity);
 app.store.createSession({id:'cache-test',status:'finished'});const original=path.join(root,'original.flv');await fs.writeFile(original,'original-recording');
 const source=app.store.addSource('cache-test',original,0),spec={version:1,sessionId:'cache-test',sourceId:source.id,startMs:0,endMs:60000,sourceFingerprint:'source',profileHash:'profile',assHash:'ass'};
 app.media.renderCache.statfs=async()=>({bavail:1024**4,bsize:1});
 const held=await app.media.renderCache.build(spec,file=>fs.writeFile(file,minimalMp4),{estimatedBytes:minimalMp4.length});
 const first=await post('preparation/cache/clear');assert.equal(first.status,200);await fs.access(held.file);assert.equal(await fs.readFile(original,'utf8'),'original-recording');
 held.release();const second=await post('preparation/cache/clear');assert.equal(second.status,200);assert.ok(second.value.cleanup.freedBytes>0);await assert.rejects(fs.access(held.file),{code:'ENOENT'});assert.equal(await fs.readFile(original,'utf8'),'original-recording');assert.equal(app.preparation.status('cache-test').status,'paused');
});

test('提醒确认 API 仅确认当前轮次，清理后再次超值会重新提醒，旧请求不能确认新一轮',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'preparation-cache-warning-'));
 const app=await createApp({data:path.join(root,'data'),projectRoot:root,port:0,noRecorder:true,preparation:false,compact:false,automaticClean:false,ffmpeg:'must-not-launch',ffprobe:'must-not-launch'});
 await app.startupRecovery;app.ingestor.stop();await app.media.renderCache.loadAll();
 t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
 const post=async(route,data={},status=200)=>{const response=await fetch(app.runtime.origin+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});assert.equal(response.status,status);return response.json();};
 let used=49*1024**3;const snapshot=app.media.renderCache.snapshot.bind(app.media.renderCache);
 app.media.renderCache.snapshot=()=>({...snapshot(),usedBytes:used});
 assert.equal(app.preparation.snapshot().cache.warningDue,false);
 used=50*1024**3;const first=app.preparation.snapshot().cache;assert.equal(first.warningDue,true);
 const token={cycle:first.warningCycle,thresholdGiB:first.warningGiB};
 for(const input of [{},null,{cycle:0,thresholdGiB:50},{cycle:1,thresholdGiB:'50'}])await post('preparation/cache/acknowledge',input,400);
 const acknowledged=await post('preparation/cache/acknowledge',token);assert.equal(acknowledged.cache.warningDue,false);assert.equal(acknowledged.cache.warningEnabled,true);
 used=80*1024**3;assert.equal((await post('preparation/cache/clear')).cache.warningDue,false,'cleanup that leaves usage above threshold must not reset');
 used=49*1024**3;const cleaned=await post('preparation/cache/clear');assert.equal(cleaned.cache.warningAcknowledged,false);
 used=50*1024**3;const second=app.preparation.snapshot().cache;assert.equal(second.warningDue,true);assert.equal(second.warningCycle,first.warningCycle+1);
 assert.equal((await post('preparation/cache/acknowledge',token)).cache.warningDue,true);
 assert.equal((await post('preparation/cache/acknowledge',{cycle:second.warningCycle,thresholdGiB:50})).cache.warningDue,false);
 assert.equal(app.media.renderCache.maxBytes,Infinity);
});

test('旧缓存上限仅迁移为提醒大小，旧容量等待自动解除，磁盘不足与用户暂停仍保留',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'preparation-cache-upgrade-')),data=path.join(root,'data');
 const seed=new Store(data);seed.setting('preparationCacheGiB',25);seed.close();
 const options={data,projectRoot:root,port:0,noRecorder:true,preparation:false,compact:false,automaticClean:false,ffmpeg:'must-not-launch',ffprobe:'must-not-launch'};
 const first=await createApp(options);await first.startupRecovery;first.ingestor.stop();await first.preparation.close();
 for(const [id,reason,paused] of [['quota','capacity',0],['paused','capacity',1],['disk','disk',0]]){
  first.store.createSession({id,status:'finished'});
  first.store.run("INSERT INTO preparation_jobs(session,status,reason,paused,next_retry) VALUES(?,'waiting',?,?,?)",id,reason,paused,Number.MAX_SAFE_INTEGER);
 }
 await first.close();
 const app=await createApp(options);await app.startupRecovery;app.ingestor.stop();t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
 assert.equal(app.media.renderCache.maxBytes,Infinity);assert.equal(app.preparation.snapshot().cache.warningGiB,25);
 assert.equal(app.preparation.row('quota').next_retry,0);assert.equal(app.preparation.row('quota').status,'queued');assert.equal(app.preparation.row('quota').reason,'');
 assert.equal(app.preparation.row('paused').paused,1);assert.equal(app.preparation.row('disk').reason,'disk');
});
