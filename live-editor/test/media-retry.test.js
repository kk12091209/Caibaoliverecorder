import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaFailure,retryMedia} from '../server/media-retry.js';

test('temporary IO retries use bounded backoff and a fresh unit on every attempt',async()=>{
  const attempts=[],waits=[],events=[];
  const value=await retryMedia(i=>{attempts.push(i);if(i<2)throw Object.assign(Error('busy'),{code:'EBUSY'});return 'saved';},
    {sleep:async ms=>waits.push(ms),report:event=>events.push(event)});
  assert.equal(value,'saved');assert.deepEqual(attempts,[0,1,2]);assert.deepEqual(waits,[250,500]);assert.equal(events.length,2);
});
test('persistent temporary failure stops after three total attempts',async()=>{
  let count=0;await assert.rejects(retryMedia(()=>{count++;throw Object.assign(Error('busy'),{code:'EBUSY'});},{sleep:async()=>{}}));assert.equal(count,3);
});
for(const code of ['ENOSPC','EDQUOT','EIO','EACCES','EPERM','ENOENT','SOURCE_CHANGED','PREP_STALE','EXPORT_CANCELLED'])test(`${code} never blindly retries or burns through completed work`,async()=>{
  let calls=0;await assert.rejects(retryMedia(()=>{calls++;throw Object.assign(Error(code),{code});},{sleep:()=>assert.fail('must not wait')}));assert.equal(calls,1);
});
test('cancellation interrupts retry backoff instead of starting another attempt',async()=>{
  const controller=new AbortController();let count=0;
  await assert.rejects(retryMedia(()=>{count++;throw Object.assign(Error('busy'),{code:'EBUSY'});},
    {signal:controller.signal,report:()=>controller.abort()}),{name:'AbortError'});assert.equal(count,1);
});
test('full disk takes priority over a transient wrapper and completed publication is not re-encoded',()=>{
  assert.equal(mediaFailure(Object.assign(Error('wrapper'),{code:'EBUSY',cause:Object.assign(Error('full'),{code:'ENOSPC'})})),'action');
  assert.equal(mediaFailure(Object.assign(Error('busy'),{code:'EBUSY',savePending:true})),'stop');
});
test('parallel failing steps share a hard retry allowance without overspending it',async()=>{
  let remaining=6,retries=0,calls=0;
  await Promise.allSettled(Array.from({length:8},()=>retryMedia(()=>{calls++;throw Object.assign(Error('busy'),{code:'EBUSY'});},
    {sleep:async()=>{},allowRetry:()=>remaining>0,report:()=>{remaining--;retries++;}})));
  assert.equal(retries,6);assert.equal(calls,14);assert.equal(remaining,0);
});
