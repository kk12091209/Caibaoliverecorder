import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { ServiceRuntime, serviceBuild } from '../server/service-runtime.js';
import { availableLocalPort } from '../server/local-endpoint.js';
import { createApp } from '../server/index.js';

const appRoot=fileURLToPath(new URL('..',import.meta.url));
const roots=[];
test.after(async()=>{for(const root of roots)await fs.rm(root,{recursive:true,force:true});});
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-service-'));
  roots.push(root);return root;
}
async function application(t,options={}){
  const data=options.data??await fixture(t);
  const app=await createApp({data,port:0,noRecorder:true,compact:false,preparation:false,ffmpeg:'not-launched',ffprobe:'not-launched',runtimePollMs:10,...options});
  t.after(()=>app.close());return app;
}
async function request(app,body,authorized=true){
  const headers=authorized?{'X-Caibo-Instance':app.runtime.token}:{};
  const response=await fetch(app.runtime.origin+'/internal/desktop',body?{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)}:{headers});
  return {status:response.status,body:await response.json()};
}
async function until(check){
  for(let n=0;n<200;n++){if(await check())return;await delay(10);}assert.fail('service did not settle');
}

test('同一 data 先获取 OS 数据锁，第二个服务无法进入 Store 恢复流程',async t=>{
  const app=await application(t);
  const session=app.store.createSession({title:'still recording',status:'recording'});
  await assert.rejects(()=>createApp({data:app.root,noRecorder:true}),{code:'SERVICE_RUNNING'});
  assert.equal(app.store.session(session.id).status,'recording');
  await app.close();
  const next=await application(t,{data:app.root});assert.notEqual(next.runtime.instance,app.runtime.instance);
});

test('两份独立数据自动使用不同编辑端口，所有地址限于本机',async t=>{
  const first=await application(t),second=await application(t);
  assert.notEqual(first.port,second.port);assert.equal(first.server.address().address,'127.0.0.1');
  const descriptor=JSON.parse(await fs.readFile(first.runtime.file,'utf8'));
  assert.equal(descriptor.origin,first.runtime.origin);assert.equal(descriptor.dataPath,await fs.realpath(first.root));
  assert.equal(descriptor.build,await serviceBuild(appRoot));
  assert.equal((await fetch(first.runtime.origin+'/api/state')).status,200);
  const forbidden=await new Promise((resolve,reject)=>{http.get(first.runtime.origin+'/api/state',{headers:{Host:'example.com:'+first.port}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});
  assert.equal(forbidden,403);
});

test('后台管理接口需要私有实例令牌且不向客户端返回令牌',async t=>{
  const app=await application(t);
  assert.equal((await request(app,undefined,false)).status,403);
  assert.equal((await request(app,{action:'exit'},false)).status,403);
  const value=await request(app,{action:'heartbeat',client:'a'.repeat(32),pid:process.pid});
  assert.equal(value.status,200);assert.equal(value.body.token,undefined);assert.equal(app.runtime.liveClients(),1);
  assert.equal((await request(app,{action:'heartbeat',client:'bad',pid:0})).status,400);
  assert.equal((await request(app,{action:'unknown'})).status,400);
});

test('死进程留下的地址文件不阻止启动，安全退出只删除当前实例的发现文件',async t=>{
  const root=await fixture(t);
  await fs.writeFile(path.join(root,'desktop-service.json'),JSON.stringify({instance:'stale',pid:1,origin:'http://127.0.0.1:1'}));
  const runtime=await ServiceRuntime.acquire(root,appRoot,{});t.after(()=>runtime.release());
  await runtime.publish(await availableLocalPort());
  await fs.writeFile(runtime.file,JSON.stringify({instance:'other'}));await runtime.release();
  assert.equal(JSON.parse(await fs.readFile(runtime.file)).instance,'other');
});

test('进程崩溃后 OS 释放独占锁，保留录像数据可直接重新启动',async t=>{
  const root=await fixture(t),module=new URL('../server/service-runtime.js',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {ServiceRuntime} from ${JSON.stringify(module)}; const runtime=await ServiceRuntime.acquire(${JSON.stringify(root)},${JSON.stringify(appRoot)},{}); console.log('ready'); setInterval(()=>{},1000);`],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  await once(child.stdout,'data');
  await assert.rejects(()=>ServiceRuntime.acquire(root,appRoot,{}),{code:'SERVICE_RUNNING'});
  const stopped=once(child,'exit');child.kill();await stopped;
  const next=await ServiceRuntime.acquire(root,appRoot,{});await next.release();
});

test('桌面心跳与宽限期防止启动中退出，遗留后台在空闲后自动回收',async t=>{
  const root=await fixture(t);let time=0,pidAlive=true;
  const runtime=await ServiceRuntime.acquire(root,appRoot,{managed:true,now:()=>time,isAlive:()=>pidAlive,startupGraceMs:100,clientTimeoutMs:10});t.after(()=>runtime.release());
  assert.equal(runtime.shouldStop({busy:false}),false);
  runtime.heartbeat('a'.repeat(32),123);time=100;
  runtime.heartbeat('a'.repeat(32),123);assert.equal(runtime.shouldStop({busy:false}),false);
  pidAlive=false;assert.equal(runtime.shouldStop({busy:true}),false);assert.equal(runtime.shouldStop({busy:false}),true);
});

test('更新请求等录制结束再切换，不中止素材写入',async t=>{
  const app=await application(t),session=app.store.createSession({title:'recording',status:'recording'});
  await request(app,{action:'restart'});await delay(40);
  assert.equal(app.runtime.closed,false);assert.equal(app.activity().busy,true);
  app.store.run("UPDATE sessions SET status='finished' WHERE id=?",session.id);
  await until(()=>app.runtime.closed);
  await app.close();
  await assert.rejects(()=>fs.stat(app.runtime.file),{code:'ENOENT'});
});

test('导出、预处理和整理都会阻止更新，普通播放不构成后台任务',async t=>{
  const app=await application(t);
  app.media.interactiveChildren.add({});const interactive=[...app.media.interactiveChildren][0];app.media.children.add(interactive);
  assert.equal(app.activity().busy,false);
  const foreground={};app.media.children.add(foreground);assert.equal(app.activity().busy,true);app.media.children.delete(foreground);
  app.preparation.active={};assert.equal(app.activity().busy,true);app.preparation.active=null;
  app.storage.busy=true;assert.equal(app.activity().busy,true);app.storage.busy=false;
  app.media.children.delete(interactive);app.media.interactiveChildren.delete(interactive);
  await request(app,{action:'exit'});await until(()=>app.runtime.closed);
});

test('启动失败不留下数据独占锁，修正后可重试',async t=>{
  const root=await fixture(t),port=await availableLocalPort();
  const first=await application(t,{port});
  await assert.rejects(()=>createApp({data:root,port,noRecorder:true,ffmpeg:'not-launched',ffprobe:'not-launched'}),{code:'EADDRINUSE'});
  const retry=await application(t,{data:root});assert.ok(retry.port>0);
  await first.close();
});

test('地址发布失败关闭数据库与监听器，不留下半启动服务',async t=>{
  const data=await fixture(t),publish=ServiceRuntime.prototype.publish;
  let fail=true;
  t.mock.method(ServiceRuntime.prototype,'publish',async function(port){if(fail){fail=false;throw new Error('simulated discovery write failure');}return publish.call(this,port);});
  await assert.rejects(()=>createApp({data,port:0,noRecorder:true,ffmpeg:'not-launched',ffprobe:'not-launched'}),/discovery write failure/);
  const next=await application(t,{data});assert.ok(next.port>0);
});

test('发现文件清理失败也释放独占锁，后续启动不会永久卡住',async t=>{
  const root=await fixture(t),runtime=await ServiceRuntime.acquire(root,appRoot,{});
  await fs.mkdir(runtime.file);
  await assert.rejects(()=>runtime.release());
  const next=await ServiceRuntime.acquire(root,appRoot,{});
  await fs.rmdir(next.file);await next.release();
});

test('慢盘恢复完成之后才开始桌面连接宽限期，不在刚启动时误退出',async t=>{
  let time=0;const root=await fixture(t);
  const runtime=await ServiceRuntime.acquire(root,appRoot,{managed:true,now:()=>time,startupGraceMs:100});t.after(()=>runtime.release());
  time=200;await runtime.publish(await availableLocalPort());
  assert.equal(runtime.shouldStop({busy:false}),false);
  time=301;assert.equal(runtime.shouldStop({busy:false}),true);
});
