import { useEffect, useId, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useWorks } from '../lib/catalog'

export function WorkSwitcher() {
  const works = useWorks()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const { pathname } = useLocation()
  const current = works.find((entry) => entry.slug === pathname.match(/^\/works\/([^/]+)/)?.[1])

  useEffect(() => {
    setOpen(false)
  }, [pathname])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="switcher" ref={rootRef}>
      <button
        type="button"
        className={open ? 'switcher-button is-open' : 'switcher-button'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
      >
        <small>产品</small>
        <strong>{current?.name ?? '选择产品'}</strong>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M3.5 6.5 8 11l4.5-4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {open && (
        <div className="switcher-panel" id={menuId} role="menu" aria-label="切换产品">
          <Link className="switcher-all" role="menuitem" to="/works" onClick={() => setOpen(false)}>
            全部产品
          </Link>
          {works.map((work) => (
            <Link
              key={work.slug}
              role="menuitem"
              to={`/works/${work.slug}`}
              onClick={() => setOpen(false)}
              className={work.slug === current?.slug ? 'switcher-item is-current' : 'switcher-item'}
              aria-current={work.slug === current?.slug ? 'page' : undefined}
            >
              <strong>{work.name}</strong>
              <em>{work.version}</em>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
