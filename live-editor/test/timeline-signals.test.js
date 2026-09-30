import test from 'node:test';
import assert from 'node:assert/strict';
import {signalWindow,viewWindow,panWindow,zoomWindow,windowPercent,visibleRange,timeAtPixel,aggregateAudio,aggregateDensity,audioStateLabel,densityStateLabel} from '../src/timeline-signals.js';

test('horizontal panning keeps local detail across a four-hour recording and clamps both ends',()=>{
  const window={from:7140.125,to:7260.125};
  assert.deepEqual(panWindow(14400,window,10000.25),{from:10000.25,to:10120.25});
  assert.deepEqual(panWindow(14400,window,-80),{from:0,to:120});
  assert.deepEqual(panWindow(14400,window,15000),{from:14280,to:14400});
  assert.deepEqual(panWindow(14400,window,NaN),window);
  assert.deepEqual(panWindow(14400,null,10000),{from:0,to:14400});
  assert.deepEqual(panWindow(0,null,100),{from:0,to:0});
  assert.deepEqual(window,{from:7140.125,to:7260.125});
});

test('zoom enters two minutes, reaches ten-second detail and returns to the full recording',()=>{
  let window=zoomWindow(14400,null,7200,.5);
  assert.deepEqual(window,{from:7140,to:7260});
  window=zoomWindow(14400,window,7200,.5);
  assert.deepEqual(window,{from:7170,to:7230});
  for(let i=0;i<10;i++)window=zoomWindow(14400,window,7200,.5);
  assert.deepEqual(window,{from:7195,to:7205});
  assert.equal(zoomWindow(200,{from:40,to:160},100,2),null);
  assert.equal(zoomWindow(8,null,4,.5),null);
  assert.equal(zoomWindow(0,null,0,.5),null);
  assert.deepEqual(zoomWindow(45,null,20,.5),{from:8.75,to:31.25});
});

test('zoom uses the visible center when playback is elsewhere and handles footage boundaries',()=>{
  const window={from:1000,to:1120};
  assert.deepEqual(zoomWindow(14400,window,40,.5),{from:1030,to:1090});
  assert.deepEqual(zoomWindow(14400,window,null,.5),{from:1030,to:1090});
  assert.deepEqual(zoomWindow(14400,null,0,.5),{from:0,to:120});
  assert.deepEqual(zoomWindow(14400,null,14400,.5),{from:14280,to:14400});
  assert.deepEqual(zoomWindow(14400,window,NaN,NaN),window);
  assert.deepEqual(zoomWindow(14400,window,1060,-1),window);
});

test('newly recorded footage does not stretch or move a panned window or change absolute selections',()=>{
  const window=panWindow(14400,{from:7140,to:7260},14280),range={start:14310,end:14340};
  assert.deepEqual(viewWindow(15000,window),{from:14280,to:14400});
  assert.deepEqual(visibleRange(range,window.from,window.to),{left:25,width:25});
  assert.equal(timeAtPixel(300,600,window.from,window.to),14340);
  assert.equal(windowPercent(range.start,window.from,window.to),25);
  assert.deepEqual(panWindow(15000,window,15000),{from:14880,to:15000});
  assert.deepEqual(range,{start:14310,end:14340});
});

test('two-minute view remains within footage and stays fixed while recording grows',()=>{
  assert.deepEqual(signalWindow(3600,1800),{from:1740,to:1860});
  assert.deepEqual(signalWindow(180,0),{from:0,to:120});
  assert.deepEqual(signalWindow(180,178),{from:60,to:180});
  assert.deepEqual(signalWindow(45,44),{from:0,to:45});
  assert.deepEqual(signalWindow(0,0),{from:0,to:0});
  const fixed=signalWindow(3600,1800);
  assert.deepEqual(viewWindow(3700,fixed),fixed);
  assert.deepEqual(viewWindow(3700,null),{from:0,to:3700});
  assert.deepEqual(viewWindow(1750,fixed),{from:1740,to:1750});
});

test('fractional seeking and flags use the same window origin without changing absolute selections',()=>{
  const from=58.125,to=178.125;
  assert.equal(windowPercent(88.125,from,to),25);
  assert.equal(timeAtPixel(150,600,from,to),88.125);
  assert.equal(timeAtPixel(-8,600,from,to),from);
  assert.equal(timeAtPixel(620,600,from,to),to);
  const range={start:40,end:100,selected:false};
  assert.equal(visibleRange(range,60,180).left,0);
  assert.ok(Math.abs(visibleRange(range,60,180).width-100/3)<1e-10);
  assert.deepEqual(visibleRange({start:150,end:210},60,180),{left:75,width:25});
  assert.equal(visibleRange({start:0,end:60},60,180),null);
  assert.equal(visibleRange({start:200,end:210},60,180),null);
  assert.equal(visibleRange({start:0,end:1},0,0),null);
  assert.deepEqual(range,{start:40,end:100,selected:false});
});

test('waveform aggregation preserves brief peaks, RMS energy, and unknown-state indicators',()=>{
  const bins=[{peak:.2,rms:.1,state:'ready'},{peak:1,rms:.3,state:'ready'},{peak:0,rms:0,state:'silent'},{state:'pending'},{state:'unavailable'}];
  const bars=aggregateAudio(bins,2);
  assert.equal(bars.length,2);
  assert.equal(bars[0].peak,1);
  assert.ok(Math.abs(bars[0].rms-Math.sqrt(.05))<1e-10);
  assert.equal(bars[1].state,'silent');
  assert.equal(bars[1].pending,true);
  assert.equal(bars[1].unavailable,true);
  assert.equal(aggregateAudio([{state:'pending'},{state:'unavailable'}],1)[0].state,'pending');
  assert.equal(aggregateAudio([{state:'unavailable'}],100)[0].state,'unavailable');
  assert.deepEqual(aggregateAudio([],600),[]);
});

test('density resize aggregation retains all repeated messages, including the final bin',()=>{
  const bins=Array.from({length:601},(_,i)=>i===600?300:1);
  for(const width of [1,37,180,1200]){
    const bars=aggregateDensity(bins,width);
    assert.equal(bars.length,Math.min(width,bins.length));
    assert.equal(bars.reduce((sum,n)=>sum+n,0),900);
    assert.ok(bars.at(-1)>=300);
  }
  assert.deepEqual(aggregateDensity([-1,NaN,2],3),[0,0,2]);
});

test('labels distinguish unprepared data, no audio, silence, and density building',()=>{
  const selected={selected:true};
  assert.equal(audioStateLabel(null,selected),'波形准备中…');
  assert.equal(audioStateLabel({status:'no_audio',bins:[]},selected),'无音轨');
  assert.equal(audioStateLabel({bins:[{state:'silent'}]},selected),'音频静音');
  assert.equal(audioStateLabel({bins:[{state:'unavailable'}]},selected),'波形无法读取');
  assert.equal(audioStateLabel({bins:[{state:'pending'}]},selected),'波形准备中…');
  assert.equal(audioStateLabel({status:'partial',bins:[{state:'ready'},{state:'pending'}]},selected),'波形生成中…');
  assert.equal(densityStateLabel({status:'building',bins:[0,0]},selected),'密度统计中…');
  assert.equal(densityStateLabel({status:'error',bins:[0]},selected),'密度暂不可用');
  assert.equal(densityStateLabel({status:'ready',bins:[0,0]},selected),'暂无有效弹幕');
  assert.equal(densityStateLabel({status:'ready',bins:[0,1]},selected),'');
});
