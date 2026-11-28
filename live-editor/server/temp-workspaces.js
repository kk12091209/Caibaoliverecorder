import { fingerprint, pathKey as key } from './storage-files.js';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MARKER = '.bili-temp-owner.json';
const FORMAT = 'bili-editor-temp-v1';
const NAME = /^bili-(probe|export|full)-[A-Za-z0-9_-]+$/;
const recorderCompletionMarker = /^dotnet-suggest-registration-BililiveRecorder\.Cli, Version=\d+\.\d+\.\d+\.\d+, Culture=neutral, PublicKeyToken=null$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const jobIdValid = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
const retainedValid = value => value && typeof value === 'object' && !Array.isArray(value) && jobIdValid(value.jobId)&&(!Object.hasOwn(value,'ownerReleased')||typeof value.ownerReleased==='boolean');
const unrecognizedReason = '临时工作区有无法确认归属的文件，已保留。';
const validName = name => typeof name === 'string' && !!name && !/[\\/:\x00-\x1f]/.test(name) && !/[. ]$/.test(name);
const ordinary = stat => stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n;
const statIfPresent = file => fs.lstat(file, { bigint: true }).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});
const directoryIdentity = directory => {
  const stat = sync.lstatSync(directory, { bigint: true });
  return [String(stat.dev), String(stat.ino)].join(':');
};
const retryable = new Set(['EBUSY', 'EPERM', 'EACCES', 'ETXTBSY', 'EIO', 'EMFILE', 'ENFILE']);
const pidValid = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;

export function processRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function checkDirectory(directory, missingAllowed = false) {
  const absolute = path.resolve(directory), volume = path.parse(absolute).root;
  let current = volume;
  for (const component of path.relative(volume, absolute).split(path.sep)) {
    current = path.join(current, component);
    let stat;
    try { stat = sync.lstatSync(current); }
    catch (error) { if (missingAllowed && error.code === 'ENOENT') return false; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('临时目录包含链接或异常路径，已保留。');
  }
  if (key(sync.realpathSync(absolute)) !== key(absolute)) throw new Error('临时目录实际路径不一致，已保留。');
  return true;
}

function ownedDirectory(root, directory) {
  if (key(path.dirname(directory)) !== key(root) || !NAME.test(path.basename(directory))) throw new Error('临时工作区不在允许清理的范围。');
  checkDirectory(directory);
}

function readMarker(root, directory) {
  ownedDirectory(root, directory);
  const file = path.join(directory, MARKER), stat = sync.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384) return null;
  const data = JSON.parse(sync.readFileSync(file, 'utf8'));
  if (data.format !== FORMAT || data.directory !== path.basename(directory) || !UUID.test(data.token) || !pidValid(data.ownerPid)
    || !Array.isArray(data.childPids) || data.childPids.length > 1000 || data.childPids.some(pid => !pidValid(pid))
    || !Number.isSafeInteger(data.pendingSpawns) || data.pendingSpawns < 0
    || ('sessionId' in data && !jobIdValid(data.sessionId))
    || ('cleanupKept' in data && (data.cleanupKept !== true || !data.sessionId || data.retained || data.pendingSpawns || data.childPids.length))
    || ('retained' in data && (!retainedValid(data.retained) || NAME.exec(path.basename(directory))?.[1] !== 'export'))) return null;
  return data;
}

function allowedFile(directory, name) {
  if (name === MARKER) return true;
  if(/^\.bili-temp-owner-[0-9a-f-]+\.tmp$/i.test(name))return true;
  const kind = NAME.exec(path.basename(directory))?.[1];
  if (kind === 'probe') return name === 'sample.flv';
  if (kind === 'export' && (['.bili-export-checkpoint.json','.bili-export-checkpoint.previous.json'].includes(name) || /^\.bili-export-checkpoint-[0-9a-f-]+\.tmp$/i.test(name))) return true;
  if (kind === 'export' && (name === '.bili-export-publication.json' || /^\.bili-export-publication-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/i.test(name))) return true;
  if (kind === 'export' && /^(?:audio-\d+\.flac|audio-concat\.txt|video-concat(?:-danmaku)?\.txt|video(?:-danmaku)?\.mp4|audio\.m4a)$/.test(name)) return true;
  if (kind === 'export' && /^(?:original-\d+\.mp4|original-concat\.txt|audio-copy-\d+\.m4a|audio-copy-concat\.txt|(?:clean-)?names-\d+\.ass|names\.ass|sequence-\d+\.mp4)$/.test(name)) return true;
  if (kind === 'export' && /^(?:avatar-[a-f0-9]{64}|gift-(?:default-gift|default-guard|[a-f0-9]{64}))\.png$/.test(name)) return true;
  if (kind === 'export' && /^filter-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.txt$/.test(name)) return true;
  if (kind === 'export') return /^(?:part-\d+(?:-block-\d+(?:-[01]){0,6})?(?:-danmaku)?\.mp4|(?:names-)?part-\d+(?:-block-\d+(?:-[01]){0,6})?\.ass|(?:concat|split-\d+)(?:-danmaku)?\.txt|final(?:-danmaku)?\.mp4)$/.test(name);
  return false;
}

export class TemporaryWorkspaces {
  constructor(root, { processAlive = processRunning, storageIdentity, isReferenced = () => false, journal } = {}) {
    this.root = path.resolve(root);
    this.processAlive = processAlive;
    this.storageIdentity = storageIdentity;
    this.isReferenced = isReferenced;
    this.journal = journal ?? new Map();
    this.active = new Map();
    this.removing = new Set();
    this.waiting = new Map();
    this.cleaning = null;
    this.removedBytes = 0;
  }
  checkRoot() {
    if (this.storageIdentity && directoryIdentity(path.dirname(this.root)) !== this.storageIdentity) {
      throw new Error('原存储位置已变化，等待原磁盘连接。');
    }
    return checkDirectory(this.root, true);
  }
  inactive(directory, marker) {
    const state = this.active.get(key(directory));
    if (marker.pendingSpawns || marker.childPids.some(pid => this.alive(pid))) return false;
    if (state) return state.completed && marker.token === state.data.token && marker.ownerPid === process.pid;
    return marker.cleanupKept || !this.alive(marker.ownerPid);
  }
  countRemoval(result, stat) {
    const bytes = Number(stat.size);
    result.freedBytes += bytes;
    result.deletedFiles++;
    this.removedBytes += bytes;
  }
  async create(prefix, sessionId) {
    if (!['bili-probe-','bili-export-'].includes(prefix)) throw new Error('无效的临时工作区类型。');
    if(sessionId!==undefined&&!jobIdValid(sessionId))throw new Error('临时工作区素材编号无效。');
    checkDirectory(this.root, true);
    await fs.mkdir(this.root, { recursive: true }); checkDirectory(this.root);
    const directory = await fs.mkdtemp(path.join(this.root, prefix));
    const state = { directory, completed: false, finishing: null, data: { format: FORMAT, directory: path.basename(directory), token: randomUUID(), ownerPid: process.pid, childPids: [], pendingSpawns: 0 } };
    if(sessionId!==undefined)state.data.sessionId=sessionId;
    try { ownedDirectory(this.root, directory); sync.writeFileSync(path.join(directory, MARKER), JSON.stringify(state.data), { flag: 'wx' }); }
    catch (error) { await fs.rmdir(directory).catch(() => {}); throw error; }
    this.active.set(key(directory), state); return directory;
  }
  write(state, data) {
    const existing = readMarker(this.root, state.directory);
    if (!existing || existing.token !== state.data.token || existing.ownerPid !== state.data.ownerPid) throw new Error('临时工作区所有权标记异常，已保留。');
    // Keep the last valid owner until the new copy has been flushed and renamed.
    const text=JSON.stringify(data);if(Buffer.byteLength(text)>16384)throw new Error('临时工作区归属记录超过安全大小，已保留文件。');
    const temporary=path.join(state.directory,`.bili-temp-owner-${randomUUID()}.tmp`);let handle;
    try{
      handle=sync.openSync(temporary,'wx',0o600);sync.writeFileSync(handle,text);sync.fsyncSync(handle);sync.closeSync(handle);handle=undefined;
      sync.renameSync(temporary,path.join(state.directory,MARKER));state.data=data;
    }finally{if(handle!==undefined)try{sync.closeSync(handle);}catch{}try{sync.unlinkSync(temporary);}catch{}}
  }
  retainedState(directory, jobId, requireRetained = true) {
    if (!jobIdValid(jobId)) throw new Error('保留导出的任务编号无效。');
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\x00-\x1f]/.test(directory)) throw new Error('保留导出的临时目录无效。');
    directory = path.resolve(directory);
    if (NAME.exec(path.basename(directory))?.[1] !== 'export') throw new Error('仅导出临时目录可以保留待发布的视频。');
    const marker = readMarker(this.root, directory);
    if (!marker || marker.cleanupKept || (marker.retained && marker.retained.jobId !== jobId) || (requireRetained && !marker.retained)) throw new Error('保留导出的所有权或任务标记不匹配，已保留文件。');
    let state = this.active.get(key(directory));
    if (state) {
      if (state.finishing) throw new Error('临时工作区正在清理，不能改变保留状态。');
      if (marker.token !== state.data.token || marker.ownerPid !== state.data.ownerPid || marker.ownerPid !== process.pid) throw new Error('临时工作区所有权已变化，已保留文件。');
      if (requireRetained && (marker.pendingSpawns || marker.childPids.some(pid => this.alive(pid)))) throw new Error('保留导出仍有视频进程运行或启动中，请稍后重试。');
      state.data = marker;
    } else {
      // Only previously retained orphans may be recovered. An unmarked orphan
      // could already be in a cleanup pass and must never be claimed here.
      if (!marker.retained || marker.pendingSpawns || (!marker.retained.ownerReleased&&this.alive(marker.ownerPid)) || marker.childPids.some(pid => this.alive(pid))) throw new Error('保留导出仍由其他进程使用，或无法确认其已停止。');
      state = { directory, completed: false, finishing: null, data: marker };
      this.write(state, { ...marker, ownerPid: process.pid, childPids: [] });
      this.active.set(key(directory), state);
    }
    return state;
  }
  async retain(directory, jobId, details = {}) {
    const state = this.retainedState(directory, jobId, false);
    this.write(state, { ...state.data, retained: { ...state.data.retained, ...details, jobId } });
    state.completed = false;
    return true;
  }
  async adoptRetained(directory, jobId) {
    const state = this.retainedState(directory, jobId);
    if(state.data.retained.ownerReleased)this.write(state,{...state.data,retained:{...state.data.retained,ownerReleased:false}});
    state.completed = false;
    return state;
  }
  async release(directory, jobId) {
    const state = this.retainedState(directory, jobId);
    const data = { ...state.data, childPids: [] };
    delete data.retained;
    this.write(state, data);
    // A previous finally may have requested finish while this was retained.
    // The caller explicitly finishes only after publication is committed.
    state.completed = false;
    return true;
  }
  beforeSpawn(directory) {
    const state = directory && this.active.get(key(directory)); if (!state) return null;
    if (state.completed || state.finishing) throw new Error('临时工作区已完成或正在清理，不能启动新进程。');
    this.write(state, { ...state.data, pendingSpawns: state.data.pendingSpawns + 1 }); return state;
  }
  spawned(state, pid) {
    if (!state) return;
    this.write(state, { ...state.data, pendingSpawns: state.data.pendingSpawns - 1, childPids: pidValid(pid) ? [...new Set([...state.data.childPids, pid])] : state.data.childPids });
  }
  childExited(state, pid) {
    if (!state) return;
    try { this.write(state, { ...state.data, childPids: state.data.childPids.filter(value => value !== pid) }); } catch {}
    if (state.completed) void this.finish(state.directory);
  }
  alive(pid) {
    try { return this.processAlive(pid) !== false; } catch { return true; }
  }
  async remove(directory, expected, ownActive = false, { control } = {}) {
    const outcome = await this.removeOutcome(directory, expected, ownActive, { control });
    return !!outcome?.removed;
  }
  async removeOutcome(directory, expected, ownActive = false, { control, keepRetained = false, sessionId, checkReferences = false } = {}) {
    const directoryKey = key(directory);
    if (this.removing.has(directoryKey)) return null;
    this.removing.add(directoryKey);
    try {
      control?.check();
      if (!this.checkRoot()) return null;
      ownedDirectory(this.root, directory);
      const directoryId = directoryIdentity(directory);
      const currentOwner = () => {
        if (!this.checkRoot()) return null;
        const owner = readMarker(this.root, directory);
        if (directoryIdentity(directory) !== directoryId || !owner || owner.token !== expected.token ||
          owner.ownerPid !== expected.ownerPid || owner.retained || owner.pendingSpawns ||
          (!owner.cleanupKept && !ownActive && this.alive(owner.ownerPid)) || owner.childPids.some(pid => this.alive(pid)) ||
          (checkReferences && this.isReferenced(directory, sessionId))) return null;
        return owner;
      };
      const marker = currentOwner();
      if (!marker) return null;
      const result = { freedBytes: 0, deletedFiles: 0, retained: [], waiting: [], removed: false, kept: false };
      const keep = (name, reason = unrecognizedReason) => ({ path: path.join(directory, name), reason });
      const names = (await fs.readdir(directory)).filter(name => name !== MARKER);
      if (marker.cleanupKept && names.length) return { ...result, retained: names.map(name => keep(name)), kept: true };

      const markerFile = path.join(directory, MARKER);
      const markerStat = await fs.lstat(markerFile, { bigint: true });
      const entries = new Map();
      for (const name of names) {
        const stat = await statIfPresent(path.join(directory, name));
        if (stat) entries.set(name, stat);
      }
      const planKey = path.basename(directory);
      const prior = this.journal.get(planKey);
      const plan = prior ?? { token: marker.token, directoryId, files: Object.fromEntries(
        [...entries].filter(([name, stat]) => validName(name) && allowedFile(directory, name) && ordinary(stat))
          .map(([name, stat]) => [name, fingerprint(stat)])
      ) };
      if (plan.token !== marker.token || plan.directoryId !== directoryId) return null;
      if (!prior) this.journal.set(planKey, plan);
      for (const [name, stat] of entries) {
        if (!Object.hasOwn(plan.files, name) || !ordinary(stat) || fingerprint(stat) !== plan.files[name]) continue;
        if (!currentOwner()) return null;
        const file = path.join(directory, name);
        const current = await statIfPresent(file);
        if (!current || !ordinary(current) || fingerprint(current) !== plan.files[name]) continue;
        control?.check();
        try {
          await fs.unlink(file);
          this.countRemoval(result, current);
          control?.progress();
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          if (!retryable.has(error.code)) throw error;
          result.waiting.push({ ...keep(name, '文件仍在使用或无法写入，稍后自动重试。'), retryable: true });
        }
      }

      const remaining = (await fs.readdir(directory)).filter(name => name !== MARKER);
      const owner = currentOwner();
      const currentMarker = await statIfPresent(markerFile);
      if (!owner || !ordinary(currentMarker) || fingerprint(currentMarker) !== fingerprint(markerStat)) return null;
      control?.check();
      if (remaining.length) {
        const waitingPaths = new Set(result.waiting.map(file => file.path));
        result.retained = remaining.map(name => keep(name)).filter(file => !waitingPaths.has(file.path));
        if (keepRetained && !result.waiting.length) {
          const state = this.active.get(directoryKey) ?? { directory, data: owner };
          this.write(state, { ...owner, childPids: [], cleanupKept: true });
          result.kept = true;
        }
        this.waiting.set(directoryKey, new Set(result.waiting.map(file => path.basename(file.path))));
        return result;
      }
      // Remove the ownership record after the payload. Keep the journal until
      // the directory is gone, so an interrupted deletion can't adopt new files.
      try { await fs.unlink(markerFile); this.countRemoval(result, markerStat); }
      catch (error) {
        if (!retryable.has(error.code)) throw error;
        result.waiting.push({ ...keep(MARKER, '暂存记录仍在使用或无法写入，稍后自动重试。'), retryable: true });
        return result;
      }
      ownedDirectory(this.root, directory);
      control?.check();
      await fs.rmdir(directory);
      this.journal.delete(planKey);
      this.waiting.delete(directoryKey);
      control?.progress();
      result.removed = true;
      return result;
    } finally {
      this.removing.delete(directoryKey);
    }
  }
  async finish(directory, { checkReferences = false } = {}) {
    const state = this.active.get(key(directory)); if (!state) return false;
    state.completed = true;
    if(state.data.retained&&!state.data.pendingSpawns&&!state.data.childPids.some(pid=>this.alive(pid)))
      try{this.write(state,{...state.data,retained:{...state.data.retained,ownerReleased:true}});}catch{ /* Uncertain markers stay protected. */ }
    if (state.finishing) return state.finishing;
    state.finishing = (async () => {
      try {
        const outcome = await this.removeOutcome(directory, state.data, true, { checkReferences });
        if (outcome?.removed) this.active.delete(key(directory));
        return !!outcome?.removed;
      }
      catch { return false; }
      finally { state.finishing = null; }
    })();
    return state.finishing;
  }
  cleanupStale() {
    if (this.cleaning) return this.cleaning;
    this.cleaning = this.cleanup().finally(() => { this.cleaning = null; }); return this.cleaning;
  }
  async removeSession(sessionId, { control, keepRetained = false }={}) {
    const result={freedBytes:0,deletedFiles:0,retained:[],waiting:[]};
    if(this.cleaning){if(control)await control.wait(this.cleaning);else await this.cleaning;}
    if(!this.checkRoot())return result;
    for(const name of await fs.readdir(this.root)) {
      control?.check();
      if(!NAME.test(name))continue;
      const directory=path.join(this.root,name);
      let marker;try{marker=readMarker(this.root,directory);}catch{continue;}
      if(marker?.sessionId!==sessionId)continue;
      // Explicit material deletion may release its own inactive processing
      // checkpoints. Pending publication remains protected from this path.
      if(marker.retained?.processing&&!marker.retained.publicationIntent&&this.active.get(key(directory))?.completed!==false&&!marker.pendingSpawns&&!marker.childPids.some(pid=>this.alive(pid))){
        const checkpoint = await this.adoptRetained(directory, marker.retained.jobId);
        await this.release(directory, marker.retained.jobId);
        checkpoint.completed = true;
        marker = checkpoint.data;
      }
      const state=this.active.get(key(directory));
      if(state?.finishing){if(control)await control.wait(state.finishing);else await state.finishing;if(!this.active.has(key(directory)))continue;}
      if(marker.retained||marker.pendingSpawns||marker.childPids.some(pid=>this.alive(pid))||(!marker.cleanupKept&&(state?!state.completed:this.alive(marker.ownerPid))))throw new Error('这份素材的临时工作区仍在处理或等待保存，请稍后重试删除。');
      const outcome=await this.removeOutcome(directory,marker,!!state,{control,keepRetained,sessionId,checkReferences:true});
      if(!outcome)throw new Error('素材临时工作区仍被占用或所有权发生变化，请稍后重试删除。');
      if(outcome.removed||outcome.kept)this.active.delete(key(directory));
      result.freedBytes+=outcome.freedBytes;result.deletedFiles+=outcome.deletedFiles;
      result.retained.push(...outcome.retained);
      result.waiting.push(...outcome.waiting);
    }
    return result;
  }
  directoryForReview(name) {
    if (!validName(name) || !this.checkRoot()) throw new Error('暂存目录不可用，请重新检查。');
    const directory = path.join(this.root, name);
    checkDirectory(directory);
    return directory;
  }
  reviewMarker(directory) {
    try { return readMarker(this.root, directory); } catch { return null; }
  }
  confirmation(directory, marker, name, stat) {
    return createHash('sha256').update(JSON.stringify([
      key(this.root), directoryIdentity(this.root), directoryIdentity(directory), marker.token, name, fingerprint(stat),
    ])).digest('hex');
  }
  async review() {
    if (!this.checkRoot()) return [];
    const workspaces = [];
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      const { name } = entry, directory = path.join(this.root, name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        const stat = await statIfPresent(directory);
        if (stat) workspaces.push({ name, path: directory, status: 'unverified', bytes: stat.isFile() ? Number(stat.size) : null, files: [] });
        continue;
      }
      if (!NAME.test(name)) {
        if (name === 'system-commandline-sentinel-files') {
          try {
            checkDirectory(directory);
            const entries = await fs.readdir(directory, { withFileTypes: true });
            // System.CommandLine writes one completion registration marker per CLI build.
            if (entries.every(file => file.isFile() && recorderCompletionMarker.test(file.name))) continue;
          } catch { /* Leave unreadable directories visible for review. */ }
        }
        workspaces.push({ name, path: directory, status: 'unverified', bytes: null, files: [], canOpen: validName(name) });
        continue;
      }
      try {
        ownedDirectory(this.root, directory);
        const marker = this.reviewMarker(directory);
        const referenced = this.isReferenced(directory);
        const status = marker?.retained || referenced ? 'retained' : !marker ? 'unverified' :
          !this.inactive(directory, marker) ? 'active' : marker.cleanupKept ? 'kept' : 'review';
        const waiting = this.waiting.get(key(directory));
        const plan = this.journal.get(name);
        let bytes = 0;
        const files = [];
        for (const file of await fs.readdir(directory)) {
          if (file === MARKER) continue;
          const stat = await statIfPresent(path.join(directory, file));
          if (!stat) continue;
          const size = stat.isFile() && !stat.isSymbolicLink() ? Number(stat.size) : null;
          bytes += size ?? 0;
          const confirmed = ordinary(stat) && allowedFile(directory, file) &&
            (!plan || Object.hasOwn(plan.files, file) && plan.files[file] === fingerprint(stat));
          const entry = { name: file, bytes: size, status: waiting?.has(file) ? 'waiting' : confirmed && status === 'review' ? 'ready' : status };
          if (['review', 'kept'].includes(entry.status) && validName(file) && ordinary(stat) && !this.removing.has(key(directory))) {
            entry.confirmation = this.confirmation(directory, marker, file, stat);
          }
          files.push(entry);
        }
        workspaces.push({ name, path: directory, status: waiting?.size ? 'waiting' : status,
          sessionId: marker?.sessionId, canOpen: true, bytes, files: files.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1)) });
      } catch (error) {
        if (error.code !== 'ENOENT') workspaces.push({ name, path: directory, status: 'unavailable', bytes: null, files: [] });
      }
    }
    return workspaces.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
  }
  async removeReviewed({ directory: name, file, confirmation, confirmed } = {}) {
    if (confirmed !== true || !NAME.test(name ?? '') || !validName(file) || file === MARKER ||
      typeof confirmation !== 'string' || !/^[a-f0-9]{64}$/.test(confirmation)) {
      throw new Error('请先检查并确认要移除的临时文件。');
    }
    const directory = this.directoryForReview(name), directoryKey = key(directory);
    if (this.removing.has(directoryKey)) throw new Error('暂存目录正在清理，请稍后重新检查。');
    const target = path.join(directory, file);
    const verify = stat => {
      const marker = this.reviewMarker(directory);
      if (!this.checkRoot() || !marker || !this.inactive(directory, marker) || marker.retained || this.isReferenced(directory) ||
        !ordinary(stat) || key(sync.realpathSync(target)) !== key(target) || this.confirmation(directory, marker, file, stat) !== confirmation) {
        throw new Error('文件身份、归属或使用状态已变化，请重新检查。');
      }
      return marker;
    };
    this.removing.add(directoryKey);
    let marker;
    const result = { freedBytes: 0, deletedFiles: 0 };
    try {
      const stat = await statIfPresent(target);
      marker = verify(stat);
      await fs.unlink(target);
      this.countRemoval(result, stat);
    } finally { this.removing.delete(directoryKey); }
    // Close out the marker if this was the final payload. Newly appearing
    // files still require the normal ownership and cleanup-plan checks.
    if ((await fs.readdir(directory)).every(file => file === MARKER)) {
      const state = this.active.get(directoryKey);
      const outcome = await this.removeOutcome(directory, marker, !!state, { checkReferences: true }).catch(() => null);
      if (outcome?.removed) {
        this.active.delete(directoryKey);
        result.freedBytes += outcome.freedBytes;
        result.deletedFiles += outcome.deletedFiles;
      }
    }
    return result;
  }
  async cleanup() {
    const result = { removed: 0, skipped: 0 };
    for (const state of this.active.values()) {
      if (state.completed && await this.finish(state.directory, { checkReferences: true })) result.removed++;
    }
    let names;
    try { if (!this.checkRoot()) return result; names = await fs.readdir(this.root); }
    catch { result.skipped++; return result; }
    for (const name of names) {
      if (!NAME.test(name)) continue;
      const directory = path.join(this.root, name);
      try {
        if (this.active.has(key(directory))) { result.skipped++; continue; }
        const marker = this.reviewMarker(directory);
        if (!marker) {
          const plan = this.journal.get(name);
          if (!plan || !this.checkRoot() || this.isReferenced(directory)) { result.skipped++; continue; }
          ownedDirectory(this.root, directory);
          if (directoryIdentity(directory) === plan.directoryId && !(await fs.readdir(directory)).length) {
            await fs.rmdir(directory);
            this.journal.delete(name);
            result.removed++;
          }
        } else if (this.inactive(directory, marker) && !marker.retained &&
            (await this.removeOutcome(directory, marker, false, { checkReferences: true }))?.removed) {
          result.removed++;
        } else result.skipped++;
      } catch { result.skipped++; }
    }
    return result;
  }
}
