import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { Store } from '../server/store.js';
import { BackgroundPreparation } from '../server/background-preparation.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(check) { const deadline = Date.now() + 2000; while (!check()) { if (Date.now() > deadline) throw new Error('condition not reached'); await new Promise(resolve => setTimeout(resolve, 5)); } }
const done = { done: true, preparedSeconds: 120, totalSeconds: 120, bytes: 1024 };
async function fixture(t, { existing = [], schedulerOptions = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-background-scheduler-')), store = new Store(root);
  const state = { now: 100000, busy: '', foreground: false, calls: [], invalidated: [] };
  const add = (id, status = 'finished') => {
    const session = store.createSession({ id, title: id, status });
    const source = store.addSource(id, path.join(root, id + '.flv'), 0, session.created, status === 'finished');
    store.run('UPDATE sources SET duration=120,closed=? WHERE id=?', status === 'finished' ? 2 : 0, source.id);
    store.run('UPDATE sessions SET duration=120 WHERE id=?', id);
    return { session, source };
  };
  for (const [id, status] of existing) add(id, status);
  const media = {
    hasForegroundWork: () => state.foreground,
    async prepareNext(id, options) { state.calls.push(id); return state.prepare ? state.prepare(id, options) : done; },
    async invalidatePreparation(id) { state.invalidated.push(id); },
  };
  const options = { now: () => state.now, busyReason: () => state.busy, idleGraceMs: 0, pollMs: 10, ...schedulerOptions };
  const scheduler = new BackgroundPreparation(store, media, options), schedulers = [scheduler];
  const restart = async () => { await schedulers.at(-1).close(); const replacement = new BackgroundPreparation(store, media, options); schedulers.push(replacement); return replacement; };
  t.after(async () => {
    for (const item of schedulers) await item.close(); store.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('bili-background-scheduler-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, store, state, media, scheduler, add, restart };
}

test('首次已完成历史不自动压制，已见活跃、新出现会话和显式历史请求可登记', async t => {
  const { scheduler, store, state, add } = await fixture(t, { existing: [['history', 'finished'], ['active', 'recording']] });
  assert.equal(scheduler.status('history'), null); assert.equal(scheduler.status('active').reason, 'source');
  await scheduler.tick(); assert.deepEqual(state.calls, []);
  store.run("UPDATE sessions SET status='finished' WHERE id='active'"); store.run("UPDATE sources SET closed=2 WHERE session='active'");
  await scheduler.tick(); assert.equal(scheduler.status('active').status, 'ready');
  add('new-import'); await scheduler.tick(); assert.equal(scheduler.status('new-import').status, 'ready');
  scheduler.enqueue('history'); await scheduler.tick(); assert.equal(scheduler.status('history').status, 'ready');
  assert.equal(scheduler.snapshot().items.length, 3);
});

test('seen 基线跨重启保留；离线期间新增的完成素材可发现，旧历史仍不自动开始', async t => {
  const { scheduler, state, add, restart } = await fixture(t, { existing: [['history', 'finished']] });
  await scheduler.close(); add('offline-new'); const next = await restart();
  await next.tick(); assert.deepEqual(state.calls, ['offline-new']); assert.equal(next.status('history'), null);
});

test('重复 tick/wake 单 worker，prepareNext 每次只推进一块，准备进度持久', async t => {
  const { scheduler, state } = await fixture(t, { existing: [['a', 'finished']] });
  const block = deferred(); let concurrent = 0, maxConcurrent = 0;
  state.prepare = async (id, { onProgress }) => { concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); onProgress({ preparedSeconds: 60, totalSeconds: 120, bytes: 512 }); await block.promise; concurrent--; return { ...done, done: false, preparedSeconds: 60, bytes: 512 }; };
  scheduler.enqueue('a'); const work = scheduler.tick(); await until(() => state.calls.length === 1);
  const peers = Array.from({ length: 10 }, () => scheduler.tick());
  assert.equal(scheduler.status('a').preparedSeconds, 60); assert.equal(scheduler.status('a').status, 'preparing');
  block.resolve(); await Promise.all([work, ...peers]); assert.equal(maxConcurrent, 1); assert.equal(state.calls.length, 1);
  state.prepare = null; await scheduler.tick(); assert.equal(scheduler.status('a').status, 'ready'); assert.equal(state.calls.length, 2);
});

test('前台请求等待后台取消完全结束，并在前台忙/quiet grace时禁止新块', async t => {
  const { scheduler, state } = await fixture(t, { existing: [['a', 'finished']], schedulerOptions: { idleGraceMs: 100 } });
  const settled = deferred(); let signal;
  state.prepare = async (id, options) => { signal = options.signal; await settled.promise; return done; };
  scheduler.enqueue('a'); await scheduler.tick(); state.now += 100; const work = scheduler.tick(); await until(() => !!signal);
  let yielded = false; const yielding = scheduler.yieldForForeground().then(() => { yielded = true; });
  await turn(); assert.ok(signal.aborted); assert.equal(yielded, false);
  state.foreground = true; settled.resolve(); await Promise.all([work, yielding]); assert.equal(scheduler.status('a').status, 'waiting');
  await scheduler.tick(); assert.equal(state.calls.length, 1);
  state.foreground = false; state.prepare = null; await scheduler.tick(); state.now += 99; await scheduler.tick(); assert.equal(state.calls.length, 1);
  state.now++; await scheduler.tick(); assert.equal(scheduler.status('a').status, 'ready');
});

test('多素材优先连续完成已有进度的一份，重启后仍保持顺序而不逐块轮转', async t => {
  const { scheduler, state, restart } = await fixture(t, { existing: [['a', 'finished'], ['b', 'finished']] });
  const blocks = new Map();
  state.prepare = async id => {
    const count = (blocks.get(id) || 0) + 1; blocks.set(id, count); state.now += 1000;
    return { done: count === 3, preparedSeconds: count * 40, totalSeconds: 120, bytes: count * 512 };
  };
  scheduler.enqueue('a'); scheduler.enqueue('b'); await scheduler.tick();
  assert.deepEqual(state.calls, ['a']); assert.equal(scheduler.status('a').preparedSeconds, 40);
  const next = await restart();
  await next.tick(); await next.tick();
  assert.deepEqual(state.calls, ['a', 'a', 'a']); assert.equal(next.status('a').status, 'ready');
  assert.equal(next.status('b').preparedSeconds, 0);
  await next.tick(); await next.tick(); await next.tick();
  assert.deepEqual(state.calls, ['a', 'a', 'a', 'b', 'b', 'b']); assert.equal(next.status('b').status, 'ready');
});

test('已有进度素材暂停或等待空间时让其他素材继续', async t => {
  for (const reason of ['paused', 'space']) {
    const { scheduler, state } = await fixture(t, { existing: [['a', 'finished'], ['b', 'finished']] });
    let aCalls = 0;
    state.prepare = async id => {
      state.now += 1000;
      if (id === 'b') return done;
      aCalls++;
      if (aCalls === 1) return { ...done, done: false, preparedSeconds: 60, bytes: 512 };
      if (reason === 'space') throw Object.assign(new Error('缓存容量不足'), { code: 'PREP_SPACE' });
      return done;
    };
    scheduler.enqueue('a'); scheduler.enqueue('b'); await scheduler.tick();
    if (reason === 'paused') await scheduler.pause('a'); else await scheduler.tick();
    await scheduler.tick();
    assert.equal(scheduler.status('b').status, 'ready');
    assert.equal(scheduler.status('a').preparedSeconds, 60);
    assert.equal(scheduler.status('a').status, reason === 'paused' ? 'paused' : 'waiting');
    assert.equal(state.calls.at(-1), 'b');
  }
});

test('录制/连接未知/真正波形解码均抢占；普通状态轮询不取消后台', async t => {
  for (const reason of ['recording', 'connection', 'waveform']) {
    const { scheduler, state } = await fixture(t, { existing: [[reason, 'finished']] });
    let signal; const settled = deferred();
    state.prepare = async (id, options) => { signal = options.signal; await settled.promise; return done; };
    scheduler.enqueue(reason); const work = scheduler.tick(); await until(() => !!signal);
    for (let n = 0; n < 30; n++) scheduler.snapshot(); assert.equal(signal.aborted, false);
    state.busy = reason; const busyTick = scheduler.tick(); assert.equal(signal.aborted, true);
    settled.resolve(); await Promise.all([work, busyTick]); assert.equal(scheduler.status(reason).reason, reason);
  }
});

test('全局关闭等待取消并持久，手动start只排队，显式单项暂停不被重新开启覆盖', async t => {
  const { scheduler, state, restart } = await fixture(t, { existing: [['a', 'finished'], ['b', 'finished']] });
  scheduler.enqueue('a'); scheduler.enqueue('b'); await scheduler.pause('b');
  const settled = deferred(); let signal;
  state.prepare = async (id, options) => { signal = options.signal; await settled.promise; return done; };
  const work = scheduler.tick(); await until(() => !!signal);
  let disabled = false; const disabling = scheduler.setEnabled(false).then(() => { disabled = true; });
  await turn(); assert.equal(disabled, false); assert.equal(signal.aborted, true); settled.resolve(); await Promise.all([work, disabling]);
  const next = await restart(); state.prepare = null;
  assert.equal(next.snapshot().enabled, false); next.enqueue('a'); await next.tick(); assert.equal(state.calls.length, 1);
  assert.equal(next.status('a').reason, 'disabled'); assert.equal(next.status('b').status, 'paused');
  await next.setEnabled(true); await next.tick(); assert.equal(next.status('a').status, 'ready'); assert.equal(next.status('b').status, 'paused');
});

test('空间不足30秒后才重试，其他错误停止自动重试，显式resume可以恢复', async t => {
  const { scheduler, state } = await fixture(t, { existing: [['a', 'finished']] });
  state.prepare = async () => { throw Object.assign(new Error('磁盘空间不足'), { code: 'PREP_SPACE' }); };
  scheduler.enqueue('a'); await scheduler.tick(); assert.equal(scheduler.status('a').reason, 'space');
  state.now += 29999; for (let n = 0; n < 10; n++) await scheduler.tick(); assert.equal(state.calls.length, 1);
  state.now++; state.prepare = async () => { throw new Error('损坏的素材'); }; await scheduler.tick(); assert.equal(scheduler.status('a').status, 'error');
  state.now += 1000000; await scheduler.tick(); assert.equal(state.calls.length, 2);
  scheduler.resume('a'); state.prepare = null; await scheduler.tick(); assert.equal(scheduler.status('a').status, 'ready');
});

test('缓存容量上限等待手动重试，不因其他素材完成或重启而反复重建', async t => {
  const { scheduler, store, state, restart } = await fixture(t, { existing: [['a', 'finished'], ['b', 'finished']] });
  let attempts = 0;
  state.prepare = async id => {
    state.now += 1000;
    if (id === 'b') return done;
    attempts++;
    if (attempts === 1) return { ...done, done: false, preparedSeconds: 60, bytes: 512 };
    if (attempts === 2) throw Object.assign(new Error('预处理缓存已达到容量限制，请释放空间后继续。'), { code: 'PREP_SPACE', capacity: true });
    return done;
  };
  scheduler.enqueue('a'); scheduler.enqueue('b'); await scheduler.tick(); await scheduler.tick();
  assert.equal(scheduler.status('a').reason, 'space');
  assert.equal(store.get('SELECT next_retry FROM preparation_jobs WHERE session=?', 'a').next_retry, Number.MAX_SAFE_INTEGER);
  await scheduler.tick(); assert.equal(scheduler.status('b').status, 'ready');
  state.now += 86400000; await scheduler.tick(); assert.deepEqual(state.calls, ['a', 'a', 'b']);
  const next = await restart(); await next.setEnabled(false); await next.setEnabled(true); await next.tick();
  assert.deepEqual(state.calls, ['a', 'a', 'b']);
  await next.invalidate('a'); await next.tick();
  assert.equal(next.status('a').reason, 'space'); assert.deepEqual(state.calls, ['a', 'a', 'b']);
  next.resume('a'); await next.tick(); assert.equal(next.status('a').status, 'ready');
  assert.deepEqual(state.calls, ['a', 'a', 'b', 'a']);
});

test('编辑失效隔离旧回包/进度并清计划，ready重排而用户暂停保留', async t => {
  const { scheduler, state } = await fixture(t, { existing: [['a', 'finished']] });
  const settled = deferred(); let options;
  state.prepare = async (id, input) => { options = input; await settled.promise; input.onProgress(done); return done; };
  scheduler.enqueue('a'); const work = scheduler.tick(); await until(() => !!options);
  const invalidating = scheduler.invalidate('a'); assert.equal(options.signal.aborted, true);
  settled.resolve(); await Promise.all([work, invalidating]);
  assert.equal(scheduler.status('a').preparedSeconds, 0); assert.equal(scheduler.status('a').status, 'queued'); assert.deepEqual(state.invalidated, ['a']);
  state.prepare = null; await scheduler.tick(); assert.equal(scheduler.status('a').status, 'ready');
  await scheduler.invalidate('a'); assert.equal(scheduler.status('a').status, 'queued');
  await scheduler.pause('a'); await scheduler.invalidate('a'); assert.equal(scheduler.status('a').status, 'paused');
});

test('cancelSession等待renderer后阻止回写和重排，forgetSession清理记录而不碰导出任务', async t => {
  const { scheduler, store, state } = await fixture(t, { existing: [['a', 'finished']] });
  for (const status of ['failed', 'cancelled', 'queued']) store.run('INSERT INTO jobs(id,session,status,data) VALUES(?,?,?,?)', status, 'a', status, '{}');
  const initialJobs = store.all('SELECT * FROM jobs ORDER BY id');
  const settled = deferred(); let options;
  state.prepare = async (id, input) => { options = input; await settled.promise; input.onProgress(done); return done; };
  scheduler.enqueue('a'); const work = scheduler.tick(); await until(() => !!options);
  let cancelled = false; const cancelling = scheduler.cancelSession('a').then(() => { cancelled = true; });
  await turn(); assert.equal(cancelled, false); settled.resolve(); await Promise.all([work, cancelling]);
  await scheduler.tick(); assert.equal(state.calls.length, 1); assert.equal(scheduler.status('a').preparedSeconds, 0);
  store.run("UPDATE sessions SET deleted_at='deleted' WHERE id='a'"); await scheduler.forgetSession('a'); scheduler.allowSession('a'); await scheduler.tick();
  assert.equal(store.get('SELECT COUNT(*) AS n FROM preparation_jobs').n, 0); assert.equal(scheduler.status('a'), null);
  assert.deepEqual(store.all('SELECT * FROM jobs ORDER BY id'), initialJobs);
});

test('close等待真实独立子进程退出；重启恢复preparing，不恢复显式paused/用户导出', async t => {
  const { scheduler, state, restart, store } = await fixture(t, { existing: [['a', 'finished'], ['b', 'finished']] });
  store.run("INSERT INTO jobs(id,session,status,data) VALUES('old-export','a','failed','{}')");
  let child, exited = false;
  state.prepare = async (id, { signal }) => {
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
    const stopped = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', () => { exited = true; resolve(); }); });
    const abort = () => child.kill(); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try { await stopped; return done; } finally { signal.removeEventListener('abort', abort); }
  };
  scheduler.enqueue('a'); scheduler.enqueue('b'); await scheduler.pause('b');
  const work = scheduler.tick(); await until(() => !!child?.pid); await scheduler.close(); await work;
  assert.equal(exited, true); assert.equal(scheduler.active, null); assert.equal(scheduler.timer, null);
  const next = await restart(); state.prepare = null; await next.tick();
  assert.equal(next.status('a').status, 'ready'); assert.equal(next.status('b').status, 'paused');
  assert.equal(store.get("SELECT status FROM jobs WHERE id='old-export'").status, 'failed');
});


test('successful full baked export settles failed or paused preparation across restart, without rebuilding cache',async t=>{
  const f=await fixture(t);f.add('exported');f.scheduler.enqueue('exported');
  const file=path.join(f.root,'【弹幕版】full.mp4');await fs.writeFile(file,'finished video');
  const data={scope:'full',mode:'danmaku',ranges:[{start:0,end:120}],excluded:[],filterLottery:true,output:{file:path.join(f.root,'full.mp4'),danmakuFile:file}};
  f.store.run('INSERT INTO jobs(id,session,status,file,mode,data) VALUES(?,?,?,?,?,?)','done','exported','done',file,'danmaku',JSON.stringify(data));
  f.store.run("UPDATE preparation_jobs SET status='error',error='选段不足一帧。',prepared_seconds=60,bytes=123 WHERE session='exported'");
  await f.scheduler.tick();assert.equal(f.scheduler.status('exported').status,'exported');assert.equal(f.scheduler.status('exported').error,'');assert.equal(f.scheduler.status('exported').bytes,123);assert.deepEqual(f.state.calls,[]);
  const next=await f.restart();await next.tick();assert.equal(next.status('exported').status,'exported');assert.deepEqual(f.state.calls,[]);
  const edit=f.store.edit('exported');f.store.saveEdit('exported',{...edit,excluded:['different-comment']});
  await next.invalidate('exported');await next.tick();assert.equal(next.status('exported').status,'ready');assert.deepEqual(f.state.calls,['exported']);
});

test('clean, clips, failed saves and missing baked files do not satisfy full baked preparation',async t=>{
  const f=await fixture(t);
  for(const [id,scope,mode,status,present] of [['clean','full','clean','done',true],['clip','clips','danmaku','done',true],['unsaved','full','dual','save_failed',true],['missing','full','danmaku','done',false]]){
    f.add(id);f.scheduler.enqueue(id);const file=path.join(f.root,id+'.mp4');if(present)await fs.writeFile(file,'video');
    const data={scope,mode,ranges:[{start:0,end:120}],excluded:[],output:{file,danmakuFile:file}};
    f.store.run('INSERT INTO jobs(id,session,status,file,mode,data) VALUES(?,?,?,?,?,?)',id,id,status,file,mode,JSON.stringify(data));
    await f.scheduler.tick();assert.equal(f.scheduler.status(id).status,'ready');assert.ok(f.state.calls.includes(id));
  }
});

test('full dual export reconciles while foreground is busy; deleting its output makes preparation eligible again',async t=>{
  const f=await fixture(t);f.add('dual');f.scheduler.enqueue('dual');
  const file=path.join(f.root,'【弹幕版】dual.mp4');await fs.writeFile(file,'baked video');
  const data={scope:'full',ranges:[{start:0,end:120}],excluded:[],output:{file:path.join(f.root,'dual.mp4'),danmakuFile:file}};
  f.store.run('INSERT INTO jobs(id,session,status,file,mode,data) VALUES(?,?,?,?,?,?)','dual','dual','done',data.output.file,'dual',JSON.stringify(data));
  f.state.foreground=true;await f.scheduler.tick();
  assert.equal(f.scheduler.status('dual').status,'exported');assert.deepEqual(f.state.calls,[]);
  await fs.unlink(file);await f.scheduler.tick();assert.equal(f.scheduler.status('dual').status,'queued');assert.deepEqual(f.state.calls,[]);
  f.state.foreground=false;await f.scheduler.tick();assert.equal(f.scheduler.status('dual').status,'ready');
});
