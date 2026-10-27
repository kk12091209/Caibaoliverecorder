import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.js';

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-message-feed-'));
  const app=await createApp({data:path.join(root,'data'),projectRoot:root,port:0,noRecorder:true,
    preparation:false,compact:false,automaticClean:false,ffmpeg:'must-not-launch',ffprobe:'must-not-launch'});
  app.ingestor.stop();
  const session=app.store.createSession({id:'dense',status:'finished'});
  app.store.run('UPDATE sessions SET duration=200 WHERE id=?',session.id);
  app.store.transaction(()=>{
    for(let i=0;i<10000;i++)app.store.run('INSERT INTO danmaku VALUES(?,?,NULL,?,?,?,?,?)',
      `m${String(i).padStart(5,'0')}`,session.id,i/50,'测试观众',`消息${String(i).padStart(5,'0')}`,'d','16777215');
  });
  t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
  const request=async query=>{
    const response=await fetch(`${app.runtime.origin}/api/sessions/${session.id}/messages?${query}`);
    return {status:response.status,body:await response.json()};
  };
  return {app,request};
}

test('50 条/秒时，80 秒预览窗口包含整个范围，播放到缓存后半段仍有弹幕',async t=>{
  const {app,request}=await fixture(t);
  const {status,body}=await request('from=55&to=135&overlay=1');
  assert.equal(status,200);
  assert.equal(body.length,4001);
  for(const second of [100,115,120,125])assert.equal(body.filter(row=>row.time>=second&&row.time<second+1).length,50);
  assert.equal(body.at(-1).time,135);
  // Bursts at both inclusive endpoints can occupy 81 buckets, not just 80.
  app.store.run('UPDATE danmaku SET time=CAST(time AS INTEGER)');
  app.store.chatRules.drop('dense');
  const burst=await request('from=55&to=135&overlay=1');
  assert.equal(burst.body.length,4050);
});

test('密集弹幕列表围绕当前播放点取最近 500 条，返回顺序仍按时间排列',async t=>{
  const {request}=await fixture(t);
  const {status,body}=await request('from=80&to=140&at=100');
  assert.equal(status,200);assert.equal(body.length,500);
  assert.equal(body.filter(row=>row.time>=100&&row.time<101).length,50);
  assert.ok(body[0].time>=95&&body[0].time<100);
  assert.ok(body.at(-1).time>100&&body.at(-1).time<=105);
  assert.deepEqual(body.map(row=>row.time),body.map(row=>row.time).sort((a,b)=>a-b));
});

test('跟随直播尾部时列表保留最新消息；关闭跟随或搜索保留既有排序',async t=>{
  const {request}=await fixture(t);
  const tail=await request('from=180&to=240&at=200');
  assert.equal(tail.body.length,500);assert.equal(tail.body.at(-1).time,199.98);
  const ordinary=await request('from=80&to=140');
  assert.equal(ordinary.body.length,500);assert.equal(ordinary.body[0].time,80);assert.equal(ordinary.body.at(-1).time,89.98);
  const searched=await request('from=80&to=140&q=消息04');
  assert.equal(searched.body.length,500);assert.equal(searched.body[0].time,80);
});

test('跟随定位参数拒绝无效时间，不扩大用户请求的范围',async t=>{
  const {request}=await fixture(t);
  for(const at of ['NaN','Infinity','-1','79','141',''])assert.equal((await request(`from=80&to=140&at=${at}`)).status,400,at);
});

test('围绕播放点取数仍应用原有过滤，搜索和画面预览不接受列表定位排序',async t=>{
  const {app,request}=await fixture(t);
  app.store.run("UPDATE danmaku SET text='[测试表情包_开心]' WHERE id='m05000'");
  app.store.run("UPDATE danmaku SET text=? WHERE id='m05001'",'字'.repeat(30));
  app.store.run("INSERT INTO danmaku_filters VALUES('m05002','lottery')");
  const focused=await request('from=80&to=140&at=100');
  for(const id of ['m05000','m05001','m05002'])assert.equal(focused.body.some(row=>row.id===id),false);
  const searched=await request('from=80&to=140&q=消息04&at=100');
  assert.equal(searched.body[0].time,80);
  const overlay=await request('from=55&to=135&overlay=1&at=100');
  assert.equal(overlay.body[0].time,55);assert.equal(overlay.body.at(-1).time,135);
});
