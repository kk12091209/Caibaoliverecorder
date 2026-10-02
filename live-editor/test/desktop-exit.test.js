import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../server/index.js';
import {DesktopExit} from '../server/desktop-exit.js';
import {Media} from '../server/media.js';
import {saveRetryFixture} from './helpers/save-retry-fixture.js';
import {minimalMp4} from './helpers/mp4-fixture.js';

async function until(check){for(let n=0;n<500;n++){if(await check())return;await delay(10);}assert.fail('exit/recovery did not settle');}
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-quit-')),apps=[];
  const options={data:path.join(root,'data'),projectRoot:root,port:0,noRecorder:true,preparation:false,compact:false,runtimePollMs:60000,ffmpeg:'not-launched',ffprobe:'not-launched'};
  t.after(async()=>{for(const app of apps)await app.close();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('caibo-quit-'));await fs.rm(root,{recursive:true,force:true});});
  return {root,open:async()=>{const app=await createApp(options);app.ingestor.stop();apps.push(app);return app;}};
}
async function quit(app,confirmed=false){const response=await fetch(app.runtime.origin+'/internal/desktop',{method:'POST',headers:{'Content-Type':'application/json','X-Caibo-Instance':app.runtime.token},body:JSON.stringify({action:'quit',confirmed})});return {status:response.status,body:await response.json()};}

test('空闲或仅监控的退出直接受理，不等待维护轮询',async t=>{
  for(const monitoring of [false,true]){
    const f=await fixture(t),app=await f.open();
    if(monitoring)app.recorder.rooms=[{roomId:42,recording:false,recordingEnabled:true,autoRecord:true}];
    const response=await quit(app);
    assert.equal(response.status,200);assert.equal(response.body.quitAccepted,true);assert.equal(response.body.requiresExitConfirmation,false);
    assert.equal(response.body.pending,'quit');assert.equal(response.body.stopping,true);
    await app.desktopExit.completion;assert.equal(app.runtime.closed,true);
    assert.deepEqual(app.store.root,path.join(f.root,'data'));
  }
});

test('退出确认覆盖新开始的录制；取消不改变任务、监控和恢复记录',async t=>{
  const f=await fixture(t),app=await f.open();let stops=0;
  app.recorder.rooms=[{roomId:42,recording:false,recordingEnabled:true}];
  app.recorder.roomsForExit=async()=>[{roomId:42,recording:true,recordingEnabled:true}];
  app.recorder.stopForExit=async()=>{stops++;};
  const rejected=await quit(app);
  assert.equal(rejected.body.requiresExitConfirmation,true);assert.equal(rejected.body.quitAccepted,false);
  assert.equal(app.runtime.pending,'');assert.equal(app.runtime.stopping,false);assert.equal(app.media.closed,false);
  assert.equal(app.store.setting('recorder-resume-rooms'),undefined);assert.equal(stops,0);
  const accepted=await quit(app,true);assert.equal(accepted.body.quitAccepted,true);await app.desktopExit.completion;assert.equal(stops,1);
});

test('预处理单独运行不弹任务确认；受理后立刻返回，后台收尾仅执行一次',async()=>{
  let release,stopped=0,closed=0,suspended=0,prepared=0;
  const gate=new Promise(resolve=>release=resolve),runtime={request(mode){this.pending=mode;}};
  const exit=new DesktopExit({runtime,activity:()=>({busy:true,requiresExitConfirmation:false}),recorder:{roomsForExit:async()=>[],rememberExitRooms(){},async stopForExit(){stopped++;await gate;}},media:{suspendForExit(){suspended++;}},preparation:{close(){prepared++;return Promise.resolve();}},close:async()=>{closed++;}});
  try{
    const result=await exit.request();assert.equal(result.quitAccepted,true);assert.equal(closed,0);
    assert.deepEqual(await exit.request(true),result);assert.equal(suspended,1);assert.equal(prepared,1);
    await delay(10);assert.equal(stopped,1);assert.equal(closed,0);
  }finally{release();await exit.completion;}
  assert.equal(closed,1);
});

test('录制核心退出失败时保留服务并报告错误，重试成功才关闭后台',async t=>{
  const f=await fixture(t),app=await f.open();let attempts=0;
  app.recorder.stopForExit=async()=>{if(++attempts===1)throw new Error('录制核心未能退出。');};
  assert.equal((await quit(app,true)).body.quitAccepted,true);
  await assert.rejects(app.desktopExit.completion,/录制核心未能退出/);
  assert.equal(app.runtime.closed,false);
  const status=await (await fetch(app.runtime.origin+'/internal/desktop',{headers:{'X-Caibo-Instance':app.runtime.token}})).json();
  assert.equal(status.quitError,'录制核心未能退出。');assert.equal(status.stopping,true);
  assert.equal((await quit(app,true)).body.quitAccepted,true);
  await app.desktopExit.completion;assert.equal(app.runtime.closed,true);assert.equal(app.runtime.quitError,'');assert.equal(attempts,2);
});

for(const [mode,scope] of [['clean','full'],['danmaku','clips'],['dual','full']])test(`确认退出暂停 ${scope}/${mode} 及排队任务，启动自动恢复且成片不重复`,async t=>{
  const f=await fixture(t);let app=await f.open();
  const fixtureData=await saveRetryFixture(app.store,app.media,{mode,scope});
  // Fixture generates valid synthetic outputs; use a real tracked child only
  // for the interrupted attempt so abort/child cleanup is exercised as well.
  const job=fixtureData.job,firstMedia=app.media,process=Media.prototype.process,children=[];
  firstMedia.spawnTracked=(_exe,_args,options)=>{const child=spawn(globalThis.process.execPath,['-e','setTimeout(()=>{},20000)'],options);children.push(child);return child;};
  firstMedia.process=function(args,options){return process.call(this,args,{...options,input:undefined});};
  const metadata=async()=>({metadataVersion:2,width:640,height:360,fps:30,codec:'h264',videoStreams:1,audioCodec:'aac',audioStreams:1,pixelFormat:'yuv420p',sampleAspectRatio:'1:1'});
  firstMedia.probeSource=metadata;
  t.mock.method(Media.prototype,'probeSource',metadata);
  let resumedCalls=0;const resumedArguments=[];
  t.mock.method(Media.prototype,'process',async function(args,options={}){
    resumedCalls++;
    resumedArguments.push(args);
    for(const argument of args)if(/^(?:part-\d+(?:-danmaku)?|final(?:-danmaku)?)\.mp4$/.test(argument))await fs.writeFile(path.join(options.cwd,argument),minimalMp4);
  });
  const cache=path.join(firstMedia.renderCache.root,'retained-test-cache');await fs.mkdir(path.dirname(cache),{recursive:true});await fs.writeFile(cache,'keep cached block');
  const chunk=path.join(app.root,'chunks',fixtureData.source.id,'retained.flvpart');await fs.mkdir(path.dirname(chunk),{recursive:true});await fs.writeFile(chunk,'keep internal chunk');
  const before=JSON.parse(app.store.get('SELECT data FROM jobs WHERE id=?',job.id).data);
  const work=fixtureData.run();await until(()=>children.length===1);
  const second=await firstMedia.enqueue(fixtureData.session.id,{scope,mode,ranges:[{start:0,end:2}],exportDirectory:path.join(f.root,'outputs')});
  const denied=await quit(app);assert.equal(denied.body.requiresExitConfirmation,true);assert.equal(children[0].exitCode,null);assert.equal(app.media.closed,false);
  assert.equal(app.store.get('SELECT status FROM jobs WHERE id=?',job.id).status,'running');
  const interrupted=await quit(app,true);assert.equal(interrupted.body.quitAccepted,true);
  await app.desktopExit.completion;await work;
  assert.notEqual(children[0].exitCode===null&&children[0].signalCode===null,true);
  await fs.stat(fixtureData.original);await fs.stat(chunk);await fs.stat(cache);
  app=await f.open();await until(()=>app.store.get('SELECT status FROM jobs WHERE id=?',second.id)?.status==='done');
  const first=app.store.get('SELECT * FROM jobs WHERE id=?',job.id),data=JSON.parse(first.data);
  assert.equal(first.status,'done');assert.equal(data.mode,mode);assert.equal(data.scope,scope);
  assert.deepEqual(data.ranges,before.ranges);assert.deepEqual(data.excluded,before.excluded);assert.equal(data.resumeOnLaunch,undefined);
  await fs.stat(first.file);if(mode==='dual')await fs.stat(data.output.danmakuFile);
  await fs.stat(fixtureData.original);await fs.stat(chunk);await fs.stat(cache);
  assert.ok(resumedCalls>0);if(scope==='full'&&mode==='clean')assert.ok(resumedArguments.some(args=>args.includes('-c')&&args[args.indexOf('-c')+1]==='copy'));
  const count=resumedCalls;
  await app.close();app=await f.open();await delay(20);assert.equal(resumedCalls,count);assert.equal(app.store.get('SELECT status FROM jobs WHERE id=?',job.id).status,'done');
});

for(const collision of [false,true])test(`已编码成片中断后恢复保存，不重复编码${collision?'且不覆盖用户文件':''}`,async t=>{
  const f=await fixture(t);let app=await f.open();
  const output=await saveRetryFixture(app.store,app.media,{mode:'dual'});
  const occupied=output.job.output.danmakuFile;await fs.writeFile(occupied,'user video');await output.run();
  assert.equal(app.store.get('SELECT status FROM jobs WHERE id=?',output.job.id).status,'save_failed');
  const data=JSON.parse(app.store.get('SELECT data FROM jobs WHERE id=?',output.job.id).data);data.resumeOnLaunch=true;
  app.store.run("UPDATE jobs SET status='interrupted',data=? WHERE id=?",JSON.stringify(data),output.job.id);
  if(!collision)await fs.unlink(occupied);
  const directory=data.pendingPublication.directory;
  await app.close();
  // A real restart uses a new PID. Simulate that without relaxing workspace
  // ownership protection merely because the fixture reopens in this process.
  const ownerFile=path.join(directory,'.bili-temp-owner.json'),owner=JSON.parse(await fs.readFile(ownerFile,'utf8'));
  await fs.writeFile(ownerFile,JSON.stringify({...owner,ownerPid:400000001}));
  const encoding=t.mock.method(Media.prototype,'process',async()=>assert.fail('completed video must not encode again'));
  app=await f.open();await until(()=>!app.media.saves.size);
  const saved=app.store.get('SELECT * FROM jobs WHERE id=?',output.job.id),job=JSON.parse(saved.data);
  if(collision){assert.equal(saved.status,'save_failed');assert.equal(await fs.readFile(occupied,'utf8'),'user video');await fs.stat(directory);}
  else{assert.equal(saved.status,'done');await fs.stat(saved.file);await fs.stat(job.output.danmakuFile);assert.equal(job.resumeOnLaunch,undefined);}
  assert.equal(encoding.mock.callCount(),0);
});

test('用户已主动取消的导出不会因为退出又自动恢复',async t=>{
  const f=await fixture(t);let app=await f.open();const output=await saveRetryFixture(app.store,app.media);
  await app.media.cancelExport(output.job.id);await quit(app);await app.desktopExit.completion;
  app=await f.open();assert.equal(app.store.get('SELECT status FROM jobs WHERE id=?',output.job.id).status,'cancelled');
  assert.equal(JSON.parse(app.store.get('SELECT data FROM jobs WHERE id=?',output.job.id).data).resumeOnLaunch,undefined);
});

test('重试保存期间确认退出，提交收据失败仍保留自动恢复标记和已编码文件',async t=>{
  const f=await fixture(t);let app=await f.open();const output=await saveRetryFixture(app.store,app.media);
  const occupied=output.job.output.danmakuFile;await fs.writeFile(occupied,'user video');await output.run();await fs.unlink(occupied);
  const directory=JSON.parse(app.store.get('SELECT data FROM jobs WHERE id=?',output.job.id).data).pendingPublication.directory;
  let release,entered=false;const gate=new Promise(resolve=>release=resolve),publication=app.media.publication,publish=publication.publish.bind(publication);
  publication.publish=async(...args)=>{entered=true;await gate;return publish(...args);};
  publication.commit=async()=>{throw new Error('simulated receipt commit failure');};
  await app.media.retrySave(output.job.id);await until(()=>entered);
  const accepted=await quit(app,true);assert.equal(accepted.body.quitAccepted,true);release();await app.desktopExit.completion;
  // Publication retains the completed MP4 on a commit failure. Simulate a new
  // PID before opening the same test data again, as for the pending-save test.
  const ownerFile=path.join(directory,'.bili-temp-owner.json'),owner=JSON.parse(await fs.readFile(ownerFile,'utf8'));
  await fs.writeFile(ownerFile,JSON.stringify({...owner,ownerPid:400000001}));
  const encoding=t.mock.method(Media.prototype,'process',async()=>assert.fail('saving interrupted video must not encode again'));
  app=await f.open();await until(()=>app.store.get('SELECT status FROM jobs WHERE id=?',output.job.id)?.status==='done');
  const saved=app.store.get('SELECT * FROM jobs WHERE id=?',output.job.id),job=JSON.parse(saved.data);
  await fs.stat(saved.file);await fs.stat(job.output.danmakuFile);assert.equal(job.resumeOnLaunch,undefined);assert.equal(encoding.mock.callCount(),0);
});
