import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { DragHandleDots2Icon, EnterFullScreenIcon } from '@radix-ui/react-icons'
import { fitPromptRect, type PromptRect } from '../model/prompt-style'

type Gesture = {
  pointer: number
  x: number
  y: number
  width: number
  height: number
  rect: PromptRect
  resize: boolean
}
export function PromptOverlay({
  rect: requested,
  font,
  narrow,
  editing,
  change,
  children,
}: {
  rect: PromptRect
  font: number
  narrow: boolean
  editing: boolean
  change: (rect: PromptRect) => void
  children: ReactNode
}) {
  const element = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const [stage, setStage] = useState({ width: 0, height: 0 })
  const rect = fitPromptRect(requested, stage, font, narrow)
  const moveTop =
    rect.y * stage.height >= 36
      ? '-32px'
      : (1 - rect.y - rect.height) * stage.height >= 36
        ? '100%'
        : '0px'
  useLayoutEffect(() => {
    const parent = element.current!.parentElement!
    const measure = () =>
      setStage((previous) =>
        previous.width === parent.clientWidth && previous.height === parent.clientHeight
          ? previous
          : { width: parent.clientWidth, height: parent.clientHeight },
      )
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])
  function begin(event: PointerEvent<HTMLButtonElement>, resize: boolean) {
    if (!editing || event.button !== 0 || !event.isPrimary) return
    const parent = element.current!.parentElement!.getBoundingClientRect()
    gesture.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      width: parent.width,
      height: parent.height,
      rect,
      resize,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const start = gesture.current
    if (!editing || !start || start.pointer !== event.pointerId) return
    const dx = (event.clientX - start.x) / start.width
    const dy = (event.clientY - start.y) / start.height
    change(
      fitPromptRect(
        start.resize
          ? {
              ...start.rect,
              width: start.rect.width + dx,
              height: start.rect.height + dy,
            }
          : { ...start.rect, x: start.rect.x + dx, y: start.rect.y + dy },
        stage,
        font,
        narrow,
      ),
    )
  }
  function end(event: PointerEvent<HTMLButtonElement>) {
    if (gesture.current?.pointer === event.pointerId) gesture.current = null
  }
  const handles = {
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.target === event.currentTarget) end(event)
    },
  }
  function key(event: React.KeyboardEvent, resize: boolean) {
    const step = event.shiftKey ? 0.05 : 0.01
    const delta = (
      {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      } as Record<string, number[]>
    )[event.key]
    if (!delta) return
    event.preventDefault()
    change(
      fitPromptRect(
        resize
          ? { ...rect, width: rect.width + delta[0], height: rect.height + delta[1] }
          : { ...rect, x: rect.x + delta[0], y: rect.y + delta[1] },
        stage,
        font,
        narrow,
      ),
    )
  }
  return (
    <div
      ref={element}
      className={`tp-overlay${narrow ? ' is-narrow' : ''}${editing ? ' is-adjusting' : ''}`}
      style={
        {
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.width * 100}%`,
          height: `${rect.height * 100}%`,
          '--tp-move-top': moveTop,
        } as CSSProperties
      }
    >
      {children}
      {editing && (
        <>
          <button
            type="button"
            className="tp-overlay-move"
            aria-label={narrow ? '上下移动窄条，方向键可微调' : '拖动提词框，方向键可微调'}
            onPointerDown={(event) => begin(event, false)}
            onKeyDown={(event) => key(event, false)}
            {...handles}
          >
            <DragHandleDots2Icon />
            {narrow ? '上下移动' : '拖动提词框'}
          </button>
          {!narrow && (
            <button
              type="button"
              className="tp-overlay-resize"
              aria-label="调整提词框大小，方向键可微调"
              onPointerDown={(event) => begin(event, true)}
              onKeyDown={(event) => key(event, true)}
              {...handles}
            >
              <EnterFullScreenIcon />
            </button>
          )}
        </>
      )}
    </div>
  )
}
