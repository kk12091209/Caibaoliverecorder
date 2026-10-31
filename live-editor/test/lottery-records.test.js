import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.js';
import {LotteryRecorder,normalizeLottery,saveLotteryObservation,lotteryMessages,lotteryRecord,saveLotteryNote} from '../server/lottery-records.js';
import {giftCards,giftEligible,DEFAULT_GIFT_STYLE} from '../shared/gifts.js';
import {giftAss,giftMessages} from '../server/gifts.js';
import {createApp} from '../server/index.js';
const stamp=1793456000000;
const payload=(extra={})=>({id:123,room_id:1852631778,current_time:stamp/1000,time:10,lot_status:0,danmu:'一起加油',award_name:'不应作为展示名称的平台标题',award_num:2,award_per_capita:1,join_total:100,...extra});
const winner=(uid,name)=>({uid,uname:name});
async function fixture(t){const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'lottery-records-'));let store=new Store(root);const session=store.createSession({room:1852631778,created:new Date(stamp).toISOString()});const source=store.addSource(session.id,path.join(root,'clock.flv'),0,session.created,false);
  t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});return {root,session,source,get store(){return store;},restart(){store.close();store=new Store(root);}};}

test('normalization keeps exact public UID strings, respects anonymous users, and counts per-person awards',()=>{
  const record=normalizeLottery(payload({time:0,lot_status:2,award_num:4,award_per_capita:2,award_users:[winner('9007199254740993','甲'),winner('123','乙')]}),1852631778,stamp);
  assert.equal(record.state,'complete');assert.equal(record.expected,2);assert.equal(record.winners[0].uid,'9007199254740993');assert.equal(record.phrase,'一起加油');
  const hidden=normalizeLottery(payload({time:0,lot_status:2,award_users:[{uid:123,uname:'不应暴露',is_mystery:true,uinfo:{base:{origin_info:{name:'也不应暴露'}}}},winner(0,'缺少UID')]}),1852631778,stamp);
  assert.deepEqual(hidden.winners[0],{uid:'',name:'神秘用户',mystery:true});assert.equal(hidden.winners[1].uid,'');
  assert.equal(normalizeLottery({},1852631778,stamp),null);
  for(const bad of [{room_id:1},{id:'not-id'},{time:-1},{time:86401},{lot_status:99},{current_time:stamp/1000-90000}])assert.throws(()=>normalizeLottery(payload(bad),1852631778,stamp));
});

test('activity observations retain one marker, survive restart and update partial lists without erasing notes',async t=>{
  const f=await fixture(t),{session}=f;
  let record=saveLotteryObservation(f.store,session,payload(),stamp);assert.equal(record.time,10);assert.equal(lotteryMessages(f.store,session.id).length,0);
  record=saveLotteryNote(f.store,session.id,record.id,{revision:record.revision,note:'A 产品 · 蓝色'});
  const end=payload({current_time:stamp/1000+11,time:0,lot_status:2,award_users:[winner(11,'第一位')],join_total:200});
  record=saveLotteryObservation(f.store,session,end,stamp+11000);assert.equal(record.state,'partial');assert.equal(record.time,10);assert.equal(record.text,'A 产品 · 蓝色');
  record=saveLotteryObservation(f.store,session,{...end,award_users:[winner(11,'第一位'),winner(22,'第二位')]},stamp+13000);assert.equal(record.state,'complete');assert.equal(record.revision,1);
  saveLotteryObservation(f.store,session,payload({current_time:stamp/1000+14,time:0,lot_status:1,award_users:[]}),stamp+14000);record=lotteryRecord(f.store,session.id,record.id);assert.equal(record.winners.length,2);assert.equal(record.state,'complete');
  f.restart();assert.equal(lotteryRecord(f.store,session.id,record.id).text,'A 产品 · 蓝色');assert.equal(f.store.get('SELECT COUNT(*) AS n FROM lottery_records').n,1);
  const summary=lotteryMessages(f.store,session.id)[0];assert.equal(summary.user,'天选时刻');assert.equal(summary.winners,undefined);assert.equal(summary.winnerCount,2);assert.equal(summary.exportable,false);
  assert.equal(lotteryMessages(f.store,session.id,{search:'A 产品'}).length,1);assert.equal(lotteryMessages(f.store,session.id,{search:'天选时刻'}).length,1);assert.equal(lotteryMessages(f.store,session.id,{search:'别的内容'}).length,0);
  assert.equal(giftMessages(f.store,session.id,{style:{...DEFAULT_GIFT_STYLE,minBilibili:100000}}).length,0);assert.equal(lotteryMessages(f.store,session.id).length,1);
  assert.ok(!JSON.stringify(summary).includes('不应作为展示名称'));
});

test('an already completed round is labeled as first observed rather than inventing an exact draw time',async t=>{
  const f=await fixture(t),record=saveLotteryObservation(f.store,f.session,payload({time:0,lot_status:2,award_users:[winner(1,'甲'),winner(2,'乙')]}),stamp+5000);
  assert.equal(record.time,5);assert.equal(record.timeKind,'observed');assert.equal(f.store.get('SELECT draw_at FROM lottery_records').draw_at,null);
});

test('a corrected winner count cannot keep an older shorter result labeled complete',async t=>{
  const f=await fixture(t),closed=payload({time:0,lot_status:2,award_users:[winner(1,'甲'),winner(2,'乙')]});
  const record=saveLotteryObservation(f.store,f.session,closed,stamp);assert.equal(record.state,'complete');
  const corrected=saveLotteryObservation(f.store,f.session,{...closed,award_num:3},stamp+1000);
  assert.equal(corrected.state,'partial');assert.equal(corrected.expectedWinners,3);assert.equal(corrected.winnerCount,2);
});

test('remarks edit only the display label, reject identity changes and stale revisions, and reset to the original phrase',async t=>{
  const f=await fixture(t);let r=saveLotteryObservation(f.store,f.session,payload({time:0,lot_status:2,award_users:[winner(1,'甲'),winner(2,'乙')]}),stamp);
  const before={...r};for(const bad of [{revision:0,note:'备注',winners:[]},{revision:0,note:'备注',user:'其他身份'},{revision:0,note:'bad\nline'},{revision:0,note:'x'.repeat(501)}])assert.throws(()=>saveLotteryNote(f.store,f.session.id,r.id,bad));
  r=saveLotteryNote(f.store,f.session.id,r.id,{revision:0,note:'实际发放的 A 产品'});assert.deepEqual(r.winners,before.winners);assert.equal(r.phrase,before.phrase);assert.equal(r.user,'天选时刻');
  assert.throws(()=>saveLotteryNote(f.store,f.session.id,r.id,{revision:0,note:'覆盖'}),e=>e.status===409);
  assert.throws(()=>saveLotteryNote(f.store,'other-session',r.id,{revision:1,note:'覆盖'}),e=>e.status===404);
  r=saveLotteryNote(f.store,f.session.id,r.id,{revision:1,note:'  '});assert.equal(r.text,'一起加油');assert.equal(r.note,'');
});

test('lottery records never become preview or ASS gift cards even when all gift switches are enabled',()=>{
  const lottery={type:'lottery',id:'x',time:1,user:'天选时刻',name:'绝不烧录',count:1,totalPrice:1000,platform:'bilibili'};
  assert.equal(giftCards([lottery],2).length,0);assert.equal(giftEligible(lottery,{...DEFAULT_GIFT_STYLE,preview:true,export:true}),false);assert.equal(giftAss([lottery],1280,720), '');
});

test('collector uses credential-free official requests, throttles, handles settling and stops polling after recording grace',async t=>{
  const f=await fixture(t);let now=stamp,calls=0;
  const collector=new LotteryRecorder(f.store,{now:()=>now,request:async(url,options)=>{
    calls++;assert.match(url,/^https:\/\/api.live.bilibili.com\/xlive\/lottery-interface\/v1\/Anchor\/Check\?roomid=1852631778$/);
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.ok(!Object.keys(options.headers).some(k=>/cookie|authorization/i.test(k)));
    return new Response(JSON.stringify({code:0,data:payload({current_time:Math.floor(now/1000),time:calls===1?10:0,lot_status:calls===1?0:1})}));
  }});t.after(()=>collector.close());
  await collector.tick();await collector.tick();assert.equal(calls,1);now+=11000;await collector.tick();assert.equal(calls,2);assert.equal(lotteryMessages(f.store,f.session.id)[0].state,'settling');
  f.store.run("UPDATE sessions SET status='finished',duration=20 WHERE id=?",f.session.id);now+=4000;await collector.tick();assert.equal(calls,3);now+=91000;await collector.tick();assert.equal(calls,3);
});

test('collector has bounded errors, rejects other rooms and never resurrects deleted recordings',async t=>{
  const f=await fixture(t);let now=stamp,calls=0;
  const collector=new LotteryRecorder(f.store,{now:()=>now,request:async()=>{calls++;return new Response(JSON.stringify({code:0,data:payload({room_id:1})}));}});t.after(()=>collector.close());
  await collector.tick();assert.equal(f.store.get('SELECT COUNT(*) AS n FROM lottery_records').n,0);now+=15000;await collector.tick();assert.equal(calls,1);now+=16000;await collector.tick();assert.equal(calls,2);
  collector.next.clear();collector.request=async()=>{f.store.run("UPDATE sessions SET deleted_at='deleted' WHERE id=?",f.session.id);return new Response(JSON.stringify({code:0,data:payload()}));};await collector.tick();assert.equal(f.store.get('SELECT COUNT(*) AS n FROM lottery_records').n,0);
});

test('closing the app aborts an in-flight anonymous lookup and cannot publish after shutdown',async t=>{
  const f=await fixture(t);let aborted=false;
  const collector=new LotteryRecorder(f.store,{now:()=>stamp,request:(_url,options)=>new Promise((_resolve,reject)=>{
    options.signal.addEventListener('abort',()=>{aborted=true;reject(options.signal.reason);},{once:true});
  })});
  const pending=collector.tick();await collector.close();await pending;
  assert.equal(aborted,true);assert.equal(f.store.get('SELECT COUNT(*) AS n FROM lottery_records').n,0);
});

test('API exposes lottery summaries independently of gifts and permits only a versioned remark edit',async t=>{
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'lottery-api-')),app=await createApp({data:root,noRecorder:true,preparation:false,compact:false,updatesAutoCheck:false,ffmpeg:'unused',ffprobe:'unused'});
  t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});await app.startupRecovery;
  const session=app.store.createSession({room:1852631778,status:'finished',created:new Date(stamp).toISOString()}),other=app.store.createSession({status:'finished'});app.store.run('UPDATE sessions SET duration=30 WHERE id=?',session.id);
  const record=saveLotteryObservation(app.store,session,payload({time:0,lot_status:2,award_users:[winner(11,'完整昵称甲'),winner(22,'完整昵称乙')]}),stamp+1000);
  const base=`http://127.0.0.1:${app.port}/api/sessions/${session.id}`,post=data=>fetch(base+'/lotteries/'+record.id+'/note',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  assert.equal((await(await fetch(base+'/gifts')).json()).length,0);const list=await(await fetch(base+'/lotteries')).json();assert.equal(list.length,1);assert.equal(list[0].winners,undefined);
  const detail=await(await fetch(base+'/lotteries/'+record.id)).json();assert.equal(detail.winners[1].uid,'22');
  assert.equal((await post({revision:0,note:'产品 A',winners:[]})).status,400);const saved=await(await post({revision:0,note:'产品 A'})).json();assert.equal(saved.text,'产品 A');assert.deepEqual(saved.winners,detail.winners);
  assert.equal((await post({revision:0,note:'旧窗口'})).status,409);assert.equal((await fetch(base+'/lotteries?at=bad')).status,400);
  assert.equal((await fetch(`http://127.0.0.1:${app.port}/api/sessions/${other.id}/lotteries/${record.id}`)).status,404);
  assert.equal(app.store.edit(session.id).excluded.length,0);assert.equal(app.store.get('SELECT COUNT(*) AS n FROM gift_events').n,0);
});
