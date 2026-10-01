import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { RenderCache, renderCacheKey } from '../server/render-cache.js';
import { minimalMp4 } from './helpers/mp4-fixture.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-render-cache-test-'));
const GiB = 2 ** 30, held = new Set();
const check = (name, fn) => test(name, { timeout: 8000 }, fn);
const digest = value => createHash('sha256').update(value).digest('hex');
const hashFile = async file => digest(await fs.readFile(file));
const missing = file => assert.rejects(fs.access(file), error => error.code === 'ENOENT');
const cancelled = error => error?.code === 'PREP_CANCELLED' || error?.name === 'AbortError';
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function spec(overrides = {}) {
  return { sessionId: 'session-' + randomUUID(), sourceId: 'source-' + randomUUID(), startMs: 0, endMs: 60000, sourceFingerprint: digest('source'), profileHash: digest('profile-60fps'), assHash: digest('visible-ass'), version: 1, ...overrides };
}
function track(lease) { if (lease) held.add(lease); return lease; }
async function fixture(name, options = {}) {
  const data = path.join(root, name, 'data');
  await fs.mkdir(data, { recursive: true });
  const settings = { statfs: async () => ({ bavail: 100 * GiB, bsize: 1 }), ...options };
  return { data, cacheRoot: path.join(data, 'render-cache'), settings, cache: new RenderCache(data, settings) };
}
async function build(cache, key, options = {}) {
  return track(await cache.build(key, file => fs.writeFile(file, minimalMp4), { estimatedBytes: minimalMp4.length, ...options }));
}

check('已完成 MP4 才能命中，身份和字节保持一致，新的 RenderCache 实例可直接复用', async () => {
  const f = await fixture('restart'), key = spec();
  assert.equal(await f.cache.acquire(key), null);
  const created = await build(f.cache, key);
  assert.equal(created.bytes, minimalMp4.length);
  assert.equal(await hashFile(created.file), digest(minimalMp4));
  const relative = path.relative(f.cacheRoot, created.file);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.equal(path.basename(created.file), 'video.mp4');
  created.release();
  const restarted = new RenderCache(f.data, f.settings);
  const reused = track(await restarted.acquire({ ...key }));
  assert.ok(reused);
  assert.equal(reused.file, created.file);
  assert.equal(reused.bytes, minimalMp4.length);
  reused.release();
});

check('cache key 取决于实际输入、ASS、profile、时间块和版本，变化不能命中旧内容', async () => {
  const f = await fixture('keys'), key = spec();
  const original = await build(f.cache, key); original.release();
  assert.equal(f.cache.getKey(key), renderCacheKey(key));
  assert.equal(f.cache.getKey({ ...key }), f.cache.getKey(key));
  for (const patch of [{ sourceFingerprint: digest('changed-source') }, { assHash: digest('excluded-chat') }, { profileHash: digest('changed-style') }, { startMs: 60000, endMs: 120000 }, { sourceId: 'new-source' }]) {
    const changed = { ...key, ...patch };
    assert.notEqual(f.cache.getKey(changed), f.cache.getKey(key));
    assert.equal(await f.cache.acquire(changed), null);
  }
  const current = track(await f.cache.acquire(key)); assert.ok(current); current.release();
});

check('同 key 并发 build 只渲染一次，未完成时 miss，完成后每个调用方持独立 lease', async t => {
  const f = await fixture('dedupe'), key = spec(), entered = deferred(), finish = deferred();
  t.after(() => finish.resolve());
  let renders = 0;
  const producer = async file => { renders++; entered.resolve(); await finish.promise; await fs.writeFile(file, minimalMp4); };
  const first = f.cache.build(key, producer, { estimatedBytes: minimalMp4.length });
  await entered.promise;
  const second = f.cache.build({ ...key }, producer, { estimatedBytes: minimalMp4.length });
  assert.equal(await f.cache.acquire(key), null);
  finish.resolve();
  const [a, b] = (await Promise.all([first, second])).map(track);
  assert.equal(renders, 1);
  assert.equal(a.file, b.file);
  assert.notEqual(a, b);
  a.release(); a.release();
  let settled = false;
  const removal = f.cache.removeSession(key.sessionId).then(result => { settled = true; return result; });
  t.after(() => b.release());
  await nextTurn(); await nextTurn();
  assert.equal(settled, false);
  await fs.access(b.file);
  b.release();
  const result = await removal;
  assert.ok(result.deletedFiles >= 1);
  await missing(a.file);
});

check('外部 signal 取消后必须等 producer 真正结束，不提交半成品', async t => {
  const f = await fixture('abort'), key = spec(), entered = deferred(), finish = deferred(), controller = new AbortController();
  t.after(() => finish.resolve());
  let settled = false;
  const operation = f.cache.build(key, async file => {
    entered.resolve(); await finish.promise; await fs.writeFile(file, minimalMp4);
  }, { signal: controller.signal, estimatedBytes: minimalMp4.length }).then(lease => ({ lease }), error => ({ error })).then(value => { settled = true; return value; });
  await entered.promise; controller.abort();
  await nextTurn(); await nextTurn();
  assert.equal(settled, false);
  finish.resolve();
  const outcome = await operation;
  assert.ok(cancelled(outcome.error));
  assert.equal(await f.cache.acquire(key), null);
});

check('cancelSession 等待 producer 与现有 lease，block 幂等且 allow 一次可恢复', async t => {
  const f = await fixture('cancel-session'), firstKey = spec();
  const existing = await build(f.cache, firstKey);
  const secondKey = { ...firstKey, startMs: 60000, endMs: 120000 };
  const entered = deferred(), finish = deferred();
  t.after(() => { finish.resolve(); existing.release(); });
  let suppliedSignal;
  const producer = f.cache.build(secondKey, async (file, { signal }) => { suppliedSignal = signal; entered.resolve(); await finish.promise; await fs.writeFile(file, minimalMp4); }).then(lease => ({ lease }), error => ({ error }));
  await entered.promise;
  f.cache.blockSession(firstKey.sessionId); f.cache.blockSession(firstKey.sessionId);
  let settled = false;
  const cancellation = f.cache.cancelSession(firstKey.sessionId).then(value => { settled = true; return value; });
  assert.ok(suppliedSignal instanceof AbortSignal);
  assert.equal(suppliedSignal.aborted, true);
  await nextTurn(); assert.equal(settled, false);
  finish.resolve();
  assert.ok(cancelled((await producer).error));
  await nextTurn(); assert.equal(settled, false);
  await fs.access(existing.file);
  existing.release();
  await cancellation;
  f.cache.allowSession(firstKey.sessionId);
  const restored = track(await f.cache.acquire(firstKey)); assert.ok(restored); restored.release();
  const regenerated = await build(f.cache, secondKey); regenerated.release();
});

check('已取消 signal 和被 block 的 session 不启动 producer；verifySource=false 阻止提交', async () => {
  const f = await fixture('gates'), key = spec(), controller = new AbortController();
  controller.abort();
  let renders = 0;
  const producer = async file => { renders++; await fs.writeFile(file, minimalMp4); };
  await assert.rejects(f.cache.build(key, producer, { signal: controller.signal }), cancelled);
  f.cache.blockSession(key.sessionId);
  await assert.rejects(f.cache.build(key, producer), cancelled);
  assert.equal(renders, 0);
  f.cache.allowSession(key.sessionId);
  let verified = 0;
  await assert.rejects(f.cache.build(key, producer, { verifySource: async () => { verified++; return false; } }));
  assert.ok(verified > 0);
  assert.equal(await f.cache.acquire(key), null);
  const valid = await build(f.cache, key, { verifySource: async () => true }); valid.release();
});

check('未生成、零长度、截断或损坏 MP4 均不能建立可命中条目，producer 错误可安全重试', async () => {
  const f = await fixture('invalid-output');
  const producers = [async () => {}, file => fs.writeFile(file, ''), file => fs.writeFile(file, minimalMp4.subarray(0, 12)), file => fs.writeFile(file, 'not an mp4'), async () => { throw new Error('producer test failed'); }];
  for (const producer of producers) {
    const key = spec();
    await assert.rejects(f.cache.build(key, producer));
    assert.equal(await f.cache.acquire(key), null);
    const valid = await build(f.cache, key); valid.release();
  }
});

check('视频 inode、大小或 mtime 变化产生 miss，删除保留未知替代文件，新 build 使用不同 generation', async () => {
  const f = await fixture('changed-file');
  for (const kind of ['replacement', 'size', 'mtime']) {
    const key = spec(), old = await build(f.cache, key); old.release();
    if (kind === 'replacement') { await fs.rename(old.file, old.file + '.user-backup'); await fs.writeFile(old.file, minimalMp4); }
    if (kind === 'size') await fs.appendFile(old.file, 'changed');
    if (kind === 'mtime') { const stat = await fs.stat(old.file); await fs.utimes(old.file, stat.atime, new Date(stat.mtimeMs + 10000)); }
    const changed = await hashFile(old.file);
    assert.equal(await f.cache.acquire(key), null);
    const fresh = await build(f.cache, key);
    assert.notEqual(fresh.file, old.file);
    fresh.release();
    await f.cache.removeSession(key.sessionId);
    assert.equal(await hashFile(old.file), changed);
    await missing(fresh.file);
  }
});

check('manifest 被替换、篡改 spec 或结构损坏时 miss 且不删除视频与未知 manifest', async () => {
  const f = await fixture('changed-manifest');
  for (const invalid of ['json', 'spec', 'identity']) {
    const key = spec(), lease = await build(f.cache, key); lease.release();
    const manifest = path.join(path.dirname(lease.file), 'manifest.json');
    const value = JSON.parse(await fs.readFile(manifest, 'utf8'));
    let text;
    if (invalid === 'json') text = '{incomplete';
    else {
      if (invalid === 'spec') value.spec.sessionId = 'another-session';
      if (invalid === 'identity') value.fileIdentity.size = String(BigInt(value.fileIdentity.size) + 1n);
      text = JSON.stringify(value);
    }
    await fs.writeFile(manifest, text);
    assert.equal(await f.cache.acquire(key), null);
    await f.cache.removeSession(key.sessionId);
    assert.equal(await fs.readFile(manifest, 'utf8'), text);
    assert.equal(await hashFile(lease.file), digest(minimalMp4));
  }
});

check('缓存 hardlink 和文件 symlink 不能命中或被清理，不操作链接目标', async t => {
  const f = await fixture('links');
  for (const kind of ['hardlink', 'symlink']) {
    const key = spec(), lease = await build(f.cache, key); lease.release();
    const outside = path.join(root, 'outside-' + randomUUID() + '.mp4');
    if (kind === 'hardlink') await fs.link(lease.file, outside);
    else {
      await fs.writeFile(outside, minimalMp4); await fs.unlink(lease.file);
      try { await fs.symlink(outside, lease.file, 'file'); }
      catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic('当前系统没有创建文件 symlink 权限；hardlink 独立覆盖'); continue; } throw error; }
    }
    assert.equal(await f.cache.acquire(key), null);
    await f.cache.removeSession(key.sessionId);
    await fs.lstat(lease.file);
    assert.equal(await hashFile(outside), digest(minimalMp4));
  }
});

check('render-cache 根目录 junction 不得用于生成、读取或删除外部目录', async () => {
  const f = await fixture('root-junction');
  const outside = path.join(root, 'junction-target'); await fs.mkdir(outside);
  const kept = path.join(outside, 'keep.mp4'); await fs.writeFile(kept, minimalMp4);
  await fs.symlink(outside, f.cacheRoot, process.platform === 'win32' ? 'junction' : 'dir');
  let renders = 0;
  await assert.rejects(f.cache.build(spec(), async file => { renders++; await fs.writeFile(file, minimalMp4); }));
  assert.equal(renders, 0);
  try { await f.cache.removeSession('some-session'); } catch {}
  assert.equal(await hashFile(kept), digest(minimalMp4));
  assert.deepEqual(await fs.readdir(outside), ['keep.mp4']);
});

check('removeSession 仅删除该 session 的自有缓存，其他缓存、原片、弹幕、编辑和 retained 成片均保留', async () => {
  const f = await fixture('exact-session'), key = spec(), otherKey = spec();
  const owned = await build(f.cache, key), other = await build(f.cache, otherKey);
  owned.release(); other.release();
  const protectedFiles = [path.join(f.data, 'originals', 'raw.flv'), path.join(f.data, 'originals', 'raw.xml'), path.join(f.data, 'editor.sqlite'), path.join(f.data, 'edits.json'), path.join(f.data, 'temp', 'bili-export-retained', 'final.mp4'), path.join(f.data, 'temp', 'bili-export-retained', '.bili-temp-owner.json'), path.join(f.cacheRoot, 'unknown-user-file.mp4')];
  for (const file of protectedFiles) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'protected:' + file); }
  const before = await Promise.all(protectedFiles.map(hashFile));
  const result = await f.cache.removeSession(key.sessionId);
  assert.ok(result.deletedFiles >= 1); assert.ok(result.freedBytes >= minimalMp4.length);
  await missing(owned.file); await fs.access(other.file);
  assert.deepEqual(await Promise.all(protectedFiles.map(hashFile)), before);
  const available = track(await f.cache.acquire(otherKey)); assert.ok(available); available.release();
});

check('磁盘空间低于保留量加预估体积时报 PREP_SPACE，恢复空间后同 key 可重新构建', async () => {
  let available = 2 * GiB + minimalMp4.length - 1;
  const f = await fixture('disk-space', { statfs: async () => ({ bavail: available, bsize: 1 }) }), key = spec();
  let renders = 0;
  const producer = async file => { renders++; await fs.writeFile(file, minimalMp4); };
  await assert.rejects(f.cache.build(key, producer, { estimatedBytes: minimalMp4.length }), error => error.code === 'PREP_SPACE' && error.capacity !== true);
  assert.equal(renders, 0);
  available = 100 * GiB;
  const lease = track(await f.cache.build(key, producer, { estimatedBytes: minimalMp4.length }));
  assert.equal(renders, 1); lease.release();
});

check('prune keepKeys 保留指定 key 及所有活 lease，只清当前 session 的其他完整缓存', async () => {
  const f = await fixture('prune-keys'), first = spec(), second = { ...first, startMs: 60000, endMs: 120000 }, third = { ...first, startMs: 120000, endMs: 180000 };
  const keep = await build(f.cache, first), pinned = await build(f.cache, second), disposable = await build(f.cache, third);
  const foreignKey = spec(), foreign = await build(f.cache, foreignKey);
  keep.release(); disposable.release(); foreign.release();
  const keepKeys = new Set([f.cache.getKey(first)]);
  await f.cache.prune({ keepKeys, sessionId: first.sessionId });
  await fs.access(keep.file); await fs.access(pinned.file); await fs.access(foreign.file); await missing(disposable.file);
  pinned.release();
  await f.cache.prune({ keepKeys, sessionId: first.sessionId });
  await missing(pinned.file); await fs.access(keep.file); await fs.access(foreign.file);
});

check('软预算淘汰最旧的未 leased 缓存，不能为新构建移除仍被导出读取的文件', async () => {
  let now = 1000;
  const f = await fixture('budget', { minFreeBytes: 0, maxBytes: minimalMp4.length * 2, now: () => now });
  const first = spec(), second = spec(), third = spec();
  const old = await build(f.cache, first); old.release(); now = 2000;
  const pinned = await build(f.cache, second); now = 3000;
  const recent = await build(f.cache, third);
  await missing(old.file); await fs.access(pinned.file); await fs.access(recent.file);
  assert.equal(await hashFile(pinned.file), digest(minimalMp4));
  recent.release(); pinned.release();
});

check('源内容在 producer 期间变化时 verifySource 必须阻止最终提交', async () => {
  const f = await fixture('source-changed-during-render'), key = spec();
  let version = 'original', produced = false;
  await assert.rejects(f.cache.build(key, async file => {
    await fs.writeFile(file, minimalMp4); produced = true; version = 'changed';
  }, { verifySource: async () => version === 'original' }));
  assert.equal(produced, true);
  assert.equal(await f.cache.acquire(key), null);
});

check('重启遇到无 manifest 的旧 generation 只当 miss，重建使用新目录并保留未知旧文件', async () => {
  const f = await fixture('restart-incomplete'), key = spec();
  const completed = await build(f.cache, key); completed.release();
  await fs.unlink(path.join(path.dirname(completed.file), 'manifest.json'));
  const restarted = new RenderCache(f.data, f.settings);
  assert.equal(await restarted.acquire(key), null);
  const fresh = await build(restarted, key); fresh.release();
  assert.notEqual(fresh.file, completed.file);
  await restarted.removeSession(key.sessionId);
  assert.equal(await hashFile(completed.file), digest(minimalMp4));
  await missing(fresh.file);
});
check('一个同 key 调用方取消不会中止仍有消费者的共享 producer，各自得到取消或独立 lease', async t => {
  const f = await fixture('dedupe-one-abort'), key = spec(), entered = deferred(), finish = deferred(), controller = new AbortController();
  let sharedSignal, renders = 0;
  t.after(() => finish.resolve());
  const producer = async (file, { signal }) => { renders++; sharedSignal = signal; entered.resolve(); await finish.promise; await fs.writeFile(file, minimalMp4); };
  const first = f.cache.build(key, producer, { signal: controller.signal }).then(lease => ({ lease }), error => ({ error }));
  await entered.promise;
  const second = f.cache.build(key, producer).then(lease => ({ lease }), error => ({ error }));
  await nextTurn();
  controller.abort();
  assert.equal(sharedSignal.aborted, false);
  finish.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.ok(cancelled(a.error));
  assert.ok(b.lease, b.error?.message); track(b.lease); b.lease.release();
  assert.equal(renders, 1);
});

check('hasReady 只报告已完成且身份有效的当前 session 缓存，不留下 lease 阻止删除', async () => {
  const f = await fixture('has-ready'), key = spec();
  assert.equal(await f.cache.hasReady(key.sessionId), false);
  const first = await build(f.cache, key); first.release();
  assert.equal(await f.cache.hasReady(key.sessionId), true);
  assert.equal(await f.cache.hasReady('another-session'), false);
  f.cache.blockSession(key.sessionId);
  assert.equal(await f.cache.hasReady(key.sessionId), false);
  f.cache.allowSession(key.sessionId);
  assert.equal(await f.cache.hasReady(key.sessionId), true);
  await fs.appendFile(first.file, 'changed after ready');
  assert.equal(await f.cache.hasReady(key.sessionId), false);
  const rebuilt = await build(f.cache, key); rebuilt.release();
  assert.equal(await f.cache.hasReady(key.sessionId), true);
  await f.cache.removeSession(key.sessionId);
  f.cache.allowSession(key.sessionId);
  assert.equal(await f.cache.hasReady(key.sessionId), false);
  await missing(rebuilt.file);
  await fs.access(first.file);
});

check('删除素材同时清掉失败 producer 留下的空 key/generation 目录，不触碰其他素材', async () => {
  const f = await fixture('empty-producer-folders'), key = spec();
  const sessionRoot = path.join(f.cache.root, key.sessionId);
  await fs.mkdir(path.join(sessionRoot, renderCacheKey(key), randomUUID()), { recursive: true });
  await fs.mkdir(path.join(sessionRoot, digest('empty-key')), { recursive: true });
  const neighbor = path.join(f.cache.root, 'another-session', 'keep.txt'); await fs.mkdir(path.dirname(neighbor), { recursive: true }); await fs.writeFile(neighbor, 'keep');
  const result = await f.cache.removeSession(key.sessionId);
  assert.equal(result.preserved.length, 0); assert.equal(result.deletedFiles, 0); assert.equal(result.freedBytes, 0);
  await missing(sessionRoot); assert.equal(await fs.readFile(neighbor, 'utf8'), 'keep');
});
check('同 session 当前计划的两块均 leased 时超预算停止新构建，保留命中并在释放后清理过期块', async t => {
  let now = 1000;
  const f = await fixture('same-session-pinned-budget', { minFreeBytes: 0, maxBytes: minimalMp4.length * 2, now: () => now });
  const first = spec(), second = { ...first, startMs: 60000, endMs: 120000 }, third = { ...first, startMs: 120000, endMs: 180000 };
  const leases = [];
  t.after(() => { for (const lease of leases) lease.release(); });
  const a = await build(f.cache, first); leases.push(a); now = 2000;
  const b = await build(f.cache, second); leases.push(b); now = 3000;
  let renders = 0;
  const producer = async file => { renders++; await fs.writeFile(file, minimalMp4); };
  await assert.rejects(f.cache.build(third, producer, { estimatedBytes: minimalMp4.length }), error => error.code === 'PREP_SPACE' && error.capacity === true);
  assert.equal(renders, 0, 'capacity exhaustion must not start another render');
  for (const [key, original] of [[first, a], [second, b]]) {
    const hit = track(await f.cache.acquire(key));
    assert.ok(hit, 'each pinned ready block must remain a cache hit');
    leases.push(hit);
    assert.equal(hit.file, original.file);
    assert.equal(await hashFile(hit.file), digest(minimalMp4));
    hit.release();
  }
  assert.equal(await f.cache.acquire(third), null);
  a.release(); b.release();
  await f.cache.prune({ keepKeys: new Set([f.cache.getKey(second)]), sessionId: first.sessionId });
  await missing(a.file); await fs.access(b.file);
  const latest = track(await f.cache.build(third, producer, { estimatedBytes: minimalMp4.length })); leases.push(latest);
  assert.equal(renders, 1);
  await fs.access(b.file); await fs.access(latest.file);
  latest.release();
});
check('真正的 ENOSPC 或 EDQUOT 不带容量标志，允许调度器在磁盘恢复后自动重试', async () => {
  for (const code of ['ENOSPC', 'EDQUOT']) {
    const f = await fixture('disk-error-' + code), key = spec();
    await assert.rejects(f.cache.build(key, async () => { throw Object.assign(new Error('disk full'), { code }); }), failure => failure.code === 'PREP_SPACE' && failure.capacity !== true);
    const lease = await build(f.cache, key); lease.release();
  }
});
test.after(async () => {
  for (const lease of held) try { lease.release(); } catch {}
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('bili-render-cache-test-')) throw new Error('Unexpected render-cache test root');
  await fs.rm(root, { recursive: true, force: true });
});
