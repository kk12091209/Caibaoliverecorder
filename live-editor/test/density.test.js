import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { DensityService } from '../server/density.js';

function fixture(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-density-test-'));
  const store = new Store(root), density = new DensityService(store, options);
  t.after(() => {
    density.close();
    store.close();
    const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(root));
    assert.ok(relative.startsWith('bili-density-test-') && !relative.includes(path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  store.createSession({ id: 'one', status: 'complete' });
  store.run('UPDATE sessions SET duration=600 WHERE id=?', 'one');
  let nextId = 0;
  const insert = store.db.prepare('INSERT INTO danmaku(id,session,time,user,text,type,color) VALUES(?,?,?,?,?,?,?)');
  const add = (time, { session = 'one', type = 'd', text = '普通重复弹幕', lottery = false } = {}) => {
    const id = `message-${++nextId}`;
    insert.run(id, session, time, '测试用户', text, type, 'ffffff');
    if (lottery) store.run("INSERT INTO danmaku_filters VALUES(?,'lottery')", id);
    return id;
  };
  return { store, density, add };
}

const total = result => result.bins.reduce((sum, value) => sum + value, 0);
async function ready(density, session = 'one', options = {}) {
  for (let i = 0; i < 1000; i++) {
    const result = density.request(session, options);
    assert.notEqual(result.status, 'error', result.error);
    if (result.status === 'ready') return result;
    await yieldTurn();
  }
  assert.fail('Density did not finish its bounded history scan');
}

test('high frequency ordinary copies collapse, explicit lottery and non-chat types stay excluded', async t => {
  const { store, density, add } = fixture(t);
  store.transaction(() => {
    for (let i = 0; i < 720; i++) add(i < 600 ? 70 + i / 100 : 200 + i / 1000);
    for (let i = 0; i < 240; i++) add(130 + i / 100, { lottery: true });
    for (const type of ['gift', 'guard', 'sc']) add(71, { type });
  });
  const result = await ready(density, 'one', { from: 0, to: 600, bins: 600 });
  assert.equal(total(result), 2);
  assert.equal(total(await ready(density, 'one', { from: 70, to: 80, bins: 1000 })), 1);
  assert.equal(result.bins[130], 0);
  assert.ok(result.bins.every(Number.isInteger));
  store.saveEdit('one', { ...store.edit('one'), filterLottery: false });
  assert.equal(total(await ready(density)), 2);
});

test('history backfill yields after finite row batches including excluded types', async t => {
  const { store, density, add } = fixture(t, { batchSize: 3 });
  for (let i = 0; i < 4; i++) add(1, { type: 'gift' });
  for (let i = 0; i < 7; i++) add(1,{text:'普通弹幕'+i});
  await store.chatRules.prepare('one');
  const first = density.request('one', { from: 0, to: 10 });
  assert.equal(first.status, 'building');
  assert.equal(total(first), 0);
  await yieldTurn();
  assert.equal(density.cache.get('one').cursor, 3);
  assert.equal(total(density.request('one', { from: 0, to: 10 })), 0);
  await yieldTurn();
  assert.equal(density.cache.get('one').cursor, 6);
  assert.equal(total(await ready(density, 'one', { from: 0, to: 10 })), 7);
});

test('rowid watermark includes current arrivals and late XML messages with earlier times', async t => {
  const { density, add } = fixture(t, { batchSize: 2 });
  add(400.9);
  assert.equal(total(await ready(density)), 1);
  const cached = density.cache.get('one');
  add(10.4);
  add(501.2);
  add(10.9);
  const result = await ready(density, 'one', { from: 0, to: 600, bins: 600 });
  assert.equal(density.cache.get('one'), cached);
  assert.equal(result.bins[10], 2);
  assert.equal(result.bins[400], 1);
  assert.equal(result.bins[501], 1);
  assert.equal(total(result), 4);
});

test('manual deletion and undo rebuild counts without double excluding lottery or rewriting raw data', async t => {
  const { store, density, add } = fixture(t);
  const normal = add(8), lottery = add(8, { lottery: true });
  add(8);
  assert.equal(total(await ready(density)), 2);
  store.saveEdit('one', { ...store.edit('one'), excluded: [normal, lottery] });
  assert.equal(total(await ready(density)), 1);
  store.saveEdit('one', { ...store.edit('one'), filterLottery: false });
  assert.equal(total(await ready(density)), 1);
  store.saveEdit('one', { ...store.edit('one'), excluded: [] });
  assert.equal(total(await ready(density)), 2);
  store.saveEdit('one', { ...store.edit('one'), filterLottery: true });
  assert.equal(total(await ready(density)), 2);
  assert.equal(store.get('SELECT count(*) AS n FROM danmaku').n, 3);
});

test('range edits retain ready history while new lottery flags explicitly invalidate it', async t => {
  const { store, density, add } = fixture(t);
  const id = add(8);
  add(9);
  await ready(density);
  const histogram = density.cache.get('one').histogram;
  store.saveEdit('one', { ...store.edit('one'), ranges: [{ start: 1, end: 5, selected: true }] });
  const unchanged = density.request('one');
  assert.equal(unchanged.status, 'ready');
  assert.equal(density.cache.get('one').histogram, histogram);
  store.run("INSERT INTO danmaku_filters VALUES(?,'lottery')", id);
  density.invalidate('one');
  assert.equal(total(await ready(density)), 1);
  store.run('DELETE FROM danmaku_filters WHERE message=?', id);
  density.invalidate('one');
  assert.equal(total(await ready(density)), 2);
});

test('one-second half-open buckets align windows, cap bin counts, and handle block boundaries', async t => {
  const { density, add } = fixture(t);
  for (const time of [0, 0.999, 1, 120, 255.999, 256, 511.999, 512, 1024]) add(time);
  const result = await ready(density, 'one', { from: 0, to: 120, bins: 1000 });
  assert.deepEqual([result.from, result.to, result.step, result.bins.length], [0, 120, 1, 120]);
  assert.equal(result.bins[0], 2);
  assert.equal(result.bins[1], 1);
  assert.equal(total(result), 3);
  const window = density.request('one', { from: 255.2, to: 512.3, bins: 2 });
  assert.deepEqual([window.from, window.to, window.step, window.bins.length], [255, 513, 129, 2]);
  assert.deepEqual(window.bins, [2, 2]);
  assert.deepEqual(density.request('one', { from: 0, to: 1280, bins: 5 }).bins, [5, 2, 1, 0, 1]);
  assert.equal(density.request('one', { from: 0, to: 10001, bins: 50000 }).bins.length <= 1000, true);
  assert.equal(total(density.request('one', { from: 0, to: 1e12, bins: 1 })), 9);
  assert.deepEqual(density.request('one', { from: 0, to: 0 }).bins, []);
  for (const options of [{ from: -1 }, { to: NaN }, { to: Infinity }, { from: 2, to: 1 }, { bins: 0 }]) {
    assert.throws(() => density.request('one', options), error => error.status === 400);
  }
});

test('LRU bounds session caches and canceled backfills never reinsert evicted or deleted sessions', async t => {
  const { store, density, add } = fixture(t, { batchSize: 1, maxSessions: 2 });
  for (const id of ['two', 'three']) store.createSession({ id, status: 'complete' });
  for (let i = 0; i < 5; i++) for (const session of ['one', 'two', 'three']) add(1, { session });
  density.request('one');
  density.request('two');
  density.request('one');
  density.request('three');
  assert.deepEqual([...density.cache.keys()], ['one', 'three']);
  density.drop('one');
  await yieldTurn();
  assert.equal(density.cache.has('one'), false);
  assert.equal(density.cache.has('two'), false);
  store.run("UPDATE sessions SET deleted_at='deleted' WHERE id='three'");
  await yieldTurn();
  assert.equal(density.cache.has('three'), false);
  assert.throws(() => density.request('three'), error => error.status === 404);
});

test('close cancels pending database work and scan failures remain observable and retryable', async t => {
  const { store, density, add } = fixture(t, { batchSize: 1 });
  add(1);
  const originalAll = store.all.bind(store);
  store.all = () => { throw new Error('simulated database failure'); };
  density.request('one');
  await yieldTurn();
  assert.equal(density.cache.get('one').status, 'error');
  assert.equal(density.cache.get('one').error, 'simulated database failure');
  store.all = originalAll;
  const error = density.request('one');
  assert.equal(error.status, 'error');
  assert.equal(error.error, 'simulated database failure');
  await yieldTurn();
  assert.equal(total(await ready(density)), 1);
  add(2);
  density.request('one');
  density.close();
  store.all = () => { assert.fail('closed density must not query the database'); };
  await yieldTurn();
  assert.equal(density.cache.size, 0);
  assert.throws(() => density.request('one'), error => error.status === 503);
  store.all = originalAll;
});

test('sampling keeps uncapped peaks without double counting or losing manual exclusions', async t => {
  const {store,density,add}=fixture(t,{batchSize:7});
  const source=store.addSource('one',path.join(store.root,'originals','sample.flv'),0);
  const ids=[];
  for(let i=0;i<50;i++)ids.push(add(8+i/1000,{text:'普通弹幕'+i}));
  store.run('INSERT INTO danmaku_density VALUES(?,?,?,?)','one',source.id,8,9950);
  let result=await ready(density,'one',{from:0,to:10,bins:10});
  assert.equal(result.bins[8],10000);
  assert.equal(total(await ready(density,'one',{from:0,to:10,bins:10})),10000);
  store.saveEdit('one',{...store.edit('one'),excluded:[ids[0]]});
  result=await ready(density,'one',{from:0,to:10,bins:10});
  assert.equal(result.bins[8],9999);
  store.saveEdit('one',{...store.edit('one'),excluded:[]});
  assert.equal(total(await ready(density,'one',{from:0,to:10,bins:10})),10000);
});

test('density counters append independently after cached messages and respect bounded batches', async t => {
  const {store,density,add}=fixture(t,{batchSize:2});
  const source=store.addSource('one',path.join(store.root,'originals','sample.flv'),0);
  add(1); assert.equal(total(await ready(density)),1);
  const entry=density.cache.get('one');
  for(let i=0;i<5;i++)store.run('INSERT INTO danmaku_density VALUES(?,?,?,?)','one',source.id,i,1000);
  assert.equal(density.request('one').status,'building');
  await yieldTurn(); assert.equal(entry.densityCursor,2);
  assert.equal(total(await ready(density)),5001);
  assert.equal(density.cache.get('one'),entry);
  density.drop('one');
  assert.equal(total(await ready(density)),5001);
});
