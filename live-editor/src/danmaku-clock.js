// Interpolate presentation timestamps at the display refresh rate. The source may
// deliver only 25/30 frames per second; the overlay need not move in those steps.
export class DanmakuClock {
  constructor({ maxExtrapolation = 0.2 } = {}) {
    this.maxExtrapolation = maxExtrapolation;
    this.reset(0, 0);
  }

  reset(mediaTime, wallTime, { running = false, rate = 1 } = {}) {
    this.media = Number.isFinite(mediaTime) ? mediaTime : 0;
    this.wall = wallTime;
    this.rate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    this.running = running;
    this.lastSample = this.media;
    this.lastSampleWall = wallTime;
    this.lastValue = this.media;
  }

  sample(mediaTime, wallTime) {
    if (!Number.isFinite(mediaTime) || !this.running) return;
    // Repeated currentTime values are not evidence that playback advanced.
    // Keeping their original wall time also bounds drift if a stall event is late.
    if (mediaTime === this.lastSample) return;
    const predicted = this.project(wallTime);
    const error = mediaTime - predicted;
    this.media = Math.abs(error) > 0.25 ? mediaTime : predicted + error * 0.12;
    this.wall = wallTime;
    this.lastSample = mediaTime;
    this.lastSampleWall = wallTime;
  }

  project(wallTime) {
    if (!this.running) return this.media;
    const boundedWall = Math.min(wallTime, this.lastSampleWall + this.maxExtrapolation * 1000);
    // requestVideoFrameCallback can announce the next display's timestamp before
    // that vsync occurs. Project backwards from that future anchor as well;
    // clamping the delta to zero would jump early and hold every other RAF.
    return this.media + (boundedWall - this.wall) / 1000 * this.rate;
  }

  at(wallTime) {
    // Small clock corrections must never move a scrolling comment backwards.
    const value = this.project(wallTime);
    this.lastValue = this.running ? Math.max(this.lastValue, value) : value;
    return this.lastValue;
  }
}

// Bound both bitmap memory and measured-text entries; long broadcasts must not
// retain every comment ever seen. Costs are pixels*4 for RGBA raster sprites.
export class DanmakuCache {
  constructor(maxCost) { this.maxCost = maxCost; this.cost = 0; this.entries = new Map(); }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  set(key, value, cost = 1) {
    const old = this.entries.get(key);
    if (old) { this.cost -= old.cost; this.entries.delete(key); }
    if (cost > this.maxCost) return value;
    this.entries.set(key, { value, cost }); this.cost += cost;
    while (this.cost > this.maxCost) {
      const oldest = this.entries.keys().next().value;
      this.cost -= this.entries.get(oldest).cost; this.entries.delete(oldest);
    }
    return value;
  }
  clear() { this.entries.clear(); this.cost = 0; }
}
