import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {Store} from '../server/store.js';
import {RenderPipeline,layoutComments,layoutCommentsAsync} from '../server/render-plan.js';
import {scrollingTracks} from '../shared/danmaku-tracks.js';
import {danmakuGeometry,danmakuDuration} from '../shared/danmaku-style.js';

const messages=Array.from({length:1200},(_,i)=>({id:String(i).padStart(5,'0'),type:'d',time:Math.floor(i/60),text:'弹幕'+(i%7)+'测试'.repeat(i%12),color:String(16777215-i)}));
const styles=[
  {size:.6,opacity:100,speed:1,fps:60,areaTop:0,areaHeight:1},
  {size:1.5,opacity:80,speed:.5,fps:30,areaTop:.6,areaHeight:1/3},
  {size:5,opacity:100,speed:2,fps:60,areaTop:0,areaHeight:1/3},
];
// Version 9 intentionally improves dense placement. These snapshots are also
// guarded by the independent motion oracle and overlap baselines in dense-danmaku.
const hashes=['8c697c1a52a1f5132135b74faeb4d23a3e227b758adf4e58010c1d4c7476e2de','ac1f071cb4cc0d6bd137a6ca0c4b3d12798809c679a21ad3d1be8dc7c88f148d','a410d2e0c8b48c3e0018ea6c30ccdcc3947d64012ccce147448ac272d7930820'];

test('dense layout v9 golden fixtures remain stable across resumable track batches',async()=>{
  for(let i=0;i<styles.length;i++){
    const options={width:1920,height:1080,style:styles[i],rate:50},full=layoutComments(messages,options);
    assert.equal(createHash('sha256').update(JSON.stringify(full)).digest('hex'),hashes[i]);
    let resumed=[];const state={};
    for(let from=0;from<messages.length;from+=37)resumed.push(...await layoutCommentsAsync(messages.slice(from,from+37),{...options,state}));
    assert.deepEqual(resumed,full);assert.equal(resumed.length,1000);
  }
});

async function fixture(t,{rules=false}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bili-layout-delta-')),store=new Store(root),session=store.createSession();
  if(!rules){store.chatRules.close();store.chatRules=null;}
  const pipeline=new RenderPipeline({store},()=>''),geometry={width:1920,height:1080,style:styles[0]};
  const add=(rows)=>store.transaction(()=>{for(const m of rows)store.run('INSERT INTO danmaku VALUES(?,?,?,?,?,?,?,?)',m.id,session.id,'source',m.time,'viewer',m.text,m.type??'d',m.color??'16777215');});
  const all=()=>store.all(`SELECT d.rowid AS rowid,d.*,EXISTS(SELECT 1 FROM danmaku_filters f WHERE f.message=d.id AND f.reason='lottery') AS lottery,
    EXISTS(SELECT 1 FROM danmaku_filters f WHERE f.message=d.id AND f.reason IN ('length','repeat')) AS policyFiltered FROM danmaku d WHERE session=? ORDER BY rowid`,session.id);
  t.after(async()=>{store.close();await fs.rm(root,{recursive:true,force:true});});
  return {root,store,session,pipeline,add,all,geometry,layout:()=>pipeline.layout(session.id,undefined,50,geometry)};
}

test('append reads only new rows, preserves the rate boundary and leaves old published arrays immutable',async t=>{
  const f=await fixture(t);f.add(messages.slice(0,37));const first=await f.layout(),saved=JSON.stringify(first);
  for(let from=37;from<messages.length;from+=83){
    const delta=messages.slice(from,from+83);f.add(delta);const actual=await f.layout();
    assert.equal(f.pipeline.lastLayoutWork.incremental,true);assert.equal(f.pipeline.lastLayoutWork.readRows,delta.length);
    assert.deepEqual(actual,layoutComments(f.all(),{...f.geometry,rate:50}));
  }
  assert.equal(JSON.stringify(first),saved);
  const cached=await f.layout();assert.equal(await f.layout(),cached);
});

test('late arrival and an earlier ID at an equal timestamp rebuild the complete canonical layout',async t=>{
  for(const late of [{id:'late',time:2,text:'迟到'}, {id:'00000a',time:0,text:'同秒插入'}]){
    const f=await fixture(t);f.add(messages.slice(0,600));await f.layout();f.add([late]);const actual=await f.layout();
    assert.equal(f.pipeline.lastLayoutWork.incremental,false);assert.deepEqual(actual,layoutComments(f.all(),f.geometry));
  }
});

test('text updates, replacement, deletion and filter changes cannot reuse an old checkpoint',async t=>{
  const f=await fixture(t);f.add(messages.slice(0,120));await f.layout();
  for(const mutate of [
    ()=>f.store.run("UPDATE danmaku SET text='修改',color='123' WHERE id='00000'"),
    ()=>f.store.run("INSERT OR REPLACE INTO danmaku SELECT id,session,source,time,user,'替换',type,color FROM danmaku WHERE id='00001'"),
    ()=>f.store.run("DELETE FROM danmaku WHERE id='00002'"),
    ()=>f.store.run("INSERT INTO danmaku_filters VALUES('00003','repeat')"),
    ()=>f.store.run("UPDATE danmaku_filters SET reason='lottery' WHERE message='00003'"),
    ()=>f.store.run("DELETE FROM danmaku_filters WHERE message='00003'"),
  ]){mutate();const actual=await f.layout();assert.equal(f.pipeline.lastLayoutWork.incremental,false);assert.deepEqual(actual,layoutComments(f.all(),f.geometry));}
});

test('other SQLite connection edits invalidate a checkpoint even without local triggers',async t=>{
  const f=await fixture(t);f.add(messages.slice(0,100));await f.layout();
  const external=new DatabaseSync(path.join(f.root,'editor.sqlite'));
  try{external.exec("UPDATE danmaku SET text='外部修正' WHERE id='00000'");}finally{external.close();}
  const actual=await f.layout();assert.equal(f.pipeline.lastLayoutWork.incremental,false);assert.deepEqual(actual,layoutComments(f.all(),f.geometry));
});

test('style changes and repeat-policy retractions reflow without losing original messages',async t=>{
  const f=await fixture(t,{rules:true});
  f.add(Array.from({length:4},(_,i)=>({id:'repeat'+i,time:i,text:'重复测试'})));const before=await f.layout();assert.equal(before.length,4);
  f.add([{id:'repeat4',time:4,text:'重复测试'}]);const retracted=await f.layout();assert.equal(retracted.length,1);assert.equal(f.all().length,5);
  assert.equal(f.pipeline.lastLayoutWork.incremental,false);assert.deepEqual(retracted,layoutComments(f.all(),f.geometry));
  f.geometry.style=styles[1];assert.deepEqual(await f.layout(),layoutComments(f.all(),f.geometry));assert.equal(f.pipeline.lastLayoutWork.incremental,false);
});

test('cancelled or invalidated async layout does not overwrite a good checkpoint',async t=>{
  const f=await fixture(t);f.add(messages.slice(0,10));const first=await f.layout();
  f.add(messages.slice(10));const controller=new AbortController();
  const operation=f.pipeline.layout(f.session.id,controller.signal,50,f.geometry);controller.abort();
  await assert.rejects(operation,error=>error.code==='PREP_CANCELLED');assert.equal(f.pipeline.layouts.get(f.session.id).messages,first);
  assert.deepEqual(await f.layout(),layoutComments(f.all(),f.geometry));
});

test('empty and entirely filtered checkpoints still accept the next normal append',async t=>{
  const f=await fixture(t);assert.deepEqual(await f.layout(),[]);
  f.add([{id:'gift',time:100,text:'礼物',type:'gift'}]);assert.deepEqual(await f.layout(),[]);
  f.add([{id:'normal',time:1,text:'正常弹幕'}]);assert.deepEqual(await f.layout(),layoutComments(f.all(),f.geometry));
  assert.equal(f.pipeline.lastLayoutWork.incremental,true);
});

test('historical mutation during a yielded read cannot publish an inconsistent checkpoint',async t=>{
  const f=await fixture(t);f.add(messages.slice(0,10));const first=await f.layout();f.add(messages.slice(10));
  const all=f.store.all.bind(f.store);let changed=false;
  f.store.all=(sql,...args)=>{
    const rows=all(sql,...args);
    if(!changed&&sql.includes('SELECT d.rowid AS rowid,d.*')){changed=true;setImmediate(()=>f.store.run("UPDATE danmaku SET text='读取期间改变' WHERE id='00000'"));}
    return rows;
  };
  await assert.rejects(f.layout(),{code:'PREP_STALE'});assert.equal(f.pipeline.layouts.get(f.session.id).messages,first);
  assert.deepEqual(await f.layout(),layoutComments(f.all(),f.geometry));
});

test('standalone layouts retain legacy ordering for numeric and omitted IDs',()=>{
  const options={width:1920,height:1080,style:styles[0]};
  for(const rows of [[{id:2},{id:10},{id:1}],[{id:'b'},{},{id:'a'},{}]]){
    const input=rows.map(m=>({...m,time:0,text:'测试',type:'d'}));
    const ordered=input.slice().sort((a,b)=>a.time-b.time||(a.id<b.id?-1:a.id>b.id?1:0));
    const expected=scrollingTracks(ordered,{...options,...danmakuGeometry(1080,styles[0]),duration:danmakuDuration(styles[0])});
    assert.deepEqual(layoutComments(input,options),expected);
  }
});
