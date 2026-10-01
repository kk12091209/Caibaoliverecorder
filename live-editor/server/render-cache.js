import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { checkedFile, fingerprint, pathKey } from './storage-files.js';

const GiB = 1024 ** 3, ID = /^[\w-]{1,100}$/, KEY = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const OWNER_FORMAT = 'render-cache-owner-v1', FORMAT = 'render-cache-entry-v1';
const REMOVAL = '.deleting.json', REMOVAL_FORMAT = 'render-cache-removal-v1';
const error = (code, message) => Object.assign(new Error(message), { code });
const cancelled = () => error('PREP_CANCELLED', '后台预处理已暂停。');
function normalized(spec) {
  if (!spec || spec.version !== 1 || !ID.test(spec.sessionId || '') || !ID.test(spec.sourceId || '') || !Number.isFinite(spec.startMs) || !Number.isFinite(spec.endMs) || spec.startMs < 0 || spec.endMs <= spec.startMs || spec.endMs > Number.MAX_SAFE_INTEGER) throw error('PREP_SPEC', '预处理缓存描述无效。');
  for (const name of ['sourceFingerprint', 'profileHash', 'assHash']) if (typeof spec[name] !== 'string' || !spec[name].length || spec[name].length > 65536) throw error('PREP_SPEC', '预处理缓存签名无效。');
  return Object.fromEntries(['version', 'sessionId', 'sourceId', 'startMs', 'endMs', 'sourceFingerprint', 'profileHash', 'assHash'].map(name => [name, spec[name]]));
}
export function renderCacheKey(spec) { return createHash('sha256').update(JSON.stringify(normalized(spec))).digest('hex'); }
function fileIdentity(stat) { return Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(name => [name, String(stat[name])])); }
const matchIdentity = (stat, identity) => stat && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(name => String(stat[name]) === identity?.[name]);
// Deletion checks ownership, not whether a block is still eligible for reuse.
// chmod/ACL and other metadata changes update ctime without replacing a file.
// Retain the inode, device, size and content-write-time guards, plus the path,
// link-count and manifest checks below. Playback/cache hits stay strict.
const matchRemovalIdentity = (stat, identity) => stat && ['dev', 'ino', 'size', 'mtimeNs'].every(name => String(stat[name]) === identity?.[name]);
const publicEntry = entry => ({ path: entry.directory, reason: '缓存身份改变或包含未知文件，已保留' });
async function plainDirectory(directory, create = false) {
  const absolute = path.resolve(directory), volume = path.parse(absolute).root; let current = volume;
  for (const part of path.relative(volume, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); let stat;
    try { stat = await fs.lstat(current); }
    catch (failure) {
      if (!create || failure.code !== 'ENOENT') throw failure;
      try { await fs.mkdir(current); } catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('PREP_PATH', '预处理缓存目录包含链接或异常路径。');
  }
  if (pathKey(await fs.realpath(absolute)) !== pathKey(absolute)) throw error('PREP_PATH', '预处理缓存目录实际位置不一致。');
  return absolute;
}
async function readJson(root, file) {
  const stat = await checkedFile(root, file);
  if (stat.nlink !== 1n || stat.size > 262144n) throw error('PREP_MANIFEST', '缓存记录无效。');
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (fingerprint(await checkedFile(root, file)) !== fingerprint(stat)) throw error('PREP_MANIFEST', '缓存记录读取时发生变化。');
  return { value, identity: fileIdentity(stat) };
}
async function removeEmptyDirectory(directory, control) {
  try { await plainDirectory(directory); control?.check(); await fs.rmdir(directory); control?.progress(); }
  catch (failure) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(failure.code)) throw failure; }
}
async function durableJson(file, value) {
  const handle = await fs.open(file, 'wx');
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
}
async function completeMp4(file, bytes) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw error('PREP_INVALID', '预处理没有生成完整视频。');
  const handle = await fs.open(file, 'r'), seen = new Set(); let position = 0, boxes = 0;
  try {
    while (position < bytes) {
      if (++boxes > 100000 || bytes - position < 8) throw error('PREP_INVALID', '预处理视频结构不完整。');
      const header = Buffer.alloc(16), { bytesRead } = await handle.read(header, 0, Math.min(16, bytes - position), position);
      if (bytesRead < 8) throw error('PREP_INVALID', '预处理视频读取不完整。');
      let size = header.readUInt32BE(0), minimum = 8;
      if (size === 1) { if (bytesRead < 16 || header.readBigUInt64BE(8) > BigInt(Number.MAX_SAFE_INTEGER)) throw error('PREP_INVALID', '预处理视频长度无效。'); size = Number(header.readBigUInt64BE(8)); minimum = 16; }
      else if (!size) size = bytes - position;
      if (size < minimum || size > bytes - position) throw error('PREP_INVALID', '预处理视频数据被截断。');
      seen.add(header.toString('ascii', 4, 8)); position += size;
    }
    if (!['ftyp', 'moov', 'mdat'].every(name => seen.has(name))) throw error('PREP_INVALID', '预处理视频缺少完整 MP4 数据。');
  } finally { await handle.close(); }
}

export class RenderCache {
  constructor(dataRoot, { minFreeBytes = 2 * GiB, maxBytes = 20 * GiB, statfs = directory => fs.statfs(directory, { bigint: true }), now = Date.now } = {}) {
    if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) throw error('PREP_PATH', '缓存数据目录必须使用完整路径。');
    if (![minFreeBytes, maxBytes].every(value => Number.isFinite(value) && value >= 0)) throw error('PREP_SPACE', '缓存容量设置无效。');
    this.root = path.join(path.resolve(dataRoot), 'render-cache', 'v1'); this.minFreeBytes = minFreeBytes; this.maxBytes = maxBytes; this.statfs = statfs; this.now = now;
    this.entries = new Map(); this.loaded = new Set(); this.loading = new Map(); this.building = new Map(); this.blocked = new Set(); this.waiters = new Set(); this.closed = false; this.reserved = 0; this.spaceQueue = Promise.resolve();
  }
  getKey(spec) { return renderCacheKey(spec); }
  assertAllowed(id) { if (this.closed || this.blocked.has(id)) throw cancelled(); }
  notify() { for (const waiter of [...this.waiters]) if (!this.busySession(waiter.id)) { this.waiters.delete(waiter); waiter.resolve(); } }
  busySession(id) { return [...this.building.values()].some(work => work.spec.sessionId === id && !work.settled) || [...this.entries.values()].some(entry => entry.spec.sessionId === id && entry.leases > 0); }
  blockSession(id) { if (!ID.test(id || '')) throw error('PREP_SPEC', '素材编号无效。'); this.blocked.add(id); }
  allowSession(id) { this.blocked.delete(id); }
  async cancelSession(id) {
    this.blockSession(id);
    for (const work of this.building.values()) if (work.spec.sessionId === id) work.controller.abort();
    if (this.busySession(id)) await new Promise(resolve => { this.waiters.add({ id, resolve }); this.notify(); });
  }
  async loadSession(id, refresh = false) {
    if (!ID.test(id || '')) throw error('PREP_SPEC', '素材编号无效。');
    if (this.loading.has(id)) return this.loading.get(id);
    if (this.loaded.has(id) && !refresh) return;
    const operation = (async () => {
      const sessionRoot = path.join(this.root, id); let keys;
      try { await plainDirectory(sessionRoot); keys = await fs.readdir(sessionRoot); } catch (failure) { if (failure.code === 'ENOENT') { this.loaded.add(id); return; } throw failure; }
      for (const key of keys.filter(key => KEY.test(key))) {
        const folder = path.join(sessionRoot, key); let generations;
        try { await plainDirectory(folder); generations = await fs.readdir(folder); } catch { continue; }
        for (const token of generations.filter(token => UUID.test(token))) {
          const directory = path.join(folder, token), entryId = pathKey(directory);
          if (this.entries.has(entryId)) continue;
          try {
            await plainDirectory(directory);
            // A removal receipt is written before the first unlink. It keeps
            // ownership proof when shutdown interrupted metadata deletion.
            let removal;
            try { removal = await readJson(this.root, path.join(directory, REMOVAL)); }
            catch (failure) { if (failure.code !== 'ENOENT') continue; }
            if (removal) {
              const value = removal.value;
              if (value.format !== REMOVAL_FORMAT || value.token !== token || value.spec?.sessionId !== id || renderCacheKey(value.spec) !== key) continue;
              if (!['fileIdentity','manifestIdentity','ownerIdentity'].every(field=>['dev','ino','size','mtimeNs'].every(name=>typeof value[field]?.[name]==='string'))) continue;
              this.entries.set(entryId, { id: entryId, directory, file: path.join(directory,'video.mp4'), spec: normalized(value.spec), key, bytes: Number(value.fileIdentity.size), fileIdentity: value.fileIdentity, manifestIdentity: value.manifestIdentity, ownerIdentity: value.ownerIdentity, removing: true, created: 0, lastUsed: 0, leases: 0, deleting: false });
              continue;
            }
            const owner = await readJson(this.root, path.join(directory, 'owner.json'));
            const record = await readJson(this.root, path.join(directory, 'manifest.json')), value = record.value;
            if (owner.value.format !== OWNER_FORMAT || owner.value.token !== token || owner.value.sessionId !== id || owner.value.key !== key || value.format !== FORMAT || value.token !== token || value.key !== key || value.spec?.sessionId !== id || renderCacheKey(value.spec) !== key || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.fileIdentity?.size !== String(value.bytes)) continue;
            this.entries.set(entryId, { id: entryId, directory, file: path.join(directory, 'video.mp4'), spec: normalized(value.spec), key, bytes: value.bytes, fileIdentity: value.fileIdentity, manifestIdentity: record.identity, ownerIdentity: owner.identity, created: Number(value.created) || 0, lastUsed: Number(value.created) || 0, leases: 0, deleting: false });
          } catch { /* Corrupt or unknown generations are preserved, never hits. */ }
        }
      }
      this.loaded.add(id);
    })().finally(() => this.loading.delete(id));
    this.loading.set(id, operation); return operation;
  }
  async loadAll() {
    let sessions; try { await plainDirectory(this.root); sessions = await fs.readdir(this.root); } catch (failure) { if (failure.code === 'ENOENT') return; throw failure; }
    for (const id of sessions.filter(name => ID.test(name))) await this.loadSession(id);
  }
  lease(entry) {
    if (entry.deleting) return null;
    entry.leases++; let released = false; entry.lastUsed = this.now();
    return { file: entry.file, bytes: entry.bytes, key: entry.key, release: () => { if (released) return; released = true; entry.leases--; this.notify(); } };
  }
  async valid(entry) {
    if (entry.removing) return false;
    const stat = await checkedFile(this.root, entry.file);
    if (stat.nlink !== 1n || !matchIdentity(stat, entry.fileIdentity)) return false;
    const manifest = await checkedFile(this.root, path.join(entry.directory, 'manifest.json'));
    const owner = await checkedFile(this.root, path.join(entry.directory, 'owner.json'));
    return manifest.nlink === 1n && owner.nlink === 1n && matchIdentity(manifest, entry.manifestIdentity) && matchIdentity(owner, entry.ownerIdentity);
  }
  async acquire(spec) {
    spec = normalized(spec); this.assertAllowed(spec.sessionId); const key = renderCacheKey(spec);
    await this.loadSession(spec.sessionId); this.assertAllowed(spec.sessionId);
    const entries = [...this.entries.values()].filter(entry => entry.key === key && !entry.deleting).sort((a, b) => b.created - a.created);
    for (const entry of entries) {
      const lease = this.lease(entry); if (!lease) continue;
      try { if (await this.valid(entry)) { this.assertAllowed(spec.sessionId); return lease; } } catch (failure) { if (failure.code === 'PREP_CANCELLED') { lease.release(); throw failure; } }
      lease.release();
    }
    return null;
  }
  async hasReady(sessionId) {
    if (!ID.test(sessionId || '') || this.closed || this.blocked.has(sessionId)) return false;
    try {
      await this.loadSession(sessionId);
      for (const entry of [...this.entries.values()].filter(entry => entry.spec.sessionId === sessionId && !entry.deleting)) {
        const lease = this.lease(entry); if (!lease) continue;
        try { if (await this.valid(entry) && !this.blocked.has(sessionId) && !this.closed) return true; } catch {}
        finally { lease.release(); }
      }
    } catch {}
    return false;
  }
  async freeSpace(expected = 0) {
    try {
      const stat = await this.statfs(this.root), available = BigInt(stat.bavail) * BigInt(stat.bsize);
      if (available < BigInt(Math.ceil(this.minFreeBytes + expected))) throw error('PREP_SPACE', '磁盘空间不足，后台预处理已暂停。');
    } catch (failure) { if (failure.code === 'PREP_SPACE') throw failure; throw error('PREP_SPACE', '暂时无法确认可用磁盘空间，后台预处理已暂停。'); }
  }
  async reserveSpace(bytes) {
    let resolve; const previous = this.spaceQueue; this.spaceQueue = new Promise(done => { resolve = done; }); await previous;
    try {
      await plainDirectory(this.root, true); await this.loadAll();
      const used = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      if (used + this.reserved + bytes > this.maxBytes) await this.prune({ targetBytes: Math.max(0, this.maxBytes - this.reserved - bytes) });
      const remaining = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      if (remaining + this.reserved + bytes > this.maxBytes) throw Object.assign(error('PREP_SPACE', '预处理缓存已达到容量限制，已暂停自动重试；仍可继续编辑和导出。'), { capacity: true });
      await this.freeSpace(this.reserved + bytes); this.reserved += bytes;
    } finally { resolve(); }
  }
  async build(spec, render, { signal, estimatedBytes = 0, verifySource } = {}) {
    spec = normalized(spec); this.assertAllowed(spec.sessionId);
    if (signal?.aborted) throw cancelled();
    if (typeof render !== 'function' || !Number.isFinite(estimatedBytes) || estimatedBytes < 0) throw error('PREP_SPEC', '缓存生成参数无效。');
    const hit = await this.acquire(spec); if (hit) { if (signal?.aborted) { hit.release(); throw cancelled(); } return hit; }
    const key = renderCacheKey(spec); let work = this.building.get(key);
    if (!work) {
      work = { key, spec, controller: new AbortController(), users: new Set(), settled: false, estimate: Math.ceil(estimatedBytes), render, verifySource };
      this.building.set(key, work);
      // Start after registering this caller, so cancellation has a consumer.
      work.promise = Promise.resolve().then(() => this.produce(work)).finally(() => { work.settled = true; this.notify(); });
    }
    const user = { cancelled: false }; work.users.add(user);
    const abort = () => { user.cancelled = true; if ([...work.users].every(user => user.cancelled)) work.controller.abort(); };
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    try { const entry = await work.promise; if (user.cancelled) throw cancelled(); this.assertAllowed(spec.sessionId); const lease = this.lease(entry); if (!lease) throw error('PREP_STALE', '预处理缓存已更新，请重试。'); return lease; }
    finally { signal?.removeEventListener('abort', abort); work.users.delete(user); if (work.settled && !work.users.size && this.building.get(key) === work) this.building.delete(key); this.notify(); }
  }
  async produce(work) {
    const check = () => { this.assertAllowed(work.spec.sessionId); if (work.controller.signal.aborted) throw cancelled(); };
    let directory, reservation = false, ownerIdentity, partialIdentity, finalIdentity;
    try {
      check(); await this.reserveSpace(work.estimate); reservation = true; check();
      const parent = path.join(this.root, work.spec.sessionId, work.key); await plainDirectory(parent, true);
      const token = randomUUID(); directory = path.join(parent, token); await fs.mkdir(directory);
      const owner = { format: OWNER_FORMAT, token, key: work.key, sessionId: work.spec.sessionId, ownerPid: process.pid };
      await durableJson(path.join(directory, 'owner.json'), owner); ownerIdentity = fileIdentity(await checkedFile(this.root, path.join(directory, 'owner.json')));
      const partial = path.join(directory, 'partial.mp4');
      await work.render(partial, { signal: work.controller.signal }); check();
      const stat = await checkedFile(this.root, partial); if (stat.nlink !== 1n) throw error('PREP_INVALID', '预处理视频不是独占文件。'); partialIdentity = fileIdentity(stat);
      await completeMp4(partial, Number(stat.size)); check();
      if (work.verifySource && await work.verifySource() === false) throw error('PREP_STALE', '素材或弹幕已更新，已放弃过期预处理。'); check();
      if (!matchIdentity(await checkedFile(this.root, partial), partialIdentity)) throw error('PREP_STALE', '预处理结果写入期间发生变化。');
      if (Number(stat.size) > work.estimate) { const extra = Number(stat.size) - work.estimate; await this.reserveSpace(extra); work.estimate += extra; }
      await this.freeSpace(Number(stat.size)); check();
      const final = path.join(directory, 'video.mp4');
      await fs.copyFile(partial, final, fs.constants.COPYFILE_EXCL);
      const finalStat = await checkedFile(this.root, final); if (finalStat.nlink !== 1n || finalStat.size !== stat.size) throw error('PREP_INVALID', '预处理结果保存不完整。');
      finalIdentity = fileIdentity(finalStat);
      const handle = await fs.open(final, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
      check();
      const manifest = { format: FORMAT, token, key: work.key, spec: work.spec, bytes: Number(finalStat.size), fileIdentity: finalIdentity, created: this.now() };
      await durableJson(path.join(directory, 'manifest.json'), manifest); check();
      const record = await readJson(this.root, path.join(directory, 'manifest.json'));
      if (!matchIdentity(await checkedFile(this.root, final), finalIdentity)) throw error('PREP_STALE', '预处理结果保存时发生变化。');
      if (matchIdentity(await checkedFile(this.root, partial), partialIdentity)) await fs.unlink(partial);
      const entry = { id: pathKey(directory), directory, file: final, spec: work.spec, key: work.key, bytes: manifest.bytes, fileIdentity: finalIdentity, manifestIdentity: record.identity, ownerIdentity, created: manifest.created, lastUsed: this.now(), leases: 0, deleting: false };
      this.entries.set(entry.id, entry); return entry;
    } catch (failure) {
      if (directory) await this.discardBuild(directory, ownerIdentity, { partialIdentity, finalIdentity });
      if (work.controller.signal.aborted || this.blocked.has(work.spec.sessionId)) throw cancelled();
      if (['ENOSPC', 'EDQUOT'].includes(failure.code)) throw error('PREP_SPACE', '磁盘空间不足，后台预处理已暂停。');
      throw failure;
    } finally { if (reservation) this.reserved -= work.estimate; }
  }
  async discardBuild(directory, ownerIdentity, { partialIdentity, finalIdentity }) {
    try {
      if (!ownerIdentity || !matchIdentity(await checkedFile(this.root, path.join(directory, 'owner.json')), ownerIdentity)) return;
      for (const [name, expected] of [['partial.mp4', partialIdentity], ['video.mp4', finalIdentity]]) {
        const file = path.join(directory, name), stat = await checkedFile(this.root, file, { missing: true });
        if (!stat) continue;
        if (stat.nlink !== 1n || (expected && !matchIdentity(stat, expected))) return;
        await fs.unlink(file);
      }
      const manifest = path.join(directory, 'manifest.json');
      try { const value = await readJson(this.root, manifest); if (value.value.token !== path.basename(directory)) return; await fs.unlink(manifest); } catch (failure) { if (failure.code !== 'ENOENT') return; }
      if ((await fs.readdir(directory)).some(name => name !== 'owner.json')) return;
      await fs.unlink(path.join(directory, 'owner.json')); await fs.rmdir(directory);
    } catch { /* Never broaden cleanup after an identity/path failure. */ }
  }
  async removeEntry(entry, { control }={}) {
    control?.check();
    if (entry.deleting || entry.leases || this.building.has(entry.key)) return { freedBytes: 0, deletedFiles: 0, preserved: [{ path: entry.directory, reason: '缓存正在使用，已保留' }] };
    entry.deleting = true; let freedBytes = 0, deletedFiles = 0;
    try {
      let receipt;
      try { receipt = await readJson(this.root, path.join(entry.directory, REMOVAL)); }
      catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
      const value = { format: REMOVAL_FORMAT, token: path.basename(entry.directory), spec: entry.spec, fileIdentity: entry.fileIdentity, manifestIdentity: entry.manifestIdentity, ownerIdentity: entry.ownerIdentity };
      if (receipt && JSON.stringify(receipt.value) !== JSON.stringify(value)) return { freedBytes, deletedFiles, preserved: [publicEntry(entry)] };
      const existingVideo = await checkedFile(this.root, entry.file, { missing: true });
      if (existingVideo && (existingVideo.nlink !== 1n || !matchRemovalIdentity(existingVideo, entry.fileIdentity))) return { freedBytes, deletedFiles, preserved: [publicEntry(entry)] };
      for (const [name, expected] of [['manifest.json', entry.manifestIdentity], ['owner.json', entry.ownerIdentity]]) {
        const stat = await checkedFile(this.root, path.join(entry.directory, name), { missing: !!receipt });
        if (!stat && receipt) continue;
        if (stat.nlink !== 1n || !matchRemovalIdentity(stat, expected)) return { freedBytes, deletedFiles, preserved: [publicEntry(entry)] };
      }
      const names = await fs.readdir(entry.directory);
      if (names.some(name => !['owner.json', 'manifest.json', 'video.mp4', REMOVAL].includes(name))) return { freedBytes: 0, deletedFiles: 0, preserved: [publicEntry(entry)] };
      if (!receipt) {
        control?.check();
        await durableJson(path.join(entry.directory, REMOVAL), value);
        control?.progress();
        receipt = await readJson(this.root, path.join(entry.directory, REMOVAL));
      }
      entry.removing = true;
      for (const [name, expected] of [['video.mp4', entry.fileIdentity], ['manifest.json', entry.manifestIdentity], ['owner.json', entry.ownerIdentity]]) {
        const file = path.join(entry.directory, name), stat = await checkedFile(this.root, file, { missing: true });
        if (!stat) continue;
        if (stat.nlink !== 1n || !matchRemovalIdentity(stat, expected)) return { freedBytes, deletedFiles, preserved: [publicEntry(entry)] };
        control?.check();
        await fs.unlink(file); freedBytes += Number(stat.size); deletedFiles++;
        control?.progress();
      }
      // The short-lived receipt was created by cleanup itself and is not
      // counted as reclaimed recording bytes. Remove it last, without rm -r.
      if ((await fs.readdir(entry.directory)).some(name=>name!==REMOVAL)) return { freedBytes, deletedFiles, preserved: [publicEntry(entry)] };
      if (!matchRemovalIdentity(await checkedFile(this.root,path.join(entry.directory,REMOVAL)),receipt.identity)) return { freedBytes, deletedFiles, preserved: [publicEntry(entry)] };
      control?.check();
      await fs.unlink(path.join(entry.directory, REMOVAL));
      control?.progress();
      await fs.rmdir(entry.directory); this.entries.delete(entry.id);
      control?.progress();
      for (const parent of [path.dirname(entry.directory), path.dirname(path.dirname(entry.directory))]) try { await plainDirectory(parent); control?.check(); await fs.rmdir(parent); control?.progress(); } catch (failure) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(failure.code)) throw failure; }
      return { freedBytes, deletedFiles, preserved: [] };
    } catch (failure) { control?.check(); return { freedBytes, deletedFiles, preserved: [publicEntry(entry)] }; }
    finally { entry.deleting = false; }
  }
  async prune({ keepKeys, sessionId, targetBytes = this.maxBytes, control } = {}) {
    control?.check();
    if (sessionId) await this.loadSession(sessionId, true); else await this.loadAll();
    const keep = keepKeys && new Set(keepKeys), result = { freedBytes: 0, deletedFiles: 0, preserved: [] };
    let used = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of [...this.entries.values()].sort((a, b) => a.lastUsed - b.lastUsed)) {
      control?.check();
      if (sessionId && entry.spec.sessionId !== sessionId || keep?.has(entry.key) || (!keep && used <= targetBytes)) continue;
      const removed = await this.removeEntry(entry,{control}); control?.progress(); result.freedBytes += removed.freedBytes; result.deletedFiles += removed.deletedFiles; result.preserved.push(...removed.preserved);
      if (!this.entries.has(entry.id)) used -= entry.bytes;
    }
    return result;
  }
  async removeSession(id, { control }={}) {
    if(control)await control.wait(this.cancelSession(id));else await this.cancelSession(id);
    let result;
    try { result = await this.prune({ sessionId: id, keepKeys: [], control }); }
    catch { control?.check(); return { freedBytes: 0, deletedFiles: 0, preserved: [{ path: path.join(this.root, id), reason: '缓存目录异常，已保留' }] }; }
    const sessionRoot = path.join(this.root, id);
    try {
      await plainDirectory(sessionRoot);
      // A failed/cancelled producer can leave a key or generation directory
      // without any files. rmdir is deliberately nonrecursive: unknown files
      // and live/partial generations are never removed by this sweep.
      for (const key of (await fs.readdir(sessionRoot)).filter(name => KEY.test(name))) {
        const directory = path.join(sessionRoot, key); await plainDirectory(directory);
        for (const token of (await fs.readdir(directory)).filter(name => UUID.test(name))) await removeEmptyDirectory(path.join(directory, token),control);
        await removeEmptyDirectory(directory,control);
      }
      const remaining = await fs.readdir(sessionRoot);
      control?.check();
      if (remaining.length) result.preserved.push({ path: sessionRoot, reason: '缓存目录仍含未知、未完成或被替换的文件，已保留' }); else {await fs.rmdir(sessionRoot);control?.progress();}
    }
    catch (failure) { control?.check(); if (failure.code !== 'ENOENT') result.preserved.push({ path: sessionRoot, reason: '缓存目录异常，已保留' }); }
    return result;
  }
  async close() { this.closed = true; const ids = new Set([...this.building.values()].map(work => work.spec.sessionId)); for (const entry of this.entries.values()) if (entry.leases) ids.add(entry.spec.sessionId); await Promise.all([...ids].map(id => this.cancelSession(id))); }
}
