import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { TemporaryWorkspaces } from '../server/temp-workspaces.js';
import { ExportPublication } from '../server/export-publication.js';
import { clipFile } from '../server/output-names.js';
import { minimalMp4 } from './helpers/mp4-fixture.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-publication-test-'));
const OWNER = '.bili-temp-owner.json', MANIFEST = '.bili-export-publication.json', deadPid = 400000001;
const fields = ['dev', 'ino', 'size', 'mtimeNs'];
const missing = file => assert.rejects(fs.access(file), error => error.code === 'ENOENT');
const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const readJson = file => fs.readFile(file, 'utf8').then(JSON.parse);
const errorWithCode = code => Object.assign(new Error('simulated ' + code), { code });
async function receipt(file) {
  const stat = await fs.lstat(file, { bigint: true });
  return { path: file, ...Object.fromEntries(fields.map(field => [field, String(stat[field])])) };
}
function outputAt(outputRoot, name = '202609292144-2153') {
  const dir = path.join(outputRoot, '导出片段', '20260929', name);
  return { dir, file: path.join(dir, name + '.mp4'), danmakuFile: path.join(dir, '【弹幕版】' + name + '.mp4') };
}
async function fixture(name, mode = 'clean') {
  const base = path.join(root, name), temporaryRoot = path.join(base, 'data', 'temp');
  const manager = new TemporaryWorkspaces(temporaryRoot, { processAlive: pid => pid === process.pid });
  const directory = await manager.create('bili-export-');
  const outputRoot = path.join(base, '用户导出目录'), output = outputAt(outputRoot);
  const job = { id: randomUUID(), session: randomUUID(), mode, scope: 'clips', outputRoot, output };
  const results = [{ temporary: 'final.mp4', file: mode === 'danmaku' ? clipFile(output.file, 'danmaku') : output.file }];
  if (mode === 'dual') results.push({ temporary: 'final-danmaku.mp4', file: clipFile(output.file, 'danmaku') });
  for (const result of results) await fs.writeFile(path.join(directory, result.temporary), minimalMp4);
  await fs.mkdir(output.dir, { recursive: true });
  const publication = new ExportPublication(manager);
  return { base, temporaryRoot, manager, directory, outputRoot, output, job, results, publication, sources: results.map(result => path.join(directory, result.temporary)) };
}
async function stage(f) { return f.publication.stage(f.job, f.directory, f.results); }
async function retained(f) {
  assert.deepEqual((await readJson(path.join(f.directory, OWNER))).retained, { jobId: f.job.id });
  assert.equal(await f.manager.finish(f.directory), false);
  assert.equal((await f.manager.cleanupStale()).removed, 0);
  for (const file of f.sources) await fs.access(file);
}

for (const mode of ['clean', 'danmaku', 'dual']) {
  test(`${mode} 成片发布到中文路径，丢失的父目录自动重建，commit 后只保留单链接成片及匹配凭据`, async () => {
    const f = await fixture('中文目录-' + mode, mode);
    const before = await Promise.all(f.sources.map(hash));
    const staged = await stage(f);
    assert.equal(staged.directory, f.directory);
    await fs.rmdir(f.output.dir);
    const discovered = await f.publication.discover(f.job.id);
    assert.equal(discovered.directory, f.directory);
    const published = await f.publication.publish(f.job.id, f.directory, { outputRoot: f.outputRoot, output: f.output });
    assert.equal(published.file, f.results[0].file);
    assert.deepEqual(published.publishedFiles, await Promise.all(f.results.map(result => receipt(result.file))));
    for (const [index, result] of f.results.entries()) {
      assert.equal(await hash(result.file), before[index]);
      assert.equal((await fs.stat(result.file)).nlink, 2);
      assert.equal((await fs.stat(f.sources[index])).ino, (await fs.stat(result.file)).ino);
    }
    await retained(f);
    const committed = await f.publication.commit(f.job.id, f.directory, published.publishedFiles);
    assert.equal(committed.cleaned, true);
    await missing(f.directory);
    for (const [index, result] of f.results.entries()) {
      assert.equal((await fs.stat(result.file)).nlink, 1);
      assert.deepEqual(await receipt(result.file), published.publishedFiles[index]);
      assert.equal(await hash(result.file), before[index]);
    }
    assert.equal(await f.publication.discover(f.job.id), null);
  });
}

test('双文件第二个目标 EEXIST 时绝不覆盖用户文件，撤回自己的第一文件并保留已编码结果', async () => {
  const f = await fixture('collision', 'dual');
  await stage(f);
  const collision = f.results[1].file;
  await fs.writeFile(collision, 'existing user video');
  const original = await hash(collision);
  await assert.rejects(f.publication.publish(f.job.id, f.directory), error => error.code === 'EEXIST' && error.savePending === true);
  await missing(f.results[0].file);
  assert.equal(await hash(collision), original);
  await retained(f);
  for (const source of f.sources) assert.equal((await fs.stat(source)).nlink, 1);
  const outputRoot = path.join(f.base, '重新选择保存位置'), output = outputAt(outputRoot);
  const saved = await f.publication.publish(f.job.id, f.directory, { outputRoot, output });
  assert.equal(saved.publishedFiles.length, 2);
  await f.publication.commit(f.job.id, f.directory, saved.publishedFiles);
  assert.equal(await hash(collision), original);
  for (const file of [output.file, output.danmakuFile]) await fs.access(file);
});

test('跨卷 EXDEV 退回排他 copyFile，保存结果和凭据正确且 commit 不影响目标', async t => {
  const f = await fixture('cross-volume');
  await stage(f);
  const original = fs.link;
  let calls = 0;
  const mock = t.mock.method(fs, 'link', async (source, destination) => {
    if (source === f.sources[0]) { calls++; throw errorWithCode('EXDEV'); }
    return original(source, destination);
  });
  let published;
  try { published = await f.publication.publish(f.job.id, f.directory); }
  finally { mock.mock.restore(); }
  assert.equal(calls, 1);
  assert.equal((await fs.stat(f.results[0].file)).nlink, 1);
  assert.notEqual((await fs.stat(f.results[0].file)).ino, (await fs.stat(f.sources[0])).ino);
  assert.equal(await hash(f.results[0].file), await hash(f.sources[0]));
  assert.deepEqual(published.publishedFiles, [await receipt(f.results[0].file)]);
  await f.publication.commit(f.job.id, f.directory, published.publishedFiles);
  await missing(f.directory);
  await fs.access(f.results[0].file);
});

for (const [code, expected] of [['ENOSPC', 'NO_SPACE'], ['EPERM', 'DESTINATION_UNAVAILABLE']]) {
  test(`${code} 保存失败保留成片和清单，切换目录可以直接重试成功`, async t => {
    const f = await fixture('destination-' + code);
    await stage(f);
    const originalHash = await hash(f.sources[0]);
    const link = fs.link, copyFile = fs.copyFile;
    const mockLink = t.mock.method(fs, 'link', async (source, destination) => source === f.sources[0] ? Promise.reject(errorWithCode('EXDEV')) : link(source, destination));
    const mockCopy = t.mock.method(fs, 'copyFile', async (source, destination, flags) => source === f.sources[0] ? Promise.reject(errorWithCode(code)) : copyFile(source, destination, flags));
    try {
      await assert.rejects(f.publication.publish(f.job.id, f.directory), error => error.code === expected && error.savePending === true && error.directory === f.directory);
    } finally { mockCopy.mock.restore(); mockLink.mock.restore(); }
    await retained(f);
    assert.equal(await hash(f.sources[0]), originalHash);
    assert.equal((await f.publication.discover(f.job.id)).directory, f.directory);
    const outputRoot = path.join(f.base, '换盘后的位置'), output = outputAt(outputRoot);
    const saved = await f.publication.publish(f.job.id, f.directory, { outputRoot, output });
    assert.equal(saved.file, output.file);
    assert.equal(await hash(saved.file), originalHash);
    await f.publication.commit(f.job.id, f.directory, saved.publishedFiles);
    await missing(f.directory);
    await missing(f.results[0].file);
  });
}

test('发布后未 commit 模拟数据库保存失败，重启发现清单并复用已有 receipt，绝不再生成或复制成片', async t => {
  const f = await fixture('restart-published', 'dual');
  await stage(f);
  const first = await f.publication.publish(f.job.id, f.directory);
  const owner = await readJson(path.join(f.directory, OWNER));
  await fs.writeFile(path.join(f.directory, OWNER), JSON.stringify({ ...owner, ownerPid: deadPid }));
  f.manager.active.clear();
  const manager = new TemporaryWorkspaces(f.temporaryRoot, { processAlive: pid => pid === process.pid });
  const restarted = new ExportPublication(manager);
  assert.equal((await manager.cleanupStale()).removed, 0);
  assert.equal((await restarted.discover(f.job.id)).directory, f.directory);
  const link = t.mock.method(fs, 'link', async () => { throw new Error('published receipt should be reused'); });
  const copy = t.mock.method(fs, 'copyFile', async () => { throw new Error('published receipt should be reused'); });
  let recovered;
  try { recovered = await restarted.publish(f.job.id, f.directory); }
  finally { copy.mock.restore(); link.mock.restore(); }
  assert.deepEqual(recovered.publishedFiles, first.publishedFiles);
  await restarted.commit(f.job.id, f.directory, recovered.publishedFiles);
  await missing(f.directory);
  for (const result of f.results) assert.equal((await fs.stat(result.file)).nlink, 1);
});

for (const invalid of ['missing', 'empty', 'truncated', 'box-overflow']) {
  test(`stage 拒绝 ${invalid} 临时视频，未创建任何成片`, async () => {
    const f = await fixture('invalid-source-' + invalid);
    if (invalid === 'missing') await fs.unlink(f.sources[0]);
    else if (invalid === 'empty') await fs.writeFile(f.sources[0], Buffer.alloc(0));
    else if (invalid === 'truncated') await fs.writeFile(f.sources[0], minimalMp4.subarray(0, 16));
    else { const bytes = Buffer.from(minimalMp4); bytes.writeUInt32BE(bytes.length + 1, 0); await fs.writeFile(f.sources[0], bytes); }
    await assert.rejects(stage(f), error => error.code === (invalid === 'missing' ? 'SOURCE_MISSING' : 'SOURCE_INVALID'));
    await missing(f.results[0].file);
  });
}

test('stage 后源被替换或新增硬链接均停止发布，保留变化后的文件用于检查', async () => {
  for (const kind of ['replace', 'hardlink']) {
    const f = await fixture('changed-source-' + kind);
    await stage(f);
    if (kind === 'replace') {
      await fs.rename(f.sources[0], path.join(f.base, 'retained-original.mp4'));
      await fs.writeFile(f.sources[0], minimalMp4);
    } else await fs.link(f.sources[0], path.join(f.base, 'outside-link.mp4'));
    await assert.rejects(f.publication.publish(f.job.id, f.directory), error => error.code === 'SOURCE_CHANGED' && error.savePending === true);
    await retained(f);
    await missing(f.results[0].file);
  }
});

test('非法 root/越界路径和目标目录 junction 拒绝发布，不向链接目标写视频', async () => {
  const f = await fixture('unsafe-destination');
  await stage(f);
  const overrides = [
    { outputRoot: 'relative-root', output: f.output },
    { outputRoot: f.outputRoot, output: { ...f.output, file: path.join(f.base, 'escaped.mp4') } },
    { outputRoot: f.outputRoot, output: { ...f.output, dir: path.join(f.outputRoot, 'wrong-parent') } },
    { outputRoot: f.outputRoot + '\u0000bad', output: f.output },
  ];
  for (const override of overrides) {
    await assert.rejects(f.publication.publish(f.job.id, f.directory, override), error => error.code === 'INVALID_PATH' && error.savePending === true);
    await retained(f);
  }
  const target = path.join(f.base, 'outside-target'), alias = path.join(f.base, 'linked-output');
  await fs.mkdir(target);
  await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const output = outputAt(alias);
  await assert.rejects(f.publication.publish(f.job.id, f.directory, { outputRoot: alias, output }), error => ['UNSAFE_PATH', 'DESTINATION_UNAVAILABLE'].includes(error.code));
  assert.deepEqual(await fs.readdir(target), []);
  await retained(f);
});

test('commit 要求匹配的数据库 receipt；目标替换后不得删除 retained 源视频或用户替换文件', async () => {
  const f = await fixture('replaced-target');
  await stage(f);
  const published = await f.publication.publish(f.job.id, f.directory);
  await assert.rejects(f.publication.commit(f.job.id, f.directory, []), error => error.code === 'INVALID_RECEIPT');
  const before = await hash(f.sources[0]);
  await fs.rename(published.file, published.file + '.original');
  await fs.writeFile(published.file, 'user replacement must survive');
  await assert.rejects(f.publication.commit(f.job.id, f.directory, published.publishedFiles), error => error.code === 'DESTINATION_CHANGED' && error.savePending === true);
  assert.equal(await hash(f.sources[0]), before);
  assert.equal(await fs.readFile(published.file, 'utf8'), 'user replacement must survive');
  assert.equal(await hash(published.file + '.original'), before);
  await retained(f);
});

test('manifest 必须匹配 jobId 与 owner token，错误任务不能发现、发布或提交另一任务结果', async () => {
  const f = await fixture('manifest-job');
  await stage(f);
  assert.equal(await f.publication.discover(randomUUID()), null);
  await assert.rejects(f.publication.publish(randomUUID(), f.directory), error => error.code === 'INVALID_MANIFEST');
  await assert.rejects(f.publication.commit(randomUUID(), f.directory, []), error => error.code === 'INVALID_MANIFEST');
  const file = path.join(f.directory, MANIFEST), original = await readJson(file);
  for (const patch of [{ jobId: randomUUID() }, { token: randomUUID() }]) {
    await fs.writeFile(file, JSON.stringify({ ...original, ...patch }));
    await assert.rejects(f.publication.publish(f.job.id, f.directory), error => error.code === 'INVALID_MANIFEST');
    assert.equal(await f.publication.discover(f.job.id), null);
    for (const source of f.sources) await fs.access(source);
    await missing(f.results[0].file);
  }
});

async function restart(f) {
  const owner = await readJson(path.join(f.directory, OWNER));
  await fs.writeFile(path.join(f.directory, OWNER), JSON.stringify({ ...owner, ownerPid: deadPid }));
  f.manager.active.clear();
  const manager = new TemporaryWorkspaces(f.temporaryRoot, { processAlive: pid => pid === process.pid });
  return { manager, publication: new ExportPublication(manager) };
}

test('saving intent 已落盘、link 完成但 receipt 未写时，重启根据同 inode 恢复，不再次发布', async t => {
  const f = await fixture('crash-before-receipt');
  await stage(f);
  const file = path.join(f.directory, MANIFEST), manifest = await readJson(file);
  manifest.state = 'saving';
  await fs.writeFile(file, JSON.stringify(manifest));
  await fs.link(f.sources[0], f.results[0].file);
  assert.deepEqual((await readJson(file)).publishedFiles, []);
  const expected = await receipt(f.results[0].file);
  const restarted = await restart(f);
  const link = t.mock.method(fs, 'link', async () => { throw new Error('existing publication must be recovered'); });
  const copy = t.mock.method(fs, 'copyFile', async () => { throw new Error('existing publication must be recovered'); });
  let recovered;
  try { recovered = await restarted.publication.publish(f.job.id, f.directory); }
  finally { copy.mock.restore(); link.mock.restore(); }
  assert.deepEqual(recovered.publishedFiles, [expected]);
  await restarted.publication.commit(f.job.id, f.directory, recovered.publishedFiles);
  assert.equal((await fs.stat(f.results[0].file)).nlink, 1);
  await missing(f.directory);
});

test('只有 saving intent 但目标是相同内容的独立 copy 时不能冒认未登记 receipt', async () => {
  const f = await fixture('unproven-copy');
  await stage(f);
  const file = path.join(f.directory, MANIFEST), manifest = await readJson(file);
  manifest.state = 'saving';
  await fs.writeFile(file, JSON.stringify(manifest));
  await fs.copyFile(f.sources[0], f.results[0].file);
  const before = await receipt(f.results[0].file);
  const restarted = await restart(f);
  await assert.rejects(restarted.publication.publish(f.job.id, f.directory), error => error.code === 'EEXIST');
  assert.deepEqual(await receipt(f.results[0].file), before);
  await fs.access(f.sources[0]);
  assert.deepEqual((await readJson(file)).publishedFiles, []);
});

test('dual commit 已移除一个 retained 源链接后崩溃，重启沿 receipt 完成剩余清理并保留两成片', async t => {
  const f = await fixture('partial-commit', 'dual');
  await stage(f);
  const published = await f.publication.publish(f.job.id, f.directory);
  await fs.unlink(f.sources[0]);
  assert.equal((await fs.stat(f.results[0].file)).nlink, 1);
  assert.equal((await fs.stat(f.results[1].file)).nlink, 2);
  const restarted = await restart(f);
  const link = t.mock.method(fs, 'link', async () => { throw new Error('partial commit must not re-encode or publish'); });
  const copy = t.mock.method(fs, 'copyFile', async () => { throw new Error('partial commit must not re-encode or publish'); });
  let recovered;
  try { recovered = await restarted.publication.publish(f.job.id, f.directory); }
  finally { copy.mock.restore(); link.mock.restore(); }
  assert.deepEqual(recovered.publishedFiles, published.publishedFiles);
  assert.equal((await restarted.publication.commit(f.job.id, f.directory, recovered.publishedFiles)).cleaned, true);
  await missing(f.directory);
  for (const result of f.results) assert.equal((await fs.stat(result.file)).nlink, 1);
});

for (const mode of ['clean', 'danmaku', 'dual']) test(`verifyPublished 只读核对 ${mode} 的全部指定目标、身份及单链接状态，覆盖清理完成但 DB 状态未写窗口`, async () => {
  const f = await fixture('verify-' + mode, mode);
  await stage(f);
  const published = await f.publication.publish(f.job.id, f.directory);
  const savedJob = { ...f.job, publishedFiles: published.publishedFiles };
  assert.equal(await f.publication.verifyPublished(savedJob), false);
  await f.publication.commit(f.job.id, f.directory, published.publishedFiles);
  await missing(f.directory);
  const before = await Promise.all(f.results.map(result => hash(result.file)));
  assert.equal(await f.publication.verifyPublished(savedJob), true);
  const changed = structuredClone(savedJob);
  changed.publishedFiles[0].size = String(BigInt(changed.publishedFiles[0].size) + 1n);
  const wrongPath = structuredClone(savedJob);
  wrongPath.publishedFiles[0].path = path.join(f.base, 'unrelated.mp4');
  const wrongMode = { ...savedJob, mode: 'unsupported' };
  const wrongCount = { ...savedJob, publishedFiles: [...savedJob.publishedFiles, savedJob.publishedFiles[0]] };
  for (const job of [changed, wrongPath, wrongMode, wrongCount, { ...savedJob, publishedFiles: [] }]) assert.equal(await f.publication.verifyPublished(job), false);
  const shared = path.join(f.base, 'shared-after-commit.mp4');
  await fs.link(f.results[0].file, shared);
  assert.equal(await f.publication.verifyPublished(savedJob), false);
  await fs.unlink(shared);
  assert.equal(await f.publication.verifyPublished(savedJob), true);
  await fs.rename(f.results[0].file, f.results[0].file + '.moved');
  assert.equal(await f.publication.verifyPublished(savedJob), false);
  await fs.rename(f.results[0].file + '.moved', f.results[0].file);
  assert.equal(await f.publication.verifyPublished(savedJob), true);
  assert.deepEqual(await Promise.all(f.results.map(result => hash(result.file))), before);
});
test('部分 commit 后唯一成片不能被失败重试回滚：source1 缺失且 dest2 替换时保留全部剩余文件', async () => {
  const f = await fixture('sole-copy-retry', 'dual');
  await stage(f);
  const published = await f.publication.publish(f.job.id, f.directory);
  const originalHashes = await Promise.all(f.sources.map(hash));
  await fs.unlink(f.sources[0]);
  await fs.rename(f.results[1].file, f.results[1].file + '.retained');
  await fs.writeFile(f.results[1].file, 'replacement user video');
  await assert.rejects(f.publication.publish(f.job.id, f.directory), error => error.code === 'DESTINATION_CHANGED' && error.savePending === true);
  await missing(f.sources[0]);
  assert.equal(await hash(f.results[0].file), originalHashes[0]);
  assert.equal((await fs.stat(f.results[0].file)).nlink, 1);
  assert.deepEqual(await receipt(f.results[0].file), published.publishedFiles[0]);
  assert.equal(await fs.readFile(f.results[1].file, 'utf8'), 'replacement user video');
  assert.equal(await hash(f.sources[1]), originalHashes[1]);
  assert.equal(await hash(f.results[1].file + '.retained'), originalHashes[1]);
  const manifest = await readJson(path.join(f.directory, MANIFEST));
  assert.ok(manifest.publishedFiles.some(file => file.path === f.results[0].file));
  assert.deepEqual((await readJson(path.join(f.directory, OWNER))).retained, { jobId: f.job.id });
  assert.equal(await f.manager.finish(f.directory), false);
  assert.equal((await f.manager.cleanupStale()).removed, 0);
  await fs.access(path.join(f.directory, MANIFEST));
});
test.after(async () => {
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('bili-publication-test-')) throw new Error('Unexpected publication test directory');
  await fs.rm(root, { recursive: true, force: true });
});