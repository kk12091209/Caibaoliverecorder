import { useId, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import {
  hexToHsv,
  hexToRgb,
  hsvToHex,
  normalizeHex,
  rgbToHex,
  saturationValueAt,
  type HSV,
} from '../model/prompt-color'
import { BoundedNumber, Modal } from './Dialogs'

export function ColorPicker({
  title,
  initial,
  change,
  cancel,
  apply,
}: {
  title: string
  initial: string
  change: (hex: string) => void
  cancel: () => void
  apply: () => void
}) {
  const [hsv, setHsv] = useState(() => hexToHsv(initial))
  const [hex, setHex] = useState(initial)
  const pointer = useRef<number | null>(null)
  const hint = useId()
  const color = hsvToHex(hsv)
  const rgb = hexToRgb(color)
  const valid = normalizeHex(hex)
  function update(next: HSV) {
    const value = hsvToHex(next)
    setHsv(next)
    setHex(value)
    change(value)
  }
  function fromHex(value: string) {
    const normalized = normalizeHex(value)
    setHex(value)
    if (normalized) {
      setHsv(hexToHsv(normalized, hsv.h))
      change(normalized)
    }
  }
  function pick(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    update({
      ...hsv,
      ...saturationValueAt(
        event.clientX - rect.left,
        event.clientY - rect.top,
        rect.width,
        rect.height,
      ),
    })
  }
  return (
    <Modal title={title} close={cancel}>
      <div className="tp-modal-content tp-color-picker">
        <div
          className="tp-color-square"
          style={{ '--tp-picker-hue': `hsl(${hsv.h} 100% 50%)` } as CSSProperties}
          tabIndex={0}
          role="slider"
          aria-label="饱和度与明度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(hsv.s * 100)}
          aria-valuetext={`饱和度 ${Math.round(hsv.s * 100)}%，明度 ${Math.round(hsv.v * 100)}%`}
          aria-describedby={hint}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.currentTarget.focus()
            pointer.current = event.pointerId
            event.currentTarget.setPointerCapture(event.pointerId)
            pick(event)
          }}
          onPointerMove={(event) => {
            if (pointer.current === event.pointerId) pick(event)
          }}
          onPointerUp={(event) => {
            if (pointer.current === event.pointerId) {
              pick(event)
              pointer.current = null
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
          }}
          onPointerCancel={() => {
            pointer.current = null
          }}
          onLostPointerCapture={() => {
            pointer.current = null
          }}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 0.1 : 0.01
            if (
              ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
            ) {
              event.preventDefault()
              update({
                ...hsv,
                s: Math.max(
                  0,
                  Math.min(
                    1,
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? 1
                        : hsv.s +
                          (event.key === 'ArrowRight'
                            ? step
                            : event.key === 'ArrowLeft'
                              ? -step
                              : 0),
                  ),
                ),
                v: Math.max(
                  0,
                  Math.min(
                    1,
                    hsv.v +
                      (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0),
                  ),
                ),
              })
            }
          }}
        >
          <span
            className="tp-color-cursor"
            style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
          />
        </div>
        <span className="tp-sr-only" id={hint}>
          左右方向键调整饱和度，上下方向键调整明度，按住 Shift 加大步长。
        </span>
        <label className="tp-color-hue">
          色相{' '}
          <input
            type="range"
            aria-label="色相"
            min={0}
            max={360}
            step={1}
            value={hsv.h}
            onChange={(event) => update({ ...hsv, h: Number(event.target.value) })}
          />
          <output>{Math.round(hsv.h)}°</output>
        </label>
        <div className="tp-color-values">
          <span
            className="tp-color-preview"
            style={{ background: color }}
            aria-label={`当前颜色 ${color}`}
          />
          <label>
            HEX
            <input
              aria-label="HEX 色值"
              spellCheck={false}
              autoComplete="off"
              value={hex}
              maxLength={7}
              aria-invalid={!valid}
              onChange={(event) => fromHex(event.target.value)}
              onBlur={() => {
                if (valid) setHex(valid)
              }}
            />
          </label>
          <div className="tp-color-rgb">
            {['R', 'G', 'B'].map((channel, index) => (
              <label key={channel}>
                {channel}
                <BoundedNumber
                  label={`${channel} 色值`}
                  min={0}
                  max={255}
                  value={rgb[index]}
                  onChange={(value) => {
                    const next = [...rgb]
                    next[index] = value
                    fromHex(rgbToHex(next))
                  }}
                />
              </label>
            ))}
          </div>
        </div>
        <div className="tp-color-details">
          <span>
            {valid
              ? `S ${Math.round(hsv.s * 100)}% · V ${Math.round(hsv.v * 100)}%`
              : '请输入 3 或 6 位 HEX 色值'}
          </span>
          <button
            type="button"
            className="tp-original-color"
            onClick={() => update(hexToHsv(initial, hsv.h))}
          >
            <i style={{ background: initial }} />
            原色
          </button>
        </div>
      </div>
      <footer className="tp-modal-footer">
        <button type="button" onClick={cancel}>
          取消
        </button>
        <button type="button" className="tp-primary" disabled={!valid} onClick={apply}>
          应用颜色
        </button>
      </footer>
    </Modal>
  )
}
