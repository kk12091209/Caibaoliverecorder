import { Link } from 'react-router-dom'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  Cross2Icon,
  DownloadIcon,
  ExternalLinkIcon,
  ImageIcon,
  PlayIcon,
  ReloadIcon,
} from '@radix-ui/react-icons'
import { Mark } from '../../shared/ui/Mark'
import { formatBytes, mediaDuration } from './lib/media-downloader'
import { useMediaDownloader } from './useMediaDownloader'
import { MediaImage } from './MediaImage'
import { AlbumSaveDialog } from './AlbumSaveDialog'
import './media-downloader.css'

const samples = [
  { label: '抖音视频', url: 'https://v.douyin.com/_xfRDKoFxNg/' },
  { label: '抖音图文', url: 'https://v.douyin.com/e-pVafFMxgs/' },
  { label: '抖音实况', url: 'https://v.douyin.com/ERT3rHkXMHY/' },
  { label: 'B 站视频', url: 'https://b23.tv/FQ9fWMm' },
  { label: 'B 站分 P', url: 'https://www.bilibili.com/video/BV12mpG6MEDL/?p=2' },
]
export function MediaDownloaderPage() {
  const {
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
    setSaveMode,
    album,
    setAlbum,
    motionPlayer,
    saveMode,
    notice,
    partsJob,
    transferJobs,
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
  } = useMediaDownloader()

  return (
    <div className="md-app">
      <header className="md-header">
        <Link to="/" className="md-brand">
          <Mark />
          <span>
            菜包宇宙<small>Caibao Universe</small>
          </span>
        </Link>
        <Link to="/works" className="md-back">
          <ArrowLeftIcon /> 回到产品
        </Link>
      </header>
      <main className="md-main">
        <div className="md-heading">
          <h1>菜包下载助手</h1>
          <p>保存抖音、B 站与小红书的视频、图片和实况</p>
        </div>
        <form
          className="md-form"
          onSubmit={(event) => {
            event.preventDefault()
            void resolve()
          }}
        >
          <label className="md-sr" htmlFor="media-link">
            视频或图文分享链接
          </label>
          <textarea
            id="media-link"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="粘贴视频链接，或直接粘贴整段分享文字…"
            rows={2}
            maxLength={12000}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                void resolve()
              }
            }}
          />
          <button type="submit" className="md-primary md-parse" disabled={busy}>
            {busy ? (
              <>
                <ReloadIcon className="md-spin" /> 正在解析
              </>
            ) : (
              <>
                解析链接 <ArrowRightIcon />
              </>
            )}
          </button>
        </form>
        <div className="md-input-foot">
          <p>支持分享文字、短链接和视频原链接</p>
          {busy ? (
            <button
              onClick={() => {
                activeResolve.current?.abort()
                setBusy(false)
              }}
            >
              取消解析
            </button>
          ) : (
            <span>抖音 · 哔哩哔哩 · 小红书</span>
          )}
        </div>
        <div className="md-samples">
          <span>用提供的链接试试</span>
          {samples.map((sample) => (
            <button key={sample.label} disabled={busy} onClick={() => void resolve(sample.url)}>
              {sample.label}
              <ArrowRightIcon />
            </button>
          ))}
        </div>
        {error && (
          <div role="alert" className="md-error">
            <span>{error}</span>
            <button aria-label="关闭提示" onClick={() => setError('')}>
              <Cross2Icon />
            </button>
          </div>
        )}
        {busy && (
          <div className="md-loading" role="status">
            <span className="md-loader" />
            <h2>正在读取作品</h2>
            <p>
              识别图片、实况、视频与分 P，检查可下载的源文件。
              <br />
              部分抖音或小红书作品需要加载网页，请稍候。
            </p>
          </div>
        )}
        {result && (
          <section className="md-result" aria-label="解析结果">
            <div className="md-result-heading">
              {result.avatar ? (
                <MediaImage
                  key={result.avatar}
                  className="md-avatar"
                  src={result.directAvatar}
                  fallback={result.avatar}
                  alt=""
                  decoding="async"
                />
              ) : (
                <span className="md-platform-icon">
                  {{ bilibili: 'B', douyin: '抖', xiaohongshu: '红' }[result.platform]}
                </span>
              )}
              <div className="md-result-title">
                <p>
                  {result.author}
                  <span>
                    {' '}
                    ·{' '}
                    {
                      { douyin: '抖音', bilibili: '哔哩哔哩', xiaohongshu: '小红书' }[
                        result.platform
                      ]
                    }
                  </span>
                </p>
                <h2>{result.title}</h2>
                <p>
                  {result.kind === 'images'
                    ? liveCount
                      ? `共 ${count} 项 · ${liveCount} 张实况${count > liveCount ? ` · ${count - liveCount} 张图片` : ''}`
                      : `共 ${count} 张图片 · 无水印图片`
                    : `${count > 1 ? `共 ${count} 个分 P` : '视频'} · 最高可用画质`}
                </p>
              </div>
              <a className="md-origin" href={result.url} target="_blank" rel="noreferrer">
                原作品 <ExternalLinkIcon />
              </a>
            </div>
            {appleMobile && (
              <fieldset className="md-save-mode">
                <legend>保存方式</legend>
                <label>
                  <input
                    type="radio"
                    name="save-mode"
                    checked={saveMode === 'file'}
                    onChange={() => setSaveMode('file')}
                  />
                  下载文件
                </label>
                <label>
                  <input
                    type="radio"
                    name="save-mode"
                    checked={saveMode === 'album'}
                    onChange={() => setSaveMode('album')}
                  />
                  保存到相册
                </label>
                <small>
                  {saveMode === 'album'
                    ? '准备后打开系统保存菜单，iPhone / iPad 建议使用 Safari。'
                    : result.kind === 'images'
                      ? liveCount
                        ? '实况保存为 MP4，普通图片保存为 JPG / PNG；多选打包为 ZIP。'
                        : '图片保存为 JPG / PNG，多张图片打包为 ZIP。'
                      : result.platform === 'bilibili'
                        ? '每个分 P 分别保存为 MP4，多选也无需解压。'
                        : '视频保存为 MP4。'}
                </small>
              </fieldset>
            )}
            {result.kind === 'images' ? (
              <>
                <div className="md-toolbar">
                  <div>
                    <button
                      className={multiple ? 'is-active' : ''}
                      aria-pressed={multiple}
                      onClick={() => {
                        setMultiple(!multiple)
                        if (multiple) setSelected(new Set())
                      }}
                    >
                      <CheckIcon /> {multiple ? '退出多选' : '多选'}
                    </button>
                    {multiple && (
                      <label className="md-check">
                        <input
                          ref={selectAll}
                          type="checkbox"
                          checked={all}
                          onChange={() =>
                            setSelected(
                              all ? new Set() : new Set(result.assets.map((a) => a.index)),
                            )
                          }
                        />
                        全选
                      </label>
                    )}
                    <span className="md-selection">
                      {multiple
                        ? `已选 ${selected.size} 张 · 点击图片勾选`
                        : liveCount
                          ? '点击查看图片或播放实况'
                          : '点击图片查看大图'}
                    </span>
                  </div>
                  <button
                    className="md-primary"
                    disabled={!selected.size || pending}
                    onClick={() => void download([...selected])}
                  >
                    <DownloadIcon /> {`${saveText}选中内容${saveMode === 'album' ? '到相册' : ''}`}
                    {selected.size ? `（${selected.size}）` : ''}
                  </button>
                </div>
                <div className="md-image-grid">
                  {result.assets.map((asset) => (
                    <div
                      key={asset.index}
                      className={`md-image-tile${selected.has(asset.index) ? ' is-selected' : ''}`}
                    >
                      <button
                        className="md-thumbnail"
                        onClick={() => (multiple ? toggle(asset.index) : openImage(asset.index))}
                        aria-label={`${multiple ? (selected.has(asset.index) ? '取消选择' : '选择') : '预览'}${asset.type === 'livePhoto' ? '实况' : '图片'} ${asset.index}`}
                        aria-pressed={multiple ? selected.has(asset.index) : undefined}
                      >
                        <MediaImage
                          key={asset.thumbnail}
                          src={asset.directThumbnail}
                          fallback={asset.thumbnail}
                          alt={`图片 ${asset.index}`}
                          loading={asset.index <= 6 ? 'eager' : 'lazy'}
                          decoding="async"
                        />
                        <span className="md-image-number">{asset.index}</span>
                        {asset.type === 'livePhoto' && (
                          <span className="md-live-badge">
                            <PlayIcon />
                            实况 · {asset.duration?.toFixed(1)} 秒
                          </span>
                        )}
                        <span className="md-image-open">
                          {multiple ? (
                            <>
                              <CheckIcon /> {selected.has(asset.index) ? '取消选择' : '选中图片'}
                            </>
                          ) : (
                            <>
                              {asset.type === 'livePhoto' ? <PlayIcon /> : <ImageIcon />}
                              {asset.type === 'livePhoto' ? '查看实况' : '查看大图'}
                            </>
                          )}
                        </span>
                      </button>
                      {multiple && (
                        <label className="md-tile-check">
                          <input
                            type="checkbox"
                            aria-label={`选择图片 ${asset.index}`}
                            checked={selected.has(asset.index)}
                            onChange={() => toggle(asset.index)}
                          />
                          <span>
                            <CheckIcon />
                          </span>
                        </label>
                      )}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="md-video-layout">
                <div className="md-video-cover">
                  <MediaImage
                    key={result.cover}
                    src={result.directCover}
                    fallback={result.cover}
                    alt="视频封面"
                    decoding="async"
                  />
                </div>
                <div className="md-parts">
                  <div className="md-parts-heading">
                    <h3>{count > 1 ? '选择要保存的分 P' : '下载视频'}</h3>
                    {count > 1 && (
                      <label className="md-check">
                        <input
                          ref={selectAll}
                          type="checkbox"
                          checked={all}
                          onChange={() =>
                            setSelected(
                              all ? new Set() : new Set(result.assets.map((a) => a.index)),
                            )
                          }
                        />
                        全选
                      </label>
                    )}
                  </div>
                  <div className="md-part-list">
                    {result.assets.map((asset) => (
                      <label
                        key={asset.index}
                        className={`md-part${selected.has(asset.index) ? ' is-selected' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(asset.index)}
                          onChange={() => toggle(asset.index)}
                          aria-label={
                            count > 1 ? `选择 P${asset.index} ${asset.title}` : '选择视频'
                          }
                        />
                        <span className="md-part-number">
                          {count > 1 ? `P${asset.index}` : <PlayIcon />}
                        </span>
                        <span className="md-part-name">
                          {asset.title}
                          <small>{asset.quality || '准备下载时检查可用画质'}</small>
                        </span>
                        <span className="md-part-time">{mediaDuration(asset.duration)}</span>
                      </label>
                    ))}
                  </div>
                  <button
                    className="md-primary md-download-video"
                    disabled={!selected.size || pending}
                    onClick={() => void download([...selected])}
                  >
                    <DownloadIcon />{' '}
                    {pending
                      ? '正在准备下载'
                      : count > 1
                        ? `${saveText}选中分 P${saveMode === 'album' ? '到相册' : ''}（${selected.size}）`
                        : saveMode === 'album'
                          ? '保存视频到相册'
                          : '下载视频'}
                  </button>
                  <p className="md-quality-note">统一保存为 MP4。{result.notice}</p>
                  {result.platform === 'bilibili' && count > 1 && saveMode === 'file' && (
                    <p className="md-quality-note">
                      多选分 P 会分别下载为 MP4，每个分 P 可边处理边下载。
                    </p>
                  )}
                  {partsJob?.downloads && (
                    <div className="md-part-downloads" aria-label="分 P 下载文件">
                      {partsJob.downloads.map((part) => (
                        <div key={part.index}>
                          <span>
                            <strong>P{part.index}</strong>
                            <small>
                              {part.ready
                                ? '文件已就绪'
                                : partsJob.status === 'failed'
                                  ? '准备失败'
                                  : partsJob.status === 'cancelled'
                                    ? '已取消'
                                    : part.streaming
                                      ? '正在边合并边传输'
                                      : '等待处理'}
                            </small>
                          </span>
                          {['failed', 'cancelled'].includes(partsJob.status) && !part.ready ? (
                            <button disabled={pending} onClick={() => void download([part.index])}>
                              重试 P{part.index}
                            </button>
                          ) : (
                            <a href={part.url} download={part.name}>
                              单独下载 P{part.index}
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {saveMode === 'album' &&
                    result.platform === 'bilibili' &&
                    result.assets.some(
                      (a) => selected.has(a.index) && (a.duration || 0) > 1200,
                    ) && (
                      <p className="md-quality-note">
                        长视频建议选择“下载文件”，可边合并边下载。iPhone
                        下载后在“文件”中打开，点“共享”→“储存视频”即可保存到相册。
                      </p>
                    )}
                </div>
              </div>
            )}
            {notice && (
              <p className="md-download-notice" role="status">
                {notice}
              </p>
            )}
            {transferJobs.length > 0 && (
              <div className="md-transfer-status" aria-label="下载任务状态" aria-live="polite">
                {transferJobs.map((job) => (
                  <div key={job.id}>
                    <strong>
                      {job.monitoringError ||
                        (job.status === 'done'
                          ? '文件已就绪，请在浏览器中查看下载进度。'
                          : job.status === 'failed'
                            ? `下载中断：${job.error}`
                            : job.status === 'cancelled'
                              ? '任务已取消'
                              : job.recovering
                                ? '连接波动，正在自动重试…'
                                : job.phase)}
                    </strong>
                    <span>
                      服务器已获取 {formatBytes(job.bytes)}
                      {!!job.outputBytes && ` · 已生成文件 ${formatBytes(job.outputBytes)}`}
                      {job.count > 1 && ` · 已准备 ${job.current}/${job.count} 个文件`}
                      {!!job.retries && ` · 自动重试 ${job.retries} 次`}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {result.kind === 'images' && (
              <p className="md-result-note">
                {liveCount
                  ? '实况保留每张动态片段与已有音轨，普通图片保存为 JPG / PNG。'
                  : '保持原始分辨率，不添加水印，保存为 JPG / PNG。'}
                {saveMode === 'album'
                  ? '多选内容会分组交给系统保存，无需解压。'
                  : liveCount
                    ? '多选内容会打包为 ZIP，实况保存为 MP4。'
                    : '多张图片会打包为 ZIP。'}
              </p>
            )}
          </section>
        )}
        {!busy && !result && !error && (
          <div className="md-empty">
            <div>
              <PlayIcon />
              <ImageIcon />
            </div>
            <h2>把喜欢的内容留在手边</h2>
            <p>
              视频直接保存，图文按张挑选。
              <br />
              同一投稿里的所有分 P，一次识别。
            </p>
          </div>
        )}

        <footer className="md-footer">
          菜包下载助手 · {import.meta.env.PROD ? '在线使用' : '本地开发版'}
        </footer>
      </main>
      <dialog
        ref={dialog}
        className="md-lightbox"
        aria-label="图片预览"
        onCancel={(event) => {
          event.preventDefault()
          closeImage()
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' && preview && preview > 1) setPreview(preview - 1)
          if (event.key === 'ArrowRight' && preview && preview < count) setPreview(preview + 1)
        }}
      >
        {image && (
          <>
            <div className="md-lightbox-top">
              <span>
                {image.index} / {count}
                {image.width && image.height ? (
                  <small>
                    {image.width} × {image.height}
                  </small>
                ) : null}
              </span>
              <button autoFocus aria-label="关闭图片预览" onClick={closeImage}>
                <Cross2Icon />
              </button>
            </div>
            <div className="md-lightbox-image">
              <button
                aria-label="上一张图片"
                disabled={image.index <= 1}
                onClick={() => setPreview(image.index - 1)}
              >
                <ArrowLeftIcon />
              </button>
              {image.type === 'livePhoto' ? (
                <div className="md-live-stage">
                  {motionPlayer?.index === image.index ? (
                    <video
                      key={motionPlayer.url}
                      src={motionPlayer.url}
                      poster={image.preview || image.thumbnail}
                      controls
                      playsInline
                      autoPlay
                      aria-label={`实况 ${image.index} 动态预览`}
                    />
                  ) : (
                    <>
                      <MediaImage
                        key={image.thumbnail}
                        src={image.directPreview || image.directThumbnail}
                        fallback={image.preview || image.thumbnail}
                        alt={`实况 ${image.index} 封面`}
                      />
                      <button
                        className="md-live-play"
                        disabled={pending}
                        onClick={() => void download([image.index], 'motion')}
                      >
                        <PlayIcon />
                        {pending ? '正在准备…' : '播放实况'}
                      </button>
                    </>
                  )}
                  <span className="md-live-caption">
                    {image.duration?.toFixed(2)} 秒 · 动态 {image.motionWidth} ×{' '}
                    {image.motionHeight}
                  </span>
                  {(error || (pending && notice)) && <p role="status">{error || notice}</p>}
                </div>
              ) : (
                <MediaImage
                  key={image.thumbnail}
                  src={image.directPreview || image.directThumbnail}
                  fallback={image.preview || image.thumbnail}
                  alt={`图片 ${image.index} 大图`}
                />
              )}
              <button
                aria-label="下一张图片"
                disabled={image.index >= count}
                onClick={() => setPreview(image.index + 1)}
              >
                <ArrowRightIcon />
              </button>
            </div>
            <div className="md-lightbox-foot">
              <label>
                <input
                  type="checkbox"
                  checked={selected.has(image.index)}
                  onChange={() => {
                    setMultiple(true)
                    toggle(image.index)
                    closeImage()
                  }}
                />
                选择此图
              </label>
              <button
                className="md-primary"
                disabled={pending}
                onClick={() => void download([image.index])}
              >
                <DownloadIcon />{' '}
                {pending
                  ? '正在准备'
                  : image.type === 'livePhoto'
                    ? saveMode === 'album'
                      ? '保存视频到相册'
                      : '下载 MP4'
                    : saveMode === 'album'
                      ? '保存图片到相册'
                      : '下载图片'}
              </button>
            </div>
          </>
        )}
      </dialog>
      {appleMobile && album && <AlbumSaveDialog job={album} onClose={() => setAlbum(null)} />}
    </div>
  )
}
