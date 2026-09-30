import { isStickerPlaceholder } from './chat-filter.js';

const BLOCK_SECONDS = 256;

// Keep one counter per second, not one entry per chat message. Sparse blocks also
// avoid allocating a recording-length array when a source has a large time gap.
class Histogram {
  constructor() { this.blocks = new Map(); }
  add(time) {
    if (!Number.isFinite(time) || time < 0 || !Number.isSafeInteger(Math.floor(time))) return;
    const second = Math.floor(time), key = Math.floor(second / BLOCK_SECONDS);
    let block = this.blocks.get(key);
    if (!block) this.blocks.set(key, block = { values: new Float64Array(BLOCK_SECONDS), total: 0 });
    block.values[second % BLOCK_SECONDS]++;
    block.total++;
  }
  sum(from, to) {
    if (from >= to) return 0;
    const first = Math.floor(from / BLOCK_SECONDS), last = Math.floor((to - 1) / BLOCK_SECONDS);
    let total = 0;
    const partial = (key, start, end) => {
      const block = this.blocks.get(key);
      if (block) for (let i = start; i < end; i++) total += block.values[i];
    };
    if (first === last) {
      partial(first, from % BLOCK_SECONDS, (to - 1) % BLOCK_SECONDS + 1);
      return total;
    }
    partial(first, from % BLOCK_SECONDS, BLOCK_SECONDS);
    partial(last, 0, (to - 1) % BLOCK_SECONDS + 1);
    // Do not walk billions of empty seconds for sparse or malformed timelines.
    if (last - first - 1 <= this.blocks.size) {
      for (let key = first + 1; key < last; key++) total += this.blocks.get(key)?.total || 0;
    } else {
      for (const [key, block] of this.blocks) if (key > first && key < last) total += block.total;
    }
    return total;
  }
}

function invalid(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function windowBins(session, options) {
  const from = Number(options.from ?? 0), to = Number(options.to ?? session.duration ?? 0);
  const requested = Number(options.bins ?? 300);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from ||
      !Number.isSafeInteger(Math.ceil(to)) || !Number.isFinite(requested) || requested < 1) {
    throw invalid('弹幕密度的时间范围或分段数量无效。');
  }
  const start = Math.floor(from), span = Math.ceil(to) - start;
  if (!span) return { from: start, to: start, step: 1, bins: [] };
  const count = Math.min(1000, span, Math.floor(requested));
  const step = Math.ceil(span / count), length = Math.ceil(span / step);
  const end = start + length * step;
  if (!Number.isSafeInteger(end)) throw invalid('弹幕密度的时间范围过大。');
  return { from: start, to: end, step, bins: new Array(length).fill(0) };
}

export class DensityService {
  constructor(store, { batchSize = 2048, maxSessions = 4 } = {}) {
    this.store = store;
    this.batchSize = Math.max(1, Math.min(8192, Math.floor(Number(batchSize)) || 2048));
    this.maxSessions = Math.max(1, Math.min(16, Math.floor(Number(maxSessions)) || 4));
    this.cache = new Map();
    this.closed = false;
  }

  request(sessionId, options = {}) {
    if (this.closed) throw invalid('弹幕密度服务已关闭。', 503);
    const session = this.store.session(sessionId);
    if (!session) {
      this.drop(sessionId);
      throw invalid('找不到录像。', 404);
    }
    const result = windowBins(session, options);
    let entry = this.cache.get(sessionId);
    if (!entry) {
      entry = { id: sessionId, histogram: new Histogram(), cursor: 0, target: 0,
        revision: undefined, excluded: new Set(), filterLottery: true, status: 'ready', scheduled: null };
      this.cache.set(sessionId, entry);
      while (this.cache.size > this.maxSessions) this.drop(this.cache.keys().next().value);
    } else {
      this.cache.delete(sessionId);
      this.cache.set(sessionId, entry);
    }
    this.syncEdit(entry);
    // dm_session's implicit rowid suffix makes both the watermark and bounded
    // batches efficient. A timestamp watermark would miss late XML messages.
    const latest = this.store.get('SELECT rowid AS value FROM danmaku WHERE session=? ORDER BY rowid DESC LIMIT 1', sessionId)?.value || 0;
    entry.target = Math.max(entry.target, latest);
    if (entry.cursor < entry.target) {
      // Surface a failed batch to this caller before the deferred retry starts.
      if (entry.status !== 'error') entry.status = 'building';
      this.schedule(entry);
    }
    for (let i = 0; i < result.bins.length; i++) {
      const start = result.from + i * result.step;
      result.bins[i] = entry.histogram.sum(start, start + result.step);
    }
    return { ...result, status: entry.status, ...(entry.error ? { error: entry.error } : {}) };
  }

  syncEdit(entry) {
    const revision = this.store.get('SELECT revision FROM edits WHERE session=?', entry.id)?.revision || 0;
    if (revision === entry.revision) return;
    const edit = this.store.edit(entry.id), excluded = new Set(edit.excluded || []);
    const filterLottery = edit.filterLottery !== false;
    const changed = filterLottery !== entry.filterLottery || excluded.size !== entry.excluded.size ||
      [...excluded].some(id => !entry.excluded.has(id));
    entry.revision = revision;
    entry.excluded = excluded;
    entry.filterLottery = filterLottery;
    // Changes to ranges and their checkboxes do not invalidate chat density.
    if (changed) {
      entry.histogram = new Histogram();
      entry.cursor = 0;
      entry.status = entry.target ? 'building' : 'ready';
    }
  }

  schedule(entry) {
    if (entry.scheduled || this.closed || this.cache.get(entry.id) !== entry) return;
    entry.scheduled = setImmediate(() => {
      entry.scheduled = null;
      this.scan(entry);
    });
  }

  scan(entry) {
    if (this.closed || this.cache.get(entry.id) !== entry) return;
    try {
      if (!this.store.session(entry.id)) { this.drop(entry.id); return; }
      entry.status = 'building';
      entry.error = undefined;
      this.syncEdit(entry);
      const allowed = entry.filterLottery
        ? "NOT EXISTS (SELECT 1 FROM danmaku_filters f WHERE f.message=d.id AND f.reason='lottery')"
        : '1';
      // Read all message types and project the filter. Filtering in WHERE could
      // scan an unbounded run of excluded gifts/lottery messages in one turn.
      const rows = this.store.all(`SELECT d.rowid AS rowid,d.id,d.time,d.type,d.text,${allowed} AS allowed
        FROM danmaku d WHERE d.session=? AND d.rowid>? AND d.rowid<=? ORDER BY d.rowid LIMIT ?`,
      entry.id, entry.cursor, entry.target, this.batchSize);
      for (const row of rows) {
        if (row.type === 'd' && row.allowed && !entry.excluded.has(row.id) && !isStickerPlaceholder(row.text)) entry.histogram.add(row.time);
        entry.cursor = row.rowid;
      }
      if (rows.length < this.batchSize) entry.cursor = entry.target;
      if (entry.cursor < entry.target) this.schedule(entry);
      else entry.status = 'ready';
    } catch (error) {
      entry.status = 'error';
      entry.error = error.message;
    }
  }

  // Raw messages append through rowid. Reclassification is the one other writer
  // and must call invalidate after it changes danmaku_filters for this session.
  invalidate(sessionId) { this.drop(sessionId); }

  drop(sessionId) {
    const entry = this.cache.get(sessionId);
    if (entry?.scheduled) clearImmediate(entry.scheduled);
    this.cache.delete(sessionId);
  }

  close() {
    this.closed = true;
    for (const id of this.cache.keys()) this.drop(id);
  }
}
