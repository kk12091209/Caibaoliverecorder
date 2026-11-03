import test from 'node:test';
import assert from 'node:assert/strict';
import {RenderCache} from '../server/render-cache.js';

test('物理可用空间不足、容量上限与空间查询失败不混用，保留可诊断的数值',async()=>{
 const cache=new RenderCache('/private/tmp/space-reason-fixture',{minFreeBytes:2048,statfs:async()=>({bavail:1,bsize:1024})});
 await assert.rejects(cache.freeSpace(1024),e=>e.code==='PREP_SPACE'&&e.spaceReason==='disk');
 assert.equal(cache.snapshot().availableBytes,1024);assert.equal(cache.snapshot().requiredBytes,3072);
 cache.statfs=async()=>{throw Object.assign(new Error('unavailable'),{code:'EACCES'});};
 await assert.rejects(cache.freeSpace(),e=>e.spaceReason==='space-check');assert.equal(cache.snapshot().checkError,'EACCES');assert.equal(cache.snapshot().availableBytes,undefined);
 cache.statfs=async()=>({bavail:102400,bsize:4096});await cache.freeSpace();assert.ok(cache.snapshot().availableBytes>0);assert.equal(cache.snapshot().checkError,undefined);
});
