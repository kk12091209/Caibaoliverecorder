import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../server/store.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-delete-test-'));
const stores = [];
async function write(file, contents = 'preserved data') { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, contents); return file; }
async function missing(file) { await assert.rejects(fs.access(file), error => error.code === 'ENOENT'); }
async function setup(name, { external = false, archive = true } = {}) {
  const store = new Store(path.join(root, name, 'data')); stores.push(store);
  const session = store.createSession({ title: name, status: 'finished' });
  const original = await write(path.join(external ? path.join(root, name, 'external') : path.join(store.root, 'originals', '42'), 'original.flv'), 'original video bytes');
  const xml = await write(original.replace('.flv', '.xml'), '<i>original chat</i>');
  const source = store.addSource(session.id, original, 0, new Date().toISOString(), true);
  store.run('UPDATE sources SET closed=2,duration=3 WHERE id=?', source.id);
  store.run('UPDATE sessions SET duration=3 WHERE id=?', session.id);
  const chunk = await write(path.join(store.root, 'chunks', source.id, '00000000.flvpart'), 'indexed video');
  const orphan = await write(path.join(store.root, 'chunks', source.id, '00000001.flvpart.tmp'), 'interrupted write');
  store.run('INSERT INTO chunks VALUES(?,?,?,?,?,?)', source.id, 0, 0, 1, chunk, 13);
  store.run('INSERT INTO keyframes VALUES(?,?,?,?)', source.id, 0, 0, 0);
  store.run('INSERT INTO danmaku VALUES(?,?,?,?,?,?,?,?)', 'dm-' + name, session.id, source.id, 1, 'viewer', 'message', 'd', '16777215');
  store.saveEdit(session.id, { revision: 0, ranges: [{ start: 0, end: 1 }], excluded: ['dm-' + name], undo: [] });
  store.setting('metadata:' + source.id, { width: 1920, height: 1080 });
  const archivePath = path.join(store.root, 'archives', '20260928', '202609282130-2140.flv');
  const archiveXml = archivePath.replace('.flv', '.xml'), manifest = archivePath.replace('.flv', '.originals.json');
  if (archive) {
    await fs.mkdir(path.dirname(archivePath), { recursive: true }); await fs.link(original, archivePath);
    await write(archiveXml, '<i>archive chat</i>'); await write(manifest, '[]');
    store.run("UPDATE sessions SET archive=?,archive_status='done' WHERE id=?", archivePath, session.id);
  }
  return { store, session, source, original, xml, chunk, orphan, archivePath, archiveXml, manifest };
}

test('确认后释放自有原片、弹幕、内部片段和旧归档，保留成片但删除会话和源记录', async () => {
  const f = await setup('owned');
  const exported = await write(path.join(f.store.root, 'exports', 'final.mp4'), 'finished export');
  const neighbor = await write(path.join(path.dirname(f.archivePath), 'another.flv'), 'another session');
  const roomNeighbor = await write(path.join(path.dirname(f.original), 'another.flv'), 'another recording');
  f.store.run('INSERT INTO jobs(id,session,status,mode,file,data) VALUES(?,?,?,?,?,?)', 'exported', f.session.id, 'done', 'clean', exported, '{}');
  await assert.rejects(f.store.deleteSession(f.session.id, false), /确认/); await fs.access(f.original);
  const expectedBytes = (await Promise.all([f.original,f.xml,f.chunk,f.orphan,f.archiveXml,f.manifest].map(file => fs.stat(file)))).reduce((sum, stat) => sum + stat.size, 0);
  const result = await f.store.deleteSession(f.session.id, true);
  assert.equal(result.ok, true); assert.equal(result.deletedFiles, 7); assert.equal(result.freedBytes, expectedBytes); assert.equal(result.externalFilesPreserved, 0);
  for (const file of [f.original,f.xml,f.chunk,f.orphan,f.archivePath,f.archiveXml,f.manifest,path.dirname(f.chunk)]) await missing(file);
  for (const file of [exported,neighbor,roomNeighbor,path.dirname(f.original),path.dirname(f.archivePath)]) await fs.access(file);
  assert.equal(f.store.session(f.session.id), undefined); assert.equal(f.store.pendingCleanup().length, 0); assert.equal(f.store.get('SELECT * FROM sessions WHERE id=?', f.session.id),undefined);
  assert.deepEqual(f.store.sources(f.session.id),[]);assert.equal(f.store.get('SELECT id FROM sources WHERE path=?',f.original),undefined);
  assert.equal(f.store.wasSourceDeleted(f.original),true);assert.equal(f.store.get('SELECT session FROM jobs WHERE id=?','exported').session,null);
  for (const table of ['chunks','keyframes','danmaku','edits']) assert.equal(f.store.get(`SELECT COUNT(*) AS n FROM ${table}`).n, 0);
  assert.equal(f.store.setting('metadata:' + f.source.id), undefined); assert.equal(f.store.get('SELECT status FROM jobs WHERE id=?', 'exported').status, 'done');

});

test('外部导入原视频和弹幕不删除，本程序缓存被释放且返回保留说明', async () => {
  const f = await setup('external', { external: true });
  const result = await f.store.deleteSession(f.session.id, true);
  assert.equal(result.externalFilesPreserved, 1); assert.match(result.message, /外部/);
  assert.equal(await fs.readFile(f.original, 'utf8'), 'original video bytes'); assert.equal(await fs.readFile(f.xml, 'utf8'), '<i>original chat</i>');
  for (const file of [f.chunk,f.orphan,f.archivePath,f.archiveXml,f.manifest]) await missing(file);
  assert.equal(result.preserved.filter(file => file.reason.startsWith('外部')).length, 2);
});

test('导出记录指向自有目录中的文件时也保护成片，共享原片/弹幕/分段/归档不能误删', async () => {
  const f = await setup('shared');
  const other = f.store.createSession({ title: 'other', status: 'finished' });
  const otherOriginal = await write(path.join(f.store.root, 'originals', '84', 'other.flv'));
  const otherSource = f.store.addSource(other.id, otherOriginal, 0, new Date().toISOString(), true);
  f.store.run('UPDATE sources SET closed=2,xml=? WHERE id=?', f.xml, otherSource.id);
  f.store.run('INSERT INTO chunks VALUES(?,?,?,?,?,?)', otherSource.id, 0, 0, 1, f.chunk, 13);
  f.store.run("UPDATE sessions SET archive=?,archive_status='done' WHERE id=?", f.archivePath, other.id);
  f.store.run('INSERT INTO jobs(id,session,status,mode,file,data) VALUES(?,?,?,?,?,?)', 'protected-export', f.session.id, 'done', 'clean', f.original, '{}');
  const result = await f.store.deleteSession(f.session.id, true);
  for (const file of [f.original,f.xml,f.chunk,f.archivePath,f.archiveXml,f.manifest,otherOriginal]) await fs.access(file);
  await missing(f.orphan); assert.ok(result.preserved.some(file => file.reason === '已导出的视频'));
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM chunks WHERE source=?', otherSource.id).n, 1); assert.ok(f.store.session(other.id));
});

test('Windows 大小写不同的来源路径仍作为同一共享文件保护', { skip: process.platform !== 'win32' }, async () => {
  const f = await setup('case-sharing', { archive: false });
  const other = f.store.createSession({ status: 'finished' }), alias = f.original.toUpperCase();
  assert.notEqual(alias, f.original);
  const otherSource = f.store.addSource(other.id, alias, 0, new Date().toISOString(), true); f.store.run('UPDATE sources SET closed=2 WHERE id=?', otherSource.id);
  await f.store.deleteSession(f.session.id, true); await fs.access(f.original); await fs.access(f.xml); await missing(f.chunk);
});

test('本素材的外部原片同时被旧archive字段引用时，保留规则优先于清理归档', async () => {
  const f = await setup('cross-field', { external: true });
  f.store.run('UPDATE sources SET path=?,xml=? WHERE id=?', f.archivePath, f.archiveXml, f.source.id);
  const result = await f.store.deleteSession(f.session.id, true);
  assert.equal(result.externalFilesPreserved, 1); await fs.access(f.archivePath); await fs.access(f.archiveXml); await fs.access(f.original);
  await missing(f.chunk); await missing(f.manifest);
});

test('别的房间持续更新弹幕与进度不会触发无限引用重扫或阻止删除', async t => {
  const f = await setup('unrelated-writes'), other = f.store.createSession({ status: 'recording' });
  const output = await write(path.join(f.store.root, 'exports', 'preserved.mp4'));
  f.store.run('INSERT INTO jobs(id,session,status,mode,file,data) VALUES(?,?,?,?,?,?)', 'other-job', other.id, 'running', 'clean', output, '{}');
  const realpath = fs.realpath.bind(fs); let calls = 0;
  t.mock.method(fs, 'realpath', async file => {
    calls++; assert.ok(calls < 100, 'unrelated database updates must not cause unbounded rescans');
    f.store.run('UPDATE jobs SET progress=? WHERE id=?', calls / 100, 'other-job');
    f.store.run('INSERT OR REPLACE INTO danmaku VALUES(?,?,?,?,?,?,?,?)', 'other-dm', other.id, 'other-source', calls, 'viewer', 'unrelated chat', 'd', '0');
    return realpath(file);
  });
  const result = await f.store.deleteSession(f.session.id, true); assert.equal(result.ok, true); assert.ok(calls > 0);
  await fs.access(output); assert.equal(f.store.messages(other.id).length, 1); await missing(f.original);
});

test('录制/未整理完成、归档中、切片或整场导出排队运行时均拒绝删除', async () => {
  const f = await setup('busy');
  for (const status of ['recording','finishing']) {
    f.store.run('UPDATE sessions SET status=? WHERE id=?', status, f.session.id); await assert.rejects(f.store.deleteSession(f.session.id, true), /录制/);
  }
  f.store.run("UPDATE sessions SET status='finished' WHERE id=?", f.session.id);
  for (const closed of [0,1,3,null]) { f.store.run('UPDATE sources SET closed=? WHERE id=?', closed, f.source.id); await assert.rejects(f.store.deleteSession(f.session.id, true), /录制/); }
  f.store.run('UPDATE sources SET closed=2 WHERE id=?', f.source.id);
  f.store.run("UPDATE sessions SET archive_status='running' WHERE id=?", f.session.id); await assert.rejects(f.store.deleteSession(f.session.id, true), /归档/);
  f.store.run("UPDATE sessions SET archive_status='done' WHERE id=?", f.session.id);
  for (const [scope,status] of ['clips','full'].flatMap(scope => ['queued','running','saving','save_failed','finalizing'].map(status => [scope,status]))) {
    f.store.run('INSERT OR REPLACE INTO jobs(id,session,status,data) VALUES(?,?,?,?)', 'busy-job', f.session.id, status, JSON.stringify({ scope }));
    await assert.rejects(f.store.deleteSession(f.session.id, true), /导出/);
  }
  await fs.access(f.original); await fs.access(f.chunk); assert.equal(f.store.get('SELECT deleted_at FROM sessions WHERE id=?', f.session.id).deleted_at, '');
});

test('分段越界、目录伪装成素材在任何删除发生前整体拒绝', async () => {
  const f = await setup('escape'), external = await write(path.join(root, 'outside.flvpart'));
  f.store.run('UPDATE chunks SET path=? WHERE source=?', external, f.source.id);
  await assert.rejects(f.store.deleteSession(f.session.id, true), /超出/); await fs.access(f.original); await fs.access(external);
  const prefixTrap = await write(path.join(f.store.root, 'chunks', f.source.id + '-other', '00000000.flvpart'));
  f.store.run('UPDATE chunks SET path=? WHERE source=?', prefixTrap, f.source.id);
  await assert.rejects(f.store.deleteSession(f.session.id, true), /超出/); await fs.access(f.original); await fs.access(prefixTrap);
  f.store.run('UPDATE chunks SET path=? WHERE source=?', f.chunk, f.source.id);
  await fs.unlink(f.original); await fs.mkdir(f.original);
  await assert.rejects(f.store.deleteSession(f.session.id, true), /类型异常/); await fs.access(f.xml); await fs.access(f.chunk);
});

test('父目录 junction/symlink 不允许作为自有素材边界穿透', async () => {
  const f = await setup('junction'), originals = path.join(f.store.root, 'originals'), moved = path.join(f.store.root, 'saved-originals');
  await fs.rename(originals, moved); await fs.symlink(moved, originals, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.store.deleteSession(f.session.id, true), /符号链接|联接/);
  await fs.access(path.join(moved, '42', 'original.flv')); await fs.access(f.chunk); await fs.access(f.archivePath);
  assert.equal(f.store.get('SELECT deleted_at FROM sessions WHERE id=?', f.session.id).deleted_at, '');
});

test('部分 unlink 失败保留可重试状态，禁止恢复；再次删除容忍已缺失文件并完成', async t => {
  const f = await setup('retry'), unlink = fs.unlink.bind(fs); let attempts = 0;
  const mocked = t.mock.method(fs, 'unlink', async file => { if (++attempts === 3) throw Object.assign(new Error('locked'), { code: 'EBUSY' }); return unlink(file); });
  await assert.rejects(f.store.deleteSession(f.session.id, true), /EBUSY/); mocked.mock.restore();
  const row = f.store.get('SELECT * FROM sessions WHERE id=?', f.session.id);
  assert.ok(row.deleted_at); assert.ok(row.purge_started_at); assert.equal(row.purged_at, ''); assert.match(row.purge_error, /EBUSY/);
  assert.equal(f.store.session(f.session.id), undefined); assert.equal(f.store.pendingCleanup().length, 1)
  assert.equal(f.store.sources(f.session.id).length, 1); assert.equal(f.store.messages(f.session.id).length, 1);
  const result = await f.store.deleteSession(f.session.id, true); assert.equal(result.ok, true); assert.equal(f.store.pendingCleanup().length, 0);
  for (const file of [f.original,f.xml,f.chunk,f.orphan,f.archivePath]) await missing(file);
});

test('预检期间新排队的整场导出会阻止删除，并发重复删除被拒绝', async t => {
  const f = await setup('preflight-race'), lstat = fs.lstat.bind(fs); let release, began;
  const started = new Promise(resolve => began = resolve), held = new Promise(resolve => release = resolve); let blocked = false;
  t.mock.method(fs, 'lstat', async (...args) => { if (!blocked) { blocked = true; began(); await held; } return lstat(...args); });
  const deleting = f.store.deleteSession(f.session.id, true); await started;
  await assert.rejects(f.store.deleteSession(f.session.id, true), /正在删除/);
  f.store.run('INSERT INTO jobs(id,session,status,data) VALUES(?,?,?,?)', 'raced-full-job', f.session.id, 'queued', '{"scope":"full"}');
  release(); await assert.rejects(deleting, /导出/); await fs.access(f.original); await fs.access(f.chunk);
  assert.ok(f.store.session(f.session.id));
});

test.after(async () => {
  for (const store of stores) try { store.close(); } catch {}
  if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('bili-delete-test-')) await fs.rm(root, { recursive: true, force: true });
});
