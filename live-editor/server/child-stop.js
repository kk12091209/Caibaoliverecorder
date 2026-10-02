// Only terminate child objects created by this process. Escalate a cancelled
// FFmpeg/FFprobe that ignores graceful shutdown; never target unrelated PIDs.
const stopping = new WeakMap();
export function stopChild(child, graceMs = 1000) {
  if (stopping.has(child) || child.exitCode != null || child.signalCode != null) return;
  child.kill();
  if (typeof child.once !== 'function') return;
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, graceMs);
  timer.unref?.(); stopping.set(child, timer);
  child.once('close', () => { clearTimeout(timer); stopping.delete(child); });
}
