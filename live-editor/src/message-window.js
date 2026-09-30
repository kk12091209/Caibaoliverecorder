export function overlayWindow(id, from, to, duration, finished) {
  // Live XML may arrive after the video packet. Never cache an unrecorded future
  // or the last five seconds as complete, especially after pausing at the edge.
  return { id, from, to: Math.min(to, finished ? to : Math.max(0, duration - 5)) };
}

export function containsOverlay(window, id, time) {
  return window?.id === id && time >= window.from && time + 10 <= window.to;
}
