import { stopChild } from './child-stop.js';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import { sourceStream, seekBase } from './ingest.js';

const VERSION = 1, STEP = .1, BLOCK = 30, CELLS = 300, STRIDE = 5;
const immediate = () => new Promise(resolve => setImmediate(resolve));
const amplitude = value => value === '-inf' ? 0 : Math.min(1, Math.max(0, 10 ** (Number(value) / 20)));
function signature(source) {
  let audio = '';
  try { const header = JSON.parse(source.header).audio; if (header) audio = Buffer.from(header, 'base64').subarray(11, -4).toString('base64'); } catch {}
  return JSON.stringify([VERSION, source.start, audio]);
}
function blank() { return Buffer.alloc(CELLS * STRIDE); }
function dataOf(row) { return row?.data?.length === CELLS * STRIDE ? Buffer.from(row.data) : blank(); }

// astats metadata arrives in arbitrary stdout chunks. PTS, not frame number,
// anchors samples to the source clock, including delayed audio and gaps.
export class WaveformMetadata extends Writable {
  constructor(onFrame) { super(); this.onFrame = onFrame; this.tail = ''; this.frame = null; }
  emitFrame() {
    if (this.frame && Number.isFinite(this.frame.time) && Number.isFinite(this.frame.peak) && Number.isFinite(this.frame.rms)) this.onFrame(this.frame);
    this.frame = null;
  }
  line(line) {
    const time = /\bpts_time:([-+.\deE]+)/.exec(line);
    if (time) { this.emitFrame(); this.frame = { time: Number(time[1]), duration: STEP }; return; }
    const value = /^lavfi\.astats\.Overall\.(Peak_level|RMS_level|Number_of_samples)=(.+)$/.exec(line);
    if (!value || !this.frame) return;
    if (value[1] === 'Number_of_samples') this.frame.duration = Math.min(STEP, Math.max(0, Number(value[2]) / 8000));
    else this.frame[value[1] === 'Peak_level' ? 'peak' : 'rms'] = amplitude(value[2]);
  }
  _write(bytes, encoding, callback) {
    try {
      this.tail += bytes.toString(); const lines = this.tail.split('\n'); this.tail = lines.pop();
      if (this.tail.length > 65536) throw new Error('音频波形输出格式异常。');
      for (const line of lines) this.line(line.trim()); callback();
    } catch (error) { callback(error); }
  }
  _final(callback) { try { if (this.tail) this.line(this.tail.trim()); this.emitFrame(); callback(); } catch (error) { callback(error); } }
}

export class WaveformService {
  constructor(store, media, { now = Date.now, decode } = {}) {
    this.store = store; this.media = media; this.now = now; this.decoder = decode;
    this.closed = false; this.blocked = new Map(); this.demands = new Map(); this.serial = 0; this.task = null; this.active = null;
    store.db.exec(`CREATE TABLE IF NOT EXISTS waveform_blocks(
      source TEXT NOT NULL REFERENCES sources(id),block INTEGER NOT NULL,signature TEXT NOT NULL,
      covered REAL NOT NULL,state TEXT NOT NULL,data BLOB NOT NULL,error TEXT NOT NULL DEFAULT '',
      retry REAL NOT NULL DEFAULT 0,PRIMARY KEY(source,block));`);
  }
  allowed(id) { return !this.closed && !this.blocked.has(id) && !this.store.deletions?.has(id) && !!this.store.session(id); }
  rows(source, from, to) {
    return this.store.all('SELECT * FROM waveform_blocks WHERE source=? AND block>=? AND block<=? AND signature=?', source.id,
      Math.max(0, Math.floor((from - source.start) / BLOCK)), Math.max(0, Math.floor((to - source.start - 1e-8) / BLOCK)), signature(source));
  }
  request(sessionId, { from = 0, to, bins = 600 } = {}) {
    const session = this.store.session(sessionId);
    if (!session || !this.allowed(sessionId)) throw new Error('素材不存在或正在删除。');
    to ??= session.duration;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from || !Number.isFinite(bins)) throw new Error('波形时间范围无效。');
    from = Math.min(from, session.duration); to = Math.min(to, session.duration); bins = Math.max(1, Math.min(1000, Math.floor(bins)));
    if (!(to > from)) return { bins: [], status: 'pending', hasAudio: null };
    const sources = this.store.sources(sessionId).filter(s => s.start < to && s.start + s.duration > from);
    const bars = Array.from({ length: bins }, () => ({ peak: 0, rms: 0, state: 'unavailable' }));
    const pending = new Uint8Array(bins), measured = new Uint8Array(bins), failed = new Uint8Array(bins);
    const width = (to - from) / bins;
    function visit(start, end, fn) {
      const a = Math.max(0, Math.floor((start - from) / width)), b = Math.min(bins - 1, Math.ceil((end - from) / width) - 1);
      for (let i = a; i <= b; i++) fn(i);
    }
    let hasAudio = false, hasNoAudio = false;
    for (const source of sources) {
      const start = Math.max(from, source.start), end = Math.min(to, source.start + source.duration);
      const rows = new Map(this.rows(source, from, to).map(row => [row.block, row]));
      for (let n = Math.floor((start - source.start) / BLOCK); n <= Math.floor((end - source.start - 1e-8) / BLOCK); n++) {
        const blockStart = source.start + n * BLOCK, row = rows.get(n), blockEnd = Math.min(blockStart + BLOCK, end);
        const covered = Math.min(blockEnd, row?.covered ?? blockStart), data = dataOf(row);
        if (row?.state === 'no_audio') hasNoAudio = true;
        if (covered < blockEnd) visit(Math.max(start, covered), blockEnd, i => { (row?.state === 'error' ? failed : pending)[i] = 1; });
        for (let j = Math.max(0, Math.floor((start - blockStart) / STEP)); j < CELLS && blockStart + j * STEP < covered; j++) {
          const offset = j * STRIDE; if (!data[offset]) continue; hasAudio = true;
          const peak = data.readUInt16LE(offset + 1) / 65535, rms = data.readUInt16LE(offset + 3) / 65535;
          visit(Math.max(start, blockStart + j * STEP), Math.min(covered, blockStart + (j + 1) * STEP), i => {
            measured[i] = 1; bars[i].peak = Math.max(bars[i].peak, peak); bars[i].rms = Math.max(bars[i].rms, rms);
          });
        }
      }
    }
    for (let i = 0; i < bins; i++) bars[i].state = failed[i] ? 'unavailable' : pending[i] ? 'pending' : measured[i] ? bars[i].peak > 1 / 65535 ? 'ready' : 'silent' : 'unavailable';
    const incomplete = pending.some(Boolean), unreadable = failed.some(Boolean);
    this.demands.set(sessionId, { sessionId, from, to, requested: this.now(), serial: ++this.serial });
    this.pump();
    return { bins: bars, status: incomplete || unreadable ? hasAudio ? 'partial' : incomplete ? 'pending' : 'unavailable' : hasAudio ? 'ready' : hasNoAudio ? 'no_audio' : 'unavailable', hasAudio: hasAudio ? true : incomplete || unreadable ? null : hasNoAudio ? false : null };
  }
  pump() {
    if (this.task || this.closed) return;
    this.task = Promise.resolve().then(() => this.drain()).catch(error => { this.lastError = error.message; }).finally(() => { this.task = null; });
  }
  next() {
    for (const demand of [...this.demands.values()].sort((a, b) => b.serial - a.serial)) {
      if (!this.allowed(demand.sessionId) || this.now() - demand.requested > 15000) { this.demands.delete(demand.sessionId); continue; }
      for (const source of this.store.sources(demand.sessionId)) {
        const start = Math.max(demand.from, source.start), available = source.start + source.duration;
        const end = Math.min(demand.to, source.closed === 2 ? available : source.start + Math.floor(source.duration / STEP + 1e-6) * STEP);
        if (!(end > start)) continue;
        const rows = new Map(this.rows(source, start, end).map(row => [row.block, row]));
        for (let block = Math.floor((start - source.start) / BLOCK); block <= Math.floor((end - source.start - 1e-8) / BLOCK); block++) {
          const blockStart = source.start + block * BLOCK, row = rows.get(block);
          // Fill a fixed source block once, so changing zoom never marks unseen prefixes as analysed.
          const from = Math.max(blockStart, row?.covered ?? blockStart), to = Math.min(blockStart + BLOCK, end);
          if (to <= from + 1e-6 || row?.retry > this.now()) continue;
          if (source.closed !== 2 && row && to - from < 3 && available - to < STEP + 1e-5 && to < blockStart + BLOCK) continue;
          return { source, block, from, to, row, signature: signature(source) };
        }
      }
    }
    return null;
  }
  async drain() {
    while (!this.closed) {
      const work = this.next(); if (!work) return;
      const controller = new AbortController(), active = { sessionId: work.source.session, controller, done: null };
      this.active = active; active.done = this.analyse(work, controller.signal);
      try { await active.done; } finally { if (this.active === active) this.active = null; }
      await immediate();
    }
  }
  async analyse(work, signal) {
    const { source, block, from, to } = work, data = dataOf(work.row); let state = 'ready', error = '', retry = 0;
    const onFrame = frame => {
      const begin = Math.max(from, frame.time), end = Math.min(to, frame.time + frame.duration), blockStart = source.start + block * BLOCK;
      if (!(end > begin)) return;
      for (let i = Math.max(0, Math.floor((begin - blockStart) / STEP + 1e-7)); i < CELLS && blockStart + i * STEP < end - 1e-7; i++) {
        const offset = i * STRIDE; data[offset] = 1;
        data.writeUInt16LE(Math.max(data.readUInt16LE(offset + 1), Math.round(frame.peak * 65535)), offset + 1);
        data.writeUInt16LE(Math.max(data.readUInt16LE(offset + 3), Math.round(frame.rms * 65535)), offset + 3);
      }
    };
    try {
      if (signal.aborted || !this.allowed(source.session)) return;
      const result = this.decoder ? await this.decoder(source, from, to, signal, onFrame) : await this.decode(source, from, to, signal, onFrame);
      if (result?.noAudio) state = 'no_audio';
    } catch (failure) {
      if (signal.aborted) return;
      state = 'error'; error = failure.message.slice(0, 300); retry = this.now() + 30000;
    }
    if (signal.aborted || !this.allowed(source.session)) return;
    const current = this.store.get('SELECT * FROM sources WHERE id=?', source.id);
    if (!current || signature(current) !== work.signature) return;
    // Cancellation/deletion cannot interleave between this final guard and the synchronous write.
    this.store.run('INSERT INTO waveform_blocks(source,block,signature,covered,state,data,error,retry) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source,block) DO UPDATE SET signature=excluded.signature,covered=excluded.covered,state=excluded.state,data=excluded.data,error=excluded.error,retry=excluded.retry',
      source.id, block, work.signature, state === 'error' ? work.row?.covered ?? source.start + block * BLOCK : to, state, state === 'error' ? dataOf(work.row) : data, error, retry);
  }
  async decode(source, from, to, signal, onFrame) {
    if (signal.aborted) return;
    const base = seekBase(this.store, source.id, from);
    if (!Number.isFinite(base)) throw new Error('正在等待可解码的音频数据。');
    const filter = `atrim=start=${Math.max(0, from - base)}:end=${Math.max(0, to - base)},aresample=8000,asetnsamples=n=800:p=0,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level+RMS_level+Number_of_samples,ametadata=mode=print:file=-:direct=1`;
    const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-copyts', '-threads', '1', '-filter_threads', '1', '-probesize', '1000000', '-analyzeduration', '1000000', '-f', 'flv', '-i', 'pipe:0', '-map', '0:a:0', '-vn', '-sn', '-dn', '-af', filter, '-f', 'null', '-'];
    const child = this.media.spawnTracked(this.media.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.media.children.add(child); this.media.interactiveChildren.add(child); try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    let log = '', spawnError, timedOut = false;
    child.stderr.on('data', b => { log = (log + b).slice(-4000); }); child.once('error', e => { spawnError = e; });
    const done = new Promise(resolve => child.once('close', code => { this.media.children.delete(child); this.media.interactiveChildren.delete(child); resolve(code); }));
    const input = Readable.from(sourceStream(this.store, source.id, from, to, { signal }));
    const output = new WaveformMetadata(frame => onFrame({ ...frame, time: base + frame.time }));
    const abort = () => { input.destroy(); stopChild(child); };
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; abort(); }, 30000); timeout.unref?.();
    if (signal.aborted) abort();
    try {
      // Unlike Promise.all, settling every pipe waits for sourceStream.finally
      // and its reader lease even when FFmpeg exits or an input read fails early.
      const results = await Promise.allSettled([done, pipeline(input, child.stdin).catch(e => { stopChild(child); throw e; }), pipeline(child.stdout, output).catch(e => { stopChild(child); throw e; })]);
      if (signal.aborted) return;
      if (timedOut) throw new Error('音频波形分析超时，稍后重试。');
      if (spawnError) throw spawnError;
      const inputFailure = results[1].status === 'rejected' && results[1].reason;
      if (inputFailure && !['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE'].includes(inputFailure.code)) throw inputFailure;
      if (results[2].status === 'rejected') throw results[2].reason;
      if (/matches no streams|does not contain any stream/.test(log)) return { noAudio: true };
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      if (results[0].value !== 0) throw new Error('音频波形读取失败：' + log.slice(-500));
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
  }
  async cancelSession(id) {
    this.blocked.set(id, (this.blocked.get(id) || 0) + 1); this.demands.delete(id);
    const active = this.active;
    if (active?.sessionId === id) { active.controller.abort(); await active.done; }
  }
  allowSession(id) { const count = this.blocked.get(id) || 0; if (count > 1) this.blocked.set(id, count - 1); else this.blocked.delete(id); }
  async close() { this.closed = true; this.demands.clear(); this.active?.controller.abort(); await this.task; }
}
