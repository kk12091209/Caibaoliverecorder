import { useEffect, useId, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { DownloadPanel } from '../components/DownloadPanel'
import { ProductImage, DETAIL_IMAGE_SIZES } from '../components/ProductImage'
import { useWorks } from '../lib/catalog'
import type { PlatformId } from '../data/works'
import { NotFoundPage } from '../../../shared/ui/NotFound'
import './work.css'

export function WorkPage() {
  const works = useWorks()
  const [downloadPlatform, setDownloadPlatform] = useState<PlatformId | null>(null)
  const downloadOptionsId = useId()
  const { slug } = useParams()
  const work = works.find((entry) => entry.slug === slug)

  useEffect(() => {
    if (!work) return
    document.title = `${work.name} · 菜包宇宙`
  }, [work])

  if (!work) return <NotFoundPage />

  return (
    <article className="work-page product-detail">
      <div className="shell crumb">
        <Link to="/works">产品</Link>
        <span>/</span>
        <em>{work.name}</em>
      </div>
      <header className="shell detail-intro">
        <div>
          <p className="detail-eyebrow">{work.nameEn}</p>
          <h1>{work.name}</h1>
          <div className="detail-meta">
            <span>{work.category}</span>
            {work.platforms.map((platform) => (
              <span key={platform.id}>{platform.label}</span>
            ))}
          </div>
        </div>
        <div className="detail-intro-copy">
          <p className="detail-tagline">{work.tagline}</p>
          <p className="detail-summary">{work.summary}</p>
        </div>
      </header>

      {work.screenshots?.length ? (
        <div className="shell detail-gallery">
          {work.screenshots.map((image, index) => (
            <figure key={image.src}>
              <div className="detail-screenshot" onDragStart={(event) => event.preventDefault()}>
                <ProductImage image={image} sizes={DETAIL_IMAGE_SIZES} priority={index === 0} />
              </div>
              <figcaption>
                <span>{String(index + 1).padStart(2, '0')} / 操作界面</span>
                <p>{image.caption}</p>
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}

      {work.highlights.length > 0 && (
        <section className="shell detail-section" aria-labelledby="features-title">
          <div className="detail-section-heading">
            <p className="detail-eyebrow">FEATURES</p>
            <h2 id="features-title">主要功能</h2>
          </div>
          <div className="detail-features">
            {work.highlights.map((feature) => (
              <div key={feature.index} className="detail-feature">
                <span>{feature.index}</span>
                <div>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {work.steps.length > 0 && (
        <section className="shell detail-section" aria-labelledby="steps-title">
          <div className="detail-section-heading">
            <p className="detail-eyebrow">GET STARTED</p>
            <h2 id="steps-title">从这里开始</h2>
          </div>
          <ol className="detail-steps">
            {work.steps.map((step, index) => (
              <li key={step.title}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>
      )}

      {work.notes.length > 0 && (
        <section
          className="shell detail-section detail-notes-section"
          aria-labelledby="notes-title"
        >
          <div className="detail-section-heading">
            <h2 id="notes-title">使用前了解</h2>
          </div>
          <div className="detail-notes">
            {work.notes.map((note) => (
              <details key={note.title}>
                <summary>
                  {note.title}
                  <span aria-hidden="true">+</span>
                </summary>
                <p>{note.body}</p>
              </details>
            ))}
          </div>
        </section>
      )}

      {work.appPath ? (
        <section className="shell detail-download" id="use" aria-labelledby="use-title">
          <div className="detail-section-heading">
            <p className="detail-eyebrow">OPEN IN YOUR BROWSER</p>
            <h2 id="use-title">{work.useTitle || '现在，让台本跟上你。'}</h2>
          </div>
          <p className="detail-summary">{work.useSummary || '无需安装，电脑和手机都能使用。'}</p>
          <Link className="btn btn-primary" to={work.appPath}>
            立即使用{work.name}
          </Link>
        </section>
      ) : (
        <section className="shell detail-download" id="download" aria-labelledby="download-title">
          <div className="detail-section-heading">
            <p className="detail-eyebrow">DOWNLOAD</p>
            <div className="detail-download-heading">
              <h2 id="download-title">下载{work.name}</h2>
              <div className="detail-platforms" role="group" aria-label="选择下载系统">
                {work.platforms.map((platform) => (
                  <button
                    key={platform.id}
                    type="button"
                    className={downloadPlatform === platform.id ? 'tab is-on' : 'tab'}
                    aria-pressed={downloadPlatform === platform.id}
                    aria-controls={downloadOptionsId}
                    onClick={() => setDownloadPlatform(platform.id)}
                  >
                    {platform.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div id={downloadOptionsId}>
            {downloadPlatform && (
              <DownloadPanel
                key={`${work.slug}-${downloadPlatform}`}
                work={work}
                platform={downloadPlatform}
              />
            )}
          </div>
        </section>
      )}
    </article>
  )
}
