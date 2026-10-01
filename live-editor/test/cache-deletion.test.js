import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { RenderCache } from '../server/render-cache.js';
import { acquireReader, sourceReaderCount } from '../server/storage-files.js';
import { minimalMp4 } from './helpers/mp4-fixture.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-cache-deletion-test-'));
const stores = new Set(), caches = new Set(), leases = new Set();
const check = (name, fn) => test(name, { timeout: 8000 }, fn);
const digest = value => createHash('sha256').update(value).digest('hex');
const missing = file => assert.rejects(fs.access(file), error => error.code === 'ENOENT');
const hashFile = async file => digest(await fs.readFile(file));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function write(file, content) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); return file; }
async function size(files) { return (await Promise.all(files.map(file => fs.stat(file)))).reduce((total, stat) => total + stat.size, 0); }
async function setup(name) {
  const store = new Store(path.join(root, name, 'data')); stores.add(store);
  const session = store.createSession({ title: name, status: 'finished' });
  store.run('UPDATE sessions SET duration=120 WHERE id=?', session.id);
  const original = await write(path.join(store.root, 'originals', 'room', 'source.flv'), 'original video bytes');
  const xml = await write(original.replace(/\.flv$/, '.xml'), '<i>original chat</i>');
  const source = store.addSource(session.id, original, 0, session.created, true);
  store.run('UPDATE sources SET closed=2,duration=120 WHERE id=?', source.id);
  const chunk = await write(path.join(store.root, 'chunks', source.id, '00000000.flvpart'), 'indexed video bytes');
  store.run('INSERT INTO chunks VALUES(?,?,?,?,?,?)', source.id, 0, 0, 120, chunk, (await fs.stat(chunk)).size);
  store.run('INSERT INTO keyframes VALUES(?,?,?,?)', source.id, 0, 0, 0);
  const id = 'chat-' + randomUUID();
  store.run('INSERT INTO danmaku VALUES(?,?,?,?,?,?,?,?)', id, session.id, source.id, 1, 'viewer', 'chat', 'd', '16777215');
  store.saveEdit(session.id, { revision: 0, ranges: [{ start: 0, end: 1 }], excluded: [], undo: [] });
  const cache = new RenderCache(store.root, { statfs: async () => ({ bavail: 100 * 2 ** 30, bsize: 1 }) });
  caches.add(cache); store.renderCache = cache;
  const spec = { sessionId: session.id, sourceId: source.id, startMs: 0, endMs: 60000, sourceFingerprint: digest('source'), assHash: digest('ass'), profileHash: digest('60fps'), version: 1 };
  const cached = await cache.build(spec, file => fs.writeFile(file, minimalMp4), { estimatedBytes: minimalMp4.length }); leases.add(cached);
  const cacheFiles = [cached.file, path.join(path.dirname(cached.file), 'manifest.json'), path.join(path.dirname(cached.file), 'owner.json')];
  const calls = [];
  store.preparation = {
    async cancelSession(id) { calls.push(['cancel', id]); },
    async forgetSession(id) { assert.equal(store.get('SELECT id FROM sessions WHERE id=?', id),undefined); calls.push(['forget', id]); },
    allowSession(id) { calls.push(['allow', id]); },
  };
  return { store, cache, session, source, spec, cached, cacheFiles, original, xml, chunk, rawFiles: [original, xml, chunk], calls };
}

check('删除等待 preparation 真正停止并释放 source/cache lease，合并实际字节及文件数且保留导出和邻居', async t => {
  const f = await setup('wait-preparation'), stopped = deferred(), entered = deferred();
  const reader = acquireReader(f.store, f.source.id);
  t.after(() => { stopped.resolve(); reader.release(); f.cached.release(); });
  f.store.preparation.cancelSession = async id => {
    f.calls.push(['cancel', id]); entered.resolve(); await stopped.promise;
    reader.release(); f.cached.release(); f.calls.push(['stopped', id]);
  };
  const output = await write(path.join(f.store.root, 'exports', 'finished.mp4'), minimalMp4);
  const neighbor = await write(path.join(path.dirname(f.original), 'other.flv'), 'neighbor original');
  f.store.run('INSERT INTO jobs(id,session,status,mode,file,data) VALUES(?,?,?,?,?,?)', 'finished-export', f.session.id, 'done', 'clean', output, '{}');
  const protectedHashes = await Promise.all([output, neighbor].map(hashFile));
  const expectedBytes = await size([...f.rawFiles, ...f.cacheFiles]);
  const pending = f.store.deleteSession(f.session.id, true);
  await entered.promise;
  assert.equal(sourceReaderCount(f.store, f.source.id), 1);
  assert.throws(() => acquireReader(f.store, f.source.id), /删除/);
  for (const file of [...f.rawFiles, f.cached.file]) await fs.access(file);
  stopped.resolve();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.deletedFiles, 6);
  assert.equal(result.freedBytes, expectedBytes);
  for (const file of [...f.rawFiles, ...f.cacheFiles]) await missing(file);
  assert.deepEqual(await Promise.all([output, neighbor].map(hashFile)), protectedHashes);
  assert.equal(f.store.get('SELECT status FROM jobs WHERE id=?', 'finished-export').status, 'done');
  assert.deepEqual(f.calls.map(call => call[0]), ['cancel', 'stopped', 'forget', 'allow']);
  assert.equal(f.store.deletions.has(f.session.id), false);
  assert.equal(f.cache.blocked.has(f.session.id), false);
});

check('cache producer 收到取消但未结束时不删除原片，真正结束释放 source lease 后才完成删除', async t => {
  const f = await setup('wait-producer'), entered = deferred(), aborted = deferred(), finish = deferred();
  f.cached.release();
  t.after(() => finish.resolve());
  const spec = { ...f.spec, startMs: 60000, endMs: 120000 };
  const producer = f.cache.build(spec, async (file, { signal }) => {
    const reader = acquireReader(f.store, f.source.id);
    try { signal.addEventListener('abort', () => aborted.resolve(), { once: true }); entered.resolve(); await finish.promise; await fs.writeFile(file, minimalMp4); }
    finally { reader.release(); }
  }).then(lease => ({ lease }), error => ({ error }));
  await entered.promise;
  let done = false;
  const pending = f.store.deleteSession(f.session.id, true).then(result => { done = true; return result; });
  await aborted.promise;
  assert.equal(done, false);
  assert.equal(sourceReaderCount(f.store, f.source.id), 1);
  for (const file of f.rawFiles) await fs.access(file);
  finish.resolve();
  assert.equal((await producer).error?.code, 'PREP_CANCELLED');
  assert.equal((await pending).ok, true);
  for (const file of [...f.rawFiles, f.cached.file]) await missing(file);
  assert.deepEqual(f.calls.map(call => call[0]), ['cancel', 'forget', 'allow']);
});

check('缓存目录含未知文件时保留持久清理清单，不误报完全成功', async () => {
  const f = await setup('unknown-cache'); f.cached.release();
  const unknown = await write(path.join(path.dirname(f.cached.file), 'user-notes.txt'), 'must stay');
  const result = await f.store.deleteSession(f.session.id, true);
  assert.equal(result.ok, false); assert.equal(result.pending,true);
  assert.ok(result.preserved.some(entry => entry.path === path.dirname(f.cached.file)));
  assert.match(result.message, /清理未完成/);
  assert.equal(await fs.readFile(unknown, 'utf8'), 'must stay');
  for (const file of f.cacheFiles) await fs.access(file);
  for (const file of f.rawFiles) await missing(file);
  assert.ok(f.store.pendingCleanup()[0].purge_started_at);
  assert.deepEqual(f.calls.map(call => call[0]), ['cancel', 'allow']);
});

check('仅 ctime 属性变化仍随素材删除缓存，保留成片；缓存命中检查不因此放宽', async t => {
  const f = await setup('metadata-only-change'); f.cached.release();
  const output = await write(path.join(f.store.root, 'exports', 'keep.mp4'), minimalMp4);
  f.store.run('INSERT INTO jobs(id,session,status,mode,file,data) VALUES(?,?,?,?,?,?)', 'keep-export', f.session.id, 'done', 'clean', output, '{}');
  const originalLstat = fs.lstat;
  const cachePaths = new Set(f.cacheFiles.map(file => path.resolve(file).toLowerCase()));
  const mock = t.mock.method(fs, 'lstat', async function(file, ...args) {
    const stat = await originalLstat.call(this, file, ...args);
    if (typeof stat.ctimeNs === 'bigint' && cachePaths.has(path.resolve(file).toLowerCase())) stat.ctimeNs += 1000000n;
    return stat;
  });
  try {
    assert.equal(await f.cache.acquire(f.spec), null, 'metadata changes must not silently make a cache hit');
    const result = await f.store.deleteSession(f.session.id, true);
    assert.equal(result.preserved.length, 0);
    assert.equal(result.deletedFiles, 6);
  } finally { mock.mock.restore(); }
  for (const file of [...f.rawFiles, ...f.cacheFiles]) await missing(file);
  assert.equal(await hashFile(output), digest(minimalMp4));
});

check('未 confirmed、录制中、未封口或活动/待保存导出一律先拒绝，不触碰 cancellation hooks', async () => {
  const f = await setup('rejected'); f.cached.release();
  for (const confirmed of [undefined, false, 'true', 1]) await assert.rejects(f.store.deleteSession(f.session.id, confirmed));
  for (const status of ['recording', 'finishing']) {
    f.store.run('UPDATE sessions SET status=? WHERE id=?', status, f.session.id);
    await assert.rejects(f.store.deleteSession(f.session.id, true));
  }
  f.store.run("UPDATE sessions SET status='finished' WHERE id=?", f.session.id);
  f.store.run('UPDATE sources SET closed=1 WHERE id=?', f.source.id);
  await assert.rejects(f.store.deleteSession(f.session.id, true));
  f.store.run('UPDATE sources SET closed=2 WHERE id=?', f.source.id);
  for (const status of ['queued', 'running', 'saving', 'finalizing', 'save_failed']) {
    f.store.run('INSERT OR REPLACE INTO jobs(id,session,status,mode,data) VALUES(?,?,?,?,?)', 'busy-export', f.session.id, status, 'clean', '{}');
    await assert.rejects(f.store.deleteSession(f.session.id, true));
  }
  assert.deepEqual(f.calls, []);
  assert.equal(f.cache.blocked.has(f.session.id), false);
  for (const file of [...f.rawFiles, ...f.cacheFiles]) await fs.access(file);
});

check('物理 unlink 失败时 finally 恢复 preparation/cache allow，不 forget 且保留缓存和重试状态', async t => {
  const f = await setup('physical-failure'); f.cached.release();
  const originalUnlink = fs.unlink;
  const mock = t.mock.method(fs, 'unlink', async file => {
    if (file === f.original) throw Object.assign(new Error('locked original'), { code: 'EPERM' });
    return originalUnlink(file);
  });
  try { await assert.rejects(f.store.deleteSession(f.session.id, true), /EPERM|删除/); }
  finally { mock.mock.restore(); }
  assert.deepEqual(f.calls.map(call => call[0]), ['cancel', 'allow']);
  assert.equal(f.cache.blocked.has(f.session.id), false);
  assert.equal(f.store.deletions.has(f.session.id), false);
  const state = f.store.get('SELECT * FROM sessions WHERE id=?', f.session.id);
  assert.ok(state.purge_started_at); assert.ok(state.purge_error); assert.equal(state.purged_at, '');
  const hit = await f.cache.acquire(f.spec); assert.ok(hit); hit.release();
  for (const file of [...f.rawFiles, ...f.cacheFiles]) await fs.access(file);
});

check('DB 清理事务失败不得 forget preparation，缓存虽已清理仍必须执行 allow', async t => {
  const f = await setup('db-failure'); f.cached.release();
  const originalRun = f.store.run;
  const mock = t.mock.method(f.store, 'run', function (sql, ...args) {
    if (sql === 'DELETE FROM edits WHERE session=?') throw new Error('simulated DB cleanup failure');
    return originalRun.call(this, sql, ...args);
  });
  try { await assert.rejects(f.store.deleteSession(f.session.id, true), /simulated DB cleanup failure/); }
  finally { mock.mock.restore(); }
  assert.deepEqual(f.calls.map(call => call[0]), ['cancel', 'allow']);
  assert.equal(f.cache.blocked.has(f.session.id), false);
  assert.equal(f.store.deletions.has(f.session.id), false);
  assert.equal(f.store.get('SELECT purged_at FROM sessions WHERE id=?', f.session.id).purged_at, '');
  assert.ok(f.store.get('SELECT session FROM edits WHERE session=?', f.session.id));
  for (const file of [...f.rawFiles, ...f.cacheFiles]) await missing(file);
});

check('preparation 取消异常或仍有未释放 source reader 时安全拒绝，原片保留且 finally allow', async () => {
  const failing = await setup('preparation-error'); failing.cached.release();
  failing.store.preparation.cancelSession = async id => { failing.calls.push(['cancel', id]); throw new Error('stop failed'); };
  await assert.rejects(failing.store.deleteSession(failing.session.id, true), /stop failed/);
  assert.deepEqual(failing.calls.map(call => call[0]), ['cancel', 'allow']);
  for (const file of [...failing.rawFiles, ...failing.cacheFiles]) await fs.access(file);
  const reading = await setup('unreleased-reader'); reading.cached.release();
  const reader = acquireReader(reading.store, reading.source.id);
  try { await assert.rejects(reading.store.deleteSession(reading.session.id, true), /读取|整理/); }
  finally { reader.release(); }
  assert.deepEqual(reading.calls.map(call => call[0]), ['cancel', 'allow']);
  assert.equal(reading.cache.blocked.has(reading.session.id), false);
  for (const file of [...reading.rawFiles, ...reading.cacheFiles]) await fs.access(file);
});

check('缓存视频已缺失时仍可删除匹配 metadata，计数只包含实际删除的文件', async () => {
  const f = await setup('missing-cache-video'); f.cached.release();
  const metadata = f.cacheFiles.slice(1), bytes = await size(metadata);
  await fs.unlink(f.cached.file);
  const result = await f.cache.removeSession(f.session.id);
  assert.equal(result.deletedFiles, 2);
  assert.equal(result.freedBytes, bytes);
  for (const file of f.cacheFiles) await missing(file);
  for (const file of f.rawFiles) await fs.access(file);
});

check('缓存部分 unlink 失败返回已释放字节和 preserved，重试只统计剩余 metadata', async t => {
  const f = await setup('partial-cache-unlink'); f.cached.release();
  const manifest = f.cacheFiles[1], metadataBytes = await size(f.cacheFiles.slice(1));
  const originalUnlink = fs.unlink;
  const mock = t.mock.method(fs, 'unlink', async file => {
    if (file === manifest) throw Object.assign(new Error('locked manifest'), { code: 'EPERM' });
    return originalUnlink(file);
  });
  let partial;
  try { partial = await f.cache.removeSession(f.session.id); }
  finally { mock.mock.restore(); }
  assert.equal(partial.deletedFiles, 1);
  assert.equal(partial.freedBytes, minimalMp4.length);
  assert.ok(partial.preserved.length > 0);
  await missing(f.cached.file);
  const retried = await f.cache.removeSession(f.session.id);
  assert.equal(retried.deletedFiles, 2);
  assert.equal(retried.freedBytes, metadataBytes);
  for (const file of f.cacheFiles) await missing(file);
});

check('cache 根被 junction 替换时 removeSession 返回 preserved，Store 删除不穿透缓存链接', async () => {
  const f = await setup('unsafe-cache-root'); f.cached.release();
  const actual = path.join(root, 'moved-cache-' + randomUUID());
  await fs.rename(f.cache.root, actual);
  await fs.symlink(actual, f.cache.root, process.platform === 'win32' ? 'junction' : 'dir');
  const preservedVideo = path.join(actual, path.relative(f.cache.root, f.cached.file));
  const direct = await f.cache.removeSession(f.session.id);
  assert.equal(direct.deletedFiles, 0); assert.equal(direct.freedBytes, 0); assert.ok(direct.preserved.length > 0);
  f.cache.allowSession(f.session.id);
  const result = await f.store.deleteSession(f.session.id, true);
  assert.equal(result.pending, true); assert.ok(result.preserved.length > 0);
  assert.equal(await hashFile(preservedVideo), digest(minimalMp4));
  for (const file of f.rawFiles) await missing(file);
  assert.deepEqual(f.calls.map(call => call[0]), ['cancel', 'allow']);
});

test.after(async () => {
  for (const lease of leases) try { lease.release(); } catch {}
  for (const cache of caches) await cache.close();
  for (const store of stores) try { store.close(); } catch {}
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('bili-cache-deletion-test-')) throw new Error('Unexpected cache-deletion test root');
  await fs.rm(root, { recursive: true, force: true });
});
