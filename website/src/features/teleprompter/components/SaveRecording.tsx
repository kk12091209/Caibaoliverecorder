import { useEffect, useRef, useState } from 'react'
import { DownloadIcon } from '@radix-ui/react-icons'
import {
  recordingExtension,
  recordingNameIssue,
  recordingSaveName,
  type RecordingResult,
} from '../model/recording'
import type { ExportedRecording } from '../model/recording-export'
import { formatTime } from '../model/teleprompter'
import { Modal } from './Dialogs'

type File = ExportedRecording & { name: string }
function useBlobUrl(blob?: Blob) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!blob) {
      setUrl('')
      return
    }
    const value = URL.createObjectURL(blob)
    setUrl(value)
    return () => URL.revokeObjectURL(value)
  }, [blob])
  return url
}
function DownloadFile({ file, downloaded }: { file: File; downloaded: () => void }) {
  const url = useBlobUrl(file.blob)
  return (
    <a
      className="tp-file-download"
      href={url || undefined}
      download={file.name}
      onClick={downloaded}
    >
      <span>
        <strong>{file.label}</strong>
        <small>
          {file.name} · {(file.blob.size / 1024 / 1024).toFixed(1)} MB
        </small>
      </span>
      <DownloadIcon aria-hidden="true" />
      <span className="tp-sr-only">下载{file.label}</span>
    </a>
  )
}
export function SaveRecording({
  result,
  close,
  saved,
}: {
  result: RecordingResult
  close: () => void
  saved: () => void
}) {
  const originalUrl = useBlobUrl(result.blob)
  const originalExtension = recordingExtension(result.blob.type, result.mode)
  const [name, setName] = useState('')
  const [separate, setSeparate] = useState(false)
  const [choice, setChoice] = useState<'video' | 'audio' | 'both' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [zip, setZip] = useState<File | undefined>()
  const [downloaded, setDownloaded] = useState<Set<string>>(new Set())
  const [originalDownloaded, setOriginalDownloaded] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      controller.current?.abort()
    }
  }, [])
  const nameIssue = recordingNameIssue(name)
  const completed =
    originalDownloaded ||
    (files.length > 0 && files.every((file) => downloaded.has(file.name))) ||
    Boolean(zip && downloaded.has(zip.name))
  function reset() {
    setFiles([])
    setZip(undefined)
    setDownloaded(new Set())
    setOriginalDownloaded(false)
    setError('')
  }
  async function prepare() {
    if (nameIssue) {
      setError(nameIssue)
      return
    }
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    setBusy(true)
    setError('')
    setFiles([])
    setZip(undefined)
    setDownloaded(new Set())
    setOriginalDownloaded(false)
    try {
      const next: File[] = []
      if (!separate || result.mode === 'audio') {
        const file = {
          blob: result.blob,
          extension: originalExtension,
          label: result.mode === 'video' ? '视频（含声音）' : '音频',
          name: recordingSaveName(name, originalExtension),
        }
        next.push(file)
        // Preserve the click's user activation for mobile browsers: no asynchronous conversion is needed.
        const url = URL.createObjectURL(file.blob),
          link = document.createElement('a')
        link.href = url
        link.download = file.name
        document.body.append(link)
        link.click()
        link.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 60000)
        setDownloaded(new Set([file.name]))
      } else {
        if (!choice) throw new Error('请选择要保存的视频、音频，或两者。')
        const { extractRecordingTrack, zipRecordings } = await import('../model/recording-export')
        for (const kind of choice === 'both' ? (['video', 'audio'] as const) : [choice]) {
          const file = await extractRecordingTrack(result.blob, kind, abort.signal)
          next.push({
            ...file,
            name: recordingSaveName(name, file.extension, kind === 'video' ? '-无声视频' : '-音频'),
          })
        }
        if (next.length === 2) {
          const blob = await zipRecordings(next, abort.signal)
          if (mounted.current && !abort.signal.aborted)
            setZip({
              blob,
              label: '视频与音频打包保存',
              extension: 'zip',
              name: recordingSaveName(name, 'zip', '-音画分离'),
            })
        }
      }
      if (mounted.current && !abort.signal.aborted) setFiles(next)
    } catch (problem) {
      if (mounted.current && !abort.signal.aborted)
        setError((problem as Error).message || '生成失败，请先下载原始录制。')
    } finally {
      if (mounted.current && !abort.signal.aborted) setBusy(false)
    }
  }
  function cancelGeneration() {
    controller.current?.abort()
    setBusy(false)
    setError('已取消生成，原始录制仍然保留。')
  }
  const markDownloaded = (filename: string) =>
    setDownloaded((value) => new Set([...value, filename]))
  return (
    <Modal
      title="保存本次录制"
      close={() => {
        controller.current?.abort()
        close()
      }}
    >
      <div className="tp-modal-content tp-save-recording">
        {result.mode === 'video' ? (
          <video controls playsInline src={originalUrl || undefined} aria-label="本次录制回放" />
        ) : (
          <audio controls src={originalUrl || undefined} aria-label="本次录音回放" />
        )}
        <p className="tp-take-summary">
          {formatTime(result.duration)} · {(result.blob.size / 1024 / 1024).toFixed(1)} MB ·{' '}
          {originalExtension.toUpperCase()}
        </p>
        {result.warning && (
          <p className="tp-error" role="alert">
            {result.warning}
          </p>
        )}
        <label className="tp-save-name">
          保存文件名
          <input
            aria-label="录制文件名"
            autoComplete="off"
            placeholder="请输入你希望保存的名称"
            required
            disabled={busy}
            value={name}
            maxLength={100}
            onChange={(event) => {
              setName(event.target.value)
              reset()
            }}
          />
          <small className="tp-muted">文件格式会自动补上。</small>
          {name && nameIssue && (
            <small className="tp-error" role="alert">
              {nameIssue}
            </small>
          )}
        </label>
        {result.mode === 'video' && (
          <>
            <label className="tp-check tp-separate-check">
              <input
                type="checkbox"
                disabled={busy}
                checked={separate}
                onChange={(event) => {
                  setSeparate(event.target.checked)
                  setChoice(null)
                  reset()
                }}
              />
              音画分离
            </label>
            {separate ? (
              <fieldset className="tp-save-choices">
                <legend>选择要保存的内容</legend>
                {(
                  [
                    { id: 'video', label: '视频文件（无声）' },
                    { id: 'audio', label: '音频文件' },
                    { id: 'both', label: '两者都保存' },
                  ] as const
                ).map((option) => (
                  <label key={option.id}>
                    <input
                      type="radio"
                      name="recording-save-type"
                      value={option.id}
                      disabled={busy}
                      checked={choice === option.id}
                      onChange={() => {
                        setChoice(option.id)
                        reset()
                      }}
                    />
                    {option.label}
                  </label>
                ))}
              </fieldset>
            ) : (
              <p className="tp-muted">默认保存带声音的视频。</p>
            )}
          </>
        )}
        <div className="tp-generate">
          <button
            type="button"
            className="tp-primary"
            disabled={busy || !!nameIssue || (separate && !choice)}
            onClick={() => void prepare()}
          >
            {busy ? '正在生成文件…' : separate ? '确认并生成文件' : '确认并保存'}
          </button>
          {busy && (
            <button type="button" onClick={cancelGeneration}>
              取消生成
            </button>
          )}
        </div>
        {error && (
          <p className="tp-error" role="alert">
            {error}
          </p>
        )}
        <div className="tp-generated-files" aria-live="polite">
          {zip && <DownloadFile file={zip} downloaded={() => markDownloaded(zip.name)} />}
          {files.map((file) => (
            <DownloadFile
              key={file.name}
              file={file}
              downloaded={() => markDownloaded(file.name)}
            />
          ))}
        </div>
        {files.length > 0 && (
          <p className="tp-muted">
            {zip ? 'ZIP 中包含独立的视频和音频，也可分别下载。' : ''}
            下载后请确认文件已保存，再点击“保存完成”。
          </p>
        )}
        {separate && !nameIssue && (
          <a
            className="tp-original-download"
            href={originalUrl || undefined}
            download={recordingSaveName(name, originalExtension, '-原始')}
            onClick={() => setOriginalDownloaded(true)}
          >
            保存原始视频（含声音）
          </a>
        )}
      </div>
      <footer className="tp-modal-footer">
        <button
          type="button"
          onClick={() => {
            controller.current?.abort()
            close()
          }}
        >
          稍后保存
        </button>
        <button type="button" className="tp-primary" disabled={!completed || busy} onClick={saved}>
          保存完成
        </button>
      </footer>
    </Modal>
  )
}
