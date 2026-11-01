import { saveFile } from './media-downloader.ts'

export function supportsParallelDownload(
  agent = typeof navigator === 'undefined' ? undefined : navigator,
) {
  if (!agent) return false
  return (
    /Chrome\/|Chromium\/|Edg\//.test(agent.userAgent) &&
    !/Android|iPhone|iPad|iPod|Mobile/.test(agent.userAgent)
  )
}
let workerReady: Promise<boolean> | undefined
const activeFrames = new Set<HTMLIFrameElement>()
async function supportsCompletion(worker: ServiceWorker | null) {
  if (!worker) return false
  return new Promise<boolean>((resolve) => {
    const channel = new MessageChannel()
    const done = (ready: boolean) => {
      clearTimeout(timer)
      channel.port1.close()
      resolve(ready)
    }
    const timer = window.setTimeout(() => done(false), 1500)
    channel.port1.onmessage = (event) => done(event.data === 'caibao-transfer-v3')
    try {
      worker.postMessage({ type: 'caibao-transfer-protocol' }, [channel.port2])
    } catch {
      channel.port2.close()
      done(false)
    }
  })
}
export function prepareParallelDownloads(): Promise<boolean> {
  if (
    !supportsParallelDownload() ||
    !('serviceWorker' in navigator) ||
    !window.isSecureContext ||
    !('any' in AbortSignal)
  )
    return Promise.resolve(false)
  workerReady ??= navigator.serviceWorker
    .register('/downloader-transfer-worker.js', {
      type: 'module',
      scope: '/api/downloader/',
      updateViaCache: 'none',
    })
    .then((registration) => {
      if (registration.active) return supportsCompletion(registration.active)
      const worker = registration.installing || registration.waiting
      if (!worker) return false
      return new Promise<boolean>((resolve) => {
        const done = (ready: boolean) => {
          clearTimeout(timer)
          worker.removeEventListener('statechange', changed)
          if (ready) void supportsCompletion(registration.active).then(resolve)
          else resolve(false)
        }
        const changed = () => {
          if (worker.state === 'activated') done(true)
          else if (worker.state === 'redundant') done(false)
        }
        const timer = window.setTimeout(() => done(false), 2000)
        worker.addEventListener('statechange', changed)
        changed()
      })
    })
    .catch(() => false)
    .then((ready) => {
      if (!ready) workerReady = undefined
      return ready
    })
  return workerReady
}
export async function startBrowserDownload(
  url: string,
  name: string,
  { parallel = true, signal }: { parallel?: boolean; signal?: AbortSignal } = {},
) {
  const ready = parallel && (await prepareParallelDownloads())
  signal?.throwIfAborted()
  // An old/stalled worker must not leave an unbounded number of hidden frames.
  // Native downloads remain available while the small active-frame budget is full.
  if (!ready || activeFrames.size >= 4) {
    saveFile(url, name)
    return
  }
  const target = new URL(url, window.location.origin)
  if (
    target.origin !== window.location.origin ||
    !/^\/api\/downloader\/jobs\/[a-f0-9]{36}\/(download|stream|files\/[a-f0-9]{36})$/.test(
      target.pathname,
    )
  ) {
    saveFile(url, name)
    return
  }
  // Version 1 workers only understand MP4 /stream responses. They must pass
  // new attachments through natively until the archive-aware worker activates.
  target.searchParams.set('parallel', '2')
  const transfer = crypto.randomUUID()
  target.searchParams.set('transfer', transfer)
  // A same-origin navigation lets the worker return an attachment to Chrome's
  // native download manager. No whole-file Blob, file picker, or extra task UI.
  const frame = document.createElement('iframe')
  frame.hidden = true
  frame.title = '下载文件'
  frame.src = target.href
  const dispose = () => {
    navigator.serviceWorker.removeEventListener('message', completed)
    signal?.removeEventListener('abort', dispose)
    activeFrames.delete(frame)
    frame.remove()
  }
  const completed = (event: MessageEvent) => {
    if (
      event.origin === window.location.origin &&
      event.data?.type === 'caibao-transfer-complete' &&
      event.data.id === transfer
    )
      dispose()
  }
  navigator.serviceWorker.addEventListener('message', completed)
  signal?.addEventListener('abort', dispose, { once: true })
  frame.addEventListener('error', dispose, { once: true })
  // Non-attachment error pages finish loading in the frame. Attachments are
  // reclaimed only after the worker finishes/cancels the response stream.
  frame.addEventListener('load', () => {
    try {
      if (frame.contentDocument?.URL !== 'about:blank') dispose()
    } catch {
      /* Navigation is still owned by the browser. */
    }
  })
  activeFrames.add(frame)
  document.body.appendChild(frame)
}
