import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../server/store.js';
import { TemporaryWorkspaces } from '../server/temp-workspaces.js';
import { temporaryCleanupOptions, reviewStorageCleanup, reconcileTemporaryReceipts } from '../server/storage-cleanup.js';

const markerName = '.bili-temp-owner.json';
const missing = file => assert.rejects(fs.access(file), { code: 'ENOENT' });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caibo-upgrade-cleanup-'));
  const data = path.join(root, 'data'), temp = path.join(data, 'temp');
  let store = new Store(data);
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const manager = () => new TemporaryWorkspaces(temp, { ...temporaryCleanupOptions(store), processAlive: () => false });
  return {
    root, data, temp, manager, get store() { return store; },
    restart() { store.close(); store = new Store(data); return manager(); },
  };
}

test('r6 工作区跨更新恢复，已删除素材的已知文件可释放，未知文件可复核和单项确认', async t => {
  const f = await fixture(t);
  const previous = process.env.CAIBO_R6_EDITOR || (process.env.CAIBO_PREVIOUS_DESKTOP &&
    path.join(path.dirname(process.env.CAIBO_PREVIOUS_DESKTOP), '程序组件', 'live-editor'));
  const R6 = previous ? (await import(pathToFileURL(path.join(previous, 'server', 'temp-workspaces.js')).href)).TemporaryWorkspaces : TemporaryWorkspaces;
  const old = new R6(f.temp, { processAlive: () => false });
  const directory = await old.create('bili-export-', 'deleted-yesterday');
  assert.equal(f.store.session('deleted-yesterday'), undefined);
  const large = path.join(directory, 'video.mp4'), split = path.join(directory, 'part-0-block-0.mp4');
  const gift = path.join(directory, 'gift-default-gift.png'), review = path.join(directory, 'check-me.txt');
  for (const file of [large, split, gift, review]) await fs.writeFile(file, Buffer.alloc(8192));
  old.active.clear(); // The previous service exited before it could remove this work.
  if (previous) {
    await old.cleanupStale();
    await fs.access(large); // Release r6 rejects the entire set.
  }
  const unverified = path.join(f.temp, 'bili-export-unverified');
  await fs.mkdir(unverified);
  await fs.writeFile(path.join(unverified, 'final.mp4'), 'no ownership evidence');
  const pending = await old.create('bili-export-', 'deleted-yesterday');
  const final = path.join(pending, 'final.mp4');
  await fs.writeFile(final, 'only encoded copy');
  // An old record may still point to a workspace even if its retained marker
  // was lost. The upgrade must preserve its staged video.
  f.store.run("INSERT INTO jobs(id,status,file,data) VALUES('waiting','save_failed','',?)", JSON.stringify({pendingPublication:{directory:pending}}));
  const original = path.join(f.data, 'originals', 'neighbor.flv'), exported = path.join(f.root, 'exported.mp4');
  await fs.mkdir(path.dirname(original));
  await fs.writeFile(original, 'another recording');
  await fs.writeFile(exported, 'already saved');
  f.store.run('INSERT INTO cleanup_retained VALUES(?,?,?)', 'deleted-yesterday', '昨日素材', JSON.stringify([{path:review,reason:'待核实'}]));

  const current = f.restart();
  assert.ok(current.isReferenced(pending), JSON.stringify(f.store.all("SELECT id, data FROM jobs")));
  await current.cleanupStale();
  for (const file of [large, split, gift]) await missing(file);
  const snapshot = await reviewStorageCleanup(f.store, current);
  assert.equal(snapshot.removedBytes, 8192 * 3);
  assert.ok(snapshot.usage.temporary.bytes >= 8192);
  assert.equal(snapshot.workspaces.find(item => item.path === pending).status, 'retained');
  const noProof = snapshot.workspaces.find(item => item.path === unverified);
  assert.equal(noProof.status, 'unverified');
  assert.equal(noProof.files[0].confirmation, undefined);
  const entry = snapshot.workspaces.find(item => item.path === directory).files[0];
  assert.equal(entry.name, 'check-me.txt');
  const selection = { directory: path.basename(directory), file: entry.name, confirmation: entry.confirmation };
  await assert.rejects(current.removeReviewed(selection), /确认/);
  await current.removeReviewed({ ...selection, confirmed:true });
  await reconcileTemporaryReceipts(f.store, current);
  assert.deepEqual(f.store.retainedCleanup(), []);
  await missing(directory);
  assert.equal(await fs.readFile(final,'utf8'), 'only encoded copy');
  assert.equal(await fs.readFile(original,'utf8'), 'another recording');
  assert.equal(await fs.readFile(exported,'utf8'), 'already saved');
  await fs.access(path.join(unverified,'final.mp4'));
});

test('录制核心命令补全标记计入目录用量，陌生内容仍留在待核对列表', async t => {
  const f = await fixture(t), temporary = f.manager();
  const directory = path.join(f.temp, 'system-commandline-sentinel-files');
  const marker = path.join(directory, 'dotnet-suggest-registration-BililiveRecorder.Cli, Version=0.4.9.0, Culture=neutral, PublicKeyToken=null');
  const contents = 'dotnet-suggest output';
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(marker, contents);
  await temporary.cleanupStale();
  const snapshot = await reviewStorageCleanup(f.store, temporary);
  assert.equal(snapshot.usage.temporary.bytes, Buffer.byteLength(contents));
  assert.deepEqual(snapshot.workspaces, []);
  assert.equal(snapshot.removedBytes, 0);

  const other = path.join(directory, 'unknown.mp4');
  await fs.writeFile(other, 'preserve this');
  await temporary.cleanupStale();
  const withUnknown = await reviewStorageCleanup(f.store, temporary);
  assert.equal(withUnknown.workspaces.find(item => item.path === directory)?.status, 'unverified');
  assert.equal(await fs.readFile(marker, 'utf8'), contents);
  assert.equal(await fs.readFile(other, 'utf8'), 'preserve this');
});

test('临时文件按项重试，重启后保留同路径的替换文件和新增文件', async t => {
  const f = await fixture(t), before = f.manager();
  const directory = await before.create('bili-export-', 'old-cut');
  const locked = path.join(directory,'part-0.mp4'), free = path.join(directory,'part-1.mp4');
  await fs.writeFile(locked,'old locked');
  await fs.writeFile(free,'free');
  before.active.clear();
  const unlink = fs.unlink.bind(fs);
  const mock = t.mock.method(fs,'unlink',file => file===locked ?
    Promise.reject(Object.assign(new Error('locked'),{code:'EBUSY'})) : unlink(file));
  try { await before.cleanupStale(); } finally { mock.mock.restore(); }
  await missing(free);
  assert.equal((await before.review())[0].files.find(file=>file.name==='part-0.mp4').status,'waiting');
  const newer = path.join(directory,'part-2.mp4');
  await fs.writeFile(locked,'same name, different file');
  await fs.writeFile(newer,'new file');
  const after = f.restart();
  await after.cleanupStale();
  assert.equal(await fs.readFile(locked,'utf8'),'same name, different file');
  assert.equal(await fs.readFile(newer,'utf8'),'new file');
  const entry = (await after.review())[0].files.find(file=>file.name==='part-0.mp4');
  await fs.appendFile(locked,' changed after review');
  await assert.rejects(after.removeReviewed({directory:path.basename(directory),file:entry.name,confirmation:entry.confirmation,confirmed:true}), /已变化/);
  await fs.access(path.join(directory,markerName));
});

test('在 Windows 上确实持有 NTFS 删除共享锁时，下一文件仍可释放且解锁后可重试', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), before = f.manager();
  const directory = await before.create('bili-export-','ntfs-fixture');
  const locked = path.join(directory,'part-0.mp4'), free = path.join(directory,'part-1.mp4');
  await fs.writeFile(locked,'held'); await fs.writeFile(free,'free'); before.active.clear();
  const script = path.join(f.root,'hold-lock.ps1');
  await fs.writeFile(script, 'param($File)\n$ErrorActionPreference = "Stop"\n$hold = [IO.File]::Open($File, "Open", "Read", "Read")\ntry { [Console]::WriteLine("held"); [void][Console]::ReadLine() } finally { $hold.Dispose() }');
  const holder = spawn('powershell.exe',['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',script,locked],{windowsHide:true});
  const closed = once(holder,'close');
  let ready;
  try {
    ready = await Promise.race([once(holder.stdout,'data').then(([text])=>String(text)), closed.then(()=>'' )]);
    assert.match(ready,/held/);
    await before.cleanupStale();
    await missing(free);
    await fs.access(locked);
  } finally { holder.stdin.end('\n'); await closed; }
  await f.restart().cleanupStale();
  await missing(directory);
});
