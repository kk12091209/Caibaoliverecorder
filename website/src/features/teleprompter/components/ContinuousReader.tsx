import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { formatTime, speechText, type Cue } from '../model/teleprompter'
import {
  bufferedReadingOffset,
  horizontalReadingOffset,
  readingGlyphs,
  updateStripBuffer,
  type ReadingRow,
  type StripBuffer,
} from '../model/reading-progress'
import { promptBackground, promptTextMetrics, type PromptTheme } from '../model/prompt-style'

type Block = { cue: Cue; number: number; glyphs: string[] }
const Article = memo(function Article({
  blocks,
  articleRef,
  narrow,
}: {
  blocks: Block[]
  articleRef: React.RefObject<HTMLDivElement | null>
  narrow: boolean
}) {
  return (
    <div className="tp-reader-article" ref={articleRef}>
      {blocks.length ? (
        blocks.map(({ cue, number, glyphs }) => (
          <section
            className={`tp-reader-section${cue.kind === 'pause' ? ' tp-reader-pause' : ''}`}
            data-reader-cue={cue.id}
            key={cue.id}
            aria-label={`${cue.kind === 'speech' ? `第 ${number} 段` : '停顿'}，${formatTime(cue.start)} 至 ${formatTime(cue.end)}`}
          >
            <p className="tp-reader-text">
              <small className="tp-inline-section">
                {cue.kind === 'speech' ? `第 ${number} 段` : cue.note ? '动作提示' : '停顿'}
              </small>
              {cue.kind === 'speech' ? (
                glyphs.map((glyph, index) => (
                  <span className="tp-reading-glyph" data-reader-glyph={index} key={index}>
                    {narrow ? glyph.replace(/[\r\n]/g, ' ') : glyph}
                  </span>
                ))
              ) : (
                <>
                  <span className="tp-reader-pause-timer">
                    <span data-pause-seconds>{cue.end - cue.start}</span> 秒 · · ·{' '}
                  </span>
                  {cue.note && <span data-pause-note>{cue.note}</span>}
                </>
              )}
            </p>
          </section>
        ))
      ) : (
        <p className="tp-reader-empty">暂无口播内容</p>
      )}
    </div>
  )
})
type Measured = {
  anchor: number
  rows: ReadingRow[]
  glyphs: HTMLElement[]
  positions: { x: number; width: number }[]
  element: HTMLElement
  text: HTMLElement
  textWidth: number
}

export function ContinuousReader({
  cues,
  source,
  elapsed,
  playing,
  seekRevision,
  narrow,
  font,
  opacity,
  textOpacity,
  theme,
}: {
  cues: Cue[]
  source: string
  elapsed: number
  playing: boolean
  seekRevision: number
  narrow: boolean
  font: number
  opacity: number
  textOpacity: number
  theme: PromptTheme
}) {
  const blocks = useMemo(
    () =>
      cues.map((cue, index) => ({
        cue,
        number: index + 1,
        glyphs: cue.kind === 'speech' ? readingGlyphs(speechText(source, cue)) : [],
      })),
    [cues, source],
  )
  const viewport = useRef<HTMLDivElement>(null)
  const article = useRef<HTMLDivElement>(null)
  const measured = useRef<Measured[]>([])
  const cursor = useRef({ block: -1, index: -1 })
  const partial = useRef<HTMLElement | null>(null)
  const buffer = useRef<StripBuffer | null>(null)
  const lastPosition = useRef({ elapsed: NaN, revision: -1 })
  const [layout, setLayout] = useState(0)
  const metrics = promptTextMetrics(font)
  const { lineHeight, padding } = metrics
  const anchor = lineHeight

  useLayoutEffect(() => {
    buffer.current = null
  }, [blocks, narrow])

  useLayoutEffect(() => {
    let disposed = false
    const measure = () => {
      if (disposed || !article.current) return
      const top = article.current.getBoundingClientRect().top
      measured.current = [
        ...article.current.querySelectorAll<HTMLElement>('[data-reader-cue]'),
      ].map((section) => {
        const text = section.querySelector<HTMLElement>('.tp-reader-text')!
        const textBounds = text.getBoundingClientRect()
        const glyphs = [...section.querySelectorAll<HTMLElement>('[data-reader-glyph]')]
        const rows: ReadingRow[] = []
        const positions = glyphs.map((glyph, index) => {
          const bounds = glyph.getBoundingClientRect()
          const y = bounds.top - top
          const row = rows.at(-1)
          if (row && Math.abs(row.y - y) < 2) {
            row.end = index + 1
            row.height = Math.max(row.height, bounds.height)
          } else rows.push({ start: index, end: index + 1, y, height: bounds.height })
          return { x: bounds.left - textBounds.left, width: bounds.width }
        })
        return {
          anchor: rows[0]?.y ?? section.getBoundingClientRect().top - top,
          rows,
          glyphs,
          positions,
          element: section,
          text,
          textWidth: textBounds.width,
        }
      })
      cursor.current = { block: -1, index: -1 }
      lastPosition.current = { elapsed: NaN, revision: -1 }
      setLayout((value) => value + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (viewport.current) observer.observe(viewport.current)
    if (article.current) observer.observe(article.current)
    void document.fonts.ready.then(measure)
    return () => {
      disposed = true
      observer.disconnect()
    }
  }, [blocks, font, narrow])

  useLayoutEffect(() => {
    const currentIndex = Math.max(
      0,
      cues.findIndex((cue) => elapsed >= cue.start && elapsed < cue.end),
    )
    const blockIndex = elapsed >= (cues.at(-1)?.end ?? 0) ? cues.length - 1 : currentIndex
    const cue = cues[blockIndex]
    const current = measured.current[blockIndex]
    const frame = viewport.current
    const content = article.current
    if (!cue || !current || !content || !frame) return
    const progress = Math.max(0, Math.min(1, (elapsed - cue.start) / (cue.end - cue.start)))
    const glyphProgress = progress * current.glyphs.length
    const index = Math.floor(glyphProgress)
    const jumped =
      lastPosition.current.revision !== seekRevision ||
      !Number.isFinite(lastPosition.current.elapsed) ||
      Math.abs(lastPosition.current.elapsed - elapsed) > 0.5
    const blockChanged = cursor.current.block !== blockIndex
    if (blockChanged) {
      measured.current.forEach((entry, i) => {
        entry.element.classList.toggle('is-current', i === blockIndex)
        entry.glyphs.forEach((glyph) => glyph.classList.toggle('is-read', i < blockIndex))
        const countdown = entry.element.querySelector('[data-pause-seconds]')
        if (countdown && i !== blockIndex)
          countdown.textContent = String(i < blockIndex ? 0 : cues[i].end - cues[i].start)
        if (narrow) {
          const offset =
            i < blockIndex
              ? entry.glyphs.length
                ? horizontalReadingOffset(
                    entry.positions,
                    entry.glyphs.length,
                    frame.clientWidth,
                    entry.textWidth,
                    font,
                  )
                : Math.max(0, entry.textWidth - frame.clientWidth)
              : 0
          entry.text.style.transform = `translateX(${-offset}px)`
        } else entry.text.style.removeProperty('transform')
      })
      cursor.current = { block: blockIndex, index: 0 }
    }
    if (partial.current) {
      partial.current.classList.remove('is-reading')
      partial.current.style.removeProperty('--tp-fill')
    }
    const previous = cursor.current.index
    if (index >= previous)
      for (let i = previous; i < index; i++) current.glyphs[i]?.classList.add('is-read')
    else for (let i = index; i < previous; i++) current.glyphs[i]?.classList.remove('is-read')
    partial.current = current.glyphs[index] ?? null
    partial.current?.classList.add('is-reading')
    partial.current?.style.setProperty('--tp-fill', `${(glyphProgress - index) * 100}%`)
    cursor.current.index = index
    if (cue.kind === 'pause') {
      const countdown = current.element.querySelector('[data-pause-seconds]')
      const text = String(Math.max(0, Math.ceil(cue.end - elapsed)))
      if (countdown && countdown.textContent !== text) countdown.textContent = text
    }

    content.style.setProperty('--tp-scroll-duration', jumped ? '0ms' : '180ms')
    if (narrow) {
      const previousBuffer = buffer.current
      const nextBuffer = updateStripBuffer(previousBuffer, {
        index: blockIndex,
        elapsed,
        now: performance.now(),
        playing,
        revision: seekRevision,
      })
      buffer.current = nextBuffer
      const first = nextBuffer.holding ?? blockIndex
      content.style.transform = `translateY(${-first * lineHeight}px)`
      const textProgress = cue.kind === 'pause' ? progress * current.textWidth : glyphProgress
      const horizontal =
        cue.kind === 'pause'
          ? Math.min(Math.max(0, current.textWidth - frame.clientWidth), textProgress)
          : horizontalReadingOffset(
              current.positions,
              textProgress,
              frame.clientWidth,
              current.textWidth,
              font,
            )
      current.text.style.transform = `translateX(${-horizontal}px)`
      frame.style.setProperty(
        '--tp-guide-top',
        `${padding + (nextBuffer.holding === null ? 0 : lineHeight)}px`,
      )
      frame.dataset.currentRow = nextBuffer.holding === null ? '1' : '2'
      frame.dataset.bufferCue = nextBuffer.holding === null ? '' : cues[nextBuffer.holding].id
      if (blockChanged || previousBuffer?.holding !== nextBuffer.holding)
        measured.current.forEach((entry, i) => {
          entry.element.dataset.readerRole =
            i === blockIndex
              ? 'current'
              : i === nextBuffer.holding
                ? 'buffer'
                : i === blockIndex + 1
                  ? 'next'
                  : 'hidden'
        })
    } else {
      const offset =
        cue.kind === 'speech'
          ? bufferedReadingOffset(current.rows, glyphProgress, anchor)
          : Math.max(0, current.anchor - anchor) +
            Math.max(0, current.text.offsetHeight - lineHeight * 2) * progress
      content.style.transform = `translateY(${-offset}px)`
      const row =
        current.rows.find((entry) => index >= entry.start && index < entry.end) ??
        current.rows.at(-1)
      frame.style.setProperty(
        '--tp-guide-top',
        `${padding + (row?.y ?? current.anchor) - offset}px`,
      )
    }
    lastPosition.current = { elapsed, revision: seekRevision }
  }, [elapsed, playing, seekRevision, cues, layout, narrow, anchor, lineHeight, padding, font])

  return (
    <div
      className={`tp-prompt tp-continuous${narrow ? ' tp-strip' : ''}`}
      ref={viewport}
      style={
        {
          background: promptBackground(theme.background, opacity),
          fontSize: `${metrics.font}px`,
          '--tp-line-height': `${lineHeight}px`,
          '--tp-inset': `${padding}px`,
          '--tp-unread': theme.unread,
          '--tp-read': theme.read,
          '--tp-muted': theme.muted,
          '--tp-text-opacity': textOpacity / 100,
        } as CSSProperties
      }
      aria-label={narrow ? '两行横向提词，上一段保留缓冲' : '连贯台本，保留上一行和下一行'}
    >
      <div className="tp-reading-guide" aria-hidden="true" />
      <div className="tp-reader-window">
        <Article blocks={blocks} articleRef={article} narrow={narrow} />
      </div>
    </div>
  )
}
