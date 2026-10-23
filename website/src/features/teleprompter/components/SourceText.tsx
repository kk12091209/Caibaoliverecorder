import { memo, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { LockClosedIcon } from '@radix-ui/react-icons'
import { buildCues, sourceRuns, type Draft } from '../model/teleprompter'
import {
  selectionBoundaries,
  sourceIndexAtPoint,
  touchedRange,
  type SourceRange,
} from '../model/source-selection'

// Native mouse selection remains untouched; touch selection starts on contact with available text.
export const SourceText = memo(function SourceText({
  draft,
  sourceRef,
  editingId,
  select,
}: {
  draft: Draft
  sourceRef: React.RefObject<HTMLDivElement | null>
  editingId?: string
  select: (range: SourceRange) => void
}) {
  const runs = useMemo(
    () =>
      sourceRuns(
        draft.source,
        draft.segments.filter((segment) => segment.id !== editingId),
      ),
    [draft.source, draft.segments, editingId],
  )
  const [highlight, setHighlight] = useState<SourceRange | null>(null)
  const lastRange = useRef<SourceRange | null>(null)
  const drag = useRef<{
    pointer: number
    anchor: number
    boundaries: number[]
    x: number
    y: number
  } | null>(null)
  const frame = useRef(0)
  function visibleBox(root: HTMLElement) {
    const box = root.getBoundingClientRect(),
      pane = root.closest('.tp-composer-body')?.getBoundingClientRect()
    return {
      left: box.left,
      right: box.right,
      top: Math.max(box.top, pane?.top ?? 0),
      bottom: Math.min(box.bottom, pane?.bottom ?? innerHeight, innerHeight),
    }
  }
  function update(x: number, y: number) {
    const current = drag.current,
      root = sourceRef.current
    if (!current || !root) return
    const box = visibleBox(root)
    const offset = sourceIndexAtPoint(
      root,
      Math.max(box.left + 2, Math.min(box.right - 14, x)),
      Math.max(box.top + 2, Math.min(box.bottom - 2, y)),
    )
    if (offset === null) return
    const range = touchedRange(current.boundaries, current.anchor, offset)
    if (lastRange.current?.from === range.from && lastRange.current.to === range.to) return
    lastRange.current = range
    setHighlight(range)
    select(range)
  }
  function scrollEdge() {
    const current = drag.current,
      root = sourceRef.current
    if (!current || !root) return
    const box = visibleBox(root)
    const step =
      current.y < box.top + 32
        ? -Math.min(12, (box.top + 32 - current.y) / 3)
        : current.y > box.bottom - 32
          ? Math.min(12, (current.y - box.bottom + 32) / 3)
          : 0
    if (step) {
      root.scrollTop += step
      update(current.x, current.y)
    }
    frame.current = requestAnimationFrame(scrollEdge)
  }
  function begin(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse') {
      setHighlight(null)
      return
    }
    if (!event.isPrimary || drag.current || !(event.target as Element).closest('.tp-available'))
      return
    const offset = sourceIndexAtPoint(event.currentTarget, event.clientX, event.clientY)
    const run = runs.find(
      (item) =>
        !item.segment &&
        offset !== null &&
        offset >= item.from &&
        offset <= item.from + item.text.length,
    )
    if (!run || offset === null || !run.text) return
    event.preventDefault()
    window.getSelection()?.removeAllRanges()
    lastRange.current = null
    drag.current = {
      pointer: event.pointerId,
      anchor: offset,
      boundaries: selectionBoundaries(run.text, run.from),
      x: event.clientX,
      y: event.clientY,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    update(event.clientX, event.clientY)
    frame.current = requestAnimationFrame(scrollEdge)
  }
  function finish() {
    drag.current = null
    cancelAnimationFrame(frame.current)
  }
  useEffect(
    () => () => {
      drag.current = null
      cancelAnimationFrame(frame.current)
    },
    [],
  )
  return (
    <div
      className="tp-original"
      ref={sourceRef}
      tabIndex={0}
      aria-label="台本全文，选择未分配的连续文字"
      onPointerDown={begin}
      onPointerMove={(event) => {
        if (drag.current?.pointer !== event.pointerId) return
        event.preventDefault()
        drag.current.x = event.clientX
        drag.current.y = event.clientY
        update(event.clientX, event.clientY)
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointer === event.pointerId) {
          update(event.clientX, event.clientY)
          finish()
        }
      }}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onContextMenu={(event) => {
        if (highlight) event.preventDefault()
      }}
    >
      {runs.map((run) => {
        let offset = run.from
        return (
          <span key={run.from} className={run.segment ? 'tp-assigned' : 'tp-available'}>
            {run.segment && (
              <span className="tp-lock-tag" aria-hidden="true">
                <LockClosedIcon /> 已分配 · 第{' '}
                {buildCues(draft.segments).findIndex((s) => s.id === run.segment?.id) + 1} 段
              </span>
            )}
            {(run.segment ? [run.text] : run.text.split(/(\n+)/).filter(Boolean)).map((part) => {
              const from = offset
              offset += part.length
              const a = Math.max(from, highlight?.from ?? offset),
                b = Math.min(offset, highlight?.to ?? from)
              return (
                <span
                  key={from}
                  className={/^\n+$/.test(part) ? 'tp-source-break' : undefined}
                  data-source-run={from}
                >
                  {!run.segment && a < b ? (
                    <>
                      {part.slice(0, a - from)}
                      <mark className="tp-touch-selection">{part.slice(a - from, b - from)}</mark>
                      {part.slice(b - from)}
                    </>
                  ) : (
                    part
                  )}
                </span>
              )
            })}
          </span>
        )
      })}
    </div>
  )
})
