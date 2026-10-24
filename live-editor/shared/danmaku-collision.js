// Intersection is piecewise linear between edge crossings. Integrate its
// positive area exactly: a brief crossing should not outweigh text that will
// remain obscured for seconds. Scratch space belongs to one layout generator.
function insertTime(scratch, count, elapsed, duration) {
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > duration) return count;
  let i = count;
  while (i > 0 && scratch[i - 1] > elapsed) { scratch[i] = scratch[i - 1]; i--; }
  scratch[i] = elapsed;
  return count + 1;
}
function intersection(elapsed, width, speed, left, previousSpeed, nextWidth, previousWidth) {
  const a = width - elapsed * speed, b = left - elapsed * previousSpeed;
  return Math.min(width, a + nextWidth, b + previousWidth) - Math.max(0, a, b);
}
export function horizontalConflict(before, time, textWidth, speed, width, gap, end, scratch = new Float64Array(8)) {
  const duration = Math.min(before.end, end) - time;
  if (duration <= 0) return 0;
  const left = width - (time - before.time - (before.entryDelay || 0)) * before.speed;
  const previousWidth = before.textWidth + gap, nextWidth = textWidth + gap;
  const relative = speed - before.speed, distance = width - left;
  if (relative <= 0 && distance >= previousWidth || relative > 0 && distance - relative * duration >= previousWidth) return 0;
  scratch[0] = 0; scratch[1] = duration;
  let count = 2;
  count = insertTime(scratch, count, nextWidth / speed, duration);
  count = insertTime(scratch, count, (left + previousWidth - width) / before.speed, duration);
  count = insertTime(scratch, count, width / speed, duration);
  count = insertTime(scratch, count, left / before.speed, duration);
  if (relative !== 0) {
    count = insertTime(scratch, count, distance / relative, duration);
    count = insertTime(scratch, count, (distance + nextWidth - previousWidth) / relative, duration);
  }
  let area = 0, previous = intersection(0, width, speed, left, before.speed, nextWidth, previousWidth);
  for (let i = 1; i < count; i++) {
    const value = intersection(scratch[i], width, speed, left, before.speed, nextWidth, previousWidth), span = scratch[i] - scratch[i - 1];
    if (previous >= 0 && value >= 0) area += (previous + value) * span / 2;
    else if (previous > 0) area += previous * previous * span / (previous - value) / 2;
    else if (value > 0) area += value * value * span / (value - previous) / 2;
    previous = value;
  }
  return Math.max(0, Math.min(1, area / (width * (end - time))));
}
