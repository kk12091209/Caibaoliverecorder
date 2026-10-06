import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createApp} from '../server/index.js';
import {assText} from '../server/media.js';
import {danmakuGeometry,validateDanmakuStyle,DANMAKU_SIZE_STEPS,DEFAULT_DANMAKU_STYLE} from '../shared/danmaku-style.js';
import {layoutDanmaku} from '../src/danmaku-layout.js';
import {scrollingTracks} from '../shared/danmaku-tracks.js';
import {layoutComments} from '../server/render-plan.js';

test('0.6 preserves export size across source resolutions; every size fits its lanes inside the video',()=>{
  for(const height of [180,360,720,941,1080,2160]){
    assert.equal(danmakuGeometry(height,DEFAULT_DANMAKU_STYLE).size,Number((Math.max(20,Math.round(height/24))*2/3).toFixed(3)));
    for(const size of DANMAKU_SIZE_STEPS){const g=danmakuGeometry(height,{size,opacity:100});assert.ok(g.top+(g.lanes-1)*g.lineHeight+g.size<=height);}
  }
  assert.equal(danmakuGeometry(1080,{size:1.5,opacity:100}).size,75);
});
test('ASS applies imported font, size and transparency to fill and outline, including fully transparent',()=>{
  const text=assText([{time:0,text:'TEST',lane:7}],1920,1080,{family:'Custom Font'},{size:1.5,opacity:50});
  assert.match(text,/Style: Default,Custom Font,75,&H80FFFFFF,&H80FFFFFF,&H80111111/);
  assert.match(assText([{time:0,text:'TEST'}],1280,720,null,{size:0.6,opacity:0}),/20,&HFFFFFFFF,&HFFFFFFFF,&HFF111111/);
  for(const value of [{size:0.5,opacity:100},{size:0.6,opacity:101},{size:0.6,opacity:2.2},{size:0.6,opacity:100,extra:true},null])assert.throws(()=>validateDanmakuStyle(value));
});
test('workbench export-style layout limits simultaneous bursts to free lanes and preserves six-second travel',()=>{
  const messages=Array.from({length:50},(_,i)=>({id:String(i).padStart(2,'0'),time:0,text:'SAMPLE'}));
  const geometry=danmakuGeometry(720,{size:0.6,opacity:100});
  const layout=layoutDanmaku(messages,{width:1280,height:720,fontSize:geometry.size,lineHeight:geometry.lineHeight,top:geometry.top,maxLanes:geometry.lanes,exportLayout:true,measure:()=>120});
  assert.equal(layout.size,geometry.lanes);assert.equal(new Set([...layout.values()].map(m=>m.lane)).size,layout.size);
  for(const m of layout.values()){assert.equal(m.end,6);assert.equal(m.speed,(1280+m.textWidth)/6);}
});
test('sparse traffic uses both halves at every source size and preview font measurement cannot change exported positions',()=>{
  for(const height of [360,720,940,1080,2160])for(const size of DANMAKU_SIZE_STEPS){
    const style={size,opacity:100},geometry=danmakuGeometry(height,style),width=Math.round(height*16/9);
    const messages=[{id:'a',type:'d',time:0,text:'第一条'},{id:'b',type:'d',time:.5,text:'第二条'}];
    const exported=layoutComments(messages,{width,height,style});
    if(geometry.lanes>1){assert.equal(exported.length,2);assert.ok(exported[0].y<height/2);assert.ok(exported[1].y>height/2,`height ${height}, size ${size}`);}
    for(const measure of [()=>1,()=>9999]){
      const preview=layoutDanmaku(messages,{width,height,fontSize:geometry.size,lineHeight:geometry.lineHeight,top:geometry.top,maxLanes:geometry.lanes,exportLayout:true,measure});
      assert.deepEqual([...preview.values()].map(({paintWidth,...rest})=>rest),exported.map(({paintWidth,...rest})=>rest));
    }
  }
});
test('dense scrolling never overlaps or catches a preceding comment, including short then long text and all size levels',()=>{
  const one=scrollingTracks([{id:'a',time:0,text:'短'},{id:'b',time:.5,text:'很长的弹幕内容'.repeat(6)},{id:'c',time:5.9,text:'很长的弹幕内容'.repeat(6)}],{width:400,lanes:1,top:20,lineHeight:40,size:20});
  assert.deepEqual(one.map(m=>m.id),['a','c']);
  for(const size of DANMAKU_SIZE_STEPS){
    const g=danmakuGeometry(720,{size,opacity:100}),raw=Array.from({length:500},(_,i)=>({id:String(i),time:i*.02,text:i%3?'短弹幕':'很长的弹幕内容'.repeat(8)}));
    const shown=scrollingTracks(raw,{width:1280,...g});assert.ok(shown.length>0&&shown.length<raw.length);
    for(let frame=0;frame<960;frame++){
      const time=frame/60,active=shown.filter(m=>m.time<=time&&m.end>time);
      const byLane=new Map();
      for(const m of active){const x=1280-(time-m.time)*m.speed,rect={left:Math.max(0,x),right:Math.min(1280,x+m.textWidth)};if(rect.right<=rect.left)continue;const row=byLane.get(m.lane)||[];row.push(rect);byLane.set(m.lane,row);}
      for(const row of byLane.values()){row.sort((a,b)=>a.left-b.left);for(let i=1;i<row.length;i++)assert.ok(row[i-1].right<=row[i].left+1e-6,`size ${size}, time ${time}`);}
    }
  }
});
test('settings validate atomically, retain style across restart, invalidate preparation and snapshot each new export',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'caibo-style-test-'));
  let app;
  const open=()=>createApp({data:root,noRecorder:true,preparation:false,compact:false,ffmpeg:'unused',ffprobe:'unused'});
  t.after(async()=>{await app?.close();await fs.rm(root,{recursive:true,force:true});});
  app=await open();app.ingestor.stop();app.media.work=async()=>{};
  let url=`http://127.0.0.1:${app.port}`;
  const post=input=>fetch(url+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  assert.deepEqual(app.snapshot().danmakuStyle,DEFAULT_DANMAKU_STYLE);
  const session=app.store.createSession({status:'finished'});
  app.store.run("INSERT INTO preparation_jobs(session,status) VALUES(?,'ready')",session.id);
  const invalidated=[];t.mock.method(app.preparation,'invalidate',async id=>invalidated.push(id));
  assert.equal((await post({danmakuPerSecond:12,danmakuStyle:{size:0.5,opacity:50}})).status,400);
  assert.equal(app.snapshot().danmakuPerSecond,50);
  assert.equal((await post({danmakuPerSecond:12,danmakuStyle:{size:1.5,opacity:50},danmakuFont:'f'.repeat(64)})).status,400);
  assert.deepEqual(app.snapshot().danmakuStyle,DEFAULT_DANMAKU_STYLE);assert.equal(app.snapshot().danmakuPerSecond,50);
  const style={size:2.5,opacity:45};assert.equal((await post({danmakuStyle:style,danmakuPerSecond:12})).status,200);
  assert.deepEqual(invalidated,[session.id]);assert.deepEqual(app.snapshot().danmakuStyle,style);
  app.store.run('UPDATE sessions SET duration=20 WHERE id=?',session.id);
  const edit=app.store.edit(session.id);app.store.saveEdit(session.id,{...edit,ranges:[{start:0,end:5}]});
  const job=await app.media.enqueue(session.id,{mode:'danmaku',exportDirectory:path.join(root,'exports')});
  assert.deepEqual(job.danmakuStyle,style);
  assert.equal(job.danmakuPerSecond,12);
  assert.equal((await post({danmakuStyle:{size:0.6,opacity:100}})).status,200);
  assert.deepEqual(JSON.parse(app.store.get('SELECT data FROM jobs WHERE id=?',job.id).data).danmakuStyle,style);
  await app.close();app=await open();url=`http://127.0.0.1:${app.port}`;
  assert.deepEqual(app.snapshot().danmakuStyle,DEFAULT_DANMAKU_STYLE);assert.equal(app.snapshot().danmakuPerSecond,12);
});
