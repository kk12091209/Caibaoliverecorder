import test from 'node:test';
import assert from 'node:assert/strict';
import {horizontalConflict} from '../shared/danmaku-collision.js';
import {scrollingTracks} from '../shared/danmaku-tracks.js';
import {danmakuGeometry} from '../shared/danmaku-style.js';
import {DanmakuCache} from '../src/danmaku-clock.js';
import {overlapExposure} from './helpers/danmaku-overlap.js';

test('collision exposure agrees with an independent fine-grained motion simulation',()=>{
  let seed=187;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  for(let i=0;i<400;i++){
    const width=200+random()*1800,life=3+random()*9,previousWidth=10+random()*1200,nextWidth=10+random()*1200;
    const delay=random()*.5,time=delay+random()*(life-delay),end=time+life,gap=12;
    const before={time:0,entryDelay:delay,end:life,textWidth:previousWidth,speed:(width+previousWidth)/(life-delay)};
    const speed=(width+nextWidth)/life,span=Math.min(before.end,end)-time;
    let sum=0;const steps=4000;
    for(let n=0;n<=steps;n++){
      const elapsed=span*n/steps,a=width-speed*elapsed,b=width-before.speed*(time+elapsed-delay);
      const intersection=Math.max(0,Math.min(width,a+nextWidth+gap,b+previousWidth+gap)-Math.max(0,a,b));
      sum+=intersection*(n===0||n===steps?.5:1);
    }
    const expected=sum/steps*span/(width*(end-time));
    assert.ok(Math.abs(horizontalConflict(before,time,nextWidth,speed,width,gap,end)-expected)<1e-6);
  }
});

test('brief catch-up near the edge is detected; clearly separated equal-speed text has no conflict',()=>{
  const before={time:0,entryDelay:0,end:6,textWidth:40,speed:60};
  assert.ok(horizontalConflict(before,5.9,30000,30320/6,320,12,11.9)>0);
  assert.equal(horizontalConflict(before,2,40,60,320,12,8),0);
  assert.equal(horizontalConflict(before,6,40,60,320,12,12),0);
});

test('visible cache entries survive an oversized working set and inactive entries make room',()=>{
  const cache=new DanmakuCache(12),visible=new Set(['a','b','c','d','e']);let misses=0;
  for(let frame=0;frame<100;frame++)for(const key of visible){if(cache.get(key)===undefined){misses++;cache.set(key,key,4,visible);}assert.ok(cache.cost<=12);}
  assert.equal(misses,203);assert.deepEqual(new Set(cache.entries.keys()),new Set(['a','b','c']));
  const next=new Set(['c','d','e']);cache.set('d','d',4,next);cache.set('e','e',4,next);
  assert.equal(cache.cost,12);assert.deepEqual(new Set(cache.entries.keys()),next);
  assert.equal(cache.set('oversize','draw once',13,next),'draw once');assert.equal(cache.cost,12);
  assert.equal(cache.set('c','replacement',8,next),'replacement');assert.equal(cache.get('c'),undefined);assert.equal(cache.cost,8);
  cache.clear();assert.equal(cache.cost,0);
});

test('new dense layouts retain count, size, times and speed at every region and leave no cumulative delay',()=>{
  const raw=Array.from({length:1200},(_,i)=>({id:String(i).padStart(5,'0'),time:i/50,text:'长短混合测试'.repeat(i%4+1)}));
  for(const size of [.6,1.5,5])for(const areaHeight of [1,1/3]){
    const geometry=danmakuGeometry(1080,{size,opacity:100,areaTop:0,areaHeight}),rows=scrollingTracks(raw,{width:1920,height:1080,...geometry});
    assert.equal(rows.length,raw.length);
    for(let i=0;i<rows.length;i++){
      const m=rows[i];assert.equal(m.id,raw[i].id);assert.equal(m.time,raw[i].time);assert.equal(m.end,raw[i].time+6);
      assert.ok(m.entryDelay>=0&&m.entryDelay<=.5);assert.equal(m.speed,(1920+m.textWidth)/(6-m.entryDelay));
      assert.ok(m.y>=geometry.clipTop&&m.y+geometry.size*1.4+4<=geometry.clipBottom+.001);
    }
  }
});

test('dense layout reduces sustained occlusion against captured version 8 reference fixtures',()=>{
  // Version 8 results captured before changing the scorer, measured by the
  // independent rectangle/time simulation (not production collision scores).
  const baseline=[3340417.504908528,4158580.9582964764,43435358.896149844,44751808.067341834,39307169.34209791,38881657.770972036,199574027.23353764,200330306.42570826,138989361.7142837,141270159.27232522,595286831.8849674,568297781.3689407];
  let seed=17,index=0;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  for(const rate of [15,30,50])for(const areaHeight of [1,1/3])for(const burst of [false,true]){
    const raw=Array.from({length:rate*24},(_,i)=>({id:String(i).padStart(6,'0'),time:burst?Math.floor(i/rate):i/rate,text:'测'.repeat(2+Math.floor(random()*25))}));
    const g=danmakuGeometry(1080,{size:.6,opacity:100,speed:1,fps:60,areaTop:areaHeight===1?0:.4,areaHeight});
    const rows=scrollingTracks(raw,{width:1920,height:1080,...g,duration:6});
    assert.ok(overlapExposure(rows,1920,g.size*1.4+4).total<baseline[index++]*.98);
  }
});
