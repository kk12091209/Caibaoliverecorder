import { useEffect, useRef } from 'react'
import { DragHandleDots2Icon } from '@radix-ui/react-icons'

export function ReorderHandle({
  label,
  active,
  disabled,
  lift,
  hover,
  drop,
}: {
  label: string
  active: boolean
  disabled: boolean
  lift: () => void
  hover: (id: string | null) => void
  drop: (id: string | null) => void
}) {
  const press = useRef<{ pointerId: number; x: number; y: number; lifted: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const suppressClick = useRef(false)
  const clear = () => {
    clearTimeout(timer.current)
    timer.current = undefined
  }
  useEffect(
    () => () => {
      clearTimeout(timer.current)
    },
    [],
  )
  useEffect(() => {
    if (disabled) {
      clear()
      press.current = null
    }
  }, [disabled])
  const targetAt = (x: number, y: number) =>
    document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-sort-id]')?.dataset.sortId ?? null
  return (
    <button
      type="button"
      className="tp-reorder-handle"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      title="长按交换顺序，也可点击后选择另一段"
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary || disabled) return
        clear()
        suppressClick.current = false
        const current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          lifted: false,
        }
        press.current = current
        event.currentTarget.setPointerCapture(event.pointerId)
        timer.current = setTimeout(() => {
          if (press.current === current) {
            current.lifted = true
            lift()
          }
        }, 400)
      }}
      onPointerMove={(event) => {
        const current = press.current
        if (!current || current.pointerId !== event.pointerId) return
        if (
          !current.lifted &&
          Math.hypot(event.clientX - current.x, event.clientY - current.y) > 8
        ) {
          clear()
          if (event.pointerType === 'mouse') {
            current.lifted = true
            lift()
          } else {
            suppressClick.current = true
            press.current = null
            return
          }
        }
        if (current.lifted) hover(targetAt(event.clientX, event.clientY))
      }}
      onPointerUp={(event) => {
        const current = press.current
        clear()
        press.current = null
        if (current?.lifted) {
          suppressClick.current = true
          drop(targetAt(event.clientX, event.clientY))
        }
      }}
      onPointerCancel={() => {
        clear()
        press.current = null
        drop(null)
      }}
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false
          return
        }
        lift()
      }}
    >
      <DragHandleDots2Icon />
    </button>
  )
}
