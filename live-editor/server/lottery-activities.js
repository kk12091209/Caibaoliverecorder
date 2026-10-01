const MAX_LIFETIME = 24 * 60 * 60 * 1000;

// Inputs come from a platform decoder, not repeated chat or user-editable text.
// Keep exact phrases and their server validity interval separately per room.
export class LotteryActivities {
  constructor({ now = Date.now, maxActivities = 64 } = {}) {
    this.now = now; this.maxActivities = maxActivities; this.rooms = new Map();
  }
  update(room, activity) {
    if (typeof room !== 'string' || !room.length || room.length > 128 || !activity ||
        typeof activity.id !== 'string' || !/^[\w:-]{1,128}$/.test(activity.id)) return false;
    let entries = this.rooms.get(room);
    if (!entries) { if (this.rooms.size >= 64) return false; this.rooms.set(room, entries = new Map()); }
    const now = this.now();
    for (const [id, value] of entries) if (value.expires <= now) entries.delete(id);
    if (!entries.has(activity.id) && entries.size >= this.maxActivities) return false;
    if (activity.closed === true) {
      entries.set(activity.id, { closed: true, expires: now + MAX_LIFETIME }); return true;
    }
    if (entries.get(activity.id)?.closed) return false;
    const { start, end, serverNow, phrases } = activity;
    if (![start, end, serverNow].every(Number.isSafeInteger) || start < 1000000000000 ||
        end <= start || end <= serverNow || end - start > MAX_LIFETIME || end - serverNow > MAX_LIFETIME ||
        !Array.isArray(phrases) || !phrases.length || phrases.length > 16 ||
        phrases.some(text => typeof text !== 'string' || !text.trim() || text.length > 1024)) return false;
    entries.set(activity.id, { start, end, phrases: new Set(phrases), expires: now + end - serverNow, closed: false });
    return true;
  }
  matches(room, message) {
    const entries = this.rooms.get(room); if (!entries) return false;
    const now = this.now(), stamp = message.timestamp;
    if (!Number.isSafeInteger(stamp)) return false;
    for (const [id, value] of entries) {
      if (value.expires <= now) { entries.delete(id); continue; }
      if (!value.closed && stamp >= value.start && stamp < value.end && value.phrases.has(message.text)) return true;
    }
    return false;
  }
  drop(room) { this.rooms.delete(room); }
}
