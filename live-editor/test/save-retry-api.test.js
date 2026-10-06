import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createApp } from '../server/index.js';
import { Store } from '../server/store.js';
import { FLV_HEADER } from '../server/ingest.js';
import { minimalMp4 } from './helpers/mp4-fixture.js';
import { saveRetryFixture, collideSave } from './helpers/save-retry-fixture.js';

// dev-env.ps1 places os.tmpdir() under the source .tools tree. Every Store and
// HTTP listener here is isolated from the deployed recorder and its data.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-save-retry-'));
async function appFor(t, name) {
  const base = path.join(root, name);
  const app = await createApp({automaticClean:false,preparation:false, port: 0, data: path.join(base, 'data'), projectRoot: base, noRecorder: true, compact: false, ffmpeg: 'must-not-launch', ffprobe: 'must-not-launch' });
  await app.startupRecovery;
  app.ingestor.stop();
  t.after(() => app.close());
  app.request = async (route, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/${route}`, body === undefined ? { headers } : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return app;
}
const rowOf = f => f.store.get('SELECT * FROM jobs WHERE id=?', f.job.id);
const detailsOf = f => JSON.parse(rowOf(f).data);
async function missing(file) { await assert.rejects(fs.access(file), error => error.code === 'ENOENT'); }

test('编码结束时目标目录已被移走，保存自动重建目录并清理自身临时成片', async t => {
  const app = await appFor(t, 'missing-destination');
  const f = await saveRetryFixture(app.store, app.media);
  await fs.rmdir(f.job.output.dir);
  await f.run();
  assert.equal(rowOf(f).status, 'done');
  for (const file of [f.job.output.file, f.job.output.danmakuFile]) assert.deepEqual(await fs.readFile(file), minimalMp4);
  assert.equal(detailsOf(f).canRetrySave, false);
  assert.equal(detailsOf(f).pendingPublication, undefined);
  assert.deepEqual(await fs.readdir(f.media.temporaryRoot), []);
  assert.deepEqual(await fs.readFile(f.original), FLV_HEADER);
});

for (const changeDirectory of [false, true]) {
  test(`HTTP 保存失败保留完整成片，${changeDirectory ? '换目录' : '原路径'}重试不重新编码且阻止保存中删除`, async t => {
    const app = await appFor(t, 'retry-' + changeDirectory);
    const f = await saveRetryFixture(app.store, app.media);
    const occupied = await collideSave(f), encodedCalls = f.calls.length;
    assert.equal(rowOf(f).status, 'save_failed');
    const pending = detailsOf(f).pendingPublication;
    assert.equal(detailsOf(f).canRetrySave, true);
    assert.ok(pending.directory.startsWith(f.media.temporaryRoot + path.sep));
    for (const name of ['final.mp4', 'final-danmaku.mp4']) assert.deepEqual(await fs.readFile(path.join(pending.directory, name)), minimalMp4);
    assert.equal(await fs.readFile(occupied, 'utf8'), '用户已有的视频，不能覆盖');
    await missing(f.job.output.file);
    const snapshot = app.snapshot().jobs.find(job => job.id === f.job.id);
    assert.equal(snapshot.canRetrySave, true);
    assert.equal(snapshot.exportDirectory, f.job.outputRoot);
    assert.equal((await app.request(`jobs/${f.job.id}/delete-preview`)).body.blocked, true);
    await assert.rejects(f.store.deleteSession(f.session.id, true), /导出|保存/);
    const foreign = await app.request(`jobs/${f.job.id}/retry-save`, {}, { Origin: 'https://example.invalid' });
    assert.equal(foreign.status, 403);
    assert.equal(rowOf(f).status, 'save_failed');
    if (!changeDirectory) await fs.unlink(occupied);
    const destination = path.join(root, 'retry-' + changeDirectory, 'new-output-root');
    let release, started;
    const entered = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const publish = f.media.publication.publish.bind(f.media.publication);
    t.mock.method(f.media.publication, 'publish', async (...args) => { started(); await held; return publish(...args); });
    try {
      const retry = await app.request(`jobs/${f.job.id}/retry-save`, changeDirectory ? { exportDirectory: destination } : {});
      assert.equal(retry.status, 200);
      assert.equal(retry.body.status, 'saving');
      await entered;
      assert.equal(rowOf(f).status, 'saving');
      assert.equal((await app.request(`jobs/${f.job.id}/delete-preview`)).body.blocked, true);
      await assert.rejects(f.store.deleteSession(f.session.id, true), /导出|保存/);
      const duplicate = await app.request(`jobs/${f.job.id}/retry-save`, {});
      assert.ok(duplicate.status >= 400);
    } finally { release(); await f.media.waitForSaves(); }
    assert.equal(rowOf(f).status, 'done');
    assert.equal(f.calls.length, encodedCalls, 'save retries must never launch an encoder');
    const saved = detailsOf(f);
    assert.equal(saved.canRetrySave, false);
    assert.equal(saved.pendingPublication, undefined);
    assert.equal(saved.publishedFiles.length, 2);
    for (const receipt of saved.publishedFiles) {
      assert.deepEqual(await fs.readFile(receipt.path), minimalMp4);
      assert.equal((await fs.lstat(receipt.path)).nlink, 1);
    }
    await missing(pending.directory);
    if (changeDirectory) {
      assert.equal(saved.outputRoot, destination);
      assert.equal(await fs.readFile(occupied, 'utf8'), '用户已有的视频，不能覆盖');
    }
    assert.deepEqual(await fs.readFile(f.original), FLV_HEADER);
    const successfulPreview = await app.request(`jobs/${f.job.id}/delete-preview`);
    assert.equal(successfulPreview.body.blocked, false);
    assert.ok((await app.request(`jobs/${f.job.id}/retry-save`, {})).status >= 400);
  });
}

test('真实进程退出后从保留的发布记录恢复待保存状态，并重试保存而不启动视频工具', async t => {
  const name = 'restarted', base = path.join(root, name), data = path.join(base, 'data');
  const child = `
    import { Store } from ${JSON.stringify(new URL('../server/store.js', import.meta.url).href)};
    import { saveRetryFixture, collideSave } from ${JSON.stringify(new URL('./helpers/save-retry-fixture.js', import.meta.url).href)};
    const store = new Store(${JSON.stringify(data)}); store.projectRoot = ${JSON.stringify(base)};
    const f = await saveRetryFixture(store, undefined, {scope:'full'}); await collideSave(f);
    const row = store.get('SELECT * FROM jobs WHERE id=?', f.job.id);
    if (row.status !== 'save_failed') throw new Error('fixture did not reach save failure: ' + row.error);
    const details = JSON.parse(row.data), directory = details.pendingPublication.directory;
    delete details.pendingPublication; delete details.canRetrySave;
    store.run("UPDATE jobs SET status='failed',data=? WHERE id=?", JSON.stringify(details), f.job.id);
    f.media.close(); store.close();
    process.stdout.write(JSON.stringify({id:f.job.id,directory}));
  `;
  const prior = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', child], { windowsHide: true, encoding: 'utf8' }));
  const app = await appFor(t, name);
  const restored = app.snapshot().jobs.find(job => job.id === prior.id);
  assert.equal(restored.status, 'save_failed');
  assert.equal(restored.canRetrySave, true);
  await fs.access(prior.directory);
  app.media.process = () => { throw new Error('retry must not launch video processing'); };
  const response = await app.request(`jobs/${prior.id}/retry-save`, { exportDirectory: path.join(base, 'recovered-outputs') });
  assert.equal(response.status, 200);
  await app.media.waitForSaves();
  const saved = app.store.get('SELECT * FROM jobs WHERE id=?', prior.id);
  assert.equal(saved.status, 'done', saved.error);
  const details = JSON.parse(saved.data);
  for (const receipt of details.publishedFiles) assert.deepEqual(await fs.readFile(receipt.path), minimalMp4);
  await missing(prior.directory);
});

for (const changed of [false, true]) {
  test(`临时成片已清理而完成状态未落库时，重启${changed ? '拒绝把被修改的输出标记成功' : '凭完整发布凭据恢复完成状态'}`, async t => {
    const name = 'committed-before-status-' + changed, base = path.join(root, name);
    const store = new Store(path.join(base, 'data')); store.projectRoot = base;
    const f = await saveRetryFixture(store);
    let finished;
    try {
      await f.run();
      assert.equal(rowOf(f).status, 'done');
      finished = detailsOf(f);
      finished.pendingPublication = { directory: path.join(f.media.temporaryRoot, 'bili-export-previously-cleaned'), jobId: f.job.id };
      finished.canRetrySave = true;
      store.run("UPDATE jobs SET status='saving',data=? WHERE id=?", JSON.stringify(finished), f.job.id);
      if (changed) await fs.appendFile(finished.publishedFiles[0].path, 'changed after publication');
    } finally { f.media.close(); store.close(); }
    const app = await appFor(t, name);
    const recovered = app.snapshot().jobs.find(job => job.id === f.job.id);
    if (changed) assert.notEqual(recovered.status, 'done');
    else {
      assert.equal(recovered.status, 'done');
      assert.equal(recovered.canRetrySave, false);
      assert.equal(recovered.progress, 1);
      for (const receipt of finished.publishedFiles) assert.deepEqual(await fs.readFile(receipt.path), minimalMp4);
    }
  });
}

test.after(async () => {
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('bili-save-retry-')) throw new Error('Unexpected test cleanup directory');
  await fs.rm(root, { recursive: true, force: true });
});
