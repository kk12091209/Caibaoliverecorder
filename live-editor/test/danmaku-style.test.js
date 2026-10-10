import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createApp} from '../server/index.js';
import {assText} from '../server/media.js';
import {danmakuGeometry,validateDanmakuStyle,DANMAKU_SIZE_STEPS,DEFAULT_DANMAKU_STYLE,normalizedDanmakuStyle,DANMAKU_SPEED_STEPS,danmakuDuration} from '../shared/danmaku-style.js';
import {layoutDanmaku,commentX} from '../src/danmaku-layout.js';
import {scrollingTracks} from '../shared/danmaku-tracks.js';
import {layoutComments,layoutCommentsAsync,commentSignature} from '../server/render-plan.js';

test('legacy styles keep their appearance and default motion; speed steps and frame rates are strictly validated',()=>{
  assert.deepEqual(validateDanmakuStyle({size:2.5,opacity:45}),{size:2.5,opacity:45,speed:1,fps:60});
  assert.deepEqual(normalizedDanmakuStyle(undefined),DEFAULT_DANMAKU_STYLE);
  for(const speed of DANMAKU_SPEED_STEPS)for(const fps of [30,60])assert.equal(validateDanmakuStyle({...DEFAULT_DANMAKU_STYLE,speed,fps}).speed,speed);
  for(const speed of [.4,2.1,1.05,'1',null,NaN,Infinity])assert.throws(()=>validateDanmakuStyle({...DEFAULT_DANMAKU_STYLE,speed}));
  for(const fps of [0,24,59.94,120,'30',null])assert.throws(()=>validateDanmakuStyle({...DEFAULT_DANMAKU_STYLE,fps}));
});
test('every speed uses the same wall-clock motion in preview and export at 30 and 60 fps, including slow clipped tails',()=>{
  const raw=[{id:'a',type:'d',time:0,text:'SPEED'}],width=1280,height=720;
  const baseline=layoutComments(raw)[0];
  for(const speed of DANMAKU_SPEED_STEPS)for(const fps of [30,60]){
    const style={...DEFAULT_DANMAKU_STYLE,speed,fps},g=danmakuGeometry(height,style);
    const [event]=layoutComments(raw,{width,height,style});
    assert.ok(Math.abs(event.speed-baseline.speed*speed)<1e-8);
    assert.equal(event.end,6/speed);
    const preview=layoutDanmaku(raw,{width,height,fontSize:g.size,lineHeight:g.lineHeight,top:g.top,maxLanes:g.lanes,exportLayout:true,duration:danmakuDuration(style)}).get('a');
    assert.deepEqual(preview,event);
    assert.ok(Math.abs(commentX(event,3/speed,width)-commentX(baseline,3,width))<1e-8);
  }
  const style={...DEFAULT_DANMAKU_STYLE,speed:.5},[slow]=layoutComments(raw,{style});
  assert.match(assText([{...slow,time:-8,end:4}],width,height,null,style),/0:00:00\.00,0:00:04\.00/);
});

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
test('workbench export-style layout retains simultaneous bursts regardless of lane capacity and preserves six-second travel',()=>{
  const messages=Array.from({length:50},(_,i)=>({id:String(i).padStart(2,'0'),time:0,text:'SAMPLE'}));
  const geometry=danmakuGeometry(720,{size:0.6,opacity:100});
  const layout=layoutDanmaku(messages,{width:1280,height:720,fontSize:geometry.size,lineHeight:geometry.lineHeight,top:geometry.top,maxLanes:geometry.lanes,exportLayout:true,measure:()=>120});
  assert.equal(layout.size,messages.length);assert.equal(new Set([...layout.values()].map(m=>m.lane)).size,geometry.lanes);
  for(const m of layout.values()){assert.equal(m.end,6);assert.equal(m.speed,(1280+m.textWidth)/(6-m.entryDelay));}
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
test('dense scrolling retains every admitted message at all sizes and prefers clear lanes when available',()=>{
  const one=scrollingTracks([{id:'a',time:0,text:'短'},{id:'b',time:.5,text:'很长的弹幕内容'.repeat(6)},{id:'c',time:5.9,text:'很长的弹幕内容'.repeat(6)}],{width:400,lanes:1,top:20,lineHeight:40,size:20});
  assert.deepEqual(one.map(m=>m.id),['a','b','c']);
  for(const size of DANMAKU_SIZE_STEPS){
    const g=danmakuGeometry(720,{size,opacity:100}),raw=Array.from({length:500},(_,i)=>({id:String(i),time:i*.02,text:i%3?'短弹幕':'很长的弹幕内容'.repeat(8)}));
    const shown=scrollingTracks(raw,{width:1280,...g});assert.equal(shown.length,raw.length);
    assert.deepEqual(shown.map(m=>m.id),raw.map(m=>m.id));
    for(const message of shown){assert.ok(message.lane>=0&&message.lane<g.lanes);assert.equal(message.end,message.time+6);}
  }
  const clear=scrollingTracks([{id:'a',time:0,text:'短'},{id:'b',time:.5,text:'长'.repeat(80)}],{width:400,lanes:2,top:20,lineHeight:40,size:20});
  assert.notEqual(clear[0].lane,clear[1].lane);
  const messages=Array.from({length:100},(_,i)=>({id:String(i).padStart(3,'0'),time:i*.01,type:'d',text:'测试 '+i}));
  for(const size of DANMAKU_SIZE_STEPS)for(const rate of [1,7,17,50]){
    const exported=layoutComments(messages,{rate,style:{size,opacity:100}});
    assert.equal(exported.length,rate);assert.deepEqual(exported.map(m=>m.id),messages.slice(0,rate).map(m=>m.id));
  }
});
test('simultaneous bursts spread entry and vertical positions without changing source time, duration, size or count',()=>{
  for(const height of [360,720,940,1080,2160])for(const size of DANMAKU_SIZE_STEPS){
    const style={size,opacity:100},g=danmakuGeometry(height,style),width=Math.round(height*16/9);
    const raw=Array.from({length:50},(_,i)=>({id:String(i).padStart(2,'0'),type:'d',time:0,text:'蔡老师今天好可爱'}));
    const layout=layoutComments(raw,{width,height,style,rate:50});
    assert.equal(layout.length,50);assert.ok(new Set(layout.map(m=>m.y)).size>Math.min(20,g.lanes));
    assert.equal(layout[0].entryDelay,0);assert.equal(layout.at(-1).entryDelay,.49);
    for(const m of layout){
      assert.equal(m.time,0);assert.equal(m.end,6);assert.ok(m.y>=0);assert.ok(m.y+g.size*1.4+4<=height+.001);
      assert.equal(commentX(m,m.time,width),width);assert.ok(Math.abs(commentX(m,m.end,width)+m.textWidth)<1e-6);
    }
    assert.deepEqual(layoutComments(raw,{width,height,style,rate:50}),layout);
  }
});
test('sustained high density has no accumulating delay; sparse traffic remains immediate and avoids catch-up',()=>{
  const steady=Array.from({length:6000},(_,i)=>({id:String(i),type:'d',time:i/50,text:'短弹幕'}));
  const layout=layoutComments(steady,{style:{size:2,opacity:100}});
  assert.equal(layout.length,steady.length);assert.ok(layout.every(m=>m.entryDelay===0));
  const boundary=Array.from({length:100},(_,i)=>({id:String(i).padStart(3,'0'),type:'d',time:i<50?.999:1,text:'边界涌入的弹幕'}));
  const clustered=layoutComments(boundary,{style:{size:2,opacity:100}});
  assert.equal(clustered.length,100);
  for(let i=0;i<clustered.length;i++){const m=clustered[i];assert.equal(m.time,boundary[i].time);assert.equal(m.end,m.time+6);assert.ok(m.entryDelay>=0&&m.entryDelay<=.5);}
  const raw=[{id:'a',type:'d',time:0,text:'短'},{id:'b',type:'d',time:.5,text:'长'.repeat(60)}];
  const clear=layoutComments(raw,{width:640,height:360});assert.equal(clear[0].entryDelay,0);assert.equal(clear[1].entryDelay,0);assert.notEqual(clear[0].y,clear[1].y);
});
test('refreshing a sliding workbench window retains positions already on screen',()=>{
  const raw=Array.from({length:300},(_,i)=>({id:String(i).padStart(3,'0'),time:i*.04,text:i%2?'短弹幕':'比较长的弹幕内容'.repeat(4)}));
  const g=danmakuGeometry(720,{size:2,opacity:100}),options={width:1280,height:720,fontSize:g.size,lineHeight:g.lineHeight,top:g.top,maxLanes:g.lanes,exportLayout:true,measure:()=>10};
  const before=layoutDanmaku(raw,options),window=raw.slice(80),after=layoutDanmaku(window,{...options,previous:before});
  for(const m of window){assert.equal(after.get(m.id).y,before.get(m.id).y);assert.equal(after.get(m.id).speed,before.get(m.id).speed);}
});
test('ASS preserves intermediate positions and staggered motion, including clipped six-second tails',()=>{
  const raw=Array.from({length:50},(_,i)=>({id:String(i).padStart(2,'0'),type:'d',time:0,text:'SAMPLE'}));
  const style={size:2,opacity:100},layout=layoutComments(raw,{width:1280,height:720,style}),g=danmakuGeometry(720,style);
  const m=layout.find(m=>Math.abs(m.y-(g.top+m.lane*g.lineHeight))>1);
  assert.ok(m);const ass=assText([m],1280,720,null,style);
  assert.ok(ass.includes(`,${m.y},${-m.textWidth},${m.y},${Math.round(m.entryDelay*1000)},6000)`));
  const tail={...m,time:-2,end:4},text=assText([tail],1280,720,null,style);
  const x=commentX(m,2,1280);assert.ok(text.includes(`move(${x},${m.y},${-m.textWidth},${m.y},0,4000)`));
  assert.notEqual(commentSignature([m]),commentSignature([{...m,y:m.y+.1}]));
  assert.notEqual(commentSignature([m]),commentSignature([{...m,entryDelay:m.entryDelay+.01}]));
});
test('long-recording asynchronous layout equals synchronous output and can be canceled between batches',async()=>{
  const raw=Array.from({length:4000},(_,i)=>({id:String(i).padStart(4,'0'),type:'d',time:i/50,text:i%2?'短弹幕':'长文字'.repeat(30)})),options={style:{size:2,opacity:100},width:1920,height:1080};
  assert.deepEqual(await layoutCommentsAsync(raw,options),layoutComments(raw,options));
  const controller=new AbortController();setImmediate(()=>controller.abort());
  await assert.rejects(layoutCommentsAsync(raw,{...options,signal:controller.signal}),{code:'PREP_CANCELLED'});
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
  const style={size:2.5,opacity:45,speed:1.7,fps:30};assert.equal((await post({danmakuStyle:style,danmakuPerSecond:12})).status,200);
  assert.deepEqual(invalidated,[session.id]);assert.deepEqual(app.snapshot().danmakuStyle,style);
  await app.close();app=await open();app.ingestor.stop();app.media.work=async()=>{};url=`http://127.0.0.1:${app.port}`;
  assert.deepEqual(app.snapshot().danmakuStyle,style);
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
