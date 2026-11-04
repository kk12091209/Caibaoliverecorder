import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackdropClickGuard} from '../src/backdrop-click.js';

function fixture(){
  const backdrop={},inside={},other={},guard=createBackdropClickGuard();
  const event=(overrides={})=>({target:backdrop,currentTarget:backdrop,pointerId:1,button:0,isPrimary:true,clientX:20,clientY:30,detail:1,...overrides});
  const outsideClick=()=>{guard.pointerDown(event());guard.pointerUp(event());return guard.click(event());};
  return {guard,event,backdrop,inside,other,outsideClick};
}

test('a primary outside click closes once and permits small pointer jitter',()=>{
  const {guard,event,outsideClick}=fixture();
  assert.equal(outsideClick(),true);
  assert.equal(guard.click(event()),false);
  guard.pointerDown(event());
  guard.pointerMove(event({clientX:23,clientY:33}));
  guard.pointerUp(event({clientX:23,clientY:33}));
  assert.equal(guard.click(event({clientX:23,clientY:33})),true);
});

test('dragging from inside to outside never dismisses a dialog even when click is retargeted to the backdrop',()=>{
  const {guard,event,inside,outsideClick}=fixture();
  guard.pointerDown(event({target:inside}));
  guard.pointerMove(event({clientX:500}));
  guard.pointerUp(event({clientX:500}));
  assert.equal(guard.click(event({clientX:500})),false);
  assert.equal(outsideClick(),true,'the next real outside click still works');
});

test('inside clicks and outside-to-inside drags cannot dismiss',()=>{
  for(const startsInside of [true,false]){
    const {guard,event,inside}=fixture();
    guard.pointerDown(event(startsInside?{target:inside}:{}));
    guard.pointerUp(event({target:inside}));
    assert.equal(guard.click(event()),false);
  }
});

test('an outside drag is rejected even when it returns to its starting point',()=>{
  const {guard,event}=fixture();
  guard.pointerDown(event());
  guard.pointerMove(event({clientY:50}));
  guard.pointerMove(event());
  guard.pointerUp(event());
  assert.equal(guard.click(event()),false);
});

test('displacement at release is checked even without a move event',()=>{
  const {guard,event}=fixture();
  guard.pointerDown(event());
  guard.pointerUp(event({clientX:27}));
  assert.equal(guard.click(event({clientX:27})),false);
});

test('cancellation, window blur or a modal change clears pending dismissal',()=>{
  const {guard,event,outsideClick}=fixture();
  for(const afterRelease of [false,true]){
    guard.pointerDown(event());
    if(afterRelease)guard.pointerUp(event());
    guard.reset();
    guard.pointerUp(event());
    assert.equal(guard.click(event()),false);
    assert.equal(outsideClick(),true);
  }
});

test('right clicks, secondary pointers and interrupted multi-touch gestures are rejected',()=>{
  for(const overrides of [{button:2},{isPrimary:false}]){
    const {guard,event}=fixture();
    guard.pointerDown(event(overrides));guard.pointerUp(event(overrides));
    assert.equal(guard.click(event(overrides)),false);
  }
  const {guard,event}=fixture();
  guard.pointerDown(event());
  guard.pointerDown(event({pointerId:2,isPrimary:false}));
  guard.pointerUp(event());
  assert.equal(guard.click(event()),false);
});

test('unmatched pointers, unreleased gestures and a replaced backdrop cannot dismiss',()=>{
  for(const phase of ['release','click','unreleased','backdrop']){
    const {guard,event,other}=fixture();
    guard.pointerDown(event());
    if(phase!=='unreleased')guard.pointerUp(event(phase==='release'?{pointerId:2}:phase==='backdrop'?{target:other,currentTarget:other}:{}));
    assert.equal(guard.click(event(phase==='click'?{pointerId:2}:{})),false,phase);
  }
});

test('a click without a pointer gesture or with keyboard detail zero cannot dismiss',()=>{
  const {guard,event}=fixture();
  assert.equal(guard.click(event()),false);
  guard.pointerDown(event());guard.pointerUp(event());
  assert.equal(guard.click(event({detail:0})),false);
});

test('MouseEvent click without pointerId is accepted after a valid pointer gesture',()=>{
  const {guard,event}=fixture();
  guard.pointerDown(event());guard.pointerUp(event());
  assert.equal(guard.click(event({pointerId:undefined})),true);
});
