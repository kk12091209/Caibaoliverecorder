import test from 'node:test';
import assert from 'node:assert/strict';
import {stateSync} from '../src/state-sync.js';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
  const state={now:0,reads:0,details:0,values:[],connections:[],sources:[],read:async()=>({version:'rest'})};
  const sync=stateSync({now:()=>state.now,read:signal=>{state.reads++;return state.read(signal);},
    apply:value=>state.values.push(value),connected:value=>state.connections.push(value),detail:()=>{state.details++;},
    every:callback=>{state.tick=callback;return 1;},cancel:()=>{state.tick=null;},
    events:()=>{const source={readyState:1,closed:false,close(){this.closed=true;}};state.sources.push(source);return source;}});
  state.message=value=>state.sources.at(-1).onmessage({data:JSON.stringify(value)});
  state.advance=async ms=>{state.now+=ms;state.tick?.();await turn();};
  t.after(()=>sync.close());return {state,sync};
}

test('healthy push avoids periodic state GETs while detail refresh and explicit actions keep working',async t=>{
  const {state,sync}=fixture(t);sync.start();await turn();assert.equal(state.reads,1);
  for(let i=0;i<24;i++){state.message({version:i});await state.advance(2500);}
  assert.equal(state.reads,1);assert.equal(state.details,24);assert.equal(state.values.at(-1).version,23);
  await sync.refresh();assert.equal(state.reads,2);
});
test('disconnection falls back to REST and recovering push stops duplicate polling',async t=>{
  const {state,sync}=fixture(t);sync.start();await turn();state.message({version:1});
  state.sources.at(-1).onerror();await state.advance(2500);assert.equal(state.reads,2);assert.equal(state.connections.at(-1),true);
  state.message({version:2});await state.advance(2500);assert.equal(state.reads,2);
});
test('silent connection is replaced and a late REST response cannot overwrite a newer push',async t=>{
  const {state,sync}=fixture(t);sync.start();await turn();state.message({version:1});
  await state.advance(7500);assert.equal(state.reads,2);assert.equal(state.sources.length,2);assert.equal(state.sources[0].closed,true);
  let resolve;state.read=()=>new Promise(done=>resolve=done);const request=sync.refresh();await turn();
  state.message({version:3});resolve({version:'stale'});await request;assert.equal(state.values.at(-1).version,3);
});
test('close aborts outstanding requests and ignores queued events and completion',async t=>{
  const {state,sync}=fixture(t);let resolve,signal;state.read=value=>{signal=value;return new Promise(done=>resolve=done);};
  sync.start();await turn();const source=state.sources[0];sync.close();assert.equal(signal.aborted,true);assert.equal(source.closed,true);
  source.onmessage({data:'{"version":2}'});resolve({version:1});await turn();assert.equal(state.values.length,0);assert.equal(state.tick,null);
});
test('initial API failure still opens push and retries without overlapping requests',async t=>{
  const {state,sync}=fixture(t);state.read=async()=>{throw new Error('offline');};sync.start();await turn();assert.equal(state.connections.at(-1),false);
  state.read=async()=>({version:2});await state.advance(2500);assert.equal(state.values.at(-1).version,2);
  state.message({version:3});await state.advance(2500);assert.equal(state.reads,2);
});
