import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MARKER = '.bili-temp-owner.json';
const FORMAT = 'bili-editor-temp-v1';
const NAME = /^bili-(probe|export|full)-[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const jobIdValid = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
const retainedValid = value => value && typeof value === 'object' && !Array.isArray(value) && jobIdValid(value.jobId);
const pidValid = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

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
    || ('retained' in data && (!retainedValid(data.retained) || NAME.exec(path.basename(directory))?.[1] !== 'export'))) return null;
  return data;
}

function allowedFile(directory, name) {
  if (name === MARKER) return true;
  const kind = NAME.exec(path.basename(directory))?.[1];
  if (kind === 'probe') return name === 'sample.flv';
  if (kind === 'export' && (name === '.bili-export-publication.json' || /^\.bili-export-publication-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/i.test(name))) return true;
  if (kind === 'export' && /^(?:audio-\d+\.flac|audio-concat\.txt|video-concat(?:-danmaku)?\.txt|video(?:-danmaku)?\.mp4|audio\.m4a)$/.test(name)) return true;
  if (kind === 'export') return /^(?:part-\d+(?:-danmaku)?\.mp4|part-\d+\.ass|concat(?:-danmaku)?\.txt|final(?:-danmaku)?\.mp4)$/.test(name);
  return false;
}

export class TemporaryWorkspaces {
  constructor(root, { processAlive = processRunning } = {}) {
    this.root = path.resolve(root); this.processAlive = processAlive; this.active = new Map(); this.cleaning = null;
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
    // An interrupted write leaves an invalid marker, which cleanup preserves.
    sync.writeFileSync(path.join(state.directory, MARKER), JSON.stringify(data)); state.data = data;
  }
  retainedState(directory, jobId, requireRetained = true) {
    if (!jobIdValid(jobId)) throw new Error('保留导出的任务编号无效。');
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\x00-\x1f]/.test(directory)) throw new Error('保留导出的临时目录无效。');
    directory = path.resolve(directory);
    if (NAME.exec(path.basename(directory))?.[1] !== 'export') throw new Error('仅导出临时目录可以保留待发布的视频。');
    const marker = readMarker(this.root, directory);
    if (!marker || (marker.retained && marker.retained.jobId !== jobId) || (requireRetained && !marker.retained)) throw new Error('保留导出的所有权或任务标记不匹配，已保留文件。');
    let state = this.active.get(key(directory));
    if (state) {
      if (state.finishing) throw new Error('临时工作区正在清理，不能改变保留状态。');
      if (marker.token !== state.data.token || marker.ownerPid !== state.data.ownerPid || marker.ownerPid !== process.pid) throw new Error('临时工作区所有权已变化，已保留文件。');
      if (requireRetained && (marker.pendingSpawns || marker.childPids.some(pid => this.alive(pid)))) throw new Error('保留导出仍有视频进程运行或启动中，请稍后重试。');
      state.data = marker;
    } else {
      // Only previously retained orphans may be recovered. An unmarked orphan
      // could already be in a cleanup pass and must never be claimed here.
      if (!marker.retained || marker.pendingSpawns || this.alive(marker.ownerPid) || marker.childPids.some(pid => this.alive(pid))) throw new Error('保留导出仍由其他进程使用，或无法确认其已停止。');
      state = { directory, completed: false, finishing: null, data: marker };
      this.write(state, { ...marker, ownerPid: process.pid, childPids: [] });
      this.active.set(key(directory), state);
    }
    return state;
  }
  async retain(directory, jobId) {
    const state = this.retainedState(directory, jobId, false);
    this.write(state, { ...state.data, retained: { jobId } });
    state.completed = false;
    return true;
  }
  async adoptRetained(directory, jobId) {
    const state = this.retainedState(directory, jobId);
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
  async remove(directory, expected, ownActive = false) {
    const marker = readMarker(this.root, directory);
    if (!marker || marker.token !== expected.token || marker.ownerPid !== expected.ownerPid || marker.retained || marker.pendingSpawns || (!ownActive && this.alive(marker.ownerPid)) || marker.childPids.some(pid => this.alive(pid))) return false;
    const files = [];
    for (const name of await fs.readdir(directory)) {
      if (!allowedFile(directory, name)) return false;
      const file = path.join(directory, name), stat = await fs.lstat(file, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) return false;
      files.push({ file, stat, marker: name === MARKER });
    }
    // Keep proof of ownership until all large work files are removed. Partial
    // failures retain the marker and can be retried without broad directory rm.
    files.sort((a,b) => Number(a.marker) - Number(b.marker));
    for (const entry of files) {
      ownedDirectory(this.root, directory);
      const owner = readMarker(this.root, directory);
      if (!owner || owner.token !== expected.token || owner.ownerPid !== expected.ownerPid || owner.retained || owner.pendingSpawns || (!ownActive && this.alive(owner.ownerPid)) || owner.childPids.some(pid => this.alive(pid))) return false;
      if(entry.marker&&(await fs.readdir(directory)).some(name=>name!==MARKER))return false;
      const current = await fs.lstat(entry.file, { bigint: true });
      if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1n || current.dev !== entry.stat.dev || current.ino !== entry.stat.ino || current.size !== entry.stat.size || current.mtimeNs !== entry.stat.mtimeNs) return false;
      await fs.unlink(entry.file);
    }
    ownedDirectory(this.root, directory); await fs.rmdir(directory); return true;
  }
  async finish(directory) {
    const state = this.active.get(key(directory)); if (!state) return false;
    state.completed = true;
    if (state.finishing) return state.finishing;
    state.finishing = (async () => {
      try { const removed = await this.remove(directory, state.data, true); if (removed) this.active.delete(key(directory)); return removed; }
      catch { return false; }
      finally { state.finishing = null; }
    })();
    return state.finishing;
  }
  cleanupStale() {
    if (this.cleaning) return this.cleaning;
    this.cleaning = this.cleanup().finally(() => { this.cleaning = null; }); return this.cleaning;
  }
  async removeSession(sessionId) {
    const result={freedBytes:0,deletedFiles:0};
    if(this.cleaning)await this.cleaning;
    if(!checkDirectory(this.root,true))return result;
    for(const name of await fs.readdir(this.root)) {
      if(!NAME.test(name))continue;
      const directory=path.join(this.root,name);
      let marker;try{marker=readMarker(this.root,directory);}catch{continue;}
      if(marker?.sessionId!==sessionId)continue;
      const state=this.active.get(key(directory));
      if(state?.finishing){await state.finishing;if(!this.active.has(key(directory)))continue;}
      if(marker.retained||marker.pendingSpawns||marker.childPids.some(pid=>this.alive(pid))||(state?!state.completed:this.alive(marker.ownerPid)))throw new Error('这份素材的临时工作区仍在处理或等待保存，请稍后重试删除。');
      let bytes=0,count=0;
      for(const file of await fs.readdir(directory)) {
        const stat=await fs.lstat(path.join(directory,file));
        if(!allowedFile(directory,file)||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error('素材临时工作区中有无法确认的文件，已保留，请检查后重试删除。');
        bytes+=stat.size;count++;
      }
      if(!await this.remove(directory,marker,!!state))throw new Error('素材临时工作区仍被占用或所有权发生变化，请稍后重试删除。');
      this.active.delete(key(directory));result.freedBytes+=bytes;result.deletedFiles+=count;
    }
    return result;
  }
  async cleanup() {
    const result = { removed: 0, skipped: 0 };
    for (const state of this.active.values()) if (state.completed && await this.finish(state.directory)) result.removed++;
    let names;
    try { if (!checkDirectory(this.root, true)) return result; names = await fs.readdir(this.root); }
    catch { result.skipped++; return result; }
    for (const name of names) {
      if (!NAME.test(name)) continue;
      const directory = path.join(this.root, name);
      try {
        if (this.active.has(key(directory))) { result.skipped++; continue; }
        const marker = readMarker(this.root, directory);
        if (!marker || marker.retained || marker.pendingSpawns || this.alive(marker.ownerPid) || marker.childPids.some(pid => this.alive(pid))) { result.skipped++; continue; }
        // Recheck all process identities immediately before removal. Reused PIDs
        // count as alive; access-denied and other unknown states also preserve.
        if (this.alive(marker.ownerPid) || marker.childPids.some(pid => this.alive(pid))) { result.skipped++; continue; }
        if (await this.remove(directory, marker)) result.removed++; else result.skipped++;
      } catch { result.skipped++; }
    }
    return result;
  }
}
