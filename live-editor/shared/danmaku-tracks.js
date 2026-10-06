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

// Estimate the largest on-screen intersection during the remaining shared
// travel, including a longer/faster follower catching the preceding comment.
function horizontalConflict(before, time, textWidth, speed, width, gap) {
  const age = time - before.time - (before.entryDelay || 0);
  const duration = before.end - time;
  if (duration <= 0 || (width - age * before.speed + before.textWidth <= width - gap && width - duration * speed >= gap)) return 0;
  let peak = 0;
  const limit = Math.min(width, textWidth, before.textWidth);
  for (let sample = 1; sample <= 5; sample++) {
    const elapsed = duration * sample / 6;
    const left = width - elapsed * speed, beforeLeft = width - (age + elapsed) * before.speed;
    peak = Math.max(peak, Math.min(width, left + textWidth, beforeLeft + before.textWidth) - Math.max(0, left, beforeLeft));
    if (peak >= limit) return 1;
  }
  return Math.max(.02, Math.min(1, peak / limit));
}

export function* scrollingTrackEvents(messages, { width, height, lanes, top, lineHeight, size, font, measure, previous = new Map() }) {
  const active = [], gap = danmakuGap(size), rowOrder = trackOrder(lanes);
  const rowUses = Array(lanes).fill(0), glyphHeight = size * 1.4 + 4;
  // Dense traffic can use intermediate positions instead of stacking every
  // overflow comment on exactly the same few baselines. Bound the search.
  const subdivisions = lanes > 1 ? Math.max(1, Math.floor(128 / (lanes - 1))) : 1;
  // Very small source videos may have only one nominal row at a large font.
  // Use the remaining vertical space there too, while keeping glyphs in-frame.
  const firstY = lanes === 1 && Number.isFinite(height) ? Math.min(20, top) : top;
  const lastY = lanes === 1 && Number.isFinite(height) ? Math.max(firstY, height - firstY - glyphHeight) : top + (lanes - 1) * lineHeight;
  const slots = lanes > 1 ? (lanes - 1) * subdivisions + 1 : lastY > firstY ? 129 : 1;
  const slotOrder = trackOrder(slots), step = slots > 1 ? (lastY - firstY) / (slots - 1) : lineHeight;
  const slotY = slot => firstY + slot * step, rowSlot = lane => lanes > 1 ? lane * subdivisions : Math.round((slots - 1) / 2);
  const ordered = messages.map((message, index) => ({ ...message, id: message.id ?? String(index) }))
    .sort((a, b) => a.time - b.time || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  let previousEntry = -Infinity;
  for (const message of ordered) {
    const text = danmakuText(message.text), painted = measure?.(text);
    // Browser measurement only sizes a sprite; layout and velocity are shared.
    const textWidth = danmakuTextWidth(text, size, font), old = previous.get(message.id);
    // Integer timestamps can put an entire second's messages on one instant.
    // Spread that burst by 10 ms per comment, capped at half a second. Keep
    // the original timestamp and end, so no delay backlog or extra video tail.
    const entry = Math.min(message.time + .5, Math.max(message.time, previousEntry + .01));
    const entryDelay = old && old.time === message.time && old.textWidth === textWidth &&
      Number.isFinite(old.entryDelay) && old.entryDelay >= 0 && old.entryDelay <= .5 ? old.entryDelay : Number((entry - message.time).toFixed(3));
    previousEntry = message.time + entryDelay;
    const speed = (width + textWidth) / (DANMAKU_SECONDS - entryDelay);
    // Reuse already displayed positions before doing any collision scoring.
    // A sliding workbench window must not repeatedly rerasterize or reflow it.
    const fixedY = old && old.time === message.time && old.textWidth === textWidth && old.speed === speed &&
      (old.entryDelay || 0) === entryDelay && Number.isFinite(old.y) && old.y >= firstY - .001 && old.y <= lastY + .001 ? old.y : null;
    if (fixedY !== null) {
      const comment = { ...message, text, textWidth, paintWidth: painted ?? textWidth,
        lane: Math.max(0, Math.min(lanes - 1, Math.round((fixedY - top) / lineHeight))), y: fixedY, entryDelay, speed, end: message.time + DANMAKU_SECONDS };
      rowUses[comment.lane]++; active.push(comment); yield comment; continue;
    }
    let remaining = 0;
    const conflicts = [];
    for (const before of active) {
      if (before.end <= message.time) continue;
      active[remaining++] = before;
      const weight = horizontalConflict(before, previousEntry, textWidth, speed, width, gap);
      if (weight) conflicts.push({ y: before.y, weight });
    }
    active.length = remaining;
    const scores = new Float64Array(slots), peaks = new Float64Array(slots);
    for (const { y, weight } of conflicts) {
      const first = Math.max(0, Math.ceil((y - glyphHeight - firstY) / step));
      const last = Math.min(slots - 1, Math.floor((y + glyphHeight - firstY) / step));
      for (let slot = first; slot <= last; slot++) {
        const overlap = Math.max(0, 1 - Math.abs(slotY(slot) - y) / glyphHeight);
        const cost = weight * overlap * overlap;
        scores[slot] += cost; peaks[slot] = Math.max(peaks[slot], cost);
      }
    }
    let lane = -1, slot = -1;
    for (const candidate of rowOrder) {
      if (scores[rowSlot(candidate)] < 1e-9 && (lane < 0 || rowUses[candidate] < rowUses[lane])) lane = candidate;
    }
    if (lane >= 0) slot = rowSlot(lane);
    else {
      // Minimize the worst pair first, then total crowding. This prevents a
      // long burst from repeatedly selecting one already crowded baseline.
      for (const candidate of slotOrder) {
        if (slot < 0 || peaks[candidate] < peaks[slot] - 1e-9 ||
          (Math.abs(peaks[candidate] - peaks[slot]) < 1e-9 && scores[candidate] < scores[slot] - 1e-9)) slot = candidate;
      }
      lane = Math.min(lanes - 1, Math.round(slot / subdivisions));
    }
    const comment = { ...message, text, textWidth, paintWidth: painted ?? textWidth, lane,
      y: Number(slotY(slot).toFixed(3)), entryDelay, speed, end: message.time + DANMAKU_SECONDS };
    rowUses[comment.lane]++; active.push(comment); yield comment;
  }
}

export function scrollingTracks(messages, options) {
  return [...scrollingTrackEvents(messages, options)];
}
