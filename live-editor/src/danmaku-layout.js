import { scrollingTracks } from '../shared/danmaku-tracks.js';
// Legacy callers use one velocity; export-style callers prefer clear lanes
// while retaining every comment admitted by the user's per-second limit.
export const DANMAKU_FONT_SIZE = 22 * 2 / 3;
export function layoutDanmaku(messages, { width, height, fontSize = DANMAKU_FONT_SIZE, lineHeight = fontSize + 12, top = 18, maxLanes = 10, exportLayout = false, font, measure, duration = 6, previous = new Map() }) {
  const speed = Math.max(100, width / 6);
  const laneCount = exportLayout ? Math.max(1, maxLanes) : Math.max(1, Math.min(maxLanes, Math.floor((height - top * 2) / lineHeight)));
  if(exportLayout)return new Map(scrollingTracks(messages,{width,height,lanes:laneCount,top,lineHeight,size:fontSize,font,measure,duration,previous}).map(message=>[message.id,message]));
  const occupied = Array(laneCount).fill(-Infinity), result = new Map();
  const ordered = [...messages].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  for (const message of ordered) {
    const text = String(message.text).replace(/[\r\n]+/g, ' ').slice(0, 160);
    const textWidth = measure(text), old = previous.get(message.id);
    let lane = old && old.lane < laneCount ? old.lane : occupied.findIndex(t => t <= message.time);
    if(lane<0)continue;
    occupied[lane] = Math.max(occupied[lane], message.time + (textWidth+28)/speed);
    result.set(message.id, { ...message, text, textWidth, lane, y: top + lane * lineHeight, speed, end: message.time + (width+textWidth)/speed });
  }
  return result;
}

export function commentX(comment, mediaTime, width) {
  return width - Math.max(0, mediaTime - comment.time - (comment.entryDelay || 0)) * comment.speed;
}

// Advance through the sorted feed once instead of scanning thousands of old and
// future messages on every animation frame. Seeks rebuild only the visible span.
export class DanmakuTimeline {
  constructor(layout = new Map()) { this.set(layout); }
  set(layout) {
    this.comments = [...layout.values()].sort((a, b) => a.time - b.time);
    this.maxDuration = this.comments.reduce((n, c) => Math.max(n, c.end - c.time), 0);
    this.active = []; this.next = 0; this.lastTime = -Infinity;
  }
  at(time) {
    if (time < this.lastTime || time - this.lastTime > 1) {
      let low = 0, high = this.comments.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (this.comments[middle].time < time - this.maxDuration) low = middle + 1;
        else high = middle;
      }
      this.next = low; this.active.length = 0;
    }
    while (this.next < this.comments.length && this.comments[this.next].time <= time) {
      const comment = this.comments[this.next++];
      if (comment.end > time) this.active.push(comment);
    }
    let remaining = 0;
    for (const comment of this.active) if (comment.end > time) this.active[remaining++] = comment;
    this.active.length = remaining; this.lastTime = time;
    return this.active;
  }
}
