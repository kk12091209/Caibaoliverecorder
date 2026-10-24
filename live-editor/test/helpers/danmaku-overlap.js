// Black-box validation metric: sample actual on-screen rectangle intersections
// over time, without using the production collision function or its scores.
export function overlapExposure(rows, width, glyphHeight, samples = 60) {
  let total = 0, pairs = 0, maximum = 0;
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    for (let j = i - 1; j >= 0; j--) {
      const b = rows[j];
      if (b.end <= a.time) continue;
      const vertical = Math.max(0, glyphHeight - Math.abs(a.y - b.y));
      if (!vertical) continue;
      const start = Math.max(a.time + a.entryDelay, b.time + b.entryDelay), end = Math.min(a.end, b.end);
      if (end <= start) continue;
      let sum = 0, peak = 0;
      for (let n = 0; n <= samples; n++) {
        const time = start + (end - start) * n / samples;
        const x = width - (time - a.time - a.entryDelay) * a.speed, y = width - (time - b.time - b.entryDelay) * b.speed;
        const overlap = Math.max(0, Math.min(width, x + a.textWidth, y + b.textWidth) - Math.max(0, x, y));
        sum += overlap * (n === 0 || n === samples ? .5 : 1); peak = Math.max(peak, overlap);
      }
      if (peak) { pairs++; maximum = Math.max(maximum, peak * vertical); }
      total += sum / samples * (end - start) * vertical;
    }
  }
  return { total, pairs, maximum };
}
