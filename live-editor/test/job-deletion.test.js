import test from 'node:test';
import { minimalMp4 } from './helpers/mp4-fixture.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { Media } from '../server/media.js';
import { JobDeletion } from '../server/job-deletion.js';

// dev-env.ps1 supplies an isolated E-drive temp root. No fixture opens the
// application's production database or requires an encoder/recording process.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-job-delete-'));
const stores = new Set();
const normalized = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
async function write(file, content = 'export video bytes') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}
async function missing(file) { await assert.rejects(fs.access(file), error => error.code === 'ENOENT'); }
async function receipt(file) {
  const stat = await fs.lstat(file, { bigint: true });
  return Object.fromEntries([['path', file], ...['dev', 'ino', 'size', 'mtimeNs'].map(field => [field, String(stat[field])])]);
}
function persist(f) {
  f.store.run('UPDATE jobs SET data=?,file=?,mode=? WHERE id=?', JSON.stringify(f.job), f.job.mode === 'danmaku' ? f.job.output.danmakuFile : f.job.output.file, f.job.mode, f.job.id);
}
async function fixture(name, { store, mode = 'clean', scope = 'clips', status = 'done', namingVersion = 2, sidecars = false, receipts = true, files = true } = {}) {
  const base = path.join(root, name);
  store ??= new Store(path.join(base, 'data'));
  stores.add(store);
  store.projectRoot = base;
  const session = store.createSession({ title: name, status: 'finished' });
  store.run('UPDATE sessions SET duration=600 WHERE id=?', session.id);
  const original = await write(path.join(store.root, 'originals', session.id, 'source.flv'), 'source must survive');
  const xml = await write(original.replace(/\.flv$/, '.xml'), '<i>source danmaku</i>');
  const source = store.addSource(session.id, original, 0, session.created, true);
  store.run('UPDATE sources SET closed=2,duration=600 WHERE id=?', source.id);
  const archive = await write(path.join(store.root, 'archives', session.id, 'full.mkv'), 'whole recording must survive');
  store.run("UPDATE sessions SET archive=?,archive_status='done' WHERE id=?", archive, session.id);
  const outputRoot = path.join(base, scope === 'full' ? 'full-exports' : 'clip-exports');
  const stem = '202609291200-1210';
  const dir = path.join(outputRoot, '20260929', ...(scope === 'clips' ? [stem] : []));
  const file = path.join(dir, stem + '.mp4');
  const danmakuFile = path.join(dir, namingVersion >= 2 ? '【弹幕版】' + stem + '.mp4' : stem + '_弹幕版.mp4');
  const output = { file, dir, namingVersion, sidecars, ...(mode !== 'clean' ? { danmakuFile } : {}) };
  const job = { id: randomUUID(), session: session.id, scope, mode, outputRoot, output };
  const owned = [...(mode === 'danmaku' ? [] : [file]), ...(mode === 'clean' ? [] : [danmakuFile]), ...(sidecars ? [path.join(dir, stem + '.xml'), path.join(dir, stem + '.ass'), path.join(dir, 'edit.json')] : [])];
  await fs.mkdir(dir, { recursive: true });
  if (files) for (const [index, candidate] of owned.entries()) await write(candidate, 'owned output ' + index);
  if (receipts) job.publishedFiles = files ? await Promise.all(owned.map(receipt)) : [];
  store.run('INSERT INTO jobs(id,session,created,status,mode,file,data) VALUES(?,?,?,?,?,?,?)', job.id, session.id, session.created, status, mode, mode === 'danmaku' ? danmakuFile : file, JSON.stringify(job));
  return { base, store, session, source, original, xml, archive, job, owned, service: new JobDeletion(store) };
}
async function originalsSurvive(f) {
  assert.equal(await fs.readFile(f.original, 'utf8'), 'source must survive');
  assert.equal(await fs.readFile(f.xml, 'utf8'), '<i>source danmaku</i>');
  assert.equal(await fs.readFile(f.archive, 'utf8'), 'whole recording must survive');
  assert.ok(f.store.session(f.session.id));
  assert.equal(f.store.sources(f.session.id).length, 1);
}
async function preview(f) {
  const result = await f.service.preview(f.job.id);
  f.token = result.token;
  if (!result.blocked) assert.match(result.token, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return result;
}
async function blocked(f) {
  const plan = await preview(f);
  assert.equal(plan.blocked, true);
  assert.equal(plan.token, undefined);
  assert.ok(plan.reason, 'blocked preview explains why deletion is unavailable');
  await assert.rejects(f.service.delete(f.job.id, { confirmed: true, token: f.token }));
  assert.ok(f.store.get('SELECT id FROM jobs WHERE id=?', f.job.id));
  return plan;
}

for (const scope of ['clips', 'full']) for (const mode of ['clean', 'danmaku', 'dual']) {
  test(`${scope}/${mode} 只删除该任务产物，保留同目录邻居、未声明附属文件和原片`, async () => {
    const f = await fixture(scope + '-' + mode, { scope, mode });
    const neighbors = [
      await write(path.join(f.job.output.dir, 'other.mp4'), 'another export'),
      await write(path.join(f.job.output.dir, '202609291200-1210.xml'), '<i>unclaimed</i>'),
      await write(path.join(f.job.output.dir, '202609291200-1210.ass'), 'unclaimed ASS'),
      await write(path.join(f.job.output.dir, 'edit.json'), 'unclaimed edit'),
    ];
    // A template's clean filename is not an output of a danmaku-only task.
    if (mode === 'danmaku') neighbors.push(await write(f.job.output.file, 'unrelated clean output'));
    const before = await preview(f);
    assert.equal(before.id, f.job.id);
    assert.equal(before.blocked, false);
    assert.deepEqual(before.files.filter(entry => entry.exists).map(entry => normalized(entry.path)).sort(), f.owned.map(normalized).sort());
    assert.ok(before.files.every(entry => typeof entry.exists === 'boolean' && typeof entry.size === 'number'));
    const bytes = (await Promise.all(f.owned.map(file => fs.stat(file)))).reduce((sum, stat) => sum + stat.size, 0);
    for (const confirmed of [undefined, false, 'true', 1]) {
      await assert.rejects(f.service.delete(f.job.id, { confirmed, token: f.token }));
      for (const file of f.owned) await fs.access(file);
    }
    const deleted = await f.service.delete(f.job.id, { confirmed: true, token: f.token });
    assert.equal(deleted.ok, true);
    assert.equal(deleted.deletedFiles, f.owned.length);
    assert.equal(deleted.freedBytes, bytes);
    assert.equal(f.store.get('SELECT id FROM jobs WHERE id=?', f.job.id), undefined);
    for (const file of f.owned) await missing(file);
    for (const file of neighbors) await fs.access(file);
    await originalsSurvive(f);
  });
}

test('缺少发布凭据的完成任务只删除已记录视频，保留同名附属文件',async()=>{
  const f=await fixture('exact-videos',{mode:'dual',receipts:false});
  const neighbors=[];
  for(const name of ['202609291200-1210.xml','202609291200-1210.ass','edit.json','202609291200-1210_弹幕版.mp4'])neighbors.push(await write(path.join(f.job.output.dir,name),'keep'));
  await preview(f);
  const result=await f.service.delete(f.job.id,{confirmed:true,token:f.token});assert.equal(result.deletedFiles,2);
  for(const file of f.owned)await missing(file);for(const file of neighbors)await fs.access(file);await originalsSurvive(f);
});

test('无任务返回 404；活动或待保存状态禁止删除；缺失产物可清理完成、失败和取消记录', async () => {
  const absent = await fixture('not-found');
  await assert.rejects(absent.service.delete(absent.job.id, { confirmed: true }), error => error.status === 409);
  await fs.access(absent.owned[0]);
  await assert.rejects(absent.service.preview('unknown-job'), error => error.status === 404);
  for (const status of ['queued', 'running', 'saving', 'save_failed', 'finalizing', 'unexpected']) {
    const f = await fixture('status-' + status, { status });
    await blocked(f);
    for (const file of f.owned) await fs.access(file);
  }
  for (const status of ['done', 'failed', 'cancelled', 'canceled']) {
    const f = await fixture('missing-' + status, { status, files: false, receipts: false });
    const plan = await preview(f);
    assert.equal(plan.blocked, false);
    assert.ok(plan.files.every(entry => entry.exists === false));
    const result = await f.service.delete(f.job.id, { confirmed: true, token: f.token });
    assert.deepEqual({ ok: result.ok, deletedFiles: result.deletedFiles, freedBytes: result.freedBytes }, { ok: true, deletedFiles: 0, freedBytes: 0 });
    assert.equal(f.store.get('SELECT id FROM jobs WHERE id=?', f.job.id), undefined);
    await originalsSurvive(f);
  }
});

test('预览 token 绑定具体任务及最新确认窗口，缺失、错误、旧窗口或跨任务 token 均返回 409', async () => {
  const f = await fixture('token-binding');
  const first = await preview(f);
  const latest = await preview(f);
  assert.notEqual(first.token, latest.token);
  for (const token of [undefined, '', 'not-a-token', randomUUID(), first.token]) {
    await assert.rejects(f.service.delete(f.job.id, { confirmed: true, token }), error => error.status === 409);
    await fs.access(f.owned[0]);
    assert.ok(f.store.get('SELECT id FROM jobs WHERE id=?', f.job.id));
  }
  const other = await fixture('token-other-job', { store: f.store });
  other.service = f.service;
  const otherPreview = await preview(other);
  await assert.rejects(f.service.delete(f.job.id, { confirmed: true, token: otherPreview.token }), error => error.status === 409);
  const result = await f.service.delete(f.job.id, { confirmed: true, token: latest.token });
  assert.equal(result.ok, true);
  await missing(f.owned[0]);
  for (const file of other.owned) await fs.access(file);
});
test('failed 任务已有文件但无发布凭据时保留；有精确凭据的产物可删除', async () => {
  const unsafe = await fixture('failed-unproven', { status: 'failed', receipts: false });
  await blocked(unsafe);
  await fs.access(unsafe.owned[0]);
  const proven = await fixture('failed-proven', { status: 'failed', receipts: true, mode: 'dual' });
  await preview(proven);
  const result = await proven.service.delete(proven.job.id, { confirmed: true, token: proven.token });
  assert.equal(result.deletedFiles, 2);
  for (const file of proven.owned) await missing(file);
});

test('新任务发布凭据须完整匹配当前文件身份，删除前已被改写的文件必须保留', async () => {
  for (const field of ['dev', 'ino', 'size', 'mtimeNs']) {
    const f = await fixture('receipt-' + field);
    f.job.publishedFiles[0][field] = String(BigInt(f.job.publishedFiles[0][field]) + 1n);
    persist(f);
    await blocked(f);
    await fs.access(f.owned[0]);
  }
  const missingReceipt = await fixture('receipt-missing');
  missingReceipt.job.publishedFiles = [];
  persist(missingReceipt);
  await blocked(missingReceipt);
  const wrongPath = await fixture('receipt-path');
  wrongPath.job.publishedFiles[0].path = path.join(wrongPath.job.output.dir, 'not-owned.mp4');
  persist(wrongPath);
  await blocked(wrongPath);
});

test('确认前替换文件或在原本缺失位置新建文件，不会删除后来出现的文件', async () => {
  const replaced = await fixture('replaced', { receipts: false });
  assert.equal((await preview(replaced)).blocked, false);
  await fs.rename(replaced.owned[0], replaced.owned[0] + '.retained');
  await write(replaced.owned[0], 'replacement owned by somebody else');
  await assert.rejects(replaced.service.delete(replaced.job.id, { confirmed: true, token: replaced.token }));
  assert.equal(await fs.readFile(replaced.owned[0], 'utf8'), 'replacement owned by somebody else');
  assert.ok(replaced.store.get('SELECT id FROM jobs WHERE id=?', replaced.job.id));
  const appeared = await fixture('appeared', { files: false, receipts: false });
  assert.equal((await preview(appeared)).blocked, false);
  await write(appeared.owned[0], 'new arrival');
  await assert.rejects(appeared.service.delete(appeared.job.id, { confirmed: true, token: appeared.token }));
  assert.equal(await fs.readFile(appeared.owned[0], 'utf8'), 'new arrival');
  assert.ok(appeared.store.get('SELECT id FROM jobs WHERE id=?', appeared.job.id));
});

test('原片、归档和其他任务引用不能当作本任务产物删除，确认期间新增引用同样受保护', async () => {
  for (const kind of ['source', 'archive', 'job']) {
    const f = await fixture('shared-' + kind);
    if (kind === 'source') f.store.run('UPDATE sources SET path=? WHERE id=?', f.owned[0], f.source.id);
    if (kind === 'archive') f.store.run('UPDATE sessions SET archive=? WHERE id=?', f.owned[0], f.session.id);
    if (kind === 'job') f.store.run('INSERT INTO jobs(id,session,status,mode,file,data) VALUES(?,?,?,?,?,?)', randomUUID(), f.session.id, 'done', 'clean', f.owned[0], JSON.stringify({ ...f.job, id: randomUUID() }));
    await blocked(f);
    await fs.access(f.owned[0]);
  }
  const raced = await fixture('reference-after-preview');
  await preview(raced);
  raced.store.run('INSERT INTO jobs(id,session,status,mode,file,data) VALUES(?,?,?,?,?,?)', randomUUID(), raced.session.id, 'queued', 'clean', raced.owned[0], JSON.stringify({ ...raced.job, id: randomUUID() }));
  await assert.rejects(raced.service.delete(raced.job.id, { confirmed: true, token: raced.token }));
  await fs.access(raced.owned[0]);
  assert.ok(raced.store.get('SELECT id FROM jobs WHERE id=?', raced.job.id));
});

test('硬链接文件禁止删除，原文件与全部链接保持完整', async () => {
  const f = await fixture('hardlink');
  await fs.unlink(f.owned[0]);
  await fs.link(f.original, f.owned[0]);
  f.job.publishedFiles = [await receipt(f.owned[0])];
  persist(f);
  await blocked(f);
  assert.equal((await fs.stat(f.owned[0])).nlink, 2);
  await originalsSurvive(f);
});

test('父目录 junction 和文件 symlink 禁止删除，不跟随链接到外部目标', async t => {
  const junction = await fixture('junction', { files: false, receipts: false });
  const target = path.join(junction.base, 'outside-output-root');
  await fs.mkdir(target, { recursive: true });
  const targetFile = await write(path.join(target, path.basename(junction.owned[0])), 'outside target');
  await fs.rmdir(junction.job.output.dir);
  await fs.symlink(target, junction.job.output.dir, process.platform === 'win32' ? 'junction' : 'dir');
  await blocked(junction);
  assert.equal(await fs.readFile(targetFile, 'utf8'), 'outside target');
  await t.test('file symlink', async child => {
    const linked = await fixture('symlink', { files: false, receipts: false });
    try { await fs.symlink(linked.original, linked.owned[0], 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { child.skip('当前系统未授予创建文件符号链接权限；junction 和 hardlink 已独立覆盖'); return; }
      throw error;
    }
    await blocked(linked);
    await originalsSurvive(linked);
  });
});

test('路径无效、越界、类型异常和损坏元数据不触发文件删除', async () => {
  const patches = [
    f => { f.job.output.file = 'relative.mp4'; },
    f => { f.job.output.file = path.join(f.job.outputRoot, '..', 'outside.mp4'); },
    f => { f.job.output.file = f.job.outputRoot; },
    f => { f.job.output.file += '\u0000bad'; },
    f => { f.job.outputRoot = 'relative-root'; },
    f => { f.job.output.dir = path.join(f.job.outputRoot, 'different-dir'); },
  ];
  for (const [index, patch] of patches.entries()) {
    const f = await fixture('invalid-path-' + index, { receipts: false });
    patch(f); persist(f);
    await blocked(f);
    for (const file of f.owned) await fs.access(file);
    await originalsSurvive(f);
  }
  const directory = await fixture('directory-file', { receipts: false });
  await fs.unlink(directory.owned[0]);
  await fs.mkdir(directory.owned[0]);
  const child = await write(path.join(directory.owned[0], 'preserve.txt'), 'not an export');
  await blocked(directory); await fs.access(child);
  const invalidJson = await fixture('invalid-json');
  invalidJson.store.run('UPDATE jobs SET data=? WHERE id=?', '{broken', invalidJson.job.id);
  await blocked(invalidJson); await fs.access(invalidJson.owned[0]);
});

test('中途 unlink 失败保留任务记录，已删文件允许缺失，重新确认可安全重试', async t => {
  const f = await fixture('partial', { mode: 'dual' });
  await preview(f);
  const originalUnlink = fs.unlink;
  let attempts = 0;
  const mock = t.mock.method(fs, 'unlink', async file => {
    if (f.owned.includes(String(file)) && ++attempts === 2) {
      const error = new Error('simulated locked output'); error.code = 'EPERM'; throw error;
    }
    return originalUnlink.call(fs, file);
  });
  try { await assert.rejects(f.service.delete(f.job.id, { confirmed: true, token: f.token })); }
  finally { mock.mock.restore(); }
  assert.equal(attempts, 2);
  assert.ok(f.store.get('SELECT id FROM jobs WHERE id=?', f.job.id));
  const remaining = [];
  for (const file of f.owned) try { await fs.access(file); remaining.push(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.equal(remaining.length, 1);
  const expected = (await fs.stat(remaining[0])).size;
  await preview(f);
  const retried = await f.service.delete(f.job.id, { confirmed: true, token: f.token });
  assert.equal(retried.ok, true);
  assert.equal(retried.deletedFiles, 1);
  assert.equal(retried.freedBytes, expected);
  assert.equal(f.store.get('SELECT id FROM jobs WHERE id=?', f.job.id), undefined);
  for (const file of f.owned) await missing(file);
  await originalsSurvive(f);
});

async function publishingFixture(name, scope) {
  const f = await fixture(name, { files: false, receipts: false });
  f.store.run('DELETE FROM jobs WHERE id=?', f.job.id);
  f.store.run('INSERT INTO keyframes VALUES(?,?,?,?)', f.source.id, 0, 0, 0);
  const media = new Media(f.store, { exportAcceleration: 'software' });
  media.work = async () => {};
  media.probeSource = async () => ({ width: 640, height: 360, fps: 30 });
  const temporary = new Set();
  media.process = async (args, options = {}) => {
    assert.equal(path.dirname(options.cwd), path.join(f.store.root, 'temp'));
    temporary.add(options.cwd);
    // This exercises real reservation, publication and persistence with tiny
    // encoded-file stand-ins. It deliberately does not launch or test FFmpeg.
    for (const argument of args) if (/^(?:part-\d+(?:-danmaku)?|final(?:-danmaku)?)\.mp4$/.test(argument)) await fs.writeFile(path.join(options.cwd, argument), minimalMp4);
  };
  try {
    const job = await media.enqueue(f.session.id, { scope, mode: 'dual', ranges: [{ start: 0, end: 2 }], exportDirectory: path.join(f.base, 'media-outputs') });
    return { ...f, job, media, temporary };
  } catch (error) { media.close(); throw error; }
}

test('Media 发布完成后持久化两个视频的真实身份凭据，整场预留和处理临时目录均释放', async () => {
  const f = await publishingFixture('publish-success', 'full');
  try {
    const exported = await f.media.exportJob(f.job);
    assert.equal(exported, f.job.output.file);
    const saved = JSON.parse(f.store.get('SELECT data FROM jobs WHERE id=?', f.job.id).data);
    assert.deepEqual(saved.publishedFiles, await Promise.all([f.job.output.file, f.job.output.danmakuFile].map(receipt)));
    assert.equal(saved.publishedFiles.length, 2);
    for (const directory of f.temporary) await missing(directory);
    await missing(f.job.output.reservation);
    await originalsSurvive(f);
  } finally { f.media.close(); }
});

for (const replaced of [false, true]) {
  test(`Media 发布凭据写库失败时保留成片，${replaced ? '重试拒绝被替换的文件' : '重试写库而不重新编码'}`, async t => {
    const f = await publishingFixture('publish-failure-' + replaced, replaced ? 'full' : 'clips');
    const originalRun = f.store.run;
    let reached = false;
    const mock = t.mock.method(f.store, 'run', function (sql, ...args) {
      if (sql === 'UPDATE jobs SET data=?,file=? WHERE id=?' && args[2] === f.job.id && JSON.parse(args[0]).publishedFiles?.length) {
        reached = true;
        if (replaced) {
          // The synchronous Store API is the failure boundary. Replace the
          // newly published file here before a retry checks its identity.
          syncFs.renameSync(f.job.output.file, f.job.output.file + '.retained');
          syncFs.writeFileSync(f.job.output.file, 'replacement must survive rollback');
        }
        throw new Error('simulated receipt persistence failure');
      }
      return originalRun.call(this, sql, ...args);
    });
    try {
      await assert.rejects(f.media.exportJob(f.job), /simulated receipt persistence failure/);
      mock.mock.restore();
      assert.equal(reached, true);
      const saved = JSON.parse(f.store.get('SELECT data FROM jobs WHERE id=?', f.job.id).data);
      assert.equal(saved.publishedFiles, undefined);
      assert.deepEqual(await fs.readFile(f.job.output.danmakuFile), minimalMp4);
      if (replaced) {
        assert.equal(await fs.readFile(f.job.output.file, 'utf8'), 'replacement must survive rollback');
        assert.deepEqual(await fs.readFile(f.job.output.file + '.retained'), minimalMp4);
      } else assert.deepEqual(await fs.readFile(f.job.output.file), minimalMp4);
      for (const directory of f.temporary) await fs.access(directory);
      if (f.job.output.reservation) await missing(f.job.output.reservation);
      await f.media.recoverPendingSaves();
      f.media.process = () => { throw new Error('save retry must not encode again'); };
      await f.media.retrySave(f.job.id);
      await f.media.waitForSaves();
      const retried = f.store.get('SELECT status,data FROM jobs WHERE id=?', f.job.id);
      assert.equal(retried.status, replaced ? 'save_failed' : 'done');
      if (replaced) {
        assert.equal(await fs.readFile(f.job.output.file, 'utf8'), 'replacement must survive rollback');
        assert.deepEqual(await fs.readFile(f.job.output.file + '.retained'), minimalMp4);
        for (const directory of f.temporary) await fs.access(directory);
      } else {
        assert.equal(JSON.parse(retried.data).publishedFiles.length, 2);
        for (const directory of f.temporary) await missing(directory);
      }
      await originalsSurvive(f);
    } finally { mock.mock.restore(); f.media.close(); }
  });
}
async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('仅移除记录不依赖文件核对，文件缺失、路径损坏或同路径被其他任务使用均可移除', async t => {
  for (const condition of ['missing','corrupt','shared','changed']) {
    const f=await fixture('record-only-'+condition,{mode:'dual'});
    if(condition==='missing')for(const file of f.owned)await fs.unlink(file);
    if(condition==='corrupt')f.store.run('UPDATE jobs SET data=? WHERE id=?','{broken',f.job.id);
    if(condition==='shared')f.store.run('INSERT INTO jobs(id,session,status,mode,file,data) VALUES(?,?,?,?,?,?)','other-'+condition,f.session.id,'running','dual',f.job.output.file,JSON.stringify(f.job));
    if(condition==='changed')await fs.appendFile(f.job.output.file,'changed');
    const expected=condition==='missing'?[]:await Promise.all(f.owned.map(file=>fs.readFile(file)));
    const mocks=['lstat','stat','unlink','realpath','readdir','readFile'].map(name=>t.mock.method(fs,name,()=>{throw new Error('record-only must not touch files');}));
    try {
      await assert.rejects(f.service.delete(f.job.id,{recordOnly:true}),/确认/);
      const removed=await f.service.delete(f.job.id,{confirmed:true,recordOnly:true});
      assert.equal(removed.recordOnly,true);assert.equal(removed.deletedFiles,0);assert.equal(removed.freedBytes,0);
      assert.equal(f.store.get('SELECT id FROM jobs WHERE id=?',f.job.id),undefined);
    } finally {for(const mock of mocks)mock.mock.restore();}
    if(condition==='missing')for(const file of f.owned)await missing(file);
    else assert.deepEqual(await Promise.all(f.owned.map(file=>fs.readFile(file))),expected);
    if(condition==='shared')assert.equal(f.store.get("SELECT status FROM jobs WHERE id='other-shared'").status,'running');
    await originalsSurvive(f);
  }
});

test('文件删除失败不会偷偷移除记录，用户重新确认仅移除记录后才能继续', async t => {
  const f=await fixture('record-only-after-lock');await preview(f);
  const mock=t.mock.method(fs,'unlink',async()=>{throw Object.assign(new Error('locked'),{code:'EPERM'});});
  try {await assert.rejects(f.service.delete(f.job.id,{confirmed:true,token:f.token}),/EPERM/);}
  finally {mock.mock.restore();}
  assert.ok(f.service.job(f.job.id));await fs.stat(f.owned[0]);
  await f.service.delete(f.job.id,{confirmed:true,recordOnly:true});
  assert.equal(f.service.job(f.job.id),undefined);await fs.stat(f.owned[0]);await originalsSurvive(f);
});

test('仅移除记录也保护运行中/待保存任务，互斥删除；已结束任务不受其他任务影响',async()=>{
  const f=await fixture('record-only-guards');
  for(const status of ['queued','running','finalizing','saving','cancelling','save_failed']) {
    f.store.run('UPDATE jobs SET status=? WHERE id=?',status,f.job.id);
    await assert.rejects(f.service.delete(f.job.id,{confirmed:true,recordOnly:true}));assert.ok(f.service.job(f.job.id));
  }
  f.store.run("UPDATE jobs SET status='done' WHERE id=?",f.job.id);
  f.service.deleting.add(f.job.id);await assert.rejects(f.service.delete(f.job.id,{confirmed:true,recordOnly:true}),/正在删除/);f.service.deleting.delete(f.job.id);
  await f.service.delete(f.job.id,{confirmed:true,recordOnly:true});await originalsSurvive(f);
});

test('HTTP 删除预览只读，POST 必须明确确认，成功后文件和任务消失，活动任务仍受保护', async () => {
  const { createApp } = await import('../server/index.js');
  const appRoot = path.join(root, 'http');
  const app = await createApp({automaticClean:false,preparation:false, port: await availablePort(), data: path.join(appRoot, 'data'), projectRoot: appRoot, noRecorder: true, compact: false, ffmpeg: 'not-launched', ffprobe: 'not-launched' });
  app.ingestor.stop();
  try {
    const f = await fixture('http-outputs', { store: app.store, mode: 'dual' });
    const endpoint = `http://127.0.0.1:${app.port}/api/jobs/`;
    const request = async (route, body, headers = {}) => {
      const response = await fetch(endpoint + route, body === undefined ? { headers } : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const responsePreview = await request(f.job.id + '/delete-preview');
    assert.equal(responsePreview.status, 200); assert.equal(responsePreview.body.blocked, false);
    assert.equal(responsePreview.body.files.filter(file => file.exists).length, 2);
    for (const file of f.owned) await fs.access(file);
    assert.equal((await request('missing-job/delete-preview')).status, 404);
    const noConfirmation = await request(f.job.id + '/delete', {});
    assert.ok(noConfirmation.status >= 400);
    for (const file of f.owned) await fs.access(file);
    const foreignOrigin = await request(f.job.id + '/delete', { confirmed: true, token: responsePreview.body.token }, { Origin: 'https://example.invalid' });
    assert.equal(foreignOrigin.status, 403);
    assert.equal((await request(f.job.id+'/delete',{confirmed:true,recordOnly:true},{Origin:'https://example.invalid'})).status,403);
    for (const file of f.owned) await fs.access(file);
    const missingToken = await request(f.job.id + '/delete', { confirmed: true });
    assert.equal(missingToken.status, 409);
    const stalePreview = responsePreview.body;
    const freshPreview = await request(f.job.id + '/delete-preview');
    assert.notEqual(freshPreview.body.token, stalePreview.token);
    const staleToken = await request(f.job.id + '/delete', { confirmed: true, token: stalePreview.token });
    assert.equal(staleToken.status, 409);
    const deleted = await request(f.job.id + '/delete', { confirmed: true, token: freshPreview.body.token });
    assert.equal(deleted.status, 200); assert.equal(deleted.body.ok, true);
    assert.equal(deleted.body.deletedFiles, 2);
    for (const file of f.owned) await missing(file);
    assert.equal((await request(f.job.id + '/delete-preview')).status, 404);
    assert.equal(app.snapshot().jobs.some(job => job.id === f.job.id), false);
    await originalsSurvive(f);
    const busy = await fixture('http-busy', { store: app.store, status: 'running' });
    const busyPreview = await request(busy.job.id + '/delete-preview');
    assert.equal(busyPreview.status, 200); assert.equal(busyPreview.body.blocked, true);
    assert.equal(busyPreview.body.token, undefined);
    assert.ok((await request(busy.job.id + '/delete', { confirmed: true })).status >= 400);
    for (const file of busy.owned) await fs.access(file);
    assert.ok((await request(busy.job.id+'/delete',{confirmed:true,recordOnly:true})).status>=400);
    const history=await fixture('http-history',{store:app.store});
    const historyResult=await request(history.job.id+'/delete',{confirmed:true,recordOnly:true});
    assert.equal(historyResult.status,200);assert.equal(historyResult.body.recordOnly,true);
    assert.equal(app.snapshot().jobs.some(job=>job.id===history.job.id),false);
    for(const file of history.owned)await fs.access(file);
  } finally { stores.delete(app.store); await app.close(); }
});

test.after(async () => {
  for (const store of stores) try { store.close(); } catch {}
  // Only the exact directory created for this test file can be removed.
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('bili-job-delete-')) throw new Error('Refusing to clean an unexpected test directory');
  await fs.rm(root, { recursive: true, force: true });
});
