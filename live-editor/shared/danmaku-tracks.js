import { horizontalConflict } from './danmaku-collision.js';
import {highlightPresentation} from './highlight-style.js';

export const DANMAKU_SECONDS = 6;
export const danmakuText = text => String(text).replace(/[{}\\\r\n]/g, ' ').slice(0, 200);
export const danmakuGap = size => Math.max(12, Math.ceil(size * 0.6));

// Reserve more than a glyph's advance, including outline and font overhang.
// Imported fonts supply their maximum horizontal advance in em units.
export function danmakuTextWidth(text, size, font) {
  const ratio = Math.max(1.25, Number(font?.advanceRatio) || 0);
  return Math.ceil([...danmakuText(text)].length * size * ratio + 8);
}

// Breadth-first gap splitting uses both halves before filling adjacent rows.
function trackOrder(count) {
  const order = [0], pending = [];
  if (count > 1) { order.push(count - 1); pending.push([1, count - 2]); }
  for (let index = 0; index < pending.length; index++) {
    const [from, to] = pending[index];
    if (from > to) continue;
    const middle = Math.floor((from + to) / 2);
    order.push(middle); pending.push([from, middle - 1], [middle + 1, to]);
  }
  return order;
}

export function* scrollingTrackEvents(messages, { width, height, clipTop = 0, clipBottom = height, lanes, top, lineHeight, size, font, measure, highlightStyle, duration = DANMAKU_SECONDS, previous = new Map(), ordered = false, state = {} }) {
  const active = state.active ??= [], gap = danmakuGap(size), rowOrder = trackOrder(lanes);
  const rowUses = state.rowUses ??= Array(lanes).fill(0), glyphHeight = size * 1.4 + 4;
  // Dense traffic can use intermediate positions instead of stacking every
  // overflow comment on exactly the same few baselines. Bound the search.
  const subdivisions = lanes > 1 ? Math.max(1, Math.floor(128 / (lanes - 1))) : 1;
  // Very small source videos may have only one nominal row at a large font.
  // Use the remaining vertical space there too, while keeping glyphs in-frame.
  const firstY = lanes === 1 && Number.isFinite(clipBottom) ? Math.min(clipTop + 20, top) : top;
  const lastY = lanes === 1 && Number.isFinite(clipBottom) ? Math.max(firstY, clipBottom - (firstY - clipTop) - glyphHeight) : top + (lanes - 1) * lineHeight;
  const slots = lanes > 1 ? (lanes - 1) * subdivisions + 1 : lastY > firstY ? 129 : 1;
  const slotOrder = trackOrder(slots), rowSlot = lane => lanes > 1 ? lane * subdivisions : Math.round((slots - 1) / 2);
  const scores = new Float64Array(slots), peaks = new Float64Array(slots);
  const collisionScratch = new Float64Array(8);
  // The server already orders its admitted messages. Browser callers retain
  // the public unsorted-input behavior; a checkpoint is private to one layout.
  const feed = ordered ? messages : messages.map((message, index) => ({ ...message, id: message.id ?? String(index) }))
    .sort((a, b) => a.time - b.time || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  let previousEntry = state.previousEntry ?? -Infinity;
  let index=0;
  for (const raw of feed) {
    const original=raw.id==null?{...raw,id:String(index)}:raw;index++;
    const presentation=highlightPresentation(original,size,highlightStyle),text=danmakuText(presentation.text);
    const message=original.highlighted===true?{...original,fontSize:presentation.fontSize,renderColor:presentation.renderColor}:original,fontSize=presentation.fontSize,currentHeight=fontSize*1.4+4;
    const allowedBottom=Math.max(clipTop,clipBottom-20-currentHeight),currentFirst=message.highlighted?Math.min(firstY,allowedBottom):firstY;
    const currentLast=message.highlighted?Math.max(currentFirst,Math.min(lastY,allowedBottom)):lastY;
    const step=slots>1?(currentLast-currentFirst)/(slots-1):lineHeight,slotY=slot=>currentFirst+slot*step;
    const painted = measure?.(text,fontSize);
    // Browser measurement only sizes a sprite; layout and velocity are shared.
    const textWidth = danmakuTextWidth(text, fontSize, font), old = previous.get(message.id);
    // Integer timestamps can put an entire second's messages on one instant.
    // Spread that burst by 10 ms per comment, capped at half a second. Keep
    // the original timestamp and end, so no delay backlog or extra video tail.
    const maxDelay = .5 * duration / DANMAKU_SECONDS, entryStep = .01 * duration / DANMAKU_SECONDS;
    const entry = Math.min(message.time + maxDelay, Math.max(message.time, previousEntry + entryStep));
    const entryDelay = old && old.time === message.time && old.textWidth === textWidth &&
      Math.abs(old.end - old.time - duration) < 1e-8 && Number.isFinite(old.entryDelay) && old.entryDelay >= 0 && old.entryDelay <= maxDelay ? old.entryDelay : Number((entry - message.time).toFixed(6));
    state.previousEntry = previousEntry = message.time + entryDelay;
    const speed = (width + textWidth) / (duration - entryDelay);
    // Reuse already displayed positions before doing any collision scoring.
    // A sliding workbench window must not repeatedly rerasterize or reflow it.
    const fixedY = old && old.time === message.time && old.textWidth === textWidth && old.speed === speed &&
      (old.fontSize??size)===fontSize&&(old.entryDelay || 0) === entryDelay && Number.isFinite(old.y) && old.y >= currentFirst - .001 && old.y <= currentLast + .001 ? old.y : null;
    if (fixedY !== null) {
      const comment = { ...message, text, textWidth, paintWidth: painted ?? textWidth,
        ...(message.highlighted?{glyphHeight:currentHeight}:{}),lane: Math.max(0, Math.min(lanes - 1, Math.round((fixedY - top) / lineHeight))), y: fixedY, entryDelay, speed, end: message.time + duration };
      rowUses[comment.lane]++; active.push(comment); yield comment; continue;
    }
    let remaining = 0;
    scores.fill(0); peaks.fill(0);
    for (const before of active) {
      if (before.end <= message.time) continue;
      active[remaining++] = before;
      const weight = horizontalConflict(before, previousEntry, textWidth, speed, width, gap, message.time + duration, collisionScratch);
      if (!weight) continue;
      const y = before.y;
      const beforeHeight=before.glyphHeight??glyphHeight;
      const first = step>0?Math.max(0, Math.ceil((y-currentHeight-currentFirst)/step)):0;
      const last = step>0?Math.min(slots-1,Math.floor((y+beforeHeight-currentFirst)/step)):slots-1;
      for (let slot = first; slot <= last; slot++) {
        const newY=slotY(slot),overlap=currentHeight===glyphHeight&&beforeHeight===glyphHeight?Math.max(0,1-Math.abs(newY-y)/glyphHeight):Math.max(0,Math.min(newY+currentHeight,y+beforeHeight)-Math.max(newY,y))/Math.min(currentHeight,beforeHeight);
        const cost = weight * overlap;
        scores[slot] += cost; peaks[slot] = Math.max(peaks[slot], cost);
      }
    }
    active.length = remaining;
    let lane = -1, slot = -1;
    for (const candidate of rowOrder) {
      if (scores[rowSlot(candidate)] < 1e-9 && (lane < 0 || rowUses[candidate] < rowUses[lane])) lane = candidate;
    }
    if (lane >= 0) slot = rowSlot(lane);
    else {
      // Balance total obscured area/time against the worst pair. A single brief
      // crossing must not force several other messages to overlap for seconds.
      for (const candidate of slotOrder) {
        if (slot < 0 || scores[candidate] + peaks[candidate] < scores[slot] + peaks[slot] - 1e-9 ||
          (Math.abs(scores[candidate] + peaks[candidate] - scores[slot] - peaks[slot]) < 1e-9 && peaks[candidate] < peaks[slot] - 1e-9)) slot = candidate;
      }
      lane = Math.min(lanes - 1, Math.round(slot / subdivisions));
    }
    const comment = { ...message, text, textWidth, paintWidth: painted ?? textWidth, ...(message.highlighted?{glyphHeight:currentHeight}:{}),lane,
      y: Number(slotY(slot).toFixed(3)), entryDelay, speed, end: message.time + duration };
    rowUses[comment.lane]++; active.push(comment); yield comment;
  }
}

export function scrollingTracks(messages, options) {
  return [...scrollingTrackEvents(messages, options)];
}
