import { normalizeHex } from './prompt-color.ts'

export type PromptRect = { x: number; y: number; width: number; height: number }
export const DEFAULT_PROMPT_RECT: PromptRect = { x: 0.08, y: 0.12, width: 0.84, height: 0.56 }
export type PromptColors = { unread: string; read: string; background: string }
export type PromptTheme = PromptColors & { id: string; name: string; muted: string }
export const PROMPT_THEMES = [
  {
    id: 'caibao',
    name: '菜包粉',
    unread: '#4a2432',
    read: '#c34433',
    background: '#fff0f3',
    muted: '#7d4b5c',
  },
  {
    id: 'pink',
    name: '白粉',
    unread: '#fff5f1',
    read: '#f4a5cc',
    background: '#251720',
    muted: '#e8c6d6',
  },
  {
    id: 'yellow',
    name: '白黄',
    unread: '#ffffff',
    read: '#ffdc59',
    background: '#15171c',
    muted: '#e0d7b7',
  },
  {
    id: 'cyan',
    name: '白青',
    unread: '#ffffff',
    read: '#66e2dc',
    background: '#131e22',
    muted: '#b4d9d7',
  },
  {
    id: 'amber',
    name: '黄白',
    unread: '#ffdf69',
    read: '#ffffff',
    background: '#17191e',
    muted: '#e1d4a7',
  },
  {
    id: 'ink-blue',
    name: '黑蓝',
    unread: '#171a20',
    read: '#1859ba',
    background: '#ffffff',
    muted: '#565f70',
  },
  {
    id: 'ink-pink',
    name: '黑粉',
    unread: '#20181b',
    read: '#b52366',
    background: '#fff9fc',
    muted: '#775469',
  },
] as const
export type PromptAppearance = {
  font: number
  textOpacity: number
  backgroundOpacity: number
  theme: string
  customColors?: PromptColors
  rect: PromptRect
  narrow: boolean
  stripY: number
}
export const PROMPT_APPEARANCE_KEY = 'caibao.teleprompter.appearance.v1'
export const defaultAppearance = (): PromptAppearance => ({
  font: 34,
  textOpacity: 100,
  backgroundOpacity: 85,
  theme: 'caibao',
  rect: { ...DEFAULT_PROMPT_RECT },
  narrow: false,
  stripY: 0.12,
})
const bounded = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback
export function clampPromptRect(rect: Partial<PromptRect>): PromptRect {
  const width = bounded(rect.width, 0.3, 1, DEFAULT_PROMPT_RECT.width)
  const height = bounded(rect.height, 0.12, 1, DEFAULT_PROMPT_RECT.height)
  return {
    width,
    height,
    x: bounded(rect.x, 0, 1 - width, DEFAULT_PROMPT_RECT.x * (1 - width)),
    y: bounded(rect.y, 0, 1 - height, DEFAULT_PROMPT_RECT.y * (1 - height)),
  }
}
export function parseAppearance(raw: string | null): PromptAppearance {
  try {
    const value = JSON.parse(raw || 'null')
    if (!value || typeof value !== 'object') return defaultAppearance()
    const customColors = parsePromptColors(value.customColors)
    const knownTheme =
      (value.theme === 'custom' && Boolean(customColors)) ||
      PROMPT_THEMES.some((theme) => theme.id === value.theme)
    return {
      font: bounded(value.font, 16, 72, 34),
      textOpacity: bounded(value.textOpacity, 0, 100, 100),
      backgroundOpacity: bounded(value.backgroundOpacity, 0, 100, 85),
      theme: knownTheme ? value.theme : 'caibao',
      ...(customColors ? { customColors } : {}),
      rect: clampPromptRect(
        value.rect && typeof value.rect === 'object' ? value.rect : DEFAULT_PROMPT_RECT,
      ),
      narrow: value.narrow === true,
      stripY: bounded(value.stripY, 0, 1, 0.12),
    }
  } catch {
    return defaultAppearance()
  }
}
function parsePromptColors(value: unknown): PromptColors | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<PromptColors>
  const unread = normalizeHex(input.unread),
    read = normalizeHex(input.read),
    background = normalizeHex(input.background)
  return unread && read && background ? { unread, read, background } : null
}
export function resolvePromptTheme(appearance: PromptAppearance): PromptTheme {
  if (appearance.theme === 'custom' && appearance.customColors)
    return {
      id: 'custom',
      name: '自定义',
      ...appearance.customColors,
      muted: appearance.customColors.unread,
    }
  return PROMPT_THEMES.find((theme) => theme.id === appearance.theme) ?? PROMPT_THEMES[0]
}
export function promptBackground(hex: string, opacity: number) {
  const parts = hex
    .slice(1)
    .match(/../g)!
    .map((part) => parseInt(part, 16))
  return `rgba(${parts.join(', ')}, ${Math.max(0, Math.min(100, opacity)) / 100})`
}

/** Font size is independent of the frame. The frame grows to fit complete rows. */
export function promptTextMetrics(requestedFont: number) {
  const font = bounded(requestedFont, 16, 72, 34)
  const lineHeight = font * 1.7
  const padding = 12
  return {
    font,
    lineHeight,
    padding,
    normalMinHeight: Math.ceil(lineHeight * 3 + padding * 2),
    stripHeight: Math.ceil(lineHeight * 2 + padding * 2),
  }
}

export function fitPromptRect(
  rect: Partial<PromptRect>,
  stage: { width: number; height: number },
  font: number,
  narrow: boolean,
): PromptRect {
  const requested = clampPromptRect(rect)
  if (
    !Number.isFinite(stage.width) ||
    !Number.isFinite(stage.height) ||
    stage.width <= 0 ||
    stage.height <= 0
  )
    return requested
  const metrics = promptTextMetrics(font)
  const width = narrow
    ? 1
    : Math.max(requested.width, Math.min(1, (metrics.font * 3 + metrics.padding * 2) / stage.width))
  const height = narrow
    ? Math.min(1, metrics.stripHeight / stage.height)
    : Math.max(requested.height, Math.min(1, metrics.normalMinHeight / stage.height))
  return {
    width,
    height,
    x: narrow ? 0 : Math.min(requested.x, 1 - width),
    y: Math.min(requested.y, 1 - height),
  }
}
