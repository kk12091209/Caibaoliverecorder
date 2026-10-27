import { OVERLAY_MESSAGE_LIMIT } from '../shared/message-limits.js';

export function overlayWindow(id, from, to, duration, finished, messages) {
  // Live XML may arrive after the video packet. Never cache an unrecorded future
  // or the last five seconds as complete, especially after pausing at the edge.
  let end = Math.min(to, finished ? to : Math.max(0, duration - 5));
  // A full response may have been truncated. Only reuse the range we actually
  // received, even if a future policy allows a denser window than today's cap.
  if (messages?.length >= OVERLAY_MESSAGE_LIMIT && Number.isFinite(messages.at(-1)?.time)) end = Math.min(end, messages.at(-1).time);
  return { id, from, to: end };
}

export function containsOverlay(window, id, time) {
  return window?.id === id && time >= window.from && time + 10 <= window.to;
}
