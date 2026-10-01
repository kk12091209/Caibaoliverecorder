import { setImmediate as yieldTurn } from 'node:timers/promises';
import { isStickerPlaceholder } from './chat-filter.js';

export const DEFAULT_CHAT_RATE = 50;
export const CHAT_RATE_SETTING = 'danmaku-per-second';
export function validateChatRate(value) {
  if (!Number.isInteger(value) || value < 1 || value > 50) throw new Error('弹幕上限须为 1～50。');
  return value;
}
export function chatRate(store) {
  const value = store.setting(CHAT_RATE_SETTING);
  return Number.isInteger(value) && value >= 1 && value <= 50 ? value : DEFAULT_CHAT_RATE;
}
export function isLongChat(text) {
  if (typeof text !== 'string') return true;
  let length = 0;
  for (const character of text) if (++length >= 30) return true;
  return false;
}

// A bounded rolling window, separate for every material. A fifth occurrence
// retracts the preceding copies, including copies already indexed in SQLite.
// A continuing flood shows at most one copy per ten seconds; quiet groups expire.
export class RepeatWindow {
  constructor() { this.groups = new Map(); }
  add(message) {
    const { text, time, id } = message;
    while (this.groups.size) {
      const [key, group] = this.groups.entries().next().value;
      if (group.last >= time - 10) break;
      this.groups.delete(key);
    }
    let group = this.groups.get(text);
    if (!group || time < group.last || time - group.last > 10) group = { last: time, recent: [], candidates: [], collapsed: false };
    group.recent = group.recent.filter(entry => entry.time >= time - 10);
    group.recent.push({ id, time });
    if (group.recent.length > 5) group.recent.shift();
    group.candidates = group.candidates.filter(entry => entry.time >= time - 10);
    group.last = time;
    this.groups.delete(text); this.groups.set(text, group);
    while (this.groups.size > 2000) this.groups.delete(this.groups.keys().next().value);
    if (group.collapsed && group.recent.length < 5) { group.collapsed = false; group.candidates = []; }
    if (group.collapsed) {
      if (time - group.representative.time >= 10) { group.representative = { id, time }; return { keep: true, remove: [] }; }
      return { keep: false, remove: [] };
    }
    group.candidates.push({ id, time });
    if (group.recent.length < 5) return { keep: true, remove: [] };
    group.collapsed = true; group.representative = group.candidates[0];
    return { keep: id === group.representative.id, remove: group.candidates.slice(1).map(entry => entry.id) };
  }
}

// Policy flags use the existing filter table. Originals, XML, manual exclusions
// and lottery flags remain intact. API/render callers await bounded batches, so
// opening a long existing recording does not block the editor's event loop.
export class ChatRuleIndex {
  constructor(store) { this.store = store; this.sessions = new Map(); this.closed = false; }
  state(id) {
    const rate = chatRate(this.store);
    let state = this.sessions.get(id);
    if (!state || state.rate !== rate) {
      const removed = this.store.run("DELETE FROM danmaku_filters WHERE reason IN ('length','repeat','rate') AND message IN (SELECT id FROM danmaku WHERE session=?)", id).changes;
      state = { rate, cursor: 0, repeat: new RepeatWindow(), seconds: new Map(), pending: null };
      this.sessions.set(id, state); if (removed) this.store.density?.invalidate(id);
    }
    return state;
  }
  batch(id, state) {
    if (this.closed || this.sessions.get(id) !== state || !this.store.session(id)) return false;
    const rows = this.store.all(`SELECT d.rowid AS rowid,d.id,d.time,d.text,d.type,
      EXISTS(SELECT 1 FROM danmaku_filters f WHERE f.message=d.id AND f.reason='lottery') AS lottery
      FROM danmaku d WHERE d.session=? AND d.rowid>? ORDER BY d.rowid LIMIT 2048`, id, state.cursor);
    if (!rows.length) return false;
    let reclassified = false;
    this.store.transaction(() => {
      for (const row of rows) {
        state.cursor = row.rowid;
        if (row.type !== 'd' || !Number.isFinite(row.time) || row.lottery || isStickerPlaceholder(row.text)) continue;
        const flag = (message, reason) => this.store.run("INSERT INTO danmaku_filters(message,reason) VALUES(?,?) ON CONFLICT(message) DO UPDATE SET reason=excluded.reason WHERE danmaku_filters.reason<>'lottery'", message, reason);
        if (isLongChat(row.text)) { flag(row.id, 'length'); continue; }
        const repetition = state.repeat.add(row);
        for (const message of repetition.remove) {
          if (message !== row.id) { flag(message, 'repeat'); reclassified = true; }
        }
        if (!repetition.keep) { flag(row.id, 'repeat'); continue; }
        const second = Math.floor(row.time), count = state.seconds.get(second) || 0;
        if (count >= state.rate) flag(row.id, 'rate');
        else state.seconds.set(second, count + 1);
        for (const key of state.seconds.keys()) if (key < second - 20) state.seconds.delete(key);
      }
    });
    if (reclassified) this.store.density?.invalidate(id);
    return true;
  }
  sync(id) { const state = this.state(id); while (this.batch(id, state)) {} }
  async prepare(id) {
    if (this.closed) return;
    const state = this.state(id);
    if (state.pending) return state.pending;
    state.pending = Promise.resolve().then(async () => {
      try { while (this.batch(id, state)) await yieldTurn(); }
      catch (error) { this.sessions.delete(id); throw error; }
      finally { state.pending = null; }
    });
    return state.pending;
  }
  drop(id) { this.sessions.delete(id); }
  close() { this.closed = true; this.sessions.clear(); }
}
