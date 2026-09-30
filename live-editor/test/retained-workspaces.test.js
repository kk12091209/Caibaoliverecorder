import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { TemporaryWorkspaces } from '../server/temp-workspaces.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-retained-test-'));
const MARKER = '.bili-temp-owner.json', MANIFEST = '.bili-export-publication.json';
const jobId = 'export-' + randomUUID(), deadPid = 400000001, childPid = 400000002;
const missing = file => assert.rejects(fs.access(file), error => error.code === 'ENOENT');
const marker = directory => fs.readFile(path.join(directory, MARKER), 'utf8').then(JSON.parse);
async function setMarker(directory, patch) {
  await fs.writeFile(path.join(directory, MARKER), JSON.stringify({ ...await marker(directory), ...patch }));
}
async function fixture(name, prefix = 'bili-export-') {
  const temporaryRoot = path.join(root, name, 'temp');
  const manager = new TemporaryWorkspaces(temporaryRoot, { processAlive: pid => pid === process.pid });
  const directory = await manager.create(prefix);
  const file = path.join(directory, prefix === 'bili-export-' ? 'final.mp4' : 'sample.flv');
  await fs.writeFile(file, 'complete encoded video');
  return { temporaryRoot, manager, directory, file };
}
async function orphan(f, patch = {}) {
  await setMarker(f.directory, { ownerPid: deadPid, ...patch });
  f.manager.active.clear();
}
const collector = temporaryRoot => new TemporaryWorkspaces(temporaryRoot, { processAlive: pid => pid === process.pid });

test('保留标记持久化且幂等，finish/cleanup/remove 均保护视频；release 自身不删除，caller finish 才清理', async () => {
  const f = await fixture('active');
  const tempManifest = '.bili-export-publication-' + randomUUID() + '.tmp';
  for (const name of ['final-danmaku.mp4', MANIFEST, tempManifest]) await fs.writeFile(path.join(f.directory, name), 'owned publication data');
  const before = await marker(f.directory);
  assert.equal(await f.manager.retain(f.directory, jobId), true);
  assert.equal(await f.manager.retain(f.directory, jobId), true);
  const saved = await marker(f.directory);
  assert.deepEqual(saved.retained, { jobId });
  assert.equal(saved.token, before.token);
  assert.equal(await f.manager.finish(f.directory), false);
  assert.equal(await f.manager.remove(f.directory, saved, true), false);
  assert.equal(await f.manager.remove(f.directory, saved, false), false);
  assert.equal((await f.manager.cleanupStale()).removed, 0);
  assert.equal(await fs.readFile(f.file, 'utf8'), 'complete encoded video');
  assert.equal(await f.manager.release(f.directory, jobId), true);
  assert.equal((await marker(f.directory)).retained, undefined);
  assert.equal(f.manager.active.get(f.directory.toLowerCase())?.completed ?? [...f.manager.active.values()][0].completed, false);
  assert.equal((await f.manager.cleanupStale()).removed, 0);
  for (const name of ['final.mp4', 'final-danmaku.mp4', MANIFEST, tempManifest]) await fs.access(path.join(f.directory, name));
  assert.equal(await f.manager.finish(f.directory), true);
  await missing(f.directory);
});

test('重启后的 retained 孤儿不按年龄清理，adopt 保留 token、更新 owner 并移除已死 child 登记', async () => {
  const f = await fixture('restart');
  await f.manager.retain(f.directory, jobId);
  await orphan(f, { childPids: [childPid] });
  const before = await marker(f.directory), restarted = collector(f.temporaryRoot);
  const ancient = new Date('2000-01-01T00:00:00Z');
  await fs.utimes(f.directory, ancient, ancient);
  assert.equal((await restarted.cleanupStale()).removed, 0);
  const state = await restarted.adoptRetained(f.directory, jobId);
  const saved = await marker(f.directory);
  assert.equal(saved.ownerPid, process.pid);
  assert.equal(saved.token, before.token);
  assert.deepEqual(saved.childPids, []);
  assert.deepEqual(saved.retained, { jobId });
  assert.equal(state.completed, false);
  assert.equal(await restarted.finish(f.directory), false);
  await restarted.release(f.directory, jobId);
  await fs.access(f.file);
  assert.equal(await restarted.finish(f.directory), true);
  await missing(f.directory);
});

for (const operation of ['retain', 'release']) test(`重启孤儿允许由 ${operation} 内部接管，必须已有匹配的保留任务`, async () => {
  const f = await fixture('implicit-' + operation);
  await f.manager.retain(f.directory, jobId);
  await orphan(f);
  const restarted = collector(f.temporaryRoot);
  assert.equal(await restarted[operation](f.directory, jobId), true);
  assert.equal((await marker(f.directory)).ownerPid, process.pid);
  await fs.access(f.file);
  if (operation === 'retain') {
    assert.equal(await restarted.finish(f.directory), false);
    await restarted.release(f.directory, jobId);
  }
  assert.equal(await restarted.finish(f.directory), true);
});

test('不能接管活 owner、同 PID 的其他 manager、未知进程状态或仍有活 child 的孤儿', async () => {
  const live = await fixture('live-owner');
  await live.manager.retain(live.directory, jobId);
  const second = collector(live.temporaryRoot), before = await fs.readFile(path.join(live.directory, MARKER), 'utf8');
  for (const operation of ['adoptRetained', 'retain', 'release']) await assert.rejects(second[operation](live.directory, jobId));
  assert.equal(await fs.readFile(path.join(live.directory, MARKER), 'utf8'), before);
  for (const kind of ['live-owner', 'live-child', 'uncertain']) {
    const f = await fixture('foreign-' + kind);
    await f.manager.retain(f.directory, jobId);
    await orphan(f, kind === 'live-child' ? { childPids: [childPid] } : {});
    const manager = new TemporaryWorkspaces(f.temporaryRoot, { processAlive: pid => {
      if (kind === 'uncertain') throw new Error('process status denied');
      return kind === 'live-owner' ? pid === deadPid : pid === childPid;
    } });
    await assert.rejects(manager.adoptRetained(f.directory, jobId));
    await assert.rejects(manager.release(f.directory, jobId));
    assert.equal((await manager.cleanupStale()).removed, 0);
    await fs.access(f.file);
  }
});

test('pending spawn 或活 child 阻止 release，retain 可先保护工作区，child 退出不会清理 retained', async () => {
  const f = await fixture('active-child');
  f.manager.processAlive = pid => pid === process.pid || pid === childPid;
  const ticket = f.manager.beforeSpawn(f.directory);
  await f.manager.retain(f.directory, jobId);
  await assert.rejects(f.manager.release(f.directory, jobId));
  f.manager.spawned(ticket, childPid);
  await assert.rejects(f.manager.release(f.directory, jobId));
  assert.equal(await f.manager.finish(f.directory), false);
  f.manager.processAlive = pid => pid === process.pid;
  f.manager.childExited(ticket, childPid);
  assert.equal(await f.manager.finish(f.directory), false);
  assert.deepEqual((await marker(f.directory)).retained, { jobId });
  await fs.access(f.file);
  await f.manager.release(f.directory, jobId);
  await fs.access(f.file);
  assert.equal(await f.manager.finish(f.directory), true);
});

test('pendingSpawns 即使 owner 已退出也不能猜测恢复，未经保留的孤儿不能被 retain 据为己有', async () => {
  const pending = await fixture('orphan-pending');
  await pending.manager.retain(pending.directory, jobId);
  await orphan(pending, { pendingSpawns: 1 });
  const manager = collector(pending.temporaryRoot);
  for (const operation of ['retain', 'release', 'adoptRetained']) await assert.rejects(manager[operation](pending.directory, jobId));
  assert.equal((await manager.cleanupStale()).removed, 0);
  const ordinary = await fixture('ordinary-orphan');
  await orphan(ordinary);
  await assert.rejects(collector(ordinary.temporaryRoot).retain(ordinary.directory, jobId));
  await fs.access(ordinary.file);
});

test('错误任务、篡改 token/owner、非法任务编号均不改写标记或释放视频', async () => {
  const f = await fixture('wrong-job');
  await f.manager.retain(f.directory, jobId);
  const before = await fs.readFile(path.join(f.directory, MARKER), 'utf8');
  for (const operation of ['retain', 'release', 'adoptRetained']) for (const id of ['different-job', '', '../escape', 'x'.repeat(101), 12, null]) await assert.rejects(f.manager[operation](f.directory, id));
  assert.equal(await fs.readFile(path.join(f.directory, MARKER), 'utf8'), before);
  for (const changed of [{ token: randomUUID() }, { ownerPid: deadPid }]) {
    const other = await fixture('changed-' + Object.keys(changed)[0]);
    await other.manager.retain(other.directory, jobId);
    await setMarker(other.directory, changed);
    const altered = await fs.readFile(path.join(other.directory, MARKER), 'utf8');
    for (const operation of ['retain', 'release', 'adoptRetained']) await assert.rejects(other.manager[operation](other.directory, jobId));
    assert.equal(await fs.readFile(path.join(other.directory, MARKER), 'utf8'), altered);
    assert.equal(await other.manager.finish(other.directory), false);
    await fs.access(other.file);
  }
});

test('retained 字段只要存在就必须有效，null/false/数组/非法 jobId 的目录都保留', async () => {
  const invalid = [null, false, [], {}, { jobId: '../escape' }, { jobId: 1 }, { jobId: 'x'.repeat(101) }];
  for (const [index, retained] of invalid.entries()) {
    const f = await fixture('invalid-retained-' + index);
    await orphan(f, { retained });
    const manager = collector(f.temporaryRoot);
    assert.equal((await manager.cleanupStale()).removed, 0);
    await assert.rejects(manager.adoptRetained(f.directory, jobId));
    await assert.rejects(manager.release(f.directory, jobId));
    await fs.access(f.file);
  }
});

test('retain 仅支持同根合法 export 目录，probe、越界、junction 和硬链接 marker 均拒绝', async () => {
  const f = await fixture('scope');
  const probe = await fixture('scope-probe', 'bili-probe-');
  await assert.rejects(probe.manager.retain(probe.directory, jobId));
  const outside = await fixture('scope-outside');
  await outside.manager.retain(outside.directory, jobId);
  await orphan(outside);
  await assert.rejects(f.manager.adoptRetained(outside.directory, jobId));
  const alias = path.join(f.temporaryRoot, 'bili-export-linked');
  await fs.symlink(outside.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.manager.retain(alias, jobId));
  await fs.link(path.join(f.directory, MARKER), path.join(root, 'owner-hardlink.json'));
  await assert.rejects(f.manager.retain(f.directory, jobId));
  assert.equal(await f.manager.finish(f.directory), false);
  for (const fixture of [f, probe, outside]) await fs.access(fixture.file);
});

test('publication manifest 和 UUID 临时清单仅在 export 放行，其他 .tmp 或 probe 同名文件保留', async () => {
  for (const name of [MANIFEST, '.bili-export-publication-' + randomUUID() + '.tmp']) {
    const probe = await fixture('manifest-probe-' + randomUUID(), 'bili-probe-');
    await fs.writeFile(path.join(probe.directory, name), 'not a probe-owned file');
    assert.equal(await probe.manager.finish(probe.directory), false);
    await fs.access(probe.file);
  }
  for (const name of ['.bili-export-publication-nope.tmp', '.bili-export-publication.json.tmp', 'arbitrary.tmp']) {
    const f = await fixture('manifest-unknown-' + randomUUID());
    await fs.writeFile(path.join(f.directory, name), 'unrecognized file');
    assert.equal(await f.manager.finish(f.directory), false);
    await fs.access(f.file);
  }
});

test('保留后源视频若有发布硬链接仍受保护，release 不删链接，正常清理继续拒绝多链接文件', async () => {
  const f = await fixture('published-hardlink');
  await f.manager.retain(f.directory, jobId);
  const published = path.join(root, 'published-video.mp4');
  await fs.link(f.file, published);
  assert.equal(await f.manager.finish(f.directory), false);
  await f.manager.release(f.directory, jobId);
  await fs.access(f.file); await fs.access(published);
  assert.equal(await f.manager.finish(f.directory), false);
  // The publisher removes its retained source link after durable publication.
  await fs.unlink(f.file);
  assert.equal(await f.manager.finish(f.directory), true);
  assert.equal(await fs.readFile(published, 'utf8'), 'complete encoded video');
});

test('finish 已进入清理时 retain 和 beforeSpawn 拒绝，不能向正在删除的工作区加入保留或新进程', async t => {
  const f = await fixture('finishing-race');
  let entered, proceed;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { proceed = resolve; });
  const original = fs.readdir;
  const mock = t.mock.method(fs, 'readdir', async (...args) => {
    if (args[0] === f.directory) { entered(); await gate; }
    return original(...args);
  });
  const finishing = f.manager.finish(f.directory);
  try {
    await reached;
    await assert.rejects(f.manager.retain(f.directory, jobId), /清理/);
    assert.throws(() => f.manager.beforeSpawn(f.directory), /完成|清理/);
  } finally { proceed(); await finishing; mock.mock.restore(); }
  await missing(f.directory);
});

test('缓存拼接音视频工作文件只在 export 精确放行，近似后缀与 probe 同名文件不清理', async () => {
  const names = ['audio-0.flac', 'audio-12.flac', 'audio-concat.txt', 'video-concat.txt', 'video-concat-danmaku.txt', 'video.mp4', 'video-danmaku.mp4', 'audio.m4a'];
  const owned = await fixture('mux-work-files');
  for (const name of names) await fs.writeFile(path.join(owned.directory, name), 'owned mux work');
  assert.equal(await owned.manager.finish(owned.directory), true);
  await missing(owned.directory);
  for (const name of ['audio-evil.flac', 'audio-0.flac.bak', 'video-danmaku-extra.mp4', 'video-concat-unknown.txt', 'other.m4a']) {
    const f = await fixture('unknown-mux-' + randomUUID());
    await fs.writeFile(path.join(f.directory, name), 'not owned');
    assert.equal(await f.manager.finish(f.directory), false);
    await fs.access(f.file);
  }
  const probe = await fixture('probe-mux-files', 'bili-probe-');
  for (const name of names) await fs.writeFile(path.join(probe.directory, name), 'not probe-owned');
  assert.equal(await probe.manager.finish(probe.directory), false);
  await fs.access(probe.file);
});
test.after(async () => {
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('bili-retained-test-')) throw new Error('Unexpected retained-workspace test root');
  await fs.rm(root, { recursive: true, force: true });
});