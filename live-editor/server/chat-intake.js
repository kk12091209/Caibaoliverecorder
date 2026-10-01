import { isStickerPlaceholder } from './chat-filter.js';
import { isLongChat, validateChatRate } from './chat-rules.js';

export const CHAT_LIMITS = Object.freeze({ perRoomPerSecond: 50, roomMessages: 2000,
  roomBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024,
  messageBytes: 16 * 1024, recentIds: 10000, recentIdMs: 120000 });

// One bounded reservoir per receipt second. Retain messages across a burst,
// rather than keeping only its beginning. Text equality is never deduplication.
export class ChatIntake {
  constructor({ now = Date.now, random = Math.random, limits = {}, filterLottery = () => false } = {}) {
    this.now = now; this.random = random; this.limits = { ...CHAT_LIMITS, ...limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('弹幕限制无效。');
    validateChatRate(this.limits.perRoomPerSecond);
    this.filterLottery = filterLottery; this.rooms = new Map(); this.bytes = 0;
  }
  start(room,{start=this.now()}={}) {
    if (typeof room !== 'string' || !room.length || room.length > 128) throw new Error('直播间标识无效。');
    if (!this.rooms.has(room) && this.rooms.size >= 64) throw new Error('同时采集的直播间过多。');
    if (!this.rooms.has(room)) this.rooms.set(room, { windows: new Map(), ids: new Map(), bytes: 0, count: 0,
      received: 0, filtered: 0, duplicates: 0, limited: 0, closed: false,start });
  }
  setRateLimit(value) {
    this.limits.perRoomPerSecond = validateChatRate(value);
    for (const state of this.rooms.values()) for (const window of state.windows.values()) {
      for (const item of window.items.splice(value)) { state.bytes-=item.size;this.bytes-=item.size;state.count--;state.limited++; }
    }
  }
  add(room, message) {
    const state = this.rooms.get(room); if (!state || state.closed) return false;
    state.received++;
    if (!message || typeof message.text !== 'string' || !Number.isFinite(message.time) || message.time < 0) return false;
    if (this.filterLottery(room, message) || isStickerPlaceholder(message.text) || isLongChat(message.text)) { state.filtered++; return false; }
    const id = typeof message.id === 'string' ? message.id : '', now = this.now();
    if (!id || id.length > 128) return false;
    const size = Buffer.byteLength(id) + Buffer.byteLength(message.text) + Buffer.byteLength(String(message.user || '')) + 256;
    if (size > this.limits.messageBytes) { state.limited++; return false; }
    for (const [key, expiry] of state.ids) { if (expiry > now) break; state.ids.delete(key); }
    if (state.ids.has(id)) { state.duplicates++; return false; }
    state.ids.set(id, now + this.limits.recentIdMs);
    while (state.ids.size > this.limits.recentIds) state.ids.delete(state.ids.keys().next().value);
    const second = Math.max(0,Math.floor((now-state.start) / 1000));
    let window = state.windows.get(second);
    if (!window) {
      // A stalled writer must not accumulate empty windows indefinitely either.
      if (state.windows.size >= this.limits.roomMessages) { state.limited++; return false; }
      state.windows.set(second, window = { second, seen: 0, items: [] });
    }
    window.seen++;
    const index = window.items.length < this.limits.perRoomPerSecond ? window.items.length : Math.floor(this.random() * window.seen);
    if (index >= this.limits.perRoomPerSecond) { state.limited++; return false; }
    const old = window.items[index], delta = size - (old?.size || 0);
    if ((!old && state.count >= this.limits.roomMessages) || state.bytes + delta > this.limits.roomBytes || this.bytes + delta > this.limits.totalBytes) {
      state.limited++; return false;
    }
    // Copy only the common fields: do not retain raw protobuf frames or profiles.
    window.items[index] = { size, message: { id, time: message.time, text: message.text,
      user: String(message.user || '观众'), color: message.color || '16777215', timestamp: message.timestamp } };
    state.bytes += delta; this.bytes += delta;
    if (!old) state.count++; else state.limited++;
    return true;
  }
  take(room, { force = false, limit = 250 } = {}) {
    const state = this.rooms.get(room); if (!state) return null;
    limit = Math.max(this.limits.perRoomPerSecond, Math.min(2000, Math.floor(limit) || 250));
    const second = Math.max(0,Math.floor((this.now()-state.start) / 1000)), items = [], density = [];
    for (const [key, window] of state.windows) {
      if ((!force && key >= second) || items.length + window.items.length > limit || density.length >= 250) break;
      state.windows.delete(key);
      // Activity information may arrive after the chat within the same second.
      const kept = [], discarded = [];
      for (const item of window.items) (this.filterLottery(room, item.message) ? discarded : kept).push(item);
      const removed = discarded.length;
      for (const item of discarded) { state.bytes -= item.size; this.bytes -= item.size; state.count--; }
      state.filtered += removed;
      items.push(...kept); density.push({ second: key, count: Math.max(0, window.seen - removed),kept:kept.length });
    }
    if (!density.length) return null;
    let released = false;
    return { messages: items.map(item => item.message).sort((a, b) => a.time - b.time || a.id.localeCompare(b.id)), density,
      release: () => { if (released) return; released = true;
        const bytes = items.reduce((sum, item) => sum + item.size, 0); state.bytes -= bytes; state.count -= items.length; this.bytes -= bytes;
        if (state.closed && state.count === 0) this.rooms.delete(room);
      } };
  }
  stop(room) { const state = this.rooms.get(room); if (state) state.closed = true; }
  drop(room) {
    const state = this.rooms.get(room); if (!state) return;
    for (const window of state.windows.values()) for (const item of window.items) { state.bytes -= item.size; state.count--; this.bytes -= item.size; }
    state.windows.clear(); state.ids.clear(); state.closed = true;
    if (!state.count) this.rooms.delete(room);
  }
  snapshot(room) {
    const state = this.rooms.get(room);
    return state ? { received: state.received, filtered: state.filtered, duplicates: state.duplicates, limited: state.limited,
      pending: state.count, bytes: state.bytes, windows: state.windows.size, recentIds: state.ids.size } : null;
  }
}
