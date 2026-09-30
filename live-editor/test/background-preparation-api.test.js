import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { Store } from '../server/store.js';
import { Media } from '../server/media.js';
import { createApp } from '../server/index.js';
import { FLV_HEADER } from '../server/ingest.js';
import { minimalMp4 } from './helpers/mp4-fixture.js';

// These integration tests use the real HTTP controller and scheduler, with a
// fake block producer. No recorder, FFmpeg, production database or port is used.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-preparation-api-'));
const complete = { done: true, preparedSeconds: 120, totalSeconds: 120, bytes: 4096 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function eventually(check, message) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(10); }
  assert.fail(message);
}
async function waitFor(promise, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 4000); })]); }
  finally { clearTimeout(timer); }
}
async function seedSource(store, id, status = 'finished') {
  const session = store.createSession({ id, title: id, status, created: '2026-09-01T00:00:00Z' });
  const original = path.join(store.root, 'originals', id + '.flv');
  await fs.mkdir(path.dirname(original), { recursive: true }); await fs.writeFile(original, FLV_HEADER);
  const source = store.addSource(id, original, 0, session.created, true);
  store.run('UPDATE sessions SET duration=120 WHERE id=?', id);
  store.run('UPDATE sources SET closed=?,duration=120 WHERE id=?', status === 'finished' ? 2 : 0, source.id);
  store.run('INSERT INTO keyframes VALUES(?,?,?,?)', source.id, 0, 0, 0);
  store.setting('metadata:' + source.id, { metadataVersion: 2, width: 16, height: 16, fps: 30, codec: 'h264' });
  return { session, source, original };
}
async function seedDatabase(name, setup) {
  const store = new Store(path.join(root, name, 'data'));
  try { return await setup(store); } finally { store.close(); }
}
async function appFor(t, name, prepare = async () => complete) {
  const calls = [];
  t.mock.method(Media.prototype, 'prepareNext', async function (id, options) { calls.push(id); return prepare(id, options, this); });
  const base = path.join(root, name);
  const app = await createApp({automaticClean:false, port: await availablePort(), data: path.join(base, 'data'), projectRoot: base, noRecorder: true, compact: false, ffmpeg: 'must-not-launch', ffprobe: 'must-not-launch', preparationOptions: { pollMs: 10, idleGraceMs: 0 } });
  app.ingestor.stop();
  let closed = false;
  const close = app.close.bind(app);
  app.close = async () => { if (!closed) { closed = true; await close(); } };
  t.after(() => app.close());
  app.calls = calls;
  app.request = async (route, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/${route}`, body === undefined ? { headers, signal: AbortSignal.timeout(5000) } : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  return app;
}
const preparation = (app, id) => app.snapshot().preparation.items.find(item => item.session === id);
const ready = (app, id) => eventually(() => preparation(app, id)?.status === 'ready', `${id} did not become ready: ${JSON.stringify(app.snapshot().preparation)}`);
const action = (app, id, value) => app.request(`sessions/${id}/preparation`, { action: value });
function heldProducer() {
  const entered = deferred(), aborted = deferred(), release = deferred(); let first = true, wasAborted = false;
  return { entered, aborted, release, get wasAborted() { return wasAborted; }, async prepare(id, { signal }) {
    if (!first) return complete;
    first = false; entered.resolve(id);
    const abort = () => { wasAborted = true; aborted.resolve(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) abort();
      await release.promise;
      if (signal.aborted) throw Object.assign(new Error('test preparation cancelled'), { code: 'PREP_CANCELLED' });
      return complete;
    } finally { signal.removeEventListener('abort', abort); }
  } };
}

test('首次启动不批量处理旧素材，只自动处理观察到完成及后来新增的素材', async t => {
  await seedDatabase('automatic', async store => { await seedSource(store, 'old-finished'); await seedSource(store, 'live-at-start', 'recording'); });
  const app = await appFor(t, 'automatic');
  const state = await app.request('state');
  assert.equal(state.status, 200); assert.equal(state.body.preparation.enabled, true);
  await delay(80);
  assert.equal(app.calls.length, 0);
  app.store.run("UPDATE sessions SET status='finished' WHERE id='live-at-start'");
  app.store.run("UPDATE sources SET closed=2 WHERE session='live-at-start'");
  app.preparation.wake(); await ready(app, 'live-at-start');
  await seedSource(app.store, 'imported-after-start'); app.preparation.wake(); await ready(app, 'imported-after-start');
  assert.deepEqual(new Set(app.calls), new Set(['live-at-start', 'imported-after-start']));
  assert.equal(preparation(app, 'old-finished'), undefined);
  assert.equal(app.store.all('SELECT * FROM jobs').length, 0, 'preparation must not create user exports');
  assert.deepEqual(await fs.readFile(path.join(app.store.root, 'originals', 'old-finished.flv')), FLV_HEADER);
});

test('HTTP 全局开关、显式开始和暂停/继续相互独立，非法或跨站请求不改变状态', async t => {
  await seedDatabase('controls', async store => { await seedSource(store, 'manual'); await seedSource(store, 'explicit-pause'); });
  const app = await appFor(t, 'controls');
  assert.equal((await app.request('preparation/settings', { enabled: false })).status, 200);
  assert.equal(app.store.setting('backgroundPreparationEnabled'), false);
  for (const id of ['manual', 'explicit-pause']) assert.equal((await action(app, id, 'start')).status, 200);
  assert.equal((await action(app, 'explicit-pause', 'pause')).status, 200);
  await delay(80); assert.equal(app.calls.length, 0);
  assert.equal(preparation(app, 'explicit-pause').status, 'paused');
  for (const invalid of [null, 1, 'true']) assert.ok((await app.request('preparation/settings', { enabled: invalid })).status >= 400);
  assert.ok((await action(app, 'manual', 'invalid')).status >= 400);
  assert.ok((await action(app, 'missing', 'start')).status >= 400);
  assert.equal((await app.request('preparation/settings', { enabled: true }, { Origin: 'https://example.invalid' })).status, 403);
  assert.equal(app.snapshot().preparation.enabled, false);
  await app.request('preparation/settings', { enabled: true }); await ready(app, 'manual');
  assert.equal(preparation(app, 'explicit-pause').status, 'paused'); assert.ok(!app.calls.includes('explicit-pause'));
  await action(app, 'explicit-pause', 'resume'); await ready(app, 'explicit-pause');
  const snapshot = (await app.request('state')).body.preparation;
  for (const item of snapshot.items) for (const field of ['session', 'status', 'preparedSeconds', 'totalSeconds', 'bytes', 'reason', 'error']) assert.ok(Object.hasOwn(item, field), field);
  assert.equal(app.media.children.size, 0);
});

test('HTTP 保存弹幕编辑会使已就绪素材重新准备，显式暂停时编辑保持暂停且不触碰导出任务', async t => {
  await seedDatabase('edit', async store => {
    await seedSource(store, 'edited');
    store.run("INSERT INTO danmaku VALUES('chat','edited',NULL,1,'观众','测试弹幕','d','16777215')");
    for (const status of ['cancelled', 'canceled', 'failed']) store.run('INSERT INTO jobs(id,session,status,data) VALUES(?,?,?,?)', 'export-' + status, 'edited', status, '{}');
  });
  const app = await appFor(t, 'edit');
  const jobs = app.store.all('SELECT * FROM jobs ORDER BY id');
  const invalidated = [];
  t.mock.method(app.media, 'invalidatePreparation', id => { invalidated.push(id); });
  await action(app, 'edited', 'start'); await ready(app, 'edited');
  const before = app.calls.length;
  const edit = app.store.edit('edited');
  const saved = await app.request('sessions/edited/edit', { ...edit, excluded: ['chat'] });
  assert.equal(saved.status, 200);
  await eventually(() => app.calls.length > before && preparation(app, 'edited')?.status === 'ready', 'edit was not requeued');
  assert.ok(invalidated.includes('edited')); assert.deepEqual(app.store.edit('edited').excluded, ['chat']);
  await action(app, 'edited', 'pause'); const pausedCalls = app.calls.length;
  const pausedEdit = await app.request('sessions/edited/edit', { ...app.store.edit('edited'), excluded: [], filterLottery: false });
  assert.equal(pausedEdit.status, 200); assert.deepEqual(app.store.edit('edited').excluded, []); assert.equal(app.store.edit('edited').filterLottery, true);
  await delay(80);
  assert.equal(app.calls.length, pausedCalls); assert.equal(preparation(app, 'edited').status, 'paused');
  await action(app, 'edited', 'resume'); await ready(app, 'edited');
  assert.deepEqual(app.store.all('SELECT * FROM jobs ORDER BY id'), jobs);
});

test('录制或前台导出忙时后台等待，空闲后才准备素材', async t => {
  await seedDatabase('busy', async store => { await seedSource(store, 'target'); });
  const app = await appFor(t, 'busy');
  app.media.processing = true;
  try {
    await action(app, 'target', 'start'); await delay(80);
    assert.equal(app.calls.length, 0); assert.equal(preparation(app, 'target').status, 'waiting');
  } finally { app.media.processing = false; }
  await seedSource(app.store, 'recording', 'recording'); app.preparation.wake(); await delay(80);
  assert.equal(app.calls.length, 0);
  app.store.run("UPDATE sessions SET status='finished' WHERE id='recording'");
  app.store.run("UPDATE sources SET closed=2 WHERE session='recording'");
  app.preparation.wake(); await ready(app, 'target');
  assert.ok(app.calls.includes('target'));
});

test('前台播放等待后台编码取消完成后才读取视频，避免两路同时占用处理资源', async t => {
  await seedDatabase('foreground', store => seedSource(store, 'previewed'));
  const held = heldProducer();
  t.after(() => held.release.resolve());
  const app = await appFor(t, 'foreground', held.prepare);
  let foregroundStarted = false;
  t.mock.method(app.media, 'process', async (_args, options) => { foregroundStarted = true; options.output.end(minimalMp4); });
  await action(app, 'previewed', 'start'); await waitFor(held.entered.promise, 'background did not start');
  const response = fetch(`http://127.0.0.1:${app.port}/api/sessions/previewed/preview?start=0`, { signal: AbortSignal.timeout(5000) });
  try {
    await waitFor(held.aborted.promise, 'foreground did not cancel background');
    assert.equal(foregroundStarted, false);
    await delay(25); assert.equal(foregroundStarted, false);
  } finally { held.release.resolve(); }
  const rendered = await response;
  assert.equal(rendered.status, 200); assert.deepEqual(Buffer.from(await rendered.arrayBuffer()), minimalMp4);
  assert.equal(foregroundStarted, true); assert.equal(app.media.children.size, 0);
});

test('删除素材先取消并等待后台处理退出，等待期间原片仍存在', async t => {
  const fixture = await seedDatabase('delete', store => seedSource(store, 'deleted'));
  const held = heldProducer();
  t.after(() => held.release.resolve());
  const app = await appFor(t, 'delete', held.prepare);
  await action(app, 'deleted', 'start'); await waitFor(held.entered.promise, 'background did not start');
  let returned = false;
  const response = app.request('sessions/deleted/delete', { confirmed: true }).then(result => { returned = true; return result; });
  try {
    await waitFor(held.aborted.promise, 'deletion did not cancel background');
    // Give asynchronous path validation and unlink work enough event-loop
    // turns to expose a cancel-without-await regression while the producer stays held.
    await delay(80);
    assert.equal(returned, false); assert.ok(app.store.session('deleted'));
    assert.deepEqual(await fs.readFile(fixture.original), FLV_HEADER);
  } finally { held.release.resolve(); }
  const deleted = await response;
  assert.equal(deleted.status, 200, deleted.body.error); assert.equal(deleted.body.ok, true);
  assert.equal(app.store.session('deleted'), undefined);
  await assert.rejects(fs.access(fixture.original), error => error.code === 'ENOENT');
  await delay(40); assert.equal(app.calls.filter(id => id === 'deleted').length, 1);
});

test('状态读取、已缓存波形和仅修改选段不打断正在准备的后台块', async t => {
  const fixture = await seedDatabase('read-only', store => seedSource(store, 'reading'));
  const held = heldProducer(); t.after(() => held.release.resolve());
  const app = await appFor(t, 'read-only', held.prepare);
  app.store.run('INSERT INTO waveform_blocks(source,block,signature,covered,state,data) VALUES(?,?,?,?,?,?)', fixture.source.id, 0, JSON.stringify([1, 0, '']), 30, 'no_audio', Buffer.alloc(1500));
  const invalidations = [];
  t.mock.method(app.media, 'invalidatePreparation', id => invalidations.push(id));
  await action(app, 'reading', 'start'); await waitFor(held.entered.promise, 'background did not start');
  try {
    for (let index = 0; index < 3; index++) {
      assert.equal((await app.request('state')).status, 200);
      const signals = await app.request('sessions/reading/signals?from=0&to=30&bins=30');
      assert.equal(signals.status, 200); assert.equal(signals.body.audio.status, 'no_audio');
    }
    const saved = await app.request('sessions/reading/edit', { ...app.store.edit('reading'), ranges: [{ start: 2, end: 8 }] });
    assert.equal(saved.status, 200);
    await delay(40);
    assert.equal(held.wasAborted, false); assert.deepEqual(invalidations, []); assert.equal(app.calls.length, 1);
  } finally { held.release.resolve(); }
  await ready(app, 'reading');
});

test('后台准备中的真实进程退出后恢复队列，显式暂停与已取消的用户导出保持不变', async t => {
  const name = 'restart', base = path.join(root, name), data = path.join(base, 'data');
  await seedDatabase(name, async store => {
    await seedSource(store, 'interrupted'); await seedSource(store, 'paused');
    store.setting('backgroundPreparationEnabled', false);
    store.run("INSERT INTO jobs(id,session,status,data) VALUES('cancelled-export','interrupted','cancelled','{}')");
  });
  const child = `
    import { createApp } from ${JSON.stringify(new URL('../server/index.js', import.meta.url).href)};
    import { Media } from ${JSON.stringify(new URL('../server/media.js', import.meta.url).href)};
    import net from 'node:net';
    ${availablePort.toString()}
    Media.prototype.prepareNext = async function(id) { process.stdout.write(JSON.stringify({id})); process.exit(0); };
    const app = await createApp({automaticClean:false,port:await availablePort(),data:${JSON.stringify(data)},projectRoot:${JSON.stringify(base)},noRecorder:true,compact:false,ffmpeg:'must-not-launch',ffprobe:'must-not-launch',preparationOptions:{pollMs:10,idleGraceMs:0}});
    app.ingestor.stop();
    await app.preparation.enqueue('interrupted'); await app.preparation.enqueue('paused'); await app.preparation.pause('paused');
    await app.preparation.setEnabled(true);
    setTimeout(()=>{throw new Error('fake preparation did not start')},4000);
  `;
  const interrupted = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', child], { windowsHide: true, encoding: 'utf8', timeout: 8000 }));
  assert.equal(interrupted.id, 'interrupted');
  const app = await appFor(t, name); await ready(app, 'interrupted');
  assert.equal(preparation(app, 'paused').status, 'paused'); assert.ok(!app.calls.includes('paused'));
  assert.equal(app.store.get("SELECT status FROM jobs WHERE id='cancelled-export'").status, 'cancelled');
  assert.equal(app.store.all('SELECT * FROM jobs').length, 1);
  await app.request('preparation/settings', { enabled: false }); await app.close();
  const restarted = await appFor(t, name);
  assert.equal(restarted.snapshot().preparation.enabled, false);
  assert.equal(preparation(restarted, 'paused').status, 'paused');
  await action(restarted, 'interrupted', 'resume'); await delay(80);
  assert.equal(restarted.calls.length, 0);
});

test.after(async () => {
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('bili-preparation-api-')) throw new Error('Unexpected preparation test cleanup directory');
  await fs.rm(root, { recursive: true, force: true });
});
