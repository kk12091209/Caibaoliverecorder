import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.js';
import { ServiceRuntime } from '../server/service-runtime.js';
import { Media } from '../server/media.js';
import { Store } from '../server/store.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const running = new Map();
async function application(options) {
  const app = await createApp(options);
  const list = running.get(options.data) || []; list.push(app); running.set(options.data, list);
  return app;
}
async function fixture(t) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'caibo-startup-'));
  t.after(async () => { for (const app of running.get(data) || []) await app.close(); running.delete(data); await fs.rm(data, { recursive: true, force: true }); });
  return data;
}
const options = data => ({ data, port: 0, noRecorder: true, desktopManaged: true, compact: false, preparation: false, updatesAutoCheck: false, ffmpeg: 'not-launched', ffprobe: 'not-launched' });

test('启动阶段写入当天日志和实例状态，后台令牌不会进入状态文件', async t => {
  const data = await fixture(t), phases = [];
  const app = await application({ ...options(data), onStartup: phase => phases.push(phase) });
  t.after(() => app.close());
  await app.startupRecovery;
  const state = JSON.parse(await fs.readFile(app.runtime.startupFile));
  assert.equal(state.pid, process.pid);
  assert.equal(state.instance, app.runtime.instance);
  assert.equal(state.dataPath, await fs.realpath(data));
  assert.equal(state.ready, true);
  assert.equal(state.recoverable, true);
  assert.deepEqual(phases, ['检查数据目录与已有后台', '初始化运行日志', '打开素材数据库', '检查上次更新状态', '连接本地界面服务', '本地界面服务已就绪']);
  await app.diagnostics.pending;
  const log = await fs.readFile(path.join(data, 'logs', app.diagnostics.day + '.txt'), 'utf8');
  for (const phase of phases.slice(1)) assert.ok(log.includes(phase), phase);
  assert.ok(!JSON.stringify(state).includes(app.runtime.token));
  assert.ok(!log.includes(app.runtime.token));
  await app.close();
  await assert.rejects(fs.stat(app.runtime.startupFile), { code: 'ENOENT' });
});

test('慢速旧任务恢复期间界面可读取、独占锁保留，写入暂缓', async t => {
  const data = await fixture(t), recording = path.join(data, 'original.flv');
  await fs.writeFile(recording, 'original recording');
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  t.mock.method(Media.prototype, 'recoverPendingSaves', async () => { entered(); await gate; });
  const pending = application(options(data));
  try {
    await started;
    const app=await pending;
    const state=await fetch(app.runtime.origin+'/api/state').then(response=>response.json());
    assert.equal(state.recovery.recovering,true);
    const blocked=await fetch(app.runtime.origin+'/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(blocked.status,503);
    assert.equal(JSON.parse(await fs.readFile(app.runtime.startupFile)).ready,true);
    await assert.rejects(ServiceRuntime.acquire(data, appRoot, {}), { code: 'SERVICE_RUNNING' });
    assert.equal(await fs.readFile(recording, 'utf8'), 'original recording');
  } finally { release(); const app = await pending; await app.close(); }
});

test('旧任务恢复失败仍可打开界面，正常退出后可重启，原素材与设置保留', async t => {
  const data = await fixture(t), store = new Store(data);
  const session = store.createSession({ title: '保留的录像', status: 'finished' });
  store.setting('startup-sentinel', { retained: true });
  store.close();
  const recover = Media.prototype.recoverPendingSaves;
  let first = true;
  t.mock.method(Media.prototype, 'recoverPendingSaves', async function() {
    if (first) { first = false; throw new Error('simulated startup recovery failure'); }
    return recover.call(this);
  });
  const firstApp=await application(options(data));await firstApp.startupRecovery;
  assert.equal((await fetch(firstApp.runtime.origin+'/api/state')).status,200);
  assert.ok(firstApp.snapshot().recovery.error);
  await firstApp.close();
  const app = await application(options(data));
  t.after(() => app.close());
  assert.equal(app.store.session(session.id).title, '保留的录像');
  assert.deepEqual(app.store.setting('startup-sentinel'), { retained: true });
  assert.equal((await fetch(app.runtime.origin + '/api/state')).status, 200);
});

test('启动状态文件写入失败不会阻断后台启动，也不会删除其他实例状态', async t => {
  const data = await fixture(t);
  await fs.mkdir(path.join(data, 'desktop-startup-state.json'));
  const app = await application(options(data));
  assert.ok(app.port > 0);
  await fs.rmdir(app.runtime.startupFile);
  await fs.writeFile(app.runtime.startupFile, JSON.stringify({ instance: 'another-instance' }));
  await app.close();
  assert.equal(JSON.parse(await fs.readFile(app.runtime.startupFile)).instance, 'another-instance');
});

// Windows kill('SIGTERM') terminates the process without running a signal
// handler. Its authenticated desktop quit path is covered by desktop-exit.
test('实际后台收到恢复停止信号后保留导出恢复记录、录像和日志并安全退出', { skip: process.platform==='win32', timeout: 15000 }, async t => {
  const data = await fixture(t), original = path.join(data, 'existing.flv');
  await fs.writeFile(original, 'existing recording');
  const child = spawn(process.execPath, [path.join(appRoot, 'server/index.js')], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, EDITOR_DATA: data, EDITOR_PORT: '0', EDITOR_DESKTOP_MANAGED: '0', NO_RECORDER: '1', FFMPEG_PATH: process.execPath, FFPROBE_PATH: process.execPath }
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-8192); });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8192); });
  const stopped = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await stopped; } });
  for (let n = 0; n < 100 && !stdout.includes('录播机已启动'); n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(stdout.includes('录播机已启动'), stderr);
  const store = new Store(data), session = store.createSession({ title: '恢复测试', status: 'finished' }), id = randomUUID();
  store.setting('retained-setting', 'keep');
  store.run('INSERT INTO jobs(id,session,created,status,data) VALUES(?,?,?,?,?)', id, session.id, new Date().toISOString(), 'saving', JSON.stringify({ id, session: session.id, mode: 'clean' }));
  store.close();
  child.kill('SIGTERM');
  const [code, signal] = await stopped;
  assert.equal(code, 0, stderr); assert.equal(signal, null);
  const reopened = new Store(data);
  try {
    const row = reopened.get('SELECT status,data FROM jobs WHERE id=?', id);
    assert.equal(row.status, 'interrupted');
    assert.equal(JSON.parse(row.data).resumeOnLaunch, true);
    assert.equal(reopened.setting('retained-setting'), 'keep');
  } finally { reopened.close(); }
  assert.equal(await fs.readFile(original, 'utf8'), 'existing recording');
  const logs = (await fs.readdir(path.join(data, 'logs'))).filter(name => /^\d{4}-\d{2}-\d{2}\.txt$/.test(name));
  assert.ok(logs.length);
  const log = await fs.readFile(path.join(data, 'logs', logs.at(-1)), 'utf8');
  assert.ok(log.includes('收到 SIGTERM 停止请求'));
  assert.ok(log.includes('后台正常退出'));
  assert.ok(stdout.includes('[启动阶段] 打开素材数据库'));
});
