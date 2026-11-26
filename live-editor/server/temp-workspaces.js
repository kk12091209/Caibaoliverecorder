import { pathKey as key } from './storage-files.js';
import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MARKER = '.bili-temp-owner.json';
const FORMAT = 'bili-editor-temp-v1';
const NAME = /^bili-(probe|export|full)-[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const jobIdValid = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
const retainedValid = value => value && typeof value === 'object' && !Array.isArray(value) && jobIdValid(value.jobId)&&(!Object.hasOwn(value,'ownerReleased')||typeof value.ownerReleased==='boolean');
const unrecognizedReason = '临时工作区有无法确认归属的文件，已保留。';
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
  constructor(root, { processAlive = processRunning } = {}) {
    this.root = path.resolve(root); this.processAlive = processAlive; this.active = new Map(); this.removing = new Set(); this.cleaning = null;
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
  async removeOutcome(directory, expected, ownActive, { control, preserveUnknown = false, keepRetained = false } = {}) {
    const directoryKey = key(directory);
    if (this.removing.has(directoryKey)) return null;
    this.removing.add(directoryKey);
    const currentOwner = () => {
      const owner = readMarker(this.root, directory);
      if (!owner || owner.token !== expected.token || owner.ownerPid !== expected.ownerPid || owner.retained || owner.pendingSpawns
        || (owner.cleanupKept ? !preserveUnknown : !ownActive && this.alive(owner.ownerPid))
        || owner.childPids.some(pid => this.alive(pid))) return null;
      return owner;
    };
    const result = { freedBytes: 0, deletedFiles: 0, retained: [], removed: false, kept: false };
    const keep = name => ({ path: path.join(directory, name), reason: unrecognizedReason });
    try {
      control?.check();
      const marker = currentOwner();
      if (!marker) return null;
      const names = (await fs.readdir(directory)).filter(name => name !== MARKER);
      if (marker.cleanupKept) return { ...result, retained: names.map(keep), kept: true };

      const markerFile = path.join(directory, MARKER);
      const markerStat = await fs.lstat(markerFile, { bigint: true });
      const files = [], unknown = new Set();
      for (const name of names) {
        const file = path.join(directory, name);
        const stat = await fs.lstat(file, { bigint: true }).catch(error => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        if (!stat) continue;
        if (!allowedFile(directory, name) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
          if (!preserveUnknown) return null;
          unknown.add(name);
        } else {
          files.push({ file, stat });
        }
      }
      const unchanged = (current, original) => current.isFile() && !current.isSymbolicLink() && current.nlink === 1n
        && current.dev === original.dev && current.ino === original.ino && current.size === original.size
        && current.mtimeNs === original.mtimeNs;
      for (const { file, stat } of files) {
        if (!currentOwner()) return null;
        const current = await fs.lstat(file, { bigint: true }).catch(error => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        if (!current) continue;
        if (!unchanged(current, stat)) return null;
        control?.check();
        await fs.unlink(file);
        result.freedBytes += Number(stat.size);
        result.deletedFiles++;
        control?.progress();
      }
      // Keep proof of ownership through partial deletion and until the user
      // confirms what can stay. A kept directory is no longer swept for files.
      const remaining = (await fs.readdir(directory)).filter(name => name !== MARKER);
      const owner = currentOwner();
      if (!owner || !unchanged(await fs.lstat(markerFile, { bigint: true }), markerStat)) return null;
      control?.check();
      if (remaining.length) {
        if (!preserveUnknown || remaining.some(name => !unknown.has(name))) return null;
        if (keepRetained) {
          const state = this.active.get(directoryKey) ?? { directory, data: owner };
          this.write(state, { ...owner, childPids: [], cleanupKept: true });
          result.kept = true;
        }
        result.retained = remaining.map(keep);
        return result;
      }
      await fs.unlink(markerFile);
      result.freedBytes += Number(markerStat.size);
      result.deletedFiles++;
      ownedDirectory(this.root, directory);
      control?.check();
      await fs.rmdir(directory);
      control?.progress();
      result.removed = true;
      return result;
    } finally {
      this.removing.delete(directoryKey);
    }
  }
  async finish(directory) {
    const state = this.active.get(key(directory)); if (!state) return false;
    state.completed = true;
    if(state.data.retained&&!state.data.pendingSpawns&&!state.data.childPids.some(pid=>this.alive(pid)))
      try{this.write(state,{...state.data,retained:{...state.data.retained,ownerReleased:true}});}catch{ /* Uncertain markers stay protected. */ }
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
  async removeSession(sessionId, { control, keepRetained = false }={}) {
    const result={freedBytes:0,deletedFiles:0,retained:[]};
    if(this.cleaning){if(control)await control.wait(this.cleaning);else await this.cleaning;}
    if(!checkDirectory(this.root,true))return result;
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
      const outcome=await this.removeOutcome(directory,marker,!!state,{control,preserveUnknown:true,keepRetained});
      if(!outcome)throw new Error('素材临时工作区仍被占用或所有权发生变化，请稍后重试删除。');
      if(outcome.removed||outcome.kept)this.active.delete(key(directory));
      result.freedBytes+=outcome.freedBytes;result.deletedFiles+=outcome.deletedFiles;
      result.retained.push(...outcome.retained);
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
        if (!marker || marker.retained || marker.cleanupKept || marker.pendingSpawns || this.alive(marker.ownerPid) || marker.childPids.some(pid => this.alive(pid))) { result.skipped++; continue; }
        // Recheck all process identities immediately before removal. Reused PIDs
        // count as alive; access-denied and other unknown states also preserve.
        if (this.alive(marker.ownerPid) || marker.childPids.some(pid => this.alive(pid))) { result.skipped++; continue; }
        if (await this.remove(directory, marker)) result.removed++; else result.skipped++;
      } catch { result.skipped++; }
    }
    return result;
  }
}
