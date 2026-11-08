import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';
import { useClipMarkers } from '../src/use-clip-markers.js';
import { formatFrameTime } from '../src/video-time.js';

function fixture(){
  const position=ref(0),canPreview=ref(true),messages=[];
  const source={start:0,duration:480,wall:'2026-11-08T15:58:00Z',metadata:{fps:25}};
  const detail=ref({sources:[source]});
  const markers=useClipMarkers({selected:ref('fixture'),detail,activeSession:ref({room:1,status:'finished',created:source.wall}),selectionReady:ref(true),duration:ref(480),canPreview,position,frameRateAt:()=>25,formatPosition:t=>formatFrameTime(t,25),playFrom:()=>{},tell:message=>messages.push(message)});
  const place=time=>{position.value=time;markers.placeMarker();};
  return {markers,position,place,detail,messages,canPreview};
}

test('two marks sort in either direction, and a complete pair restarts explicitly',()=>{
  const {markers:m,place}=fixture();
  place(240);assert.equal(m.draftDuration.value,null);
  place(180);assert.equal(m.readMark('start'),180);assert.equal(m.readMark('end'),240);
  place(240);assert.equal(m.endMarked.value,false);
  place(360);assert.equal(m.readMark('start'),240);assert.equal(m.readMark('end'),360);
});

test('clearing either endpoint keeps the other ready to pair, and clearing all removes both clocks',()=>{
  for(const which of ['start','end']){
    const {markers:m,place}=fixture();place(180);place(240);m.clearMark(which);
    assert.equal(m.draftDuration.value,null);
    place(120);assert.equal(m.readMark('start'),120);assert.equal(m.readMark('end'),which==='start'?240:180);
    m.clearDraftMarks();
    assert.equal(m.startDateText.value,'');assert.equal(m.endDateText.value,'');
    assert.throws(()=>m.readMark('start'));assert.throws(()=>m.readMark('end'));
  }
});

test('repeating the same displayed frame never creates a zero-frame range',()=>{
  const {markers:m,place,messages}=fixture();place(3.04);place(3.040001);
  assert.equal(m.endMarked.value,false);assert.equal(messages.length,1);
  place(3.08);assert.ok(Math.abs(m.draftDuration.value-.04)<1e-9);
});

test('recording picker and mode changes retain exact frames even though its clock shows seconds',()=>{
  const {markers:m,place}=fixture();place(120.04);place(180.08);
  m.setPositionMode('recording');
  assert.equal(m.startDateText.value,'2026-11-09T00:00:00');
  assert.equal(m.recordingMarkTime('start',m.startDateText.value),120.04);
  m.setPositionMode('video');assert.equal(m.readMark('start'),120.04);assert.equal(m.readMark('end'),180.08);
});

test('empty recording picker defaults to playback time and rejects gaps and out-of-bounds choices',()=>{
  const {markers:m,position,detail}=fixture();position.value=240;
  assert.equal(m.recordingInitial('start'),'2026-11-09T00:02:00');
  detail.value.sources=[{start:0,duration:60,wall:'2026-11-08T15:58:00Z'},{start:120,duration:360,wall:'2026-11-08T16:00:00Z'}];
  assert.throws(()=>m.recordingMarkTime('start','2026-11-08T23:59:30'),/间隙/);
  assert.throws(()=>m.recordingMarkTime('start','2026-11-09T00:07:00'),/结束时间/);
  assert.equal(m.startMarked.value,false);
});

test('invalid manual input is preserved for correction when pairing, and unavailable preview cannot place marks',()=>{
  const {markers:m,place,canPreview,messages}=fixture();
  m.inputMark('start','invalid');place(10);assert.equal(m.startText.value,'invalid');assert.equal(m.endMarked.value,false);assert.equal(messages.length,1);
  m.clearDraftMarks();canPreview.value=false;place(0);assert.equal(m.startMarked.value,false);
});
