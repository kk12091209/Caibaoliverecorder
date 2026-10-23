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
      if (registration.active) return true
      const worker = registration.installing || registration.waiting
      if (!worker) return false
      return new Promise<boolean>((resolve) => {
        const done = (ready: boolean) => {
          clearTimeout(timer)
          worker.removeEventListener('statechange', changed)
          resolve(ready)
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
  if (!ready) {
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
  // A same-origin navigation lets the worker return an attachment to Chrome's
  // native download manager. No whole-file Blob, file picker, or extra task UI.
  const frame = document.createElement('iframe')
  frame.hidden = true
  frame.title = '下载文件'
  frame.src = target.href
  document.body.appendChild(frame)
}
