import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.js';
import { Store } from '../server/store.js';
import { ServiceRuntime } from '../server/service-runtime.js';
import { damagedDatabase } from '../server/data-recovery.js';

const appRoot=fileURLToPath(new URL('..',import.meta.url));
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-data-recovery-')),apps=[];
  t.after(async()=>{for(const app of apps)await app.close();await fs.rm(root,{recursive:true,force:true});});
  return {root,async start(){const app=await createApp({data:root,noRecorder:true,port:0,desktopManaged:true,compact:false,preparation:false,updatesAutoCheck:false,ffmpeg:'not-launched',ffprobe:'not-launched'});apps.push(app);await app.startupRecovery;return app;}};
}
const publicState=app=>fetch(app.runtime.origin+'/api/state').then(r=>{assert.equal(r.status,200);return r.json();});

test('损坏的素材索引自动启用固定安全区，旧索引与录像原样保留，重启不重复重置',async t=>{
  const f=await fixture(t),db=path.join(f.root,'editor.sqlite'),raw=path.join(f.root,'originals','old.flv');
  await fs.mkdir(path.dirname(raw));await fs.writeFile(raw,'retained recording');await fs.writeFile(db,'invalid sqlite original');
  const app=await f.start(),state=await publicState(app);
  assert.equal(state.recovery.safeMode,true);assert.equal(state.dataPath,await fs.realpath(f.root));
  assert.equal(state.paths.retained,path.join(f.root,'originals'));assert.equal(state.paths.logs,path.join(f.root,'logs'));
  assert.notEqual(app.store.root,app.root);assert.equal(await fs.readFile(db,'utf8'),'invalid sqlite original');assert.equal(await fs.readFile(raw,'utf8'),'retained recording');
  app.store.setting('new-setting','retained safe setting');const session=app.store.createSession({title:'安全区新录像',status:'finished'});
  await app.close();const reopened=await f.start();assert.equal(reopened.store.root,app.store.root);assert.equal(reopened.store.setting('new-setting'),'retained safe setting');assert.ok(reopened.store.session(session.id));
  assert.equal((await fs.readdir(path.join(f.root,'recovery'))).filter(n=>n==='safe-data').length,1);
});

test('异常旧设置与任务逐条隔离，其他素材设置保留，备份原记录而不公开原值',async t=>{
  const f=await fixture(t),store=new Store(f.root),session=store.createSession({title:'正常旧素材',status:'finished'});
  store.setting('valid-setting',{keep:true});
  store.run('INSERT INTO settings VALUES(?,?)','danmaku-per-second','{private-corrupt-value');
  store.run('INSERT INTO jobs(id,session,created,status,data,file) VALUES(?,?,?,?,?,?)','bad-job',session.id,new Date().toISOString(),'saving','{private-corrupt-job','retained-output.mp4');
  store.run('INSERT INTO edits VALUES(?,?,?)',session.id,3,'broken edit');store.close();
  const app=await f.start(),state=await publicState(app);
  assert.equal(state.recovery.safeMode,false);assert.equal(app.store.session(session.id).title,'正常旧素材');assert.deepEqual(app.store.setting('valid-setting'),{keep:true});
  assert.equal(state.danmakuPerSecond,50);assert.equal(state.jobs[0].status,'failed');assert.equal(state.jobs[0].file,'retained-output.mp4');
  const records=app.store.all('SELECT kind,original FROM recovery_records');assert.equal(records.length,2);
  assert.ok(records.find(r=>r.kind==='jobs').original.includes('{private-corrupt-job'));assert.ok(records.find(r=>r.kind==='settings').original.includes('{private-corrupt-value'));
  assert.equal(app.store.edit(session.id).revision,0);assert.equal(app.store.all('SELECT * FROM recovery_records').length,3);
  assert.ok(!JSON.stringify(await publicState(app)).includes('private-corrupt'));
  await app.diagnostics.pending;const log=await fs.readFile(path.join(f.root,'logs',app.diagnostics.day+'.txt'),'utf8');assert.ok(!log.includes('private-corrupt'));
  await app.close();const next=await f.start();assert.equal(next.store.all('SELECT * FROM recovery_records').length,3);
});

test('合法 JSON 但任务形状或设置类型异常，也不会循环启动失败',async t=>{
  const f=await fixture(t),store=new Store(f.root);
  store.setting('export-directory',{});store.setting('recorder-secret',{});
  for(const [id,data] of [['array','[]'],['null','null'],['wrong-id','{"id":"different","resumeOnLaunch":true}']])store.run('INSERT INTO jobs(id,status,data) VALUES(?,?,?)',id,'saving',data);
  store.close();const app=await f.start(),state=await publicState(app);
  assert.equal(typeof state.paths.exports,'string');assert.equal(typeof app.store.setting('recorder-secret'),'string');
  assert.equal(state.jobs.length,3);assert.ok(state.jobs.every(j=>j.status==='failed'));assert.equal(app.store.all('SELECT * FROM recovery_records').length,5);
});

test('损坏后台锁隔离后正常启动；活动独占锁绝不当作旧文件清除',async t=>{
  const f=await fixture(t),lock=path.join(f.root,'desktop-service.lock.sqlite');await fs.writeFile(lock,'damaged lease original');
  const app=await f.start();assert.equal(app.runtime.leaseRecovered,true);
  const backup=(await fs.readdir(path.join(f.root,'recovery'))).find(n=>n.startsWith('lease-'));
  assert.equal(await fs.readFile(path.join(f.root,'recovery',backup,'desktop-service.lock.sqlite'),'utf8'),'damaged lease original');
  await assert.rejects(ServiceRuntime.acquire(f.root,appRoot),{code:'SERVICE_RUNNING'});assert.equal((await publicState(app)).recovery.safeMode,false);
  assert.equal((await fs.readdir(path.join(f.root,'recovery'))).filter(n=>n.startsWith('lease-')).length,1);
});

test('数据路径不可用、磁盘和权限错误不会误触发自动清空',async t=>{
  const f=await fixture(t);await fs.mkdir(path.join(f.root,'editor.sqlite'));
  await assert.rejects(f.start());await assert.rejects(fs.stat(path.join(f.root,'recovery')),{code:'ENOENT'});
  for(const error of [{errcode:5,message:'database is locked'},{errcode:13,message:'disk is full'},{errcode:8,message:'readonly database'},{errcode:14,message:'unable to open database'}])assert.equal(damagedDatabase(error),false);
  await fs.rmdir(path.join(f.root,'editor.sqlite'));assert.equal((await publicState(await f.start())).recovery.safeMode,false);
});

test('安全区标记损坏不会丢掉已经使用的新数据；恢复目录链接拒绝使用',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.root,'editor.sqlite'),'broken');let app=await f.start();app.store.setting('safe-retained',true);await app.close();
  await fs.writeFile(path.join(f.root,'recovery','active.json'),'broken marker');app=await f.start();assert.equal(app.store.setting('safe-retained'),true);await app.close();
  const original=path.join(f.root,'recovery');await fs.rename(original,path.join(f.root,'retained-recovery'));await fs.symlink(path.join(f.root,'retained-recovery'),original,'dir');
  await assert.rejects(f.start(),/目录异常/);assert.equal(await fs.readFile(path.join(f.root,'editor.sqlite'),'utf8'),'broken');
});

test('安全区索引再次损坏只隔离索引，旧新录像均保留，不反复创建空数据区',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.root,'editor.sqlite'),'original broken');let app=await f.start();const safe=app.store.root;await app.close();
  await fs.mkdir(path.join(safe,'originals'),{recursive:true});await fs.writeFile(path.join(safe,'originals','new.flv'),'new retained recording');await fs.writeFile(path.join(safe,'editor.sqlite'),'safe broken');
  app=await f.start();assert.equal(app.store.root,safe);assert.equal(await fs.readFile(path.join(safe,'originals','new.flv'),'utf8'),'new retained recording');
  const backups=(await fs.readdir(path.join(f.root,'recovery'))).filter(n=>n.startsWith('retained-index-'));assert.equal(backups.length,1);assert.equal(await fs.readFile(path.join(f.root,'recovery',backups[0],'editor.sqlite'),'utf8'),'safe broken');
  await app.close();await f.start();assert.equal((await fs.readdir(path.join(f.root,'recovery'))).filter(n=>n.startsWith('retained-index-')).length,1);
});

test('记录隔离与默认值恢复在同一事务中，外层回滚不会丢失旧记录',async t=>{
  const f=await fixture(t),store=new Store(f.root);try{
    store.run('INSERT INTO settings VALUES(?,?)','bad-nested','broken original');
    assert.throws(()=>store.transaction(()=>{assert.equal(store.setting('bad-nested'),undefined);throw new Error('cancel outer transaction');}),/cancel outer/);
    assert.equal(store.get('SELECT value FROM settings WHERE key=?','bad-nested').value,'broken original');assert.equal(store.all('SELECT * FROM recovery_records').length,0);
    assert.equal(store.setting('bad-nested'),undefined);assert.equal(store.all('SELECT * FROM recovery_records').length,1);
  }finally{store.close();}
});
