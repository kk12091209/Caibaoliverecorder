import { useEffect, useRef, useState } from 'react'
import { Cross2Icon, DownloadIcon, ReloadIcon } from '@radix-ui/react-icons'
import { formatBytes, type DownloadJob } from './lib/media-downloader'
import { ALBUM_BATCH_BYTES, albumBatch, fetchAlbumFiles } from './lib/media-save'

export function AlbumSaveDialog({ job, onClose }: { job: DownloadJob; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null),
    controller = useRef<AbortController | null>(null)
  const [start, setStart] = useState(0),
    [attempt, setAttempt] = useState(0),
    [files, setFiles] = useState<File[]>([]),
    [bytes, setBytes] = useState(0),
    [status, setStatus] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [returned, setReturned] = useState(false)
  const batch = albumBatch(job.files, start),
    total = batch.reduce((n, f) => n + f.bytes, 0),
    next = start + batch.length
  const available =
      typeof navigator.share === 'function' && typeof navigator.canShare === 'function',
    large = total > ALBUM_BATCH_BYTES
  useEffect(() => {
    const previous = document.activeElement as HTMLElement
    dialog.current?.showModal()
    return () => {
      controller.current?.abort()
      previous?.focus()
    }
  }, [])
  useEffect(() => {
    const abort = new AbortController()
    controller.current = abort
    setFiles([])
    setBytes(0)
    setError('')
    setReturned(false)
    if (!available || large) {
      setBusy(false)
      setStatus('')
      return () => abort.abort()
    }
    setBusy(true)
    setStatus('正在将文件传到此设备…')
    void fetchAlbumFiles(albumBatch(job.files, start), abort.signal, (received) => {
      if (!abort.signal.aborted) setBytes(received)
    })
      .then((value) => {
        if (abort.signal.aborted) return
        if (!navigator.canShare({ files: value }))
          throw new Error('当前浏览器无法分享这组文件，请使用下方“下载文件”。')
        setFiles(value)
        setStatus('文件已就绪，点击下方按钮打开系统保存菜单。')
      })
      .catch((reason) => {
        if (!abort.signal.aborted)
          setError(reason instanceof Error ? reason.message : '文件准备失败，请重试。')
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false)
      })
    return () => abort.abort()
  }, [job, start, attempt, available, large])
  async function share() {
    if (!files.length || busy) return
    setError('')
    setBusy(true)
    try {
      // Must run directly in this click, with no network await before share().
      // Share completion does not tell us which destination the user selected.
      await navigator.share({ files })
      setReturned(true)
      setStatus('已返回网页。请在相册确认是否保存成功；也可以再次打开保存菜单。')
    } catch (reason) {
      if (reason instanceof Error && reason.name === 'AbortError')
        setStatus('已关闭系统菜单，文件仍然可用，可以再次打开。')
      else setError('系统保存菜单未能打开，请重试，或使用“下载文件”。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="md-album-dialog"
      aria-labelledby="album-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="md-album-heading">
        <h2 id="album-title">保存到相册</h2>
        <button autoFocus aria-label="关闭相册保存" onClick={onClose}>
          <Cross2Icon />
        </button>
      </div>
      <p>在系统菜单中选择“存储图像”或“储存视频”，保存后可在相册查看。</p>
      {job.files.length > 1 && (
        <p>
          本组 {start + 1}–{next}，共 {job.files.length} 个文件。分组保存，无需解压。
        </p>
      )}
      {!available ? (
        <p className="md-album-help">
          当前浏览器不支持文件分享。iPhone / iPad 可用 Safari
          打开本页；也可下载后在“文件”中打开，点“共享”再保存到相册。
        </p>
      ) : large ? (
        <p className="md-album-help">
          此文件为 {formatBytes(total)}
          ，较大的视频请先下载到“文件”，打开后点“共享”→“储存视频”，避免网页占用过多内存。
        </p>
      ) : (
        <>
          {busy && !files.length && (
            <progress value={bytes} max={total} aria-label="传到此设备的进度" />
          )}
          <p role="status">
            {status}
            {busy && !files.length ? ` ${formatBytes(bytes)} / ${formatBytes(total)}` : ''}
          </p>
          {error && <p role="alert">{error}</p>}
          <button
            className="md-primary"
            disabled={!files.length || busy}
            onClick={() => void share()}
          >
            {busy ? <ReloadIcon className="md-spin" /> : <DownloadIcon />} 打开系统保存菜单
            {batch.length > 1 ? `（${batch.length} 个）` : ''}
          </button>
          {error && !files.length && (
            <button onClick={() => setAttempt((n) => n + 1)}>重新准备</button>
          )}
        </>
      )}
      <div className="md-album-files">
        {batch.map((file) => (
          <a key={file.id} href={file.url} download={file.name}>
            下载文件{batch.length > 1 ? ` ${file.index}` : ''} · {formatBytes(file.bytes)}
          </a>
        ))}
      </div>
      {next < job.files.length && !busy && (
        <button
          className="md-primary"
          onClick={() => {
            setFiles([])
            setStart(next)
          }}
        >
          {returned ? '准备下一组' : '下一组（请先保存本组）'}
        </button>
      )}
      <p className="md-album-foot">
        网页无法确认你在系统菜单中选择的操作；没有看到保存选项时，可先下载文件再从系统中分享。
      </p>
    </dialog>
  )
}
