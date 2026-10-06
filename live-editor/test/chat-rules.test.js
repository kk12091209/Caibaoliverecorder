import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../server/store.js';
import { ChatIntake } from '../server/chat-intake.js';
import { chatRate, isLongChat, validateChatRate, CHAT_RATE_SETTING, RepeatWindow } from '../server/chat-rules.js';
import { Media, assText } from '../server/media.js';
import { DANMAKU_FONT_SIZE } from '../src/danmaku-layout.js';
import { RENDER_VERSION } from '../server/render-plan.js';
import { createApp } from '../server/index.js';
import { Ingestor } from '../server/ingest.js';
import { setImmediate as yieldTurn } from 'node:timers/promises';

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-chat-rules-')),store=new Store(root);
  store.createSession({id:'one',status:'finished'});store.createSession({id:'two',status:'finished'});
  const f={root,store};let seq=0;
  f.add=(text,time,session='one',lottery=false)=>{const id='m-'+(++seq);f.store.run("INSERT INTO danmaku VALUES(?,?,NULL,?,'观众',?,'d','16777215')",id,session,time,text);if(lottery)f.store.run("INSERT INTO danmaku_filters VALUES(?,'lottery')",id);return id;};
  t.after(async()=>{f.store.close();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('caibao-chat-rules-'));await fs.rm(root,{recursive:true,force:true});});
  return f;
}

test('30字及以上不采集，汉字和 emoji 均按 Unicode 字符计算，短消息仍可使用额度',()=>{
  assert.equal(isLongChat('字'.repeat(29)),false);assert.equal(isLongChat('字'.repeat(30)),true);
  assert.equal(isLongChat('😀'.repeat(29)),false);assert.equal(isLongChat('😀'.repeat(30)),true);
  let time=0;const intake=new ChatIntake({now:()=>time});intake.start('a');intake.setRateLimit(1);
  assert.equal(intake.add('a',{id:'long',text:'字'.repeat(30),time:0}),false);
  assert.equal(intake.add('a',{id:'short',text:'普通聊天',time:0}),true);time=1000;
  const batch=intake.take('a');assert.deepEqual(batch.messages.map(m=>m.id),['short']);batch.release();
});

test('十秒滚动窗口达到五条时撤掉先前重复项，跨固定秒边界也能识别',()=>{
  const repeat=new RepeatWindow();
  for(let i=0;i<4;i++)assert.deepEqual(repeat.add({id:String(i),text:'好看',time:7+i}),{keep:true,remove:[]});
  assert.deepEqual(repeat.add({id:'4',text:'好看',time:16.9}),{keep:false,remove:['1','2','3','4']});
  assert.deepEqual(repeat.add({id:'later',text:'好看',time:27}),{keep:true,remove:[]});
});

test('先前显示的四条在第五条到达后只留一条，普通少量重复、其他素材和过期窗口保留',async t=>{
  const f=await fixture(t);const first=f.add('好看',0);for(let i=1;i<4;i++)f.add('好看',i);
  assert.equal(f.store.messages('one').length,4);
  f.add('好看',9.9);const second=f.add('好看',21);for(let i=0;i<4;i++)f.add('普通重复',22+i);
  for(let i=0;i<4;i++)f.add('好看',i,'two');
  assert.deepEqual(f.store.messages('one').filter(m=>m.text==='好看').map(m=>m.id),[first,second]);
  assert.equal(f.store.messages('one').filter(m=>m.text==='普通重复').length,4);
  assert.equal(f.store.messages('two').length,4);
  // A range/search does not pick a new representative or resurrect hidden copies.
  assert.equal(f.store.messages('one',1,10,'好看').length,0);
  const before=f.store.all('SELECT * FROM danmaku ORDER BY id');f.store.close();f.store=new Store(f.root);
  assert.deepEqual(f.store.messages('one').filter(m=>m.text==='好看').map(m=>m.id),[first,second]);
  assert.deepEqual(f.store.all('SELECT * FROM danmaku ORDER BY id'),before);
});

test('持续高频同文每十秒最多显示一次，跟随普通文字而非用户昵称去重',async t=>{
  const f=await fixture(t);for(let i=0;i<30;i++)f.add('持续刷屏',i);
  assert.deepEqual(f.store.messages('one').map(m=>m.time),[0,10,20]);
  assert.ok(f.store.chatRules.sessions.get('one').repeat.groups.size<=2000);
});

test('大批历史弹幕按有界批次让出事件循环，重复检测缓存有上限',async t=>{
  const f=await fixture(t);f.store.transaction(()=>{for(let i=0;i<10000;i++)f.add('普通聊天'+i,i/50);});
  const pending=f.store.chatRules.prepare('one');await yieldTurn();
  assert.ok(f.store.chatRules.sessions.get('one').cursor<10000);
  await pending;assert.equal(f.store.messages('one',0,10000,'',10000).length,10000);
  const repeat=new RepeatWindow();for(let i=0;i<10000;i++)repeat.add({id:String(i),text:String(i),time:0});
  assert.equal(repeat.groups.size,2000);
});

test('异步空索引完成后继续接收新消息，渲染、列表使用相同过滤且不改原始记录',async t=>{
  const f=await fixture(t);await f.store.chatRules.prepare('one');
  for(let i=0;i<5;i++)f.add('同文',i);f.add('字'.repeat(30),5);const normal=f.add('保留正常聊天',6);
  const lottery=f.add('抽奖口令',7,'one',true);const count=f.store.get('SELECT COUNT(*) AS n FROM danmaku').n;
  const media=new Media(f.store);t.after(()=>media.close());const layout=await media.renderer.layout('one');
  assert.equal(layout.filter(m=>m.text==='同文').length,1);assert.equal(layout.some(m=>m.text.length===30),false);assert.ok(layout.some(m=>m.id===normal));
  assert.ok(layout.find(m=>m.id===lottery).lottery);assert.equal(f.store.messages('one').some(m=>m.id===lottery),false);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM danmaku').n,count);
});

test('上限1和50逐房间独立生效，调整时缩减排队批次且保持字节预算',()=>{
  for(const value of [0,51,1.5,'20',null,NaN])assert.throws(()=>validateChatRate(value),/1～50/);
  let time=0;const intake=new ChatIntake({now:()=>time});intake.start('a');intake.start('b');
  for(let i=0;i<50;i++){intake.add('a',{id:String(i),text:'a'+i,time:0});intake.add('b',{id:String(i),text:'b'+i,time:0});}
  intake.setRateLimit(1);time=1000;const a=intake.take('a'),b=intake.take('b');
  assert.equal(a.messages.length,1);assert.equal(b.messages.length,1);a.release();b.release();assert.equal(intake.bytes,0);
  intake.setRateLimit(50);for(let i=0;i<100;i++)intake.add('a',{id:'next-'+i,text:'next'+i,time:1});time=2000;
  const next=intake.take('a');assert.equal(next.messages.length,50);next.release();assert.equal(intake.bytes,0);
});

test('预览和成片字号均为原来的三分之二，缓存版本更新防止复用大字号成片',()=>{
  assert.equal(DANMAKU_FONT_SIZE,22*2/3);
  for(const height of [360,720,1080,2160]){
    const output=assText([{time:0,text:'普通弹幕'}],1920,height),size=Number(output.match(/Style: Default,Microsoft YaHei,([^,]+)/)[1]);
    assert.ok(Math.abs(size-Math.max(20,Math.round(height/24))*2/3)<.001);
  }
  assert.equal(RENDER_VERSION,4);
});

test('B站和抖音XML索引均执行录制上限与长消息过滤，源文件保持原样',async t=>{
  const f=await fixture(t);f.store.setting(CHAT_RATE_SETTING,1);
  for(const session of ['one','two']){
    const file=path.join(f.root,session+'.flv');await fs.writeFile(file,'fixture');const source=f.store.addSource(session,file,0);
    const xml='<i>'+Array.from({length:60},(_,i)=>`<d p="1,1,25,16777215" user="观众">聊天${i}</d>`).join('')+`<d p="2,1,25,16777215">${'字'.repeat(30)}</d><d p="2.1,1,25,16777215">下一秒</d></i>`;
    await fs.writeFile(source.xml,xml);await new Ingestor(f.store).readDanmaku(source);
    assert.deepEqual(f.store.messages(session).map(m=>m.text),['聊天0','下一秒']);assert.equal(await fs.readFile(source.xml,'utf8'),xml);
  }
});

test('设置接口持久保存1～50，重启保留，非法值不影响其他设置或录制核心',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibao-rate-api-'));let app;
  const options={data:path.join(root,'data'),projectRoot:root,port:0,noRecorder:true,preparation:false,compact:false,ffmpeg:process.execPath,ffprobe:process.execPath};
  app=await createApp(options);app.ingestor.stop();
  t.after(async()=>{await app.close();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('caibao-rate-api-'));await fs.rm(root,{recursive:true,force:true});});
  const origin=()=>`http://127.0.0.1:${app.port}`,post=value=>fetch(origin()+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  app.recorder.api=async()=>assert.fail('Chat settings must not change core download logic');
  assert.equal(chatRate(app.store),50);
  for(const value of [1,20,50]){const response=await post({danmakuPerSecond:value});assert.equal(response.status,200);assert.equal((await response.json()).danmakuPerSecond,value);assert.equal(app.recorder.douyin.chat.rateLimit,value);}
  for(const value of [0,51,1.1,'20',null]){assert.equal((await post({danmakuPerSecond:value,closeAction:'exit'})).status,400);assert.equal(app.store.setting('window-close-action'),undefined);}
  await post({danmakuPerSecond:7});await app.close();app=await createApp(options);app.ingestor.stop();
  assert.equal((await(await fetch(origin()+'/api/state')).json()).danmakuPerSecond,7);assert.equal(app.recorder.douyin.chat.rateLimit,7);
});
