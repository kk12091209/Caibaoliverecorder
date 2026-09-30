import { readFileSync } from 'node:fs';

// A real, one-frame 16x16 H.264 MP4. Unit tests can exercise publication
// validation without launching FFmpeg for each mocked encoder call.
export const minimalMp4 = readFileSync(new URL('../fixtures/minimal.mp4', import.meta.url));
