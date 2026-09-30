import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { acquireReader, checkedFile, fingerprint, originalTags, isMedia, isCodecHeader } from './storage-files.js';

export const FLV_HEADER = Buffer.from([70,76,86,1,5,0,0,0,9,0,0,0,0]);
export function timestamp(tag) { return tag.readUIntBE(4, 3) + tag[7] * 16777216; }
function writeTimestamp(tag, ms) { const value = Math.max(0, Math.round(ms)) >>> 0; tag.writeUIntBE(value & 0xffffff, 4, 3); tag[7] = value >>> 24; }
export function retime(tag, ms) { const b = Buffer.from(tag); writeTimestamp(b, ms); return b; }
const STREAM_BATCH_BYTES = 256 * 1024;
export function tags(buffer) {
  const result = []; let offset = 0;
  while (offset + 15 <= buffer.length) {
    const length = buffer.readUIntBE(offset + 1, 3) + 15;
    if (length > 16 * 1024 * 1024) throw new Error('FLV 数据包大小异常。');
    if (offset + length > buffer.length) break;
    if (buffer.readUInt32BE(offset + length - 4) !== length - 4) throw new Error('FLV 数据包边界校验失败。');
    result.push({ tag: buffer.subarray(offset, offset + length), offset }); offset += length;
  }
  return { items: result, consumed: offset };
}
function videoData(b) { return b[0] === 9 && b.length > 16 && b[12] === 1; }
function keyframe(b) { return videoData(b) && b[11] >> 4 === 1; }
const decodeXML = s => s.replace(/&#x([0-9a-f]+);|&#(\d+);|&(lt|gt|quot|apos|amp);/gi, (_, x, d, n) => x || d ? String.fromCodePoint(Math.min(0x10ffff, parseInt(x || d, x ? 16 : 10))) : ({lt:'<',gt:'>',quot:'"',apos:"'",amp:'&'}[n] || ''));

export class Ingestor {
  constructor(store, { now = Date.now, xmlRetryMs = 30000 } = {}) { this.store = store; this.states = new Map(); this.xmlStates = new Map(); this.now = now; this.xmlRetryMs = xmlRetryMs; this.busy = false; this.timer = null; }
  start() { this.timer = setInterval(() => this.tick().catch(e => { this.lastError = e.message; }), 250); }
  stop() { clearInterval(this.timer); }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      const rows = this.store.all("SELECT * FROM sources WHERE error='' AND session IN (SELECT id FROM sessions WHERE deleted_at='')");
      for (const source of rows) {
        try { await this.readSource(source); await this.readDanmaku(source); }
        catch (e) { if (e.code !== 'ENOENT') { this.store.run('UPDATE sources SET error=? WHERE id=?', e.message, source.id); this.store.run('UPDATE sessions SET error=? WHERE id=?', e.message, source.session); } }
      }
    } finally { this.busy = false; }
  }
  async readSource(source) {
    if (source.closed === 2) { this.states.delete(source.id); return; }
    let state = this.states.get(source.id);
    if (!state) {
      const max = this.store.get('SELECT MAX(seq) AS seq FROM chunks WHERE source=?', source.id);
      state = { pos: source.pos, seq: (max.seq ?? -1) + 1, header: JSON.parse(source.header), parts: [], keys: [], bytes: 0, start: null, end: 0, boundary: 0 };
      this.states.set(source.id, state);
    }
    const file = await fs.open(source.path, 'r');
    try {
      const stat = await file.stat();
      if (stat.size < 13) return;
      if (state.pos === 13 && !state.parts.length) {
        const head = Buffer.alloc(13); await file.read(head, 0, 13, 0);
        if (head.toString('ascii', 0, 3) !== 'FLV' || head.readUInt32BE(5) !== 9) throw new Error('当前版本需要标准 FLV 录制文件。');
      }
      let scanned = 0, incompleteTail = false;
      while (state.pos < stat.size && scanned < 32 * 1024 * 1024) {
        const size = Math.min(20 * 1024 * 1024, stat.size - state.pos);
        const buffer = Buffer.alloc(size); const { bytesRead } = await file.read(buffer, 0, size, state.pos);
        const { items, consumed } = tags(buffer.subarray(0, bytesRead));
        if (!consumed) { incompleteTail = true; break; }
        for (const { tag } of items) {
          const type = tag[0], time = timestamp(tag) / 1000;
          if (type === 8 || type === 9) {
            if (type === 9 && (tag[11] & 15) !== 7) throw new Error('当前剪辑预览仅支持 H.264。请将录制画质设为 AVC；原始录制不会被停止。');
            const isHeader = (type === 9 || tag[11] >> 4 === 10) && tag[12] === 0;
            if (isHeader) { state.header[type === 9 ? 'video' : 'audio'] = tag.toString('base64'); }
            else {
              if (state.parts.length && time >= state.boundary) await this.flush(source, state);
              if (state.start === null) { state.start = time; state.boundary = Math.floor(time) + 1; }
              if (keyframe(tag)) state.keys.push({ time: source.start + time, offset: state.bytes });
              state.parts.push(Buffer.from(tag)); state.bytes += tag.length; state.end = Math.max(state.end, time);
            }
          }
          state.pos += tag.length;
        }
        scanned += consumed;
      }
      if (source.closed === 1 && state.pos >= stat.size) {
        await this.flush(source, state);
        this.store.run('UPDATE sources SET closed=2,pos=?,header=? WHERE id=?', state.pos, JSON.stringify(state.header), source.id);
        this.states.delete(source.id);
      } else if (source.closed === 1 && incompleteTail) {
        // A crashed writer may leave a partial final tag; preserve original bytes and report the truncated tail.
        await this.flush(source, state);
        this.store.run('UPDATE sources SET closed=2,error=? WHERE id=?', '末尾存在未写完整的数据包；已保留原文件。', source.id);
      }
    } finally { await file.close(); }
  }
  async flush(source, state) {
    if (!state.parts.length) return;
    const folder = path.join(this.store.root, 'chunks', source.id); await fs.mkdir(folder, { recursive: true });
    const target = path.join(folder, `${String(state.seq).padStart(8, '0')}.flvpart`);
    const out = await fs.open(target + '.tmp', 'w');
    try { await out.writeFile(Buffer.concat(state.parts)); await out.sync(); } finally { await out.close(); }
    await fs.rename(target + '.tmp', target);
    const start = source.start + state.start, end = source.start + state.end;
    this.store.transaction(() => {
      this.store.run('INSERT INTO chunks VALUES(?,?,?,?,?,?)', source.id, state.seq, start, end, target, state.bytes);
      for (const key of state.keys) this.store.run('INSERT INTO keyframes VALUES(?,?,?,?)', source.id, key.time, state.seq, key.offset);
      this.store.run('UPDATE sources SET pos=?,header=?,duration=MAX(duration,?) WHERE id=?', state.pos, JSON.stringify(state.header), state.end, source.id);
      this.store.run('UPDATE sessions SET duration=MAX(duration,?) WHERE id=?', end, source.session);
    });
    state.seq++; state.parts = []; state.keys = []; state.bytes = 0; state.start = null;
  }
  async readDanmaku(source) {
    if (!this.store.session(source.session)) return;
    const previous = this.xmlStates.get(source.id);
    if (source.closed === 2 && (previous?.complete || previous?.nextCheck > this.now())) return;
    const current = this.store.get('SELECT xmlpos,closed FROM sources WHERE id=?', source.id);
    if (!current) return;
    const state = previous || { complete: false, nextCheck: 0, signature: null, changedAt: this.now() };
    this.xmlStates.set(source.id, state);
    const observed = signature => {
      const now = this.now();
      if (state.signature !== signature) { state.signature = signature; state.changedAt = now; }
      // A crashed or late writer may have no closing tag. Keep checking those
      // files, but do not open every old XML four times a second indefinitely.
      state.nextCheck = current.closed === 2 && now - state.changedAt >= 5000 ? now + this.xmlRetryMs : 0;
    };
    let file; try { file = await fs.open(source.xml, 'r'); } catch (e) { if (e.code === 'ENOENT') { observed('missing'); return; } throw e; }
    try {
      const stat = await file.stat(); observed(`${stat.size}:${stat.mtimeMs}`);
      if (stat.size <= current.xmlpos) return;
      const buffer = Buffer.alloc(Math.min(4 * 1024 * 1024, stat.size - current.xmlpos));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, current.xmlpos);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      const regex = /<(d|sc|gift|guard)\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
      let match, consumed = 0; const messages = [], lotteryMessages = [];
      while ((match = regex.exec(text))) {
        // Advance past all complete events, but only index ordinary chat messages.
        consumed = regex.lastIndex;
        if(match[1]!=='d')continue;
        const attributes = {}; for (const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) attributes[attr[1]] = decodeXML(attr[2]);
        const time = Number((attributes.p || '').split(',')[0] || attributes.ts || 0) + source.start;
        const byteOffset = current.xmlpos + Buffer.byteLength(text.slice(0, match.index));
        const id = createHash('sha256').update(`${source.id}:${byteOffset}`).digest('hex').slice(0, 32);
        const content = decodeXML(match[3] || '');
        if (Number.isFinite(time)) {
          messages.push([id, source.session, source.id, time, attributes.user || '观众', content.slice(0, 10000), match[1], (attributes.p || '').split(',')[3] || '16777215']);
          // Written only after the recorder observed an explicit lottery event,
          // matching its exact passphrase inside the server's activity window.
          if (/^(?:anchor|red-pocket):[1-9]\d{0,19}$/.test(attributes.lottery || '')) lotteryMessages.push(id);
        }
      }
      if (consumed && this.store.session(source.session)) this.store.transaction(() => {
        const inserted=new Set();
        for (const values of messages) if(this.store.run('INSERT OR IGNORE INTO danmaku VALUES(?,?,?,?,?,?,?,?)', ...values).changes)inserted.add(values[0]);
        let changed=false;
        for (const id of lotteryMessages) if(this.store.run("INSERT OR IGNORE INTO danmaku_filters(message,reason) VALUES(?,'lottery')",id).changes&&!inserted.has(id))changed=true;
        // New rows and their flags become visible atomically to the rowid
        // cursor. Rebuild only when a previously indexed row is reclassified.
        if(changed)this.store.density?.invalidate(source.session);
        this.store.run('UPDATE sources SET xmlpos=? WHERE id=?', current.xmlpos + Buffer.byteLength(text.slice(0, consumed)), source.id);
      });
      // The recorder closes the <i> document when its XML writer is disposed.
      // Only seal after reading the actual EOF, never after a bounded backlog read.
      const atEnd = current.xmlpos + bytesRead >= stat.size;
      if (current.closed === 2 && atEnd && /<\/i>\s*$/.test(text) && this.store.session(source.session)) state.complete = true;
      else if (!atEnd && consumed) state.nextCheck = 0;
    } finally { await file.close(); }
  }
}

export async function* sourceStream(store, sourceId, from, to, { follow = false, signal } = {}) {
  let source = store.get('SELECT * FROM sources WHERE id=?', sourceId);
  if(!source||!store.session(source.session))throw new Error('素材不存在或已经删除。');
  const reader=acquireReader(store,sourceId);let original;
  try {
  const key = store.get('SELECT * FROM keyframes WHERE source=? AND time<=? ORDER BY time DESC LIMIT 1', sourceId, from) || store.get('SELECT * FROM keyframes WHERE source=? ORDER BY time LIMIT 1', sourceId);
  if (!key) throw new Error('正在等待可解码的关键帧。');
  const base = key.time;
  let absolute;
  if(reader.mode==='direct') {
    absolute=store.get('SELECT raw_offset FROM direct_keyframes WHERE source=? AND seq=? AND chunk_offset=?',sourceId,key.seq,key.offset)?.raw_offset;
    if(!Number.isSafeInteger(absolute)||absolute<13)throw new Error('完整原片的定位索引缺失，请检查素材。');
    const stat=await checkedFile(path.join(store.root,'originals'),source.path);
    if(fingerprint(stat)!==reader.storage.fingerprint)throw new Error('完整原片在整理后发生变化，无法安全读取，请恢复原文件。');
    original=await fs.open(source.path,'r');
    if(fingerprint(await original.stat({bigint:true}))!==reader.storage.fingerprint)throw new Error('完整原片在打开时发生变化，请恢复原文件。');
  }
  yield FLV_HEADER;
  const header = JSON.parse(source.header);
  for (const name of ['video', 'audio']) if (header[name]) yield retime(Buffer.from(header[name], 'base64'), 0);
  if(original) {
    for await(const {tag} of originalTags(original,absolute,{signal})) {
      if(!isMedia(tag)||isCodecHeader(tag))continue;
      const global=source.start+timestamp(tag)/1000;
      if(global>to+.1)return;
      yield retime(tag,(global-base)*1000);
    }
    return;
  }
  let seq = key.seq, first = true;
  while (!signal?.aborted) {
    const chunk = store.get('SELECT * FROM chunks WHERE source=? AND seq=?', sourceId, seq);
    if (!chunk) {
      source = store.get('SELECT * FROM sources WHERE id=?', sourceId);
      if(!source||!store.session(source.session))return;
      if (!follow || source.closed === 2 || source.error) return;
      await new Promise(resolve => setTimeout(resolve, 120)); continue;
    }
    const data = await fs.readFile(chunk.path); const part = first ? data.subarray(key.offset) : data;
    // readFile owns this buffer. Retiming it never changes the stored chunk.
    // Keep complete FLV tags together and flush each chunk's tail immediately
    // so a live preview never waits for a future chunk to fill a batch.
    let batchStart = 0, batchEnd = 0;
    for (const { tag, offset } of tags(part).items) {
      if (signal?.aborted) return;
      const global = source.start + timestamp(tag) / 1000;
      if (global > to + 0.1) {
        if (batchEnd > batchStart) yield part.subarray(batchStart, batchEnd);
        return;
      }
      writeTimestamp(tag, (global - base) * 1000);
      batchEnd = offset + tag.length;
      if (batchEnd - batchStart >= STREAM_BATCH_BYTES) {
        yield part.subarray(batchStart, batchEnd);
        batchStart = batchEnd;
      }
    }
    if (batchEnd > batchStart && !signal?.aborted) yield part.subarray(batchStart, batchEnd);
    first = false; seq++;
  }
  } finally {try{await original?.close();}finally{reader.release();}}
}

export function seekBase(store, sourceId, time) {
  return store.get('SELECT time FROM keyframes WHERE source=? AND time<=? ORDER BY time DESC LIMIT 1', sourceId, time)?.time ?? store.get('SELECT time FROM keyframes WHERE source=? ORDER BY time LIMIT 1', sourceId)?.time;
}
