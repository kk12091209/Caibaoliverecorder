import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { BilibiliPublisher } from '../server/bilibili-publisher.js';

const uid = '4321';
const cookie = 'SESSDATA=test-session%2Cvalue; bili_jct=test-csrf; DedeUserID=4321; ignored_secret=unrelated';
const owner = { kind: 'quick', id: 'export-123' };
const allow = () => true;
const article = { title: '直播回放', desc: '直播内容', tag: ['直播', '回放'], tid: 171, copyright: 2,
  source: 'https://space.bilibili.com/999' };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'caibo-publisher-'));
  const db = new DatabaseSync(':memory:');
  const store = { root, db, run(sql, ...args) { return db.prepare(sql).run(...args); },
    get(sql, ...args) { return db.prepare(sql).get(...args); } };
  const files = [
    { path: path.join(root, '2026 - 弹幕版.mp4'), title: '弹幕版' },
    { path: path.join(root, '2026 - 纯净版.mp4'), title: '纯净版' },
  ];
  await Promise.all(files.map(part => fs.writeFile(part.path, 'synthetic video test fixture')));
  const requests = [];
  const state = { cookie, expired: false, mid: Number(uid) };
  const credentials = {
    get: () => state.cookie,
    snapshot: () => ({ platforms: { bilibili: { configured: true, expired: state.expired } } }),
  };

  class BiliResponseError extends Error {
    constructor(code, statusCode = 200) {
      super('sensitive details from fake platform');
      Object.assign(this, { statusCode, code });
    }
  }
  class Client {
    setAuth(values, accountUid) {
      this.auth = { values, accountUid };
      requests.push(['auth', values, accountUid]);
    }
    get user() {
      return {
        request: { defaults: {} },
        async getMyInfo() {
          requests.push(['verify']);
          await state.onVerify?.();
          return { profile: { mid: state.mid } };
        },
      };
    }
    get platform() {
      const request = { defaults: {} };
      return {
        request,
        async getArchivePre() {
          requests.push(['categories', { ...request.defaults }]);
          await state.onCategories?.();
          return { typelist: [
            { id: 1, name: '动画', children: [
              { id: 171, name: '综合', notice: 'internal response field' },
              { id: 172, name: '已隐藏', show: false },
            ] },
            { id: 4, name: '游戏', children: [{ id: 17, name: '单机游戏' }] },
            { id: 5, name: '无可选子分区', children: [] },
          ] };
        },
        async addMediaWebApiV3(parts, options) {
          requests.push(['commit', parts, options, { ...request.defaults }]);
          if (state.commit) return state.commit();
          return { aid: 443322, bvid: 'BV19wHRznExk' };
        },
      };
    }
  }
  class WebVideoUploader extends EventEmitter {
    constructor(part, auth, options) {
      super();
      this.part = part;
      this.request = { defaults: {} };
      requests.push(['uploader', part, auth.accountUid, options]);
    }
    async upload() {
      this.emit('progress', { event: 'uploading', progress: 0.5 });
      const index = files.findIndex(file => file.path === this.part.path);
      await state.onPart?.(this, index);
      return { cid: 111 + index, filename: `video-${index}`, title: 'untrusted returned title' };
    }
    cancel() { state.cancelPart?.(); }
  }

  const options = { loadSdk: async () => ({ Client, WebVideoUploader, BiliResponseError }) };
  let publisher;
  async function restart() {
    await publisher?.close();
    publisher = await new BilibiliPublisher(store, credentials, options).initialize();
    return publisher;
  }
  await restart();
  t.after(async () => { await publisher.close(); db.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { publisher, restart, store, root, state, requests, files, BiliResponseError };
}

const request = parts => ({ owner, uid, config: article, parts });
const taskRow = (store, id) => store.get('SELECT * FROM bilibili_publisher_jobs WHERE id=?', id);
const publication = taskId => ({ taskId, target: 'embedded' });

test('detects whether the saved recording Cookie supports posting without network activity', async t => {
  const { publisher, requests, state } = await fixture(t);
  assert.deepEqual(publisher.snapshot(), { accountUid: uid, cookieConfigured: true, configured: true, accountError: '' });
  assert.deepEqual(await publisher.account(), { uid, name: '' });
  state.cookie = 'SESSDATA=test-session; DedeUserID=4321';
  assert.equal(publisher.snapshot().configured, false);
  await assert.rejects(publisher.account(), /bili_jct/);
  state.cookie = '';
  state.expired = true;
  await assert.rejects(publisher.account(), /已失效/);
  assert.deepEqual(requests, []);
});

test('only offers visible Bilibili subcategories and revalidates after a Cookie change', async t => {
  const { publisher, requests, state, files, BiliResponseError } = await fixture(t);
  const [catalog, shared] = await Promise.all([publisher.categories(), publisher.categories()]);
  assert.deepEqual(catalog, [
    { id: '1', name: '动画', children: [{ id: '171', name: '综合' }] },
    { id: '4', name: '游戏', children: [{ id: '17', name: '单机游戏' }] },
  ]);
  assert.deepEqual(shared, catalog);
  for (const tid of [1, 172, 999999]) {
    await assert.rejects(publisher.submit({ ...request(files), config: { ...article, tid } }), /分区不可选/);
  }
  assert.deepEqual(requests.map(row => row[0]), ['auth', 'categories']);
  assert.equal(requests[1][1].maxRedirects, 0);
  assert.equal(requests[1][1].httpsAgent.options.rejectUnauthorized, true);
  state.cookie = cookie.replace('test-session', 'updated-session');
  state.onCategories = () => { throw new BiliResponseError(-101); };
  await assert.rejects(publisher.categories(), { message: 'B站 Cookie 已失效，请在设置中更新后重试。' });
  state.onCategories = undefined;
  assert.deepEqual(await publisher.categories(), catalog);
  assert.equal(requests.filter(row => row[0] === 'categories').length, 3);
});

test('arms only recorded tasks, sends one final ordered post, and preserves exports', async t => {
  const { publisher, requests, files, store } = await fixture(t);
  let checked = false;
  const queued = await publisher.submit({ ...request(files), beforeSend() { checked = true; } });
  assert.deepEqual(queued, publication(queued.taskId));
  assert.equal(checked, true);
  assert.equal(taskRow(store, queued.taskId).status, 'staged');
  assert.equal(publisher.hasWork(), false);
  await publisher.tick(allow);
  assert.deepEqual(requests.map(row => row[0]), ['auth', 'categories']);
  requests.length = 0;
  assert.equal((await publisher.task(queued.taskId, queued.target)).status, 'queued');
  assert.equal(publisher.hasWork(), true);
  await publisher.tick((candidate, thisUid, taskId) => {
    assert.deepEqual(candidate, owner);
    assert.equal(thisUid, uid);
    assert.equal(taskId, queued.taskId);
    return true;
  });
  assert.deepEqual(requests.map(row => row[0]), ['auth', 'verify', 'uploader', 'uploader', 'auth', 'verify', 'commit']);
  assert.deepEqual({ ...requests[0][1] }, { SESSDATA: 'test-session%2Cvalue', bili_jct: 'test-csrf', DedeUserID: uid });
  assert.deepEqual(requests[2][1], files[0]);
  assert.deepEqual(requests[3][1], files[1]);
  assert.deepEqual(requests[6][1], files.map((file, i) => ({ cid: 111 + i, filename: `video-${i}`, title: file.title })));
  assert.deepEqual(requests[6][2], { ...article, tag: '直播,回放', dolby: 0, lossless_music: 0 });
  assert.equal(requests[6][3].maxRedirects, 0);
  assert.equal(requests[6][3].httpsAgent.options.rejectUnauthorized, true);
  assert.deepEqual(await publisher.task(queued.taskId), { status: 'submitted', progress: 1, aid: '443322', bvid: 'BV19wHRznExk', canRetry: false });
  assert.equal(publisher.hasWork(), false);
  await publisher.tick(allow);
  assert.equal(requests.length, 7);
  assert.ok(!JSON.stringify(taskRow(store, queued.taskId)).includes('test-session'));
  for (const file of files) assert.equal(await fs.readFile(file.path, 'utf8'), 'synthetic video test fixture');
});

test('validates exported files and input before sending requests', async t => {
  const { publisher, requests, files, root } = await fixture(t);
  const folder = path.join(root, 'originals');
  await fs.mkdir(folder);
  const original = path.join(folder, 'original.mp4');
  await fs.writeFile(original, 'fixture');
  await assert.rejects(publisher.submit(request([{ path: original, title: '原片' }])), /已导出的成片/);
  await assert.rejects(publisher.submit(request([files[0], files[0]])), /路径重复/);
  await assert.rejects(publisher.submit(request([{ ...files[0], identity: 'mismatched prior receipt' }])), /成片已发生变化/);
  await assert.rejects(publisher.submit({ ...request(files), config: { ...article, source: '长'.repeat(201) } }), /转载/);
  assert.deepEqual(requests, []);
  await assert.rejects(publisher.submit({ ...request(files), beforeSend() { throw new Error('用户设置已改变'); } }), /设置已改变/);
  const posted = await publisher.submit(request(files));
  await publisher.task(posted.taskId);
  await fs.appendFile(files[0].path, 'modified');
  await publisher.tick(allow);
  assert.match((await publisher.task(posted.taskId)).error, /成片已发生变化/);
  assert.equal((await publisher.task(posted.taskId)).canRetry, true);
  assert.deepEqual(requests.map(row => row[0]), ['auth', 'categories']);
});

test('detects account mismatch and consent removal before final posting', async t => {
  const { publisher, requests, files, state } = await fixture(t);
  let posted = await publisher.submit(request(files));
  await publisher.task(posted.taskId);
  state.mid = 9999;
  await publisher.tick(allow);
  assert.match((await publisher.task(posted.taskId)).error, /账号.*不同/);
  assert.equal(requests.filter(row => row[0] === 'uploader').length, 0);
  posted = await publisher.submit(request(files));
  await publisher.task(posted.taskId);
  state.mid = Number(uid);
  state.onPart = () => { state.mid = 9999; };
  await publisher.tick(allow);
  assert.match((await publisher.task(posted.taskId)).error, /账号.*不同/);
  assert.equal(requests.filter(row => row[0] === 'commit').length, 0);
  posted = await publisher.submit(request(files));
  await publisher.task(posted.taskId);
  state.mid = Number(uid);
  let enabled = true;
  state.onPart = () => { enabled = false; };
  await publisher.tick(() => enabled);
  assert.equal((await publisher.task(posted.taskId)).status, 'cancelled');
  assert.equal(requests.filter(row => row[0] === 'commit').length, 0);
});

test('refreshes credentials between parts and never uses an unavailable Cookie', async t => {
  const { publisher, requests, files, state } = await fixture(t);
  let queued = await publisher.submit(request(files));
  await publisher.task(queued.taskId);
  state.onPart = () => { state.cookie = 'SESSDATA=different; DedeUserID=4321'; };
  await publisher.tick(allow);
  assert.equal(requests.filter(row => row[0] === 'uploader').length, 1);
  assert.equal(requests.filter(row => row[0] === 'commit').length, 0);
  assert.match((await publisher.task(queued.taskId)).error, /Cookie/);

  state.cookie = cookie;
  requests.length = 0;
  queued = await publisher.submit(request(files));
  await publisher.task(queued.taskId);
  state.onPart = () => { state.cookie = cookie.replace('test-session', 'updated-session'); };
  await publisher.tick(allow);
  assert.equal(requests.filter(row => row[0] === 'uploader').length, 2);
  assert.equal(requests.filter(row => row[0] === 'verify').length, 3);
  assert.equal(requests.filter(row => row[0] === 'auth').at(-1)[1].SESSDATA, 'updated-session%2Cvalue');
  assert.equal((await publisher.task(queued.taskId)).status, 'submitted');
});

test('tracks in-flight bytes and preserves possibly accepted submissions without retrying', async t => {
  const { publisher, requests, files, state, BiliResponseError } = await fixture(t);
  let current;
  state.onPart = async (_part, index) => {
    const status = await publisher.task(current.taskId);
    assert.equal(status.status, 'uploading');
    assert.ok(Math.abs(status.progress - (index ? 0.7425 : 0.2475)) < 1e-6);
  };
  state.commit = async () => {
    assert.equal((await publisher.task(current.taskId)).status, 'submitting');
    throw new Error('lost acknowledgement containing test-session%2Cvalue');
  };
  current = await publisher.submit(request(files));
  await publisher.task(current.taskId);
  await publisher.tick(allow);
  const uncertain = await publisher.task(current.taskId);
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(uncertain.canRetry, false);
  assert.match(uncertain.error, /创作中心/);
  assert.ok(!uncertain.error.includes('test-session'));
  await publisher.tick(allow);
  assert.equal(requests.filter(row => row[0] === 'commit').length, 1);
  current = await publisher.submit(request(files));
  await publisher.task(current.taskId);
  state.commit = () => { throw new BiliResponseError(123013); };
  await publisher.tick(allow);
  const failed = await publisher.task(current.taskId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.canRetry, true);
  assert.match(failed.error, /拒绝/);
  current = await publisher.submit(request(files));
  await publisher.task(current.taskId);
  state.commit = () => ({});
  await publisher.tick(allow);
  assert.equal((await publisher.task(current.taskId)).status, 'uncertain');
});

test('recovers interrupted uploads and never starts an orphan or resubmits an uncertain draft', async t => {
  const { publisher, requests, files, store, restart } = await fixture(t);
  const orphan = await publisher.submit(request(files));
  const interrupted = await publisher.submit(request(files));
  await publisher.task(interrupted.taskId);
  store.run("UPDATE bilibili_publisher_jobs SET status='uploading' WHERE id=?", interrupted.taskId);
  const possiblyAccepted = await publisher.submit(request(files));
  await publisher.task(possiblyAccepted.taskId);
  store.run("UPDATE bilibili_publisher_jobs SET status='submitting' WHERE id=?", possiblyAccepted.taskId);
  const restored = await restart();
  assert.equal(taskRow(store, orphan.taskId).status, 'staged');
  assert.equal((await restored.task(interrupted.taskId)).status, 'queued');
  assert.equal((await restored.task(possiblyAccepted.taskId)).status, 'uncertain');
  await assert.rejects(restored.task('old-external-task', '18010'), err => err.taskMissing === true);
  await restored.tick(allow);
  await restored.tick(allow);
  assert.equal(requests.filter(row => row[0] === 'commit').length, 1);
  assert.equal(taskRow(store, orphan.taskId).status, 'staged');
});

test('closing cancels an active upload without waiting for SDK retry timers', { timeout: 2000 }, async t => {
  const { publisher, files, state, requests } = await fixture(t);
  const queued = await publisher.submit(request(files));
  await publisher.task(queued.taskId);
  const entered = Promise.withResolvers();
  let cancelled = false;
  state.onPart = () => { entered.resolve(); return new Promise(() => {}); };
  state.cancelPart = () => { cancelled = true; };
  const work = publisher.tick(allow);
  await entered.promise;
  await publisher.close();
  await work;
  assert.equal(cancelled, true);
  assert.equal((await publisher.task(queued.taskId)).status, 'queued');
  assert.equal(requests.filter(row => row[0] === 'commit').length, 0);
});

test('closing while B站 could already have the draft records an uncertain submission', { timeout: 2000 }, async t => {
  const { publisher, files, state, requests } = await fixture(t);
  const queued = await publisher.submit(request(files));
  await publisher.task(queued.taskId);
  const entered = Promise.withResolvers();
  state.commit = () => { entered.resolve(); return new Promise(() => {}); };
  const work = publisher.tick(allow);
  await entered.promise;
  await publisher.close();
  await work;
  assert.equal((await publisher.task(queued.taskId)).status, 'uncertain');
  assert.equal(requests.filter(row => row[0] === 'commit').length, 1);
});

test('automatic upload caps aggregate throughput and yields without committing twice', async t => {
  const { publisher, requests, state, files } = await fixture(t);
  const { taskId } = await publisher.submit({ ...request(files), owner: { kind: 'auto', id: 'recording-123' } });
  await publisher.task(taskId);
  assert.equal(publisher.tick(allow, { automaticAllowed: false }), undefined);

  let started, finishPart;
  const entered = new Promise(resolve => { started = resolve; });
  state.onPart = () => new Promise(resolve => { finishPart = resolve; started(); });
  state.cancelPart = () => finishPart();
  const first = publisher.tick(allow);
  await entered;
  const options = requests.find(record => record[0] === 'uploader')[3];
  assert.equal(options.concurrency, 1);
  assert.equal(options.limitRate, 1024);
  publisher.yieldAutomaticUpload();
  await first;
  assert.equal((await publisher.task(taskId)).status, 'queued');
  assert.equal(requests.filter(record => record[0] === 'commit').length, 0);

  delete state.onPart;
  await publisher.tick(allow);
  assert.equal((await publisher.task(taskId)).status, 'submitted');
  const commits = requests.filter(record => record[0] === 'commit');
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0][1].map(part => part.title), ['弹幕版', '纯净版']);
});

test('P2 网络失败后跨重启重试沿用同一成片的 P1 回执，只提交一次', async t => {
  const { publisher, restart, requests, files, state } = await fixture(t);
  state.onPart = (_upload, index) => {
    if (index === 1) throw Object.assign(new Error('模拟网络断开'), {code:'ECONNRESET'});
  };
  const first = await publisher.submit(request(files));
  await publisher.task(first.taskId);
  await publisher.tick(allow);
  const failed = await publisher.task(first.taskId);
  assert.equal(failed.canRetry,true);
  assert.match(failed.error,/P2.*ECONNRESET/);
  assert.equal(requests.filter(entry => entry[0]==='commit').length,0);

  const next = await restart();
  state.onPart = undefined;
  requests.length = 0;
  const retry = await next.submit(request(files));
  await next.task(retry.taskId);
  await next.tick(allow);
  assert.deepEqual(requests.filter(entry => entry[0]==='uploader').map(entry => entry[1]),[files[1]]);
  const commits = requests.filter(entry => entry[0]==='commit');
  assert.equal(commits.length,1);
  assert.deepEqual(commits[0][1].map(part => part.title),files.map(file => file.title));
  assert.equal((await next.task(retry.taskId)).status,'submitted');
});
