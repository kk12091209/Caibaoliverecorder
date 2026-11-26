import { setTimeout as sleep } from 'node:timers/promises';

export const MiB = 1024 ** 2;
const probeInterval = 15_000;
const newRecordingRate = MiB;
const minimumRate = MiB / 16;
const yieldAfter = 20_000;

export class PublicationBandwidth {
  constructor({ now = () => performance.now(), delay = sleep } = {}) {
    Object.assign(this, { now, delay });
    this.state = 'idle';
    this.rate = Infinity;
    this.reason = '';
    this.room = '';
    this.nextSend = 0;
    this.probeAt = now();
  }

  update({ state, reason = '', room = '' }, measured = 0) {
    const at = this.now();
    const previous = this.state;
    const evidence = previous !== state || reason !== this.reason || room !== this.room;
    const priorRate = this.rate;
    this.room = room;
    this.state = state;
    this.reason = reason;
    switch (state) {
      case 'idle':
        this.rate = Infinity;
        break;
      case 'observing':
        this.rate = Math.min(newRecordingRate, this.rate || newRecordingRate);
        break;
      case 'paused':
        this.rate = 0;
        break;
      case 'pressure':
        if (evidence || at >= this.probeAt) {
          this.rate = Math.max(minimumRate, (Number.isFinite(this.rate) && this.rate || newRecordingRate) / 2);
          this.probeAt = at + 3_000;
        }
        break;
      case 'healthy':
        this.rate = Number.isFinite(this.rate) && this.rate > 0 ? this.rate : newRecordingRate;
        if (previous !== state) this.probeAt = at + probeInterval;
        if (at >= this.probeAt) {
          if (measured >= this.rate * .8) this.rate = Math.round(this.rate * 1.5);
          this.probeAt = at + probeInterval;
        }
        break;
    }
    if (previous !== state) {
      if (state === 'paused') this.pauseStarted = at;
      else if (previous === 'paused') { this.pausedMs = (this.pausedMs || 0) + at - this.pauseStarted; this.pauseStarted = undefined; }
    }
    if (evidence && state !== 'pressure' && state !== 'healthy') this.probeAt = at + probeInterval;
    if (this.rate !== priorRate) this.nextSend = at;
    return evidence || this.rate !== priorRate;
  }

  snapshot() {
    return { state: this.state, limitBytesPerSecond: Number.isFinite(this.rate) ? this.rate : null,
      reason: this.reason, room: this.room };
  }

  // Shared by all subrequests. A paused chunk with an open socket is retried
  // with the same part number and upload session before the socket goes idle.
  async wait(bytes, signal, socketOpen) {
    let pausedAt;
    for (;;) {
      signal?.throwIfAborted();
      const at = this.now();
      if (!this.rate) {
        pausedAt ??= at;
        if (socketOpen && at - pausedAt >= yieldAfter) {
          throw Object.assign(new Error('Recording paused the upload'), { code: 'CAIBO_UPLOAD_YIELDED' });
        }
        await this.delay(100, undefined, { signal });
        continue;
      }
      if (!bytes || this.rate === Infinity) return;
      if (at >= this.nextSend) {
        this.nextSend = at + 1000 * bytes / this.rate;
        return;
      }
      await this.delay(Math.min(100, Math.ceil(this.nextSend - at)), undefined, { signal });
    }
  }

  pauseTime(at) { return (this.pausedMs || 0) + (this.pauseStarted === undefined ? 0 : at - this.pauseStarted); }

  transfer() {
    const started = this.now();
    const pausedAtStart = this.pauseTime(started);
    const sentThrough = new Map();
    const acknowledged = new Set();
    const samples = [];
    let emitted = 0, repeated = 0, confirmed = 0;
    return {
      awaitOpen: signal => this.wait(0, signal, false),
      take: (bytes, signal) => this.wait(bytes, signal, true),
      paused: () => this.rate === 0,
      sent: (chunk, offset, bytes) => {
        const prior = sentThrough.get(chunk) || 0;
        repeated += Math.max(0, Math.min(bytes, prior - offset));
        sentThrough.set(chunk, Math.max(prior, offset + bytes));
        emitted += bytes;
        const now = this.now();
        const slot = Math.floor(now / 250) * 250;
        if (samples.at(-1)?.slot === slot) samples.at(-1).bytes += bytes;
        else samples.push({ slot, bytes });
        while (samples.length && now - samples[0].slot >= 4_000) samples.shift();
      },
      confirm: (chunk, bytes) => {
        if (!acknowledged.has(chunk)) { acknowledged.add(chunk); confirmed += bytes; }
      },
      metrics: () => {
        const at = this.now();
        const bytes = samples.reduce((sum, sample) => sum + (at - sample.slot < 4_000 ? sample.bytes : 0), 0);
        return { bytesPerSecond: Math.round(bytes * 1000 / Math.max(1_000, Math.min(4_000, at - started))),
          emitted, repeated, confirmed, pausedMs: Math.round(this.pauseTime(at) - pausedAtStart) };
      },
    };
  }
}
