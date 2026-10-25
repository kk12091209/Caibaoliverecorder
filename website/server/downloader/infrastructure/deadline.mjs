// Bound the entire operation, including redirects and waiting for a response.
// A socket inactivity timeout alone can be renewed indefinitely by a slow peer.
export async function withDeadline(signal, milliseconds, work, message = '连接平台超时，请重试。') {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error(message)), milliseconds)
  timer.unref?.()
  let stopped
  const interrupted = new Promise((_, reject) => {
    stopped = () => reject(controller.signal.reason)
    controller.signal.addEventListener('abort', stopped, { once: true })
  })
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), interrupted])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', stopped)
  }
}
