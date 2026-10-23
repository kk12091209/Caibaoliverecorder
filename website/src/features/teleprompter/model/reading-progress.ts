import type { Cue } from './teleprompter'

/** Speech speed changes preserve the playhead; planned pauses keep their wall-clock length. */
export function advanceTimeline(cues: Cue[], position: number, seconds: number, rate: number) {
  let cursor = position
  let remaining = Math.max(0, seconds)
  const pace = Math.max(0.5, Math.min(2, rate))
  for (const cue of cues) {
    if (cue.end <= cursor) continue
    const multiplier = cue.kind === 'pause' ? 1 : pace
    const needed = (cue.end - cursor) / multiplier
    if (remaining < needed) return cursor + remaining * multiplier
    cursor = cue.end
    remaining -= needed
  }
  return Math.min(cursor, cues.at(-1)?.end ?? 0)
}

export function readingGlyphs(text: string) {
  return [...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(text)].map(
    (part) => part.segment,
  )
}

export type ReadingRow = { start: number; end: number; y: number; height: number }

/** Advance vertically only after a complete row, keeping the preceding row above it. */
export function bufferedReadingOffset(rows: ReadingRow[], glyphProgress: number, anchor: number) {
  const row =
    rows.find((entry) => glyphProgress >= entry.start && glyphProgress < entry.end) ?? rows.at(-1)
  return Math.max(0, (row?.y ?? 0) - anchor)
}

/** Leave two already-read characters behind the active character in a horizontal strip. */
export function horizontalReadingOffset(
  glyphs: { x: number; width: number }[],
  progress: number,
  viewportWidth: number,
  textWidth: number,
  font: number,
) {
  const index = Math.min(glyphs.length - 1, Math.max(0, Math.floor(progress)))
  const glyph = glyphs[index]
  if (!glyph) return 0
  const fraction = Math.max(0, Math.min(1, progress - index))
  const anchor = Math.min(viewportWidth - font, font * 3)
  return Math.max(
    0,
    Math.min(Math.max(0, textWidth - viewportWidth), glyph.x + glyph.width * fraction - anchor),
  )
}

export const STRIP_BUFFER_SECONDS = 1.5
export type StripBuffer = {
  index: number
  holding: number | null
  remaining: number
  elapsed: number
  now: number
  playing: boolean
  revision: number
}
export function updateStripBuffer(
  previous: StripBuffer | null,
  next: Pick<StripBuffer, 'index' | 'elapsed' | 'now' | 'playing' | 'revision'>,
): StripBuffer {
  const reset = { ...next, holding: null, remaining: 0 }
  if (
    !previous ||
    previous.revision !== next.revision ||
    next.elapsed < previous.elapsed ||
    next.elapsed - previous.elapsed > 0.5 ||
    next.index < previous.index ||
    next.index > previous.index + 1
  )
    return reset
  if (next.index !== previous.index) {
    return previous.playing && next.playing
      ? { ...next, holding: previous.index, remaining: STRIP_BUFFER_SECONDS }
      : reset
  }
  // Display grace uses active wall time, so changing speech speed does not shorten it.
  const consumed =
    previous.playing && next.elapsed > previous.elapsed
      ? Math.max(0, (next.now - previous.now) / 1000)
      : 0
  const remaining = Math.max(0, previous.remaining - consumed)
  return remaining > 0.000001 ? { ...next, remaining, holding: previous.holding } : reset
}
