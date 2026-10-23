import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { Link } from 'react-router-dom'
import { ArrowTopRightIcon, ChevronLeftIcon, ChevronRightIcon } from '@radix-ui/react-icons'
import type { ShowcaseEntry } from '../data/showcase'
import { HERO_IMAGE_SIZES, ProductImage } from './ProductImage'
import {
  CAROUSEL_DESKTOP_QUERY,
  carouselGestureAxis,
  carouselHasDesktopControls,
  carouselSwipeDirection,
} from '../lib/carousel-gesture'
import './product-carousel.css'

const ROTATION_DELAY = 5000
type Gesture = { pointerId: number; x: number; y: number; axis: 'horizontal' | 'vertical' | null }

function ProductLink({ entry, children }: { entry: ShowcaseEntry; children: ReactNode }) {
  const props = { className: 'preview-image-link', 'aria-label': `查看${entry.title}` }
  return entry.href.startsWith('/') ? (
    <Link to={entry.href} {...props}>
      {children}
    </Link>
  ) : (
    <a href={entry.href} {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

export function ProductCarousel({ entries }: { entries: ShowcaseEntry[] }) {
  const [selection, setSelection] = useState({
    id: entries[0]?.id ?? '',
    previousId: '',
    direction: 1,
  })
  const selectedIndex = Math.max(
    0,
    entries.findIndex((entry) => entry.id === selection.id),
  )
  const featured = entries[selectedIndex]
  const moving = useRef(false)
  const gesture = useRef<Gesture | null>(null)
  const suppressClickUntil = useRef(0)
  const [rotationRevision, setRotationRevision] = useState(0)
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [hidden, setHidden] = useState(() => document.hidden)
  const [interacting, setInteracting] = useState(false)
  const [desktopControls, setDesktopControls] = useState(() =>
    carouselHasDesktopControls(navigator, window.matchMedia(CAROUSEL_DESKTOP_QUERY).matches),
  )
  const canAutoPlay =
    !reducedMotion && !hovered && !focused && !hidden && !interacting && entries.length > 1

  const finishTransition = useCallback(() => {
    moving.current = false
    setSelection((current) => (current.previousId ? { ...current, previousId: '' } : current))
  }, [])

  const select = useCallback(
    (index: number, direction: number) => {
      if (moving.current || !entries[index]) return
      setRotationRevision((revision) => revision + 1)
      if (index === selectedIndex) return
      moving.current = !reducedMotion
      setSelection({
        id: entries[index].id,
        previousId: reducedMotion ? '' : entries[selectedIndex].id,
        direction,
      })
    },
    [entries, selectedIndex, reducedMotion],
  )

  function beginGesture(event: ReactPointerEvent<HTMLDivElement>) {
    suppressClickUntil.current = 0
    if (
      !event.isPrimary ||
      event.button !== 0 ||
      entries.length < 2 ||
      moving.current ||
      gesture.current
    )
      return
    if (event.target instanceof Element && event.target.closest('button')) return
    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      axis: null,
    }
    setInteracting(true)
  }

  function moveGesture(event: ReactPointerEvent<HTMLDivElement>) {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    current.axis ??= carouselGestureAxis(event.clientX - current.x, event.clientY - current.y)
    if (current.axis !== 'horizontal') return
    suppressClickUntil.current = performance.now() + 600
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function endGesture(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    const dx = event.clientX - current.x
    const dy = event.clientY - current.y
    const horizontal =
      current.axis === 'horizontal' ||
      (current.axis === null && carouselGestureAxis(dx, dy) === 'horizontal')
    gesture.current = null
    setInteracting(false)
    setFocused(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    if (Math.hypot(dx, dy) > 10) suppressClickUntil.current = performance.now() + 600
    if (!horizontal) return
    // A swipe must not also activate the product-detail link underneath the finger.
    suppressClickUntil.current = performance.now() + 600
    if (cancelled) return
    const direction = carouselSwipeDirection(dx, dy, event.currentTarget.clientWidth)
    if (direction) select((selectedIndex + direction + entries.length) % entries.length, direction)
  }

  useEffect(() => {
    const desktop = window.matchMedia(CAROUSEL_DESKTOP_QUERY)
    const onDesktop = () =>
      setDesktopControls(carouselHasDesktopControls(navigator, desktop.matches))
    desktop.addEventListener('change', onDesktop)
    return () => desktop.removeEventListener('change', onDesktop)
  }, [])

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onPreference = () => {
      setReducedMotion(preference.matches)
      if (preference.matches) {
        finishTransition()
      }
    }
    const onVisibility = () => setHidden(document.hidden)
    preference.addEventListener('change', onPreference)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      preference.removeEventListener('change', onPreference)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [finishTransition])

  useEffect(() => {
    if (!canAutoPlay) return
    const timer = window.setTimeout(
      () => select((selectedIndex + 1) % entries.length, 1),
      ROTATION_DELAY,
    )
    return () => window.clearTimeout(timer)
  }, [canAutoPlay, selectedIndex, entries.length, rotationRevision, select])

  useEffect(() => {
    if (!selection.previousId) return
    // Also release the controls if a browser suppresses animationend in a background tab.
    const timer = window.setTimeout(finishTransition, 700)
    return () => window.clearTimeout(timer)
  }, [selection.previousId, finishTransition])

  if (!featured) return null

  return (
    <section
      className="product-preview"
      aria-label="精选产品"
      aria-roledescription="轮播"
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') setHovered(true)
      }}
      onPointerLeave={() => setHovered(false)}
      onPointerDownCapture={() => setFocused(false)}
      onClickCapture={(event) => {
        if (event.detail > 0) setFocused(false)
      }}
      onKeyDownCapture={() => setFocused(true)}
      onFocusCapture={(event) => setFocused(event.target.matches(':focus-visible'))}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
    >
      <div
        className="preview-window"
        onPointerDown={beginGesture}
        onPointerMove={moveGesture}
        onPointerUp={endGesture}
        onPointerCancel={(event) => endGesture(event, true)}
        onLostPointerCapture={(event) => {
          // Touch initially captures on the image/link. Its bubbling loss during
          // transfer to this frame must not cancel the gesture we just started.
          if (event.target !== event.currentTarget) return
          if (gesture.current?.pointerId === event.pointerId) {
            gesture.current = null
            setInteracting(false)
          }
        }}
        onPointerLeave={(event) => {
          if (
            gesture.current?.pointerId === event.pointerId &&
            !event.currentTarget.hasPointerCapture(event.pointerId)
          ) {
            gesture.current = null
            setInteracting(false)
          }
        }}
        onDragStart={(event) => event.preventDefault()}
        onClickCapture={(event) => {
          if (performance.now() < suppressClickUntil.current) {
            event.preventDefault()
            event.stopPropagation()
            suppressClickUntil.current = 0
          }
        }}
      >
        {entries.map((entry, index) => {
          const active = index === selectedIndex
          const leaving = entry.id === selection.previousId
          return (
            <div
              key={entry.id}
              className={`preview-slide${active ? ' is-active' : ''}${active && selection.previousId ? ' is-entering' : ''}${leaving ? ' is-leaving' : ''}`}
              data-direction={selection.direction > 0 ? 'next' : 'previous'}
              aria-hidden={!active}
              inert={!active}
              onAnimationEnd={active ? finishTransition : undefined}
            >
              <ProductLink entry={entry}>
                {entry.image && (
                  <ProductImage
                    image={entry.image}
                    sizes={HERO_IMAGE_SIZES}
                    priority={active}
                    eager
                  />
                )}
                {desktopControls && (
                  <span className="preview-open" aria-hidden="true">
                    <ArrowTopRightIcon />
                  </span>
                )}
              </ProductLink>
            </div>
          )
        })}
        {desktopControls && entries.length > 1 && (
          <>
            <button
              type="button"
              className="preview-edge preview-edge-left"
              aria-label="上一张产品图"
              onClick={() => select((selectedIndex - 1 + entries.length) % entries.length, -1)}
            >
              <ChevronLeftIcon aria-hidden="true" />
            </button>
            <button
              type="button"
              className="preview-edge preview-edge-right"
              aria-label="下一张产品图"
              onClick={() => select((selectedIndex + 1) % entries.length, 1)}
            >
              <ChevronRightIcon aria-hidden="true" />
            </button>
          </>
        )}
      </div>
      {entries.length > 1 && (
        <div className="preview-controls" role="group" aria-label="切换精选产品">
          <button
            type="button"
            className="preview-step"
            aria-label="上一个产品"
            onClick={() => select((selectedIndex - 1 + entries.length) % entries.length, -1)}
          >
            <ChevronLeftIcon aria-hidden="true" />
          </button>
          {entries.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              className="preview-dot"
              aria-label={`显示${entry.title}`}
              aria-pressed={index === selectedIndex}
              onClick={() => select(index, index > selectedIndex ? 1 : -1)}
            >
              <span aria-hidden="true" />
            </button>
          ))}
          <button
            type="button"
            className="preview-step"
            aria-label="下一个产品"
            onClick={() => select((selectedIndex + 1) % entries.length, 1)}
          >
            <ChevronRightIcon aria-hidden="true" />
          </button>
        </div>
      )}
      <span
        className="preview-status"
        aria-live={canAutoPlay ? 'off' : 'polite'}
        aria-atomic="true"
      >
        {featured.title}，第 {selectedIndex + 1} 个，共 {entries.length} 个产品
      </span>
    </section>
  )
}
