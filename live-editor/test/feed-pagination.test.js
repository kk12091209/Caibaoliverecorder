import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.js';
import {messageFeed} from '../server/message-feed.js';
import {compareFeed,feedKey} from '../server/feed-cursor.js';
import {saveGift} from '../server/gifts.js';
import {Ingestor} from '../server/ingest.js';
import {messageWindow,messageTime} from '../shared/message-navigation.js';

async function fixture(t,n=100000){const root=await fs.mkdtemp(path.join(os.tmpdir(),'feed-pages-')),store=new Store(root);store.createSession({id:'history',status:'finished'});store.run('UPDATE sessions SET duration=7200 WHERE id=?','history');store.transaction(()=>{for(let i=0;i<n;i++)store.run('INSERT INTO danmaku VALUES(?,?,NULL,?,?,?,?,?)',`m${String(i).padStart(6,'0')}`,'history',Math.floor(i/14),'观众'+i%5,'内容'+i,'d','16777215');});await store.chatRules.prepare('history');t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});return store;}
test('两小时十万条记录可向后及向前完整翻页，同秒记录不遗漏、不重复',async t=>{
  const store=await fixture(t);let page=messageFeed(store,'history'),keys=[],pages=0;
  while(true){assert.ok(page.rows.length<=300);keys.push(...page.rows.map(feedKey));pages++;if(!page.hasAfter)break;page=messageFeed(store,'history',{cursor:page.after});}
  assert.equal(keys.length,100000);assert.equal(new Set(keys).size,100000);assert.ok(pages>300);
  const last=page.rows.at(-1);let before=messageFeed(store,'history',{cursor:{time:last.time+1,key:''},direction:'before'}),back=[];
  while(true){back.unshift(...before.rows.map(feedKey));if(!before.hasBefore)break;before=messageFeed(store,'history',{cursor:before.before,direction:'before'});}
  assert.deepEqual(back,keys);
});
test('混合礼物、天选记录、编辑文字及筛选跨页保持相同规则',async t=>{
  const store=await fixture(t,1300);
  const source=store.addSource('history',path.join(store.root,'test.flv'),0);
  saveGift(store,{id:'gift-1',session:'history',source:source.id,time:30,platform:'bilibili',type:'gift',user:'观众',name:'花花',giftId:'1',count:1,totalPrice:8,currency:'CNY',icon:''});
  store.run("INSERT INTO lottery_records(id,session,activity,room,time,first_seen,time_kind,phrase,state,last_live) VALUES('lottery-1','history','1',1,30,0,'draw','加油','complete',0)");
  const edit=store.edit('history');store.saveEdit('history',{...edit,messageEdits:{m000100:{user:'改名',text:'已改好'}}});
  const query={gifts:true};let page=messageFeed(store,'history',query),rows=[];do{rows.push(...page.rows);if(!page.hasAfter)break;page=messageFeed(store,'history',{...query,cursor:page.after});}while(true);
  assert.equal(rows.length,1302);assert.deepEqual(rows,[...rows].sort(compareFeed));assert.equal(rows.find(row=>row.id==='m000100').user,'改名');
  assert.equal(messageFeed(store,'history',{search:'已改好'}).rows[0].id,'m000100');
  assert.equal(messageFeed(store,'history',{gifts:true,onlyGifts:true}).rows.length,2);
  assert.ok(messageFeed(store,'history',{sender:{mode:'name',name:'观众1'}}).rows.every(row=>row.user==='观众1'));
  const focused=messageFeed(store,'history',{at:60});assert.ok(focused.rows[0].time<60);assert.ok(focused.rows.at(-1).time>=60);
  assert.throws(()=>messageFeed(store,'history',{cursor:{time:NaN,key:'d:a'}}));
});
test('跟随窗口严格前后各一分钟，翻页和礼物也不能越过窗口',async t=>{
  const store=await fixture(t,20000),scope=messageWindow(7200,600,true);
  assert.deepEqual(scope,{from:540,to:660});
  const source=store.addSource('history',path.join(store.root,'window.flv'),0);
  for(const time of [539,540,600,660,661])saveGift(store,{id:'gift-'+time,session:'history',source:source.id,time,platform:'bilibili',type:'gift',user:'观众',name:'花花',giftId:'1',count:1,totalPrice:8,currency:'CNY',icon:''});
  let page=messageFeed(store,'history',{...scope,gifts:true}),rows=[];
  while(true){rows.push(...page.rows);if(!page.hasAfter)break;page=messageFeed(store,'history',{...scope,gifts:true,cursor:page.after});}
  assert.ok(rows.every(row=>row.time>=540&&row.time<=660));
  assert.deepEqual(rows.filter(row=>row.type!=='d').map(row=>row.time),[540,600,660]);
  assert.equal(rows.filter(row=>row.type==='d').length,121*14);
  assert.deepEqual(messageWindow(7200,10,true),{from:0,to:70});
  assert.deepEqual(messageWindow(7200,7190,true),{from:7130,to:7200});
  assert.deepEqual(messageWindow(7200,600,false),{from:0,to:7200});
});
test('任意时间定位可直达两小时末尾；异常弹幕时间和历史查询不改变录制时长或媒体索引',async t=>{
  const store=await fixture(t),source=store.addSource('history',path.join(store.root,'original.flv'),0);
  store.run('UPDATE sources SET duration=7200 WHERE id=?',source.id);
  for(const [id,time] of [['negative',-20],['wrap',(2**32-20)/1000],['epoch',1793650000],['infinite',Infinity]])store.run('INSERT INTO danmaku VALUES(?,?,NULL,?,?,?,?,?)',id,'history',time,'异常测试','时间异常弹幕','d','16777215');
  const before={session:store.session('history'),sources:store.sources('history'),chunks:store.all('SELECT * FROM chunks')};
  for(const at of [0,60,3600,7000,7200,1793650000]){
    const page=messageFeed(store,'history',{at});
    assert.ok(page.rows.every(row=>row.time>=0&&row.time<=7200));
    assert.ok(page.rows.every(row=>!['negative','wrap','epoch','infinite'].includes(row.id)));
    if(at===7000)assert.ok(page.rows.some(row=>row.time===7000));
  }
  const end=messageFeed(store,'history',{at:7200});assert.equal(end.rows.at(-1).id,'m099999');
  assert.throws(()=>messageFeed(store,'history',{at:NaN}));
  assert.throws(()=>messageFeed(store,'history',{from:0,to:Infinity}));
  assert.throws(()=>messageFeed(store,'history',{cursor:{time:1793650000,key:'d:x'}}));
  assert.equal(messageTime(Infinity,7200),0);assert.equal(messageTime(1793650000,7200),7200);
  assert.deepEqual({session:store.session('history'),sources:store.sources('history'),chunks:store.all('SELECT * FROM chunks')},before);
});


test('搜索覆盖当前窗口和礼物视图，旧礼物 UID 与弹幕按时间合并',async t=>{
  const store=await fixture(t,0),source=store.addSource('history',path.join(store.root,'search.flv'),0);
  const uid='12345678901234567';
  await fs.writeFile(source.xml,`<i><d p="10,1,25,16777215,0,0,${uid},0" user="同一观众">普通弹幕提到醒目留言</d><gift ts="130" uid="${uid}" user="同一观众" giftname="小花" total_price="2"/><sc ts="150" uid="${uid}" user="同一观众" price="30">一条付费内容</sc></i>`);
  await new Ingestor(store).readDanmaku(source);
  store.run("INSERT INTO lottery_records(id,session,activity,room,time,first_seen,time_kind,phrase,state,last_live) VALUES('lottery-search','history','1',1,160,0,'draw','醒目留言抽奖','complete',0)");
  // Simulate an existing recording indexed before gift sender IDs were stored.
  store.run("UPDATE gift_events SET sender_uid=''");
  await store.senders.prepare('history',true);
  assert.deepEqual(messageFeed(store,'history').rows.map(row=>row.type),['d']);
  assert.deepEqual(messageFeed(store,'history',{gifts:true,onlyGifts:true}).rows.map(row=>row.type),['gift','sc','lottery']);
  const controls={gifts:false,onlyGifts:true,from:0,to:60,sender:{mode:'name',name:'其他观众'},style:{preview:true,export:false,minBilibili:100,minDouyin:0,currency:'CNY'}};
  assert.deepEqual(messageFeed(store,'history',{...controls,search:'醒目留言'}).rows.map(row=>[row.type,row.time]),[['d',10],['sc',150],['lottery',160]]);
  for(const search of [uid,'同一观众']){
    assert.deepEqual(messageFeed(store,'history',{...controls,search}).rows.map(row=>[row.type,row.time]),[['d',10],['gift',130],['sc',150]]);
  }
});
