import { useEffect, useId, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowRightIcon,
  ArrowTopRightIcon,
  CheckIcon,
  CodeIcon,
  CopyIcon,
  Cross2Icon,
} from '@radix-ui/react-icons'
import { browserPlugins, type BrowserPlugin } from '../../shared/data/browser-plugins'
import { NotFoundPage } from '../../shared/ui/NotFound'
import './browser-plugins.css'

const collectionPath = '/works/browser-plugins'
const pluginPath = (plugin: BrowserPlugin) => `${collectionPath}/${plugin.slug}`

function PluginMark() {
  return (
    <span className="plugin-mark" aria-hidden="true">
      <svg viewBox="0 0 40 40" fill="none">
        <path
          d="M20 4 33 9v12c0 9-13 15-13 15S7 30 7 21V9L20 4Z"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="m13 20 5 5 10-12"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

export function BrowserPluginsPage() {
  useEffect(() => {
    document.title = '浏览器插件合集 · 菜包宇宙'
  }, [])
  return (
    <article className="plugin-page">
      <div className="shell crumb">
        <Link to="/works">产品</Link>
        <span>/</span>
        <em>浏览器插件合集</em>
      </div>
      <header className="shell plugin-intro">
        <div>
          <p className="plugin-eyebrow">BROWSER TOOLS</p>
          <h1>浏览器插件合集</h1>
        </div>
        <div>
          <p className="plugin-tagline">给浏览器，加一点顺手的功能。</p>
          <p className="plugin-summary">
            一些在浏览器里使用的小工具。逐个了解功能，前往插件主页，或查看并复制完整源码。
          </p>
        </div>
      </header>
      <section className="shell plugin-list" id="plugins" aria-labelledby="plugin-list-title">
        <div className="plugin-list-heading">
          <h2 id="plugin-list-title">插件</h2>
          <span>{browserPlugins.length} 个</span>
        </div>
        {browserPlugins.map((plugin) => (
          <article className="plugin-card" key={plugin.slug}>
            <Link className="plugin-card-main" to={pluginPath(plugin)}>
              <PluginMark />
              <div>
                <p className="plugin-meta">
                  用户脚本 <span>v{plugin.version} · 本站调整版</span>
                </p>
                <h3>{plugin.name}</h3>
                <p className="plugin-summary">{plugin.summary}</p>
                <div className="plugin-tags">
                  {plugin.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              </div>
              <ArrowRightIcon className="plugin-card-arrow" />
            </Link>
            <div className="plugin-card-actions">
              <Link to={pluginPath(plugin)} className="plugin-text-link">
                了解插件 <ArrowRightIcon />
              </Link>
              <a
                href={plugin.homepage}
                target="_blank"
                rel="noreferrer"
                className="plugin-text-link"
              >
                插件主页 <ArrowTopRightIcon />
              </a>
              <Link to={`${pluginPath(plugin)}#source`} className="plugin-source-link">
                <CodeIcon /> 查看源码
              </Link>
            </div>
          </article>
        ))}
        <p className="plugin-install-note">
          当前提供用户脚本，需在 Tampermonkey 等脚本管理器中使用。
        </p>
      </section>
    </article>
  )
}

export function BrowserPluginPage() {
  const { pluginSlug } = useParams()
  const plugin = browserPlugins.find((item) => item.slug === pluginSlug)
  const location = useLocation()
  const navigate = useNavigate()
  const [sourceOpen, setSourceOpen] = useState(location.hash === '#source')
  useEffect(() => {
    if (plugin) document.title = `${plugin.name} · 浏览器插件合集 · 菜包宇宙`
  }, [plugin])
  useEffect(() => {
    if (location.hash === '#source') setSourceOpen(true)
  }, [location.hash, location.key])
  function closeSource() {
    setSourceOpen(false)
    if (location.hash === '#source') navigate(location.pathname, { replace: true })
  }
  if (!plugin) return <NotFoundPage />
  return (
    <article className="plugin-page">
      <div className="shell crumb">
        <Link to="/works">产品</Link>
        <span>/</span>
        <Link to={collectionPath}>浏览器插件合集</Link>
        <span>/</span>
        <em>{plugin.name}</em>
      </div>
      <header className="shell plugin-detail-intro">
        <PluginMark />
        <p className="plugin-meta">
          用户脚本 <span>v{plugin.version} · 本站调整版</span>
        </p>
        <h1>{plugin.name}</h1>
        <p className="plugin-tagline">{plugin.summary}</p>
        <div className="plugin-tags">
          {plugin.tags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
        <div className="plugin-primary-actions">
          <a className="btn btn-primary" href={plugin.homepage} target="_blank" rel="noreferrer">
            前往插件主页 <ArrowTopRightIcon />
          </a>
          <button type="button" className="btn" onClick={() => setSourceOpen(true)}>
            <CodeIcon /> 查看源码
          </button>
        </div>
      </header>
      <section className="shell plugin-features" aria-label="插件功能">
        {plugin.features.map((feature, index) => (
          <div key={feature.title}>
            <span className="plugin-eyebrow">0{index + 1}</span>
            <h2>{feature.title}</h2>
            <p>{feature.body}</p>
          </div>
        ))}
      </section>
      <section className="shell plugin-setup">
        <div>
          <p className="plugin-eyebrow">GET STARTED</p>
          <h2>选择适合你的方式</h2>
          <p className="plugin-summary">
            可在插件主页查看作者发布的版本；本站源码是这次调整后的 v{plugin.version}
            ，可直接复制到脚本管理器。
          </p>
        </div>
        <ol>
          <li>
            <strong>已有脚本管理器</strong>
            <p>
              点击「查看源码」并复制完整代码，在 Tampermonkey
              等脚本管理器中新建脚本，替换编辑器内容并保存。
            </p>
          </li>
          <li>
            <strong>回到 B 站使用</strong>
            <p>
              刷新支持的 B
              站页面。直播间里点击弹幕用户的菜单，选择「一键跟车」；工具栏中可查看三位对象，点击各自的
              × 取消。
            </p>
          </li>
        </ol>
      </section>
      {sourceOpen && <PluginSource plugin={plugin} close={closeSource} />}
    </article>
  )
}

function PluginSource({ plugin, close }: { plugin: BrowserPlugin; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  const press = useRef<{ x: number; y: number; pointerId: number } | null>(null)
  const title = useId()
  const [source, setSource] = useState('')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'manual'>('idle')
  useEffect(() => {
    const element = dialog.current!,
      previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    element.showModal()
    return () => {
      element.close()
      document.body.style.overflow = previous
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    void (async () => {
      try {
        const response = await fetch(plugin.source, {
          signal: controller.signal,
          cache: 'no-cache',
        })
        if (!response.ok) throw new Error('源码暂时无法加载。')
        const text = await response.text()
        if (
          !text.startsWith('// ==UserScript==') ||
          !text.includes(`// @version      ${plugin.version}`)
        )
          throw new Error('源码内容与当前版本不一致。')
        if (!controller.signal.aborted) setSource(text)
      } catch (problem) {
        if (!controller.signal.aborted) setError((problem as Error).message)
      }
    })()
    return () => controller.abort()
  }, [plugin.source, plugin.version, attempt])
  async function copy() {
    if (!source || copyState === 'copying') return
    setCopyState('copying')
    try {
      await navigator.clipboard.writeText(source)
      setCopyState('copied')
    } catch {
      editor.current?.focus()
      editor.current?.select()
      setCopyState('manual')
    }
  }
  function outside(x: number, y: number) {
    const bounds = dialog.current!.getBoundingClientRect()
    return x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom
  }
  return (
    <dialog
      className="plugin-source-dialog"
      ref={dialog}
      aria-labelledby={title}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      onPointerDown={(event) => {
        press.current =
          event.target === dialog.current &&
          event.button === 0 &&
          outside(event.clientX, event.clientY)
            ? { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
            : null
      }}
      onPointerUp={(event) => {
        const start = press.current
        press.current = null
        if (
          start &&
          start.pointerId === event.pointerId &&
          event.target === dialog.current &&
          outside(event.clientX, event.clientY) &&
          Math.hypot(start.x - event.clientX, start.y - event.clientY) < 8
        )
          close()
      }}
      onPointerCancel={() => {
        press.current = null
      }}
    >
      <header>
        <div>
          <p className="plugin-eyebrow">完整用户脚本 · v{plugin.version}</p>
          <h2 id={title}>{plugin.name}</h2>
        </div>
        <button type="button" className="plugin-close" onClick={close} aria-label="关闭源码">
          <Cross2Icon />
        </button>
      </header>
      <div className="plugin-source-toolbar">
        <span>{plugin.source.split('/').at(-1)}</span>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!source || copyState === 'copying'}
          onClick={() => void copy()}
        >
          {copyState === 'copied' ? <CheckIcon /> : <CopyIcon />}
          {copyState === 'copied' ? '已复制' : copyState === 'copying' ? '正在复制…' : '复制代码'}
        </button>
      </div>
      {error ? (
        <div className="plugin-source-message" role="alert">
          <p>{error}</p>
          <button type="button" className="btn" onClick={() => setAttempt((value) => value + 1)}>
            重新加载
          </button>
        </div>
      ) : source ? (
        <textarea
          ref={editor}
          className="plugin-source-code"
          aria-label="插件完整源码"
          value={source}
          readOnly
          spellCheck={false}
          wrap="off"
        />
      ) : (
        <p className="plugin-source-message" role="status">
          正在加载源码…
        </p>
      )}
      <footer>
        <span role="status">
          {copyState === 'manual'
            ? '源码已选中，请手动复制。'
            : copyState === 'copied'
              ? '完整源码已复制，可粘贴到脚本管理器。'
              : source
                ? `${source.split('\n').length.toLocaleString()} 行 · 仅展示，不在本站执行`
                : ''}
        </span>
        <button type="button" className="btn" onClick={close}>
          关闭
        </button>
      </footer>
    </dialog>
  )
}
