import { useEffect, useState } from 'react'
import { NavLink, Link, useLocation } from 'react-router-dom'
import { studio } from '../data/works'
import { useWorks } from '../lib/catalog'
import { Mark } from '../../../shared/ui/Mark'
import { WorkSwitcher } from './WorkSwitcher'

export function Frame({ children }: { children: React.ReactNode }) {
  const works = useWorks()
  const [open, setOpen] = useState(false)
  const [compact, setCompact] = useState(false)
  const location = useLocation()
  const currentWork = works.find(
    (entry) => entry.slug === location.pathname.match(/^\/works\/([^/]+)/)?.[1],
  )
  const action = currentWork
    ? currentWork.kind === 'collection'
      ? { to: `/works/${currentWork.slug}#plugins`, label: '浏览插件' }
      : {
          to: currentWork.appPath ?? `/works/${currentWork.slug}#download`,
          label: currentWork.appPath ? '立即使用' : '下载',
        }
    : null

  useEffect(() => {
    setOpen(false)
  }, [location.pathname])

  useEffect(() => {
    const onScroll = () => {
      const next = window.scrollY > 8
      setCompact(next)
      document.documentElement.style.setProperty('--nav', next ? '64px' : '78px')
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    document.body.classList.toggle('menu-open', open)
    return () => document.body.classList.remove('menu-open')
  }, [open])

  return (
    <>
      <a className="skip" href="#content">
        跳到正文
      </a>
      <header className={compact ? 'nav is-compact' : 'nav'}>
        <div className="nav-inner">
          <Link to="/" className="brand" aria-label="菜包宇宙，回到首页">
            <Mark className="brand-mark" />
            <span>
              <strong>菜包宇宙</strong>
              <small>Caibao Universe</small>
            </span>
          </Link>
          <nav className="nav-links" aria-label="主导航">
            <WorkSwitcher />
            <NavLink to="/about">关于</NavLink>
            {action ? (
              <Link to={action.to} className="nav-cta">
                {action.label}
              </Link>
            ) : null}
          </nav>
          <div className="nav-actions">
            {action && (
              <Link to={action.to} className="nav-cta" onClick={() => setOpen(false)}>
                {action.label}
              </Link>
            )}
            <button
              type="button"
              className="menu-button"
              aria-expanded={open}
              aria-controls="mobile-nav"
              onClick={() => setOpen((value) => !value)}
            >
              {open ? '关闭' : '菜单'}
            </button>
          </div>
        </div>
      </header>
      {open && (
        <div className="mobile-panel" id="mobile-nav">
          <p className="mobile-label">产品</p>
          <NavLink to="/works" end onClick={() => setOpen(false)}>
            全部产品
          </NavLink>
          {works.map((work) => (
            <NavLink key={work.slug} to={`/works/${work.slug}`} onClick={() => setOpen(false)}>
              {work.name}
            </NavLink>
          ))}
          <NavLink to="/about">关于</NavLink>
        </div>
      )}
      <main id="content">{children}</main>
      <footer className="footer">
        <div className="footer-grid">
          <div>
            <p className="footer-label">浏览</p>
            <Link to="/">首页</Link>
            <Link to="/works">产品</Link>
            <Link to="/about">关于</Link>
          </div>
          <div>
            <p className="footer-label">产品</p>
            {works.map((work) => (
              <Link key={work.slug} to={`/works/${work.slug}`}>
                {work.name}
              </Link>
            ))}
          </div>
          <div>
            <p className="footer-label">联系我们</p>
            <a href={studio.bilibili} target="_blank" rel="noreferrer">
              B 站主页
            </a>
            <a href={studio.github} target="_blank" rel="noreferrer">
              GitHub 主页
            </a>
          </div>
        </div>
        <p className="footer-meta">
          作者：{studio.author}，技术支持：{studio.support}
        </p>
      </footer>
    </>
  )
}
