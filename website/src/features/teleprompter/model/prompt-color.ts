export type HSV = { h: number; s: number; v: number }
const clamp = (value: number, max = 1) =>
  Math.max(0, Math.min(max, Number.isFinite(value) ? value : 0))

export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const hex = value.trim().replace(/^#/, '')
  if (/^[a-f\d]{3}$/i.test(hex))
    return `#${[...hex]
      .map((part) => part + part)
      .join('')
      .toLowerCase()}`
  return /^[a-f\d]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null
}

export function hexToRgb(hex: string): [number, number, number] {
  const normalized = normalizeHex(hex) ?? '#000000'
  return [1, 3, 5].map((offset) => parseInt(normalized.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ]
}

export function rgbToHex(rgb: readonly number[]): string {
  return `#${rgb.map((part) => Math.round(clamp(part, 255)).toString(16).padStart(2, '0')).join('')}`
}

export function hexToHsv(hex: string, previousHue = 0): HSV {
  const [r, g, b] = hexToRgb(hex).map((part) => part / 255)
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    delta = max - min
  const h =
    delta === 0
      ? previousHue
      : 60 *
        (max === r
          ? ((g - b) / delta + 6) % 6
          : max === g
            ? (b - r) / delta + 2
            : (r - g) / delta + 4)
  return { h, s: max === 0 ? 0 : delta / max, v: max }
}

export function hsvToHex({ h, s, v }: HSV): string {
  const hue = (((h % 360) + 360) % 360) / 60
  const saturation = clamp(s),
    value = clamp(v)
  const chroma = value * saturation,
    x = chroma * (1 - Math.abs((hue % 2) - 1)),
    m = value - chroma
  const rgb =
    hue < 1
      ? [chroma, x, 0]
      : hue < 2
        ? [x, chroma, 0]
        : hue < 3
          ? [0, chroma, x]
          : hue < 4
            ? [0, x, chroma]
            : hue < 5
              ? [x, 0, chroma]
              : [chroma, 0, x]
  return rgbToHex(rgb.map((part) => (part + m) * 255))
}

/** Pointer coordinates may leave the square while the pointer is captured. */
export function saturationValueAt(x: number, y: number, width: number, height: number) {
  return { s: clamp(width > 0 ? x / width : 0), v: 1 - clamp(height > 0 ? y / height : 0) }
}
