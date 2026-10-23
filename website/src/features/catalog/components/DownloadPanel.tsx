import { useEffect, useRef, useState } from 'react'
import type { DownloadFile, PlatformId, Work } from '../data/works'
import { startBrowserDownload } from '../lib/download'
import { loadCatalog, useCatalog } from '../lib/catalog'

type Phase = 'idle' | 'started'

export function DownloadPanel({ work, platform }: { work: Work; platform: PlatformId }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const { loading, error } = useCatalog()
  const resetTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(resetTimer.current), [])

  const current = work.platforms.find((item) => item.id === platform)
  const files = work.downloads.filter((file) => file.platform === platform)
  const primary = files.find((file) => file.primary) ?? files[0]
  const alternates = files.filter((file) => file !== primary)

  function onDownload(file: DownloadFile) {
    window.clearTimeout(resetTimer.current)
    setActiveId(file.id)
    try {
      startBrowserDownload(file)
      setPhase('started')
      setMessage(`已请求下载 ${file.name}`)
    } catch {
      setPhase('idle')
      setMessage('这次没有开始下载，请稍后再试。')
    }
    resetTimer.current = window.setTimeout(() => {
      setPhase('idle')
      setActiveId(null)
    }, 2400)
  }

  function labelFor(file: DownloadFile, idle: string) {
    if (activeId !== file.id) return idle
    if (phase === 'started') return '开始下载'
    return idle
  }

  if (!work.version || !primary?.href)
    return (
      <div className="panel" role="status">
        <p>
          {loading
            ? '正在获取版本信息…'
            : error
              ? '暂时无法读取下载信息，请稍后重试。'
              : '安装包正在准备中，请稍后再来。'}
        </p>
        {!loading && (
          <button type="button" className="btn" onClick={() => void loadCatalog()}>
            重新获取
          </button>
        )}
      </div>
    )
  if (!current) return null

  return (
    <div className="panel">
      <p className="panel-version">
        <span>{work.version}</span>
        <span>{work.releasedAt}</span>
      </p>

      <div className="file-main">
        <div>
          <p className="file-kicker">{primary.format}</p>
          <h3>{primary.label}</h3>
          <p>{primary.hint}</p>
        </div>
        <div className="file-side">
          <strong>{primary.size}</strong>
          <button type="button" className="btn btn-primary" onClick={() => onDownload(primary)}>
            {labelFor(primary, `下载 ${current.label} 版`)}
          </button>
        </div>
      </div>

      {alternates.length > 0 && (
        <div className="file-alts">
          {alternates.map((file) => (
            <button
              key={file.id}
              type="button"
              className="alt-link"
              onClick={() => onDownload(file)}
            >
              <span>
                {labelFor(file, file.label)}
                <small>{file.hint}</small>
              </span>
              <em>
                {file.format} · {file.size}
              </em>
            </button>
          ))}
        </div>
      )}

      <ul className="req-list">
        {current.requirements.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {work.sources?.length ? (
        <p className="dl-note">
          对应版本源码：
          {work.sources.map((source, index) => (
            <span key={source.url}>
              {index > 0 ? ' · ' : ''}
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.name.includes('FFmpeg') ? 'FFmpeg 源码' : '完整源码'}
              </a>
            </span>
          ))}
        </p>
      ) : null}
      {message ? (
        <p className="dl-note" role="status">
          {message}
        </p>
      ) : null}
    </div>
  )
}
