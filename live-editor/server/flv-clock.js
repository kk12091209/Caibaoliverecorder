const SIGNED_BOUNDARY_MS = 2 ** 31;
const CROSSING_WINDOW_MS = 60000;

// The core writes signed timestamps. Negative packets must not become a
// multi-week forward jump. Retain genuine unsigned long-recording timestamps
// when the surrounding clock is already crossing the signed boundary; normal
// live packets and seek references are much closer than this one-minute guard.
export function timestamp(tag) { return tag.readUIntBE(4, 3) + tag[7] * 16777216; }

export class RecordingClock {
  constructor(reference = 0) { this.latest = Math.max(0, reference); this.negativePackets = 0; }
  read(tag) {
    const value = timestamp(tag);
    if (value >= SIGNED_BOUNDARY_MS && this.latest < SIGNED_BOUNDARY_MS - CROSSING_WINDOW_MS) {
      this.negativePackets++;
      return null;
    }
    this.latest = Math.max(this.latest, value);
    return value;
  }
}

