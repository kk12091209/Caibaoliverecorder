import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {deletionWork} from '../server/deletion-work.js';

test('清理任务限制并发、每项仅一次，避免万余分片逐个等待',async()=>{
  let active=0,peak=0;const seen=new Set();
  await deletionWork(Array.from({length:80},(_,i)=>i),async id=>{assert.equal(seen.has(id),false);seen.add(id);active++;peak=Math.max(peak,active);await delay(1);active--;});
  assert.equal(seen.size,80);assert.equal(peak,8);assert.equal(active,0);
});
test('清理失败先等已启动的工作结束再返回，避免重试或关库与删除竞态',async()=>{
  let release,settled=false,completed=false;
  const hold=new Promise(resolve=>release=resolve);
  const task=deletionWork([0,1,2,3],async id=>{if(id===0){await delay(1);throw new Error('locked');}await hold;completed=true;},2);
  const observed=task.catch(error=>{settled=true;return error;});
  await delay(10);assert.equal(settled,false);release();
  assert.match((await observed).message,/locked/);assert.equal(completed,true);
});
