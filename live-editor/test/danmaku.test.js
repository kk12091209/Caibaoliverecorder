import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutDanmaku, commentX, DanmakuTimeline } from '../src/danmaku-layout.js';
import { DanmakuClock, DanmakuCache } from '../src/danmaku-clock.js';

test('弹幕位置跟随连续媒体时钟，60 Hz 下不再等待低频进度事件',()=>{
  const layout=layoutDanmaku([{id:'a',time:0,text:'持续移动'}],{width:900,height:500,measure:()=>100});
  const comment=layout.get('a'),positions=Array.from({length:60},(_,i)=>commentX(comment,1+i/60,900));
  for(let i=1;i<positions.length;i++)assert.ok(positions[i-1]-positions[i]>2&&positions[i-1]-positions[i]<3);
  assert.equal(commentX(comment,2,900),commentX(comment,2,900));
  assert.equal(commentX(comment,0,900),900);
});
test('弹幕分配稳定轨道，新弹幕和列表窗口滚动不会让正在播放的弹幕跳行',()=>{
  const options={width:900,height:300,measure:t=>t.length*22};
  const messages=[{id:'a',time:0,text:'比较长的一条弹幕内容'},{id:'b',time:.2,text:'后一条'}];
  const first=layoutDanmaku(messages,options);assert.notEqual(first.get('a').lane,first.get('b').lane);
  const next=layoutDanmaku([...messages.slice(1),{id:'c',time:.3,text:'新内容'}],{...options,previous:first});
  assert.equal(next.get('b').lane,first.get('b').lane);
  const crowded=layoutDanmaku(Array.from({length:50},(_,i)=>({id:String(i),time:0,text:'同一时刻的弹幕'})),options);
  assert.ok(crowded.size<=10);assert.equal(new Set([...crowded.values()].map(x=>x.lane)).size,crowded.size);
});

test('25 FPS 时间戳在 60 Hz 下连续移动，采样抖动不造成倒退且不会长期漂移',()=>{
  const clock=new DanmakuClock();clock.reset(0,0,{running:true});
  const positions=[];
  for(let frame=0;frame<600;frame++){
    const wall=frame*1000/60,media=Math.floor(wall/40)*.04;
    clock.sample(media,wall);positions.push(clock.at(wall));
  }
  for(let i=2;i<positions.length;i++){
    const step=positions[i]-positions[i-1];
    assert.ok(step>.008&&step<.025,`step ${i}=${step}`);
    assert.ok(Math.abs(positions[i]-i/60)<.05);
  }
});

test('画面呈现时间锚点支持变速、暂停、缓冲、跳转和恢复',()=>{
  const clock=new DanmakuClock();clock.reset(10,1000,{running:true});
  clock.sample(10.04,1040);assert.ok(Math.abs(clock.at(1060)-10.06)<1e-9);
  // Waiting/pause event resets to the exact displayed frame and stops movement.
  clock.reset(10.06,1060);assert.equal(clock.at(5000),10.06);
  // Seeking is a discontinuity, including backwards; stale anchors are discarded.
  clock.reset(2,6000);assert.equal(clock.at(9000),2);
  clock.reset(2,9000,{running:true,rate:2});clock.sample(2.08,9040);
  assert.ok(Math.abs(clock.at(9060)-2.12)<1e-9);
  clock.reset(20,10000,{running:false});assert.equal(clock.at(11000),20);
  clock.reset(0,12000,{running:true});assert.equal(clock.at(12000),0);
});

test('30 FPS 帧回调提前一个 vsync 提供呈现时间时，60 Hz 动画不产生交替停顿',()=>{
  const clock=new DanmakuClock();clock.reset(0,0,{running:true});
  let previous=0;
  for(let frame=1;frame<180;frame++){
    const now=frame*1000/60;
    if(frame%2===0)clock.sample(now/1000,now+1000/60);
    const time=clock.at(now),step=time-previous;
    assert.ok(step>.01&&step<.025,`frame ${frame}: ${step}`);
    assert.ok(Math.abs(time-now/1000)<.025);
    previous=time;
  }
});

test('即使缓冲事件迟到、currentTime 重复，外推也最多持续 200 毫秒',()=>{
  const clock=new DanmakuClock();clock.reset(5,0,{running:true});
  for(let frame=0;frame<120;frame++){clock.sample(5,frame*1000/60);clock.at(frame*1000/60);}
  assert.ok(clock.at(5000)<=5.2+1e-9);
  // A new frame after buffering can establish a fresh anchor without backwards motion.
  clock.sample(5.3,5100);assert.ok(clock.at(5100)>=5.2);
});

test('可见弹幕索引与完整扫描相同，支持跳转和窗口滚动更新',()=>{
  const layout=layoutDanmaku(Array.from({length:3000},(_,i)=>({id:String(i),time:i*.2,text:'可见弹幕'+i})),{width:900,height:500,measure:()=>120});
  const timeline=new DanmakuTimeline(layout);
  for(const time of [0,.1,1,2,15,15.01,15.5,400,400.016,20,0,650]){
    assert.deepEqual(timeline.at(time).map(c=>c.id),[...layout.values()].filter(c=>c.time<=time&&c.end>time).map(c=>c.id));
    assert.ok(timeline.active.length<50);
  }
  const replacement=new Map([...layout].filter(([,c])=>c.time>100&&c.time<150));timeline.set(replacement);
  assert.deepEqual(timeline.at(125).map(c=>c.id),[...replacement.values()].filter(c=>c.time<=125&&c.end>125).map(c=>c.id));
});

test('文字位图缓存按内存上限淘汰，不会随整场直播无限增长',()=>{
  const cache=new DanmakuCache(10);
  cache.set('a','A',4);cache.set('b','B',4);assert.equal(cache.get('a'),'A');
  cache.set('c','C',4);assert.equal(cache.get('b'),undefined);assert.equal(cache.get('a'),'A');assert.equal(cache.cost,8);
  cache.set('a','new A',8);assert.equal(cache.get('c'),undefined);assert.equal(cache.cost,8);
  cache.set('oversized','not retained',11);assert.equal(cache.get('oversized'),undefined);assert.equal(cache.cost,8);
  for(let i=0;i<10000;i++)cache.set(String(i),i,2);
  assert.equal(cache.entries.size,5);assert.equal(cache.cost,10);
  cache.clear();assert.equal(cache.cost,0);assert.equal(cache.entries.size,0);
});
