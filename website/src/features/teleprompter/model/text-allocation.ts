export type SourceMap = (number | null)[]
export type TextEditSelection = { start: number; end: number; inputType?: string }
export type AllocationRange = { from: number; to: number }
export const sourceMapForRange = (from: number, to: number): SourceMap =>
  Array.from({ length: Math.max(0, to - from) }, (_, index) => from + index)

export function mappedSourceRanges(map: SourceMap): AllocationRange[] {
  const ranges: AllocationRange[] = []
  for (const index of map) {
    if (index === null) continue
    const previous = ranges.at(-1)
    if (previous?.to === index) previous.to++
    else ranges.push({ from: index, to: index + 1 })
  }
  return ranges
}

const graphemes = (text: string) => [
  ...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(text),
]
function alignText(before: string, after: string, map: SourceMap): SourceMap {
  const old = graphemes(before),
    next = graphemes(after)
  let prefix = 0,
    suffix = 0
  while (
    prefix < old.length &&
    prefix < next.length &&
    old[prefix].segment === next[prefix].segment
  )
    prefix++
  while (
    suffix < old.length - prefix &&
    suffix < next.length - prefix &&
    old[old.length - 1 - suffix].segment === next[next.length - 1 - suffix].segment
  )
    suffix++
  const positions = new Map<string, number[]>()
  for (let i = prefix; i < old.length - suffix; i++) {
    const matches = positions.get(old[i].segment) ?? []
    matches.push(i)
    positions.set(old[i].segment, matches)
  }
  const result: SourceMap = []
  let cursor = prefix
  next.forEach((part, i) => {
    let match = i < prefix ? i : i >= next.length - suffix ? old.length - (next.length - i) : -1
    if (match < 0) {
      const matches = positions.get(part.segment) ?? []
      let lo = 0,
        hi = matches.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (matches[mid] < cursor) lo = mid + 1
        else hi = mid
      }
      match = matches[lo] ?? -1
      if (match >= 0) cursor = match + 1
    }
    result.push(
      ...(match >= 0
        ? map.slice(old[match].index, old[match].index + part.segment.length)
        : Array<null>(part.segment.length).fill(null)),
    )
  })
  return result
}

/** Follow the actual edit location, including repeated words and emoji; new words have no source claim. */
export function reconcileSourceMap(
  before: string,
  after: string,
  map: SourceMap,
  selection?: TextEditSelection | null,
): SourceMap {
  if (before === after) return [...map]
  if (selection && Number.isSafeInteger(selection.start) && Number.isSafeInteger(selection.end)) {
    const { start, end, inputType = '' } = selection
    const removed = before.length - after.length
    const candidates =
      start < end
        ? [[start, end]]
        : removed > 0
          ? inputType.includes('Forward')
            ? [
                [start, start + removed],
                [start - removed, start],
              ]
            : [
                [start - removed, start],
                [start, start + removed],
              ]
          : [[start, start]]
    const boundaries = new Set(
      graphemes(before)
        .map((part) => part.index)
        .concat(before.length),
    )
    for (const [from, to] of candidates) {
      const inserted = after.length - before.length + to - from
      if (
        from < 0 ||
        to > before.length ||
        inserted < 0 ||
        !boundaries.has(from) ||
        !boundaries.has(to)
      )
        continue
      if (
        before.slice(0, from) !== after.slice(0, from) ||
        before.slice(to) !== after.slice(from + inserted)
      )
        continue
      return [
        ...map.slice(0, from),
        ...alignText(
          before.slice(from, to),
          after.slice(from, from + inserted),
          map.slice(from, to),
        ),
        ...map.slice(to),
      ]
    }
  }
  return alignText(before, after, map)
}
