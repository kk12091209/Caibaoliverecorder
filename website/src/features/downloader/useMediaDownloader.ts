import { useEffect, useRef, useState } from 'react'
import {
  getDownloadJob,
  mediaPost,
  type DownloadJob,
  type MediaResult,
} from './lib/media-downloader'
import { prepareParallelDownloads, startBrowserDownload } from './lib/desktop-download'
import { prefersPhotoLibrary } from './lib/media-save'

function pauseDownload(signal: AbortSignal, ms: number) {
  signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      timer = window.setTimeout(() => {
        signal.removeEventListener('abort', abort)
        resolve()
      }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}
export function useMediaDownloader() {
  const appleMobile = prefersPhotoLibrary()
  const [input, setInput] = useState(''),
    [result, setResult] = useState<MediaResult | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<number>>(() => new Set()),
    [multiple, setMultiple] = useState(false),
    [preview, setPreview] = useState<number | null>(null),
    [player, setPlayer] = useState<{ url: string; name: string } | null>(null)
  const [chosenSaveMode, setSaveMode] = useState<'file' | 'album'>(() =>
      appleMobile ? 'album' : 'file',
    ),
    [album, setAlbum] = useState<DownloadJob | null>(null)
  const [motionPlayer, setMotionPlayer] = useState<{ index: number; url: string } | null>(null)
  const saveMode = appleMobile ? chosenSaveMode : 'file'
  const [starting, setStarting] = useState(false),
    [notice, setNotice] = useState('')
  const activeResolve = useRef<AbortController | null>(null),
    activeDownload = useRef<AbortController | null>(null),
    ready = useRef(new Map<string, DownloadJob>()),
    dialog = useRef<HTMLDialogElement>(null),
    opener = useRef<HTMLElement | null>(null),
    selectAll = useRef<HTMLInputElement>(null)
  const browserDownloads = useRef(new Map<string, AbortController>())
  useEffect(() => {
    document.title = '菜包下载助手 · 菜包宇宙'
    void prepareParallelDownloads()
    const downloads = browserDownloads.current
    return () => {
      activeResolve.current?.abort()
      activeDownload.current?.abort()
      for (const controller of downloads.values()) controller.abort()
      downloads.clear()
    }
  }, [])
  useEffect(() => {
    if (selectAll.current)
      selectAll.current.indeterminate =
        selected.size > 0 && selected.size !== (result?.assets.length || 0)
  }, [selected, result])
  const count = result?.assets.length || 0,
    all = count > 0 && selected.size === count
  const liveCount = result?.assets.filter((asset) => asset.type === 'livePhoto').length || 0
  function toggle(index: number) {
    setSelected((values) => {
      const next = new Set(values)
      next.has(index) ? next.delete(index) : next.add(index)
      return next
    })
  }
  async function resolve(text = input) {
    if (!text.trim()) return setError('请先粘贴一个分享链接。')
    activeResolve.current?.abort()
    const controller = new AbortController()
    activeResolve.current = controller
    activeDownload.current?.abort()
    setStarting(false)
    setNotice('')
    setAlbum(null)
    setMotionPlayer(null)
    setInput(text)
    setBusy(true)
    setError('')
    setPreview(null)
    setPlayer(null)
    setResult(null)
    setSelected(new Set())
    setMultiple(false)
    try {
      const value = await mediaPost<MediaResult>('resolve', { text }, controller.signal)
      if (controller.signal.aborted) return
      setResult(value)
      if (value.kind === 'video') setSelected(new Set([value.current || 1]))
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : '解析失败，请重试。')
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  function rememberDownload(key: string, job: DownloadJob) {
    ready.current.set(key, job)
    if (ready.current.size > 8) ready.current.delete(ready.current.keys().next().value!)
  }
  async function observeBrowserDownload(
    job: DownloadJob,
    key: string,
    title: string,
    controller: AbortController,
  ) {
    let failures = 0
    try {
      while (job.status === 'queued' || job.status === 'running') {
        await pauseDownload(controller.signal, 2000)
        try {
          job = await getDownloadJob(job.id, controller.signal)
          failures = 0
        } catch {
          if (controller.signal.aborted || ++failures >= 3) return
        }
      }
      if (controller.signal.aborted) return
      if (job.status === 'done') rememberDownload(key, job)
      else setError(`“${title}”下载准备失败：${job.error || '任务已取消'}，请重新下载。`)
    } catch {
      /* Leaving the page stops observation, not the browser's transfer. */
    } finally {
      browserDownloads.current.delete(key)
    }
  }
  async function download(indices: number[], requestedIntent?: 'download' | 'preview' | 'album') {
    if (!result || !indices.length || starting) return
    const intent = requestedIntent || (saveMode === 'album' ? 'album' : 'download')
    setError('')
    setNotice('')
    if (intent === 'album') closeImage()
    const showPreview = (job: DownloadJob) => {
      const asset = result.assets.find((a) => a.index === indices[0])
      if (asset?.type === 'livePhoto')
        setMotionPlayer({ index: asset.index, url: job.files[0].previewUrl })
      else setPlayer({ url: job.files[0].previewUrl, name: job.files[0].name })
    }
    const key =
      result.sessionId +
      ':' +
      [...indices].sort((a, b) => a - b).join(',') +
      (intent === 'album' ? ':album' : ':file')
    if (intent === 'download' && browserDownloads.current.has(key)) {
      setNotice('这份文件已发起下载，请在浏览器下载列表查看进度。')
      return
    }
    const existing = ready.current.get(key)
    if (existing) {
      const file = existing.archive || existing.files[0]
      if (intent === 'album') setAlbum(existing)
      else if (intent === 'preview') showPreview(existing)
      else {
        await startBrowserDownload(file.url, file.name, {
          parallel: file.bytes >= 2 * 1024 ** 2,
        })
        setNotice('已交给浏览器下载，请在浏览器下载列表查看。')
      }
      return
    }
    const controller = new AbortController()
    activeDownload.current = controller
    setStarting(true)
    try {
      let job = await mediaPost<DownloadJob>(
        'jobs',
        {
          sessionId: result.sessionId,
          indices,
          delivery: intent === 'album' ? 'album' : intent === 'download' ? 'stream' : 'file',
        },
        controller.signal,
      )
      if (controller.signal.aborted) return
      if (intent === 'download') {
        await startBrowserDownload(job.downloadUrl, '', {
          parallel: result.kind === 'video' || indices.length > 1,
          signal: controller.signal,
        })
        controller.signal.throwIfAborted()
        browserDownloads.current.set(key, controller)
        activeDownload.current = null
        void observeBrowserDownload(job, key, result.title, controller)
        setNotice('已发起浏览器下载，请在下载列表确认并查看进度；文件准备期间可能暂时显示 0 B。')
        return
      }
      while (job.status === 'queued' || job.status === 'running') {
        setNotice(intent === 'preview' ? '正在准备动态预览…' : `正在准备相册文件 · ${job.phase}`)
        await pauseDownload(controller.signal, 900)
        job = await getDownloadJob(job.id, controller.signal)
      }
      if (job.status !== 'done') throw new Error(job.error || '下载已取消，请重试。')
      rememberDownload(key, job)
      if (intent === 'album') {
        setAlbum(job)
        setNotice('')
      } else if (intent === 'preview') {
        showPreview(job)
        setNotice('')
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        setNotice('')
        setError(reason instanceof Error ? reason.message : '创建下载失败。')
      }
    } finally {
      if (!controller.signal.aborted) setStarting(false)
    }
  }
  function openImage(index: number) {
    opener.current = document.activeElement as HTMLElement
    setMotionPlayer(null)
    setPreview(index)
  }
  function closeImage() {
    dialog.current?.close()
    setPreview(null)
    opener.current?.focus()
  }
  useEffect(() => {
    if (preview !== null && !dialog.current?.open) dialog.current?.showModal()
  }, [preview])
  const image = preview !== null ? result?.assets.find((asset) => asset.index === preview) : null
  const pending = starting,
    saveText = saveMode === 'album' ? '保存' : '下载'

  return {
    appleMobile,
    input,
    setInput,
    result,
    busy,
    setBusy,
    error,
    setError,
    selected,
    setSelected,
    multiple,
    setMultiple,
    preview,
    setPreview,
    player,
    setSaveMode,
    album,
    setAlbum,
    motionPlayer,
    saveMode,
    notice,
    activeResolve,
    dialog,
    selectAll,
    count,
    all,
    liveCount,
    toggle,
    resolve,
    download,
    openImage,
    closeImage,
    image,
    pending,
    saveText,
  }
}
