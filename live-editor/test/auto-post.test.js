import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AutoPost } from '../server/auto-post.js';
import { BackgroundPreparation } from '../server/background-preparation.js';
import { BilibiliPlatform } from '../server/bilibili-platform.js';
import { CompactStorage } from '../server/compact-storage.js';
import { clipFile } from '../server/output-names.js';
import { Store } from '../server/store.js';

const key = 'bilibili:123';
const settings = { enabled: true, titleTemplate: '直播回放｜{录制日期}', description: '示例简介',
  homepage: 'https://space.bilibili.com/123', tags: ['直播回放'], categoryId: '171', mode: 'dual', copyright: 2,
  source: 'https://live.bilibili.com/123', accountUid: '123' };

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caibo-auto-post-'));
  const store = new Store(root);
  t.after(async () => {
    await media.preparation?.close();
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const credentials = {
    cookie: '', configured: false,
    snapshot() { return { platforms: { bilibili: { configured: this.configured } } }; },
    get() { return this.cookie; },
  };
  const history = [];
  const media = { async enqueue(id, input, marker) {
    history.push({ id, ...input });
    store.run('INSERT INTO jobs(id,session,created,status,data,file,mode) VALUES(?,?,?,?,?,?,?)',
      'job:' + id, id, new Date().toISOString(), 'queued', JSON.stringify(marker), '', input.mode);
  } };
  const submitted = [];
  const publisher = {
    snapshot() {
      const accountUid = /DedeUserID=(\d+)/.exec(credentials.cookie)?.[1];
      const configured = !!accountUid && credentials.cookie.includes('bili_jct=');
      return { configured, accountUid, ...(configured ? {} : { accountError: 'B站 Cookie 缺少 bili_jct。' }) };
    },
    async assertCategory(id) { assert.equal(id, '171'); },
    async submit(input) { submitted.push(input); return { taskId: 'fixture-task' }; },
    async task(task) { assert.equal(task, 'fixture-task'); return { status: 'submitted', bvid: 'BVtest001' }; },
  };
  const recorder = new BilibiliPlatform(store);
  recorder.rooms = [{ roomId: 123 }];
  const service = (busy = () => false, sourceRecorder = recorder) =>
    new AutoPost(store, credentials, media, sourceRecorder, busy, publisher);
  return { root, store, credentials, history, submitted, publisher, media, service };
}

test('投稿到 B站需要其 Cookie，并且只为已有监控主播登记新素材', async t => {
  const { store, credentials, service } = await setup(t);
  const autoPost = service();
  assert.equal(autoPost.snapshot().cookieConfigured, false);
  await assert.rejects(() => autoPost.settings(key, settings), /Cookie/);
  credentials.configured = true;
  credentials.cookie = 'SESSDATA=synthetic; DedeUserID=123';
  assert.equal((await autoPost.settings(key)).account.uid, '123');
  await assert.rejects(() => autoPost.settings(key, settings), /bili_jct/);
  credentials.cookie += '; bili_jct=mock-csrf';
  await assert.rejects(() => autoPost.settings(key, { ...settings, accountUid: '456' }), /账号已改变/);
  await assert.rejects(() => autoPost.settings('douyin:123', settings), /找不到这个监控主播/);
  assert.equal((await autoPost.settings(key)).enabled, false);
  assert.equal((await autoPost.settings(key)).copyright, '');
  await assert.rejects(autoPost.settings(key, { ...settings, copyright: '' }), /自制或转载/);
  const earlier = store.createSession({ room: 123, created: '2000-01-01T12:00:00Z' });
  await autoPost.settings(key, settings);
  autoPost.capture(earlier, key);
  assert.equal(autoPost.snapshot().jobs.length, 0);
  assert.doesNotMatch(JSON.stringify(await autoPost.settings(key)), /SESSDATA|synthetic/);
  await autoPost.settings(key, { ...settings, enabled: false, categoryId: '1' });
  assert.equal((await autoPost.settings(key)).enabled, false);
});

test('封口后只建一个导出任务，恢复后继续同一任务并按指定顺序提交双版本投稿', async t => {
  const { root, store, credentials, service, history, submitted, media } = await setup(t);
  credentials.configured = true;
  credentials.cookie = 'SESSDATA=synthetic; DedeUserID=123; bili_jct=mock-csrf';
  const autoPost = service();
  await autoPost.settings(key, settings);
  const date = new Date(Date.now() + 1000);
  const session = store.createSession({ room: 123, created: date.toISOString() });
  const source = store.addSource(session.id, path.join(root, 'original.flv'), 0, session.created, false);
  autoPost.capture(session, key);
  autoPost.capture(session, key);
  await autoPost.tick();
  assert.equal(history.length, 0);
  store.run("UPDATE sessions SET duration=3,status='finished' WHERE id=?", session.id);
  await autoPost.tick();
  assert.equal(history.length, 0);
  store.run('UPDATE sources SET closed=2 WHERE id=?', source.id);
  await autoPost.tick();
  assert.deepEqual(history, [{ id: session.id, scope: 'full', mode: 'dual' }]);
  const recovered = service();
  await recovered.tick();
  assert.equal(history.length, 1);
  const clean = path.join(root, '202611221530-202611221531.mp4'), danmaku = clipFile(clean, 'danmaku');
  await fs.writeFile(clean, 'fixture');
  await fs.writeFile(danmaku, 'fixture');
  store.run("UPDATE jobs SET status='done',file=?,data=json_set(data,'$.output',json(?)) WHERE session=?",
    clean, JSON.stringify({ danmakuFile: danmaku }), session.id);
  credentials.cookie = 'SESSDATA=other-synthetic; DedeUserID=456';
  await recovered.tick();
  assert.equal(recovered.snapshot().jobs[0].status, 'blocked');
  credentials.cookie = 'SESSDATA=synthetic; DedeUserID=123; bili_jct=mock-csrf';
  const jobId = 'job:' + session.id;
  const exportFinalizer = Promise.withResolvers(), finalizerWaited = Promise.withResolvers();
  media.exportOperations = new Map([[jobId, {done:{then(resolve, reject) {
    finalizerWaited.resolve();
    return exportFinalizer.promise.then(resolve, reject);
  }}}]]);
  const submission = recovered.tick();
  try {
    assert.equal(await Promise.race([finalizerWaited.promise.then(() => true), submission.then(() => false)]), true);
    assert.equal(submitted.length, 0);
    store.run("UPDATE jobs SET data=json_set(data,'$.performance',json(?)) WHERE id=?", '{"elapsedMs":15}', jobId);
  } finally {
    media.exportOperations.delete(jobId);
    exportFinalizer.resolve();
    await submission;
  }
  assert.equal(recovered.snapshot().jobs[0].status, 'uploading', recovered.snapshot().jobs[0].error);
  assert.deepEqual(recovered.snapshot().jobs[0].parts, [{ title: '弹幕版' }, { title: '纯净版' }]);
  assert.equal(recovered.snapshot().jobs[0].status, 'uploading');
  assert.equal(recovered.isUploadingExport('job:' + session.id), true);
  await recovered.tick();
  assert.equal(recovered.snapshot().jobs[0].status, 'submitted');
  assert.equal(recovered.isUploadingExport('job:' + session.id), false);
  const { result } = store.get('SELECT result FROM auto_post_jobs WHERE session=?', session.id);
  assert.deepEqual(JSON.parse(result).parts.map(part => part.path), [danmaku, clean]);
  assert.equal(JSON.parse(result).taskId, 'fixture-task');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].config.desc, '示例简介\n主页链接：https://space.bilibili.com/123');
  assert.deepEqual(submitted[0].parts.map(part => part.title), ['弹幕版', '纯净版']);
  assert.equal(history.length, 1);
});

test('自动投稿优先预处理同一素材并在完成后只创建一次导出', async t => {
  const { root, store, credentials, media, history, service } = await setup(t);
  credentials.configured = true;
  credentials.cookie = 'SESSDATA=synthetic; DedeUserID=123; bili_jct=mock-csrf';
  const preparation = media.preparation = new BackgroundPreparation(store, media, { idleGraceMs: 0 });
  t.mock.method(preparation, 'wake', () => {});
  preparation.start();
  const prepared = [];
  media.prepareNext = async id => {
    prepared.push(id);
    return { done: true, preparedSeconds: 3, totalSeconds: 3, bytes: 0 };
  };
  function finished(name, created) {
    const session = store.createSession({ room: 123, status: 'finished', created });
    const source = store.addSource(session.id, path.join(root, name + '.flv'), 0, created, true);
    store.run('UPDATE sessions SET duration=3 WHERE id=?', session.id);
    store.run('UPDATE sources SET closed=2 WHERE id=?', source.id);
    preparation.enqueue(session.id);
    return session;
  }
  const other = finished('unrelated', '2000-01-01T00:00:00Z');
  store.run('UPDATE preparation_jobs SET prepared_seconds=2 WHERE session=?', other.id);
  const autoPost = service();
  await autoPost.settings(key, settings);
  const session = finished('auto', new Date(Date.now() + 1000).toISOString());
  autoPost.capture(session, key);
  await autoPost.tick();
  assert.equal(autoPost.snapshot().jobs[0].stage, 'waiting-preparation');
  assert.deepEqual(history, []);
  await preparation.tick();
  assert.deepEqual(prepared, [session.id]);
  await autoPost.tick();
  await autoPost.tick();
  assert.deepEqual(history, [{ id: session.id, scope: 'full', mode: 'dual' }]);

  const failed = finished('failed', new Date(Date.now() + 2000).toISOString());
  autoPost.capture(failed, key);
  store.run("UPDATE preparation_jobs SET status='error' WHERE session=?", failed.id);
  await autoPost.tick();
  assert.equal(history.at(-1).id, failed.id);
});

test('录制中开启自动投稿可登记当前场，只在手动停止并完成文件收尾后导出', async t => {
  const { root, store, credentials, service, history } = await setup(t);
  credentials.configured = true;
  credentials.cookie = 'SESSDATA=synthetic; DedeUserID=123; bili_jct=mock-csrf';
  const autoPost = service();
  const current = store.createSession({ room: 123, created: '2026-11-22T16:01:00Z' });
  const source = store.addSource(current.id, path.join(root, 'live.flv'), 0, current.created, false);
  store.run('INSERT INTO source_storage(source,eligible) VALUES(?,1)', source.id);
  const old = store.createSession({ room: 123, status: 'finished', created: '2026-11-22T12:00:00Z' });
  const stale = store.addSource(old.id, path.join(root, 'old.flv'), 0, old.created, false);
  store.run('INSERT INTO source_storage(source,eligible) VALUES(?,1)', stale.id);
  const imported = store.createSession({ room: 123, created: '2026-11-22T16:05:00Z' });
  store.addSource(imported.id, path.join(root, 'imported.flv'), 0, imported.created, false);

  autoPost.capture(current, key);
  assert.deepEqual(autoPost.snapshot().jobs, []);
  await autoPost.settings(key, settings);
  await autoPost.settings(key, settings);
  assert.deepEqual(autoPost.snapshot().jobs.map(job => [job.session, job.title]),
    [[current.id, '直播回放｜11月23日']]);
  await autoPost.tick();
  assert.equal(history.length, 0);

  store.run("UPDATE sessions SET status='finishing',duration=3 WHERE id=?", current.id);
  await autoPost.tick();
  assert.equal(history.length, 0);
  store.run('UPDATE sources SET closed=2 WHERE id=?', source.id);
  store.run("UPDATE sessions SET status='finished' WHERE id=?", current.id);
  await autoPost.tick();
  await autoPost.tick();
  assert.deepEqual(history, [{ id: current.id, scope: 'full', mode: 'dual' }]);
});

test('素材整理的空轮询不会阻止同一轮自动导出', async t => {
  const { root, store, credentials, service, history } = await setup(t);
  credentials.configured = true;
  credentials.cookie = 'SESSDATA=synthetic; DedeUserID=123; bili_jct=mock-csrf';
  const storage = new CompactStorage(store);
  const autoPost = service(() => storage.busy);
  await autoPost.settings(key, settings);
  const created = new Date(Date.now() + 1000).toISOString();
  const session = store.createSession({ room: 123, status: 'finished', created });
  const source = store.addSource(session.id, path.join(root, 'sealed.flv'), 0, created, true);
  store.run('UPDATE sessions SET duration=3 WHERE id=?', session.id);
  store.run('UPDATE sources SET closed=2 WHERE id=?', source.id);
  store.run("INSERT INTO source_storage(source,eligible,mode,status) VALUES(?,1,'direct','done')", source.id);
  autoPost.capture(session, key);

  // The production timer launches both operations without awaiting either.
  const posting = autoPost.tick();
  const compaction = storage.tick();
  await Promise.all([posting, compaction]);
  assert.deepEqual(history, [{ id: session.id, scope: 'full', mode: 'dual' }]);
  assert.equal(autoPost.snapshot().jobs[0].status, 'exporting');
});

test('抖音和小红书可以投稿到同一个 B站账号，主播设置和录像分别归属', async t => {
  const { root, store, credentials, service, history } = await setup(t);
  credentials.configured = true;
  credentials.cookie = 'SESSDATA=synthetic; DedeUserID=123; bili_jct=mock-csrf';
  const douyin = 'douyin-user:123', xiaohongshu = 'xiaohongshu-user:abcdef0123456789abcdef01';
  const open = new Map();
  const recorder = { anchors: [key, douyin, xiaohongshu].map(key => ({ key })),
    recordingForAnchor: key => open.get(key) };
  const autoPost = service(undefined, recorder);
  await autoPost.settings(key, { ...settings, enabled: false });
  await autoPost.settings(douyin, { ...settings, homepage: 'https://www.douyin.com/user/EXAMPLE123', titleTemplate: '抖音录像' });
  const xhsSession = store.createSession({ room: 0 });
  open.set(xiaohongshu, xhsSession);
  await autoPost.settings(xiaohongshu, { ...settings, homepage: 'https://xhslink.cn/o/example', titleTemplate: '小红书录像', mode: 'clean' });
  const douyinSession = store.createSession({ room: 0, created: new Date(Date.now() + 1000).toISOString() });
  autoPost.capture(douyinSession, douyin);
  autoPost.capture(douyinSession, douyin);
  const legacyImport = store.createSession({ room: 0, status: 'finished' });
  autoPost.capture(legacyImport);

  assert.equal((await autoPost.settings(key)).enabled, false);
  assert.equal((await autoPost.settings(douyin)).titleTemplate, '抖音录像');
  assert.equal((await autoPost.settings(xiaohongshu)).mode, 'clean');
  assert.deepEqual(autoPost.snapshot().jobs.map(job => [job.session, job.title]),
    [[douyinSession.id, '抖音录像'], [xhsSession.id, '小红书录像']]);
  await autoPost.tick();
  assert.deepEqual(history, []);

  for (const session of [xhsSession, douyinSession]) {
    const source = store.addSource(session.id, path.join(root, session.id + '.flv'), 0, session.created, true);
    store.run('UPDATE sources SET closed=2 WHERE id=?', source.id);
    store.run("UPDATE sessions SET duration=3,status='finished' WHERE id=?", session.id);
  }
  await autoPost.tick();
  await autoPost.tick();
  assert.deepEqual(history, [{ id: xhsSession.id, scope: 'full', mode: 'clean' },
    { id: douyinSession.id, scope: 'full', mode: 'dual' }]);
  autoPost.remove(xiaohongshu);
  assert.equal(autoPost.snapshot().jobs.find(job => job.session === xhsSession.id).status, 'cancelled');
  assert.equal(autoPost.snapshot().jobs.find(job => job.session === douyinSession.id).status, 'exporting');
});

test('抖音旧直播间识别为主播后沿用原投稿授权和排队任务', async t => {
  const { store, credentials, service } = await setup(t);
  credentials.configured = true;
  credentials.cookie = 'SESSDATA=synthetic; DedeUserID=123; bili_jct=mock-csrf';
  const previous = 'douyin:123', key = 'douyin-user:911';
  const session = store.createSession({ room: 0 });
  const recorder = { anchors: [{ key: previous }], recordingForAnchor: () => session };
  const autoPost = service(undefined, recorder);
  await autoPost.settings(previous, settings);
  autoPost.moveAnchor(previous, key);
  recorder.anchors = [{ key }];
  await autoPost.tick();
  assert.equal(autoPost.snapshot().jobs[0].status, 'queued');
  assert.equal((await autoPost.settings(key)).enabled, true);
  assert.equal(store.setting('bilibili-auto-post:'+previous), undefined);
  assert.equal(store.get('SELECT room FROM auto_post_jobs WHERE session=?', session.id).room, key);
});


test('以前只同意模拟的设置不会升级为真实授权', async t => {
  const { root, store, credentials, service, history, submitted } = await setup(t);
  credentials.configured = true;
  credentials.cookie = 'SESSDATA=synthetic; DedeUserID=123; bili_jct=mock-csrf';
  const legacyConfig = { ...settings, uid: '123', enabledAt: 0, title: '旧模拟稿件' };
  store.setting('bilibili-auto-post:123', legacyConfig);
  const autoPost = service();
  const session = store.createSession({ room: 123, status: 'finished' });
  const source = store.addSource(session.id, path.join(root, 'old.flv'), 0, session.created, true);
  store.run('UPDATE sources SET closed=2 WHERE id=?', source.id);
  store.run('UPDATE sessions SET duration=3 WHERE id=?', session.id);
  store.run("INSERT INTO auto_post_jobs(session,room,config,status) VALUES(?,?,?,'queued')",
    session.id, '123', JSON.stringify(legacyConfig));
  const saved = await autoPost.settings(key);
  assert.equal(saved.enabled, false);
  assert.equal(saved.titleTemplate, settings.titleTemplate);
  await autoPost.tick();
  assert.equal(autoPost.snapshot().jobs[0].status, 'cancelled');
  assert.deepEqual(history, []);
  assert.deepEqual(submitted, []);
});

test('上传工具响应丢失时保留待核对状态，重启或重试不会重复提交', async t => {
  const { root, store, credentials, service, publisher } = await setup(t);
  credentials.configured = true;
  credentials.cookie = 'SESSDATA=synthetic; DedeUserID=123; bili_jct=mock-csrf';
  const autoPost = service();
  await autoPost.settings(key, { ...settings, homepage: '  ' });
  const session = store.createSession({ room: 123, status: 'finished', created: new Date(Date.now() + 1000).toISOString() });
  const source = store.addSource(session.id, path.join(root, 'original.flv'), 0, session.created, true);
  store.run('UPDATE sessions SET duration=3 WHERE id=?', session.id);
  store.run('UPDATE sources SET closed=2 WHERE id=?', source.id);
  autoPost.capture(session, key);
  await autoPost.tick();
  const clean = path.join(root, 'existing.mp4');
  await fs.writeFile(clean, 'fixture');
  const danmaku = clipFile(clean, 'danmaku');
  await fs.writeFile(danmaku, 'fixture');
  store.run("UPDATE jobs SET status='done',file=?,data=json_set(data,'$.output',json(?)) WHERE session=?",
    clean, JSON.stringify({ danmakuFile: danmaku }), session.id);
  let attempts = 0;
  let description;
  publisher.submit = async ({ config }) => {
    attempts++;
    description = config.desc;
    throw Object.assign(new Error('response lost'), { submissionUncertain: true });
  };
  await autoPost.tick();
  const recovered = service();
  await recovered.tick();
  assert.equal(recovered.snapshot().jobs[0].status, 'uncertain');
  assert.throws(() => recovered.retry(session.id), /核对/);
  assert.equal(attempts, 1);
  assert.equal(description, settings.description);
});

test('关闭再开启不会补投已取消的成片，显式重开可登记正在录的场次', async t => {
  const { root, store, credentials, service, history } = await setup(t);
  credentials.configured = true;
  credentials.cookie = 'SESSDATA=synthetic; DedeUserID=123; bili_jct=mock-csrf';
  const autoPost = service();
  await autoPost.settings(key, settings);
  const previous = store.createSession({ room: 123, status: 'finished', created: new Date(Date.now() + 1000).toISOString() });
  autoPost.capture(previous, key);
  const previousTitle = autoPost.snapshot().jobs[0].title;
  const current = store.createSession({ room: 123, status: 'recording', created: new Date(Date.now() + 2000).toISOString() });
  const source = store.addSource(current.id, path.join(root, 'current.flv'), 0, current.created, false);
  store.run('INSERT INTO source_storage(source,eligible) VALUES(?,1)', source.id);
  autoPost.capture(current, key);
  await autoPost.settings(key, { ...settings, enabled: false });
  assert(autoPost.snapshot().jobs.every(job => job.status === 'cancelled'));
  await autoPost.settings(key, { ...settings, titleTemplate: '重新开启后的标题' });
  await autoPost.tick();
  assert.deepEqual(autoPost.snapshot().jobs.map(job => [job.status, job.title]), [
    ['queued', '重新开启后的标题'], ['cancelled', previousTitle],
  ]);
  assert.deepEqual(history, []);
});
