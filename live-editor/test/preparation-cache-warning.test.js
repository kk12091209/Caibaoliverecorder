import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.js';
import {cacheWarningSnapshot,acknowledgeCacheWarning} from '../server/preparation-cache-warning.js';

const cache = (gib, inventoryReady=true) => ({usedBytes:gib*1024**3,inventoryReady});
const request = warning => ({cycle:warning.warningCycle,thresholdGiB:warning.warningGiB});
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cache-warning-cycle-'));
  const stores=[];
  t.after(async()=>{for(const store of stores)if(!store.closed)store.close();await fs.rm(root,{recursive:true,force:true});});
  return ()=>{const store=new Store(root);stores.push(store);return store;};
}

test('确认只覆盖本轮；清理仍高于或等于阈值不重置，低于后再次达到才重新提醒',async t=>{
  const open=await fixture(t),store=open();
  const below = { usedBytes: 49_999_999_999, inventoryReady: true };
  const at = { ...below, usedBytes: 50_000_000_000 };
  assert.equal(cacheWarningSnapshot(store,below).warningDue,false);
  const first=cacheWarningSnapshot(store,at);assert.equal(first.warningDue,true);
  acknowledgeCacheWarning(store,at,request(first));
  for(const sample of [cache(100),cache(51),at]){
    const warning=cacheWarningSnapshot(store,sample);
    assert.equal(warning.warningDue,false);assert.equal(warning.warningEnabled,true);assert.equal(warning.warningCycle,first.warningCycle);
  }
  assert.equal(cacheWarningSnapshot(store,below).warningAcknowledged,false);
  const second=cacheWarningSnapshot(store,at);
  assert.equal(second.warningDue,true);assert.equal(second.warningCycle,first.warningCycle+1);
  acknowledgeCacheWarning(store,at,request(first));
  assert.equal(cacheWarningSnapshot(store,at).warningDue,true,'late acknowledgement must not silence the next period');
  acknowledgeCacheWarning(store,at,request(second));
  assert.equal(cacheWarningSnapshot(store,cache(60)).warningDue,false);
});

test('旧默认值的提醒记录不算用户设置，显式保存过的 50 GiB 仍按原值提醒', async t => {
  const open = await fixture(t);
  const store = open();
  store.setting('preparationCacheWarningState', { cycle: 1, above: false, acknowledged: false, thresholdGiB: 50 });
  const defaultUsage = { usedBytes: 50_000_000_000, inventoryReady: true };
  assert.equal(cacheWarningSnapshot(store, defaultUsage).warningDue, true);
  assert.equal(store.setting('preparationCacheWarningGiB'), undefined);

  store.setting('preparationCacheWarningGiB', 50);
  store.close();
  const reopened = open();
  const custom = cacheWarningSnapshot(reopened, defaultUsage);
  assert.equal(custom.warningGiB, 50);
  assert.equal(custom.warningDue, false);
  assert.equal(cacheWarningSnapshot(reopened, cache(50)).warningDue, true);
});

test('重启统计完成前的零值不重置确认；完整统计确实低于阈值才重新启用',async t=>{
  const open=await fixture(t);let store=open();
  const first=cacheWarningSnapshot(store,cache(60));acknowledgeCacheWarning(store,cache(60),request(first));store.close();store=open();
  const persisted=store.setting('preparationCacheWarningState');
  assert.equal(cacheWarningSnapshot(store,cache(0,false)).warningDue,false);
  assert.equal(cacheWarningSnapshot(store,cache(60,false)).warningDue,false);
  assert.deepEqual(store.setting('preparationCacheWarningState'),persisted);
  assert.equal(cacheWarningSnapshot(store,cache(70)).warningDue,false,'restart with the same files stays acknowledged');
  store.close();store=open();
  cacheWarningSnapshot(store,cache(0,false));
  cacheWarningSnapshot(store,cache(30));
  const second=cacheWarningSnapshot(store,cache(50));assert.equal(second.warningDue,true);assert.equal(second.warningCycle,first.warningCycle+1);
});

test('提醒关闭与本轮确认独立；调整提醒值会按新的阈值判断',async t=>{
  const open=await fixture(t),store=open();
  store.setting('preparationCacheWarningEnabled',false);
  const first=cacheWarningSnapshot(store,cache(50));assert.equal(first.warningDue,false);
  cacheWarningSnapshot(store,cache(0));assert.equal(cacheWarningSnapshot(store,cache(100)).warningDue,false);
  store.setting('preparationCacheWarningEnabled',true);
  const second=cacheWarningSnapshot(store,cache(100));assert.equal(second.warningDue,true);
  acknowledgeCacheWarning(store,cache(100),request(second));
  store.setting('preparationCacheWarningGiB',120);assert.equal(cacheWarningSnapshot(store,cache(100)).warningDue,false);
  const third=cacheWarningSnapshot(store,cache(120));assert.equal(third.warningDue,true);
  acknowledgeCacheWarning(store,cache(120),request(second));assert.equal(cacheWarningSnapshot(store,cache(120)).warningDue,true);
});

test('旧版永久确认迁移为本轮确认，未知或无效统计不会重新启用',async t=>{
  const open=await fixture(t),store=open();store.setting('preparationCacheWarningAcknowledged',true);
  for(const snapshot of [{usedBytes:0},cache(NaN),cache(-1),cache(0,false)]){
    assert.equal(cacheWarningSnapshot(store,snapshot).warningDue,false);
    assert.equal(store.setting('preparationCacheWarningState'),undefined);
  }
  const warning=cacheWarningSnapshot(store,cache(60));assert.equal(warning.warningEnabled,true);assert.equal(warning.warningDue,false);
  cacheWarningSnapshot(store,cache(10));assert.equal(cacheWarningSnapshot(store,cache(50)).warningDue,true);
});
