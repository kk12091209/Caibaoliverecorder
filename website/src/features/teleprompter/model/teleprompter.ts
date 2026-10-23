import {
  mappedSourceRanges,
  reconcileSourceMap,
  sourceMapForRange,
  type SourceMap,
} from './text-allocation.ts'

export type Speech = {
  id: string
  kind: 'speech'
  start: number
  end: number
  from: number
  to: number
  text?: string
  sourceMap?: SourceMap
}
export type Pause = { id: string; kind: 'pause'; start: number; end: number; note?: string }
export type Segment = Speech | Pause
export type Draft = { schema: 1; title: string; source: string; rate: number; segments: Segment[] }
export type Cue = Segment & { automatic?: boolean }
export const STORAGE_KEY = 'caibao.teleprompter.v1'
export const MAX_TIME = 24 * 60 * 60
export const MAX_PAUSE_NOTE = 300
export const MAX_SCRIPT_LENGTH = 10000

export const countCharacters = (text: string) => (text.match(/[\p{L}\p{N}]/gu) ?? []).length
export const recommendedCount = (seconds: number, rate: number) => Math.round((seconds * rate) / 60)
export const readingSeconds = (text: string, rate: number) =>
  Math.round((countCharacters(text) * 60) / rate)
export function formatTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds))
  return `${Math.floor(value / 60)
    .toString()
    .padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`
}

const overlaps = (a: number, b: number, c: number, d: number) => a < d && c < b
const boundary = (text: string, index: number) =>
  !(
    index > 0 &&
    index < text.length &&
    /[\uD800-\uDBFF]/.test(text[index - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[index])
  )
export const speechText = (source: string, segment: Speech) =>
  segment.text ?? source.slice(segment.from, segment.to)
export const speechSourceMap = (segment: Speech): SourceMap =>
  segment.sourceMap ? [...segment.sourceMap] : sourceMapForRange(segment.from, segment.to)
export const speechRanges = (segment: Speech) =>
  segment.sourceMap
    ? mappedSourceRanges(segment.sourceMap)
    : [{ from: segment.from, to: segment.to }]
export const allocatedCharacterCount = (draft: Draft) =>
  sourceRuns(draft.source, draft.segments).reduce(
    (total, run) => total + (run.segment ? countCharacters(run.text) : 0),
    0,
  )
export function validateSpeechSelection(
  segment: Pick<Speech, 'id' | 'from' | 'to'>,
  source: string,
  existing: Segment[],
): string | null {
  if (
    ![segment.from, segment.to].every(Number.isSafeInteger) ||
    segment.from < 0 ||
    segment.to > source.length ||
    segment.from >= segment.to ||
    !boundary(source, segment.from) ||
    !boundary(source, segment.to) ||
    countCharacters(source.slice(segment.from, segment.to)) === 0
  )
    return '请先在原文中选择本段需要朗读的文字。'
  if (
    existing.some(
      (entry) =>
        entry.id !== segment.id &&
        entry.kind === 'speech' &&
        speechRanges(entry).some((range) =>
          overlaps(segment.from, segment.to, range.from, range.to),
        ),
    )
  )
    return '选区包含已分配的文字，请重新选择未分配的连续文字。'
  return null
}
export function validateSegment(
  segment: Segment,
  source: string,
  existing: Segment[],
): string | null {
  if (
    ![segment.start, segment.end].every(Number.isSafeInteger) ||
    segment.start < 0 ||
    segment.end <= segment.start ||
    segment.end > MAX_TIME
  )
    return '请设置有效的起止时间，结束时间需晚于开始时间（最长 24 小时）。'
  if (
    existing.some(
      (entry) =>
        entry.id !== segment.id && overlaps(segment.start, segment.end, entry.start, entry.end),
    )
  )
    return '这段时间与已有分段重叠，请调整起止时间。'
  if (
    segment.kind === 'pause' &&
    segment.note !== undefined &&
    (typeof segment.note !== 'string' || segment.note.length > MAX_PAUSE_NOTE)
  )
    return `动作提示最多支持 ${MAX_PAUSE_NOTE} 个字符。`
  if (segment.kind !== 'speech') return null
  if (segment.text === undefined && segment.sourceMap === undefined)
    return validateSpeechSelection(segment, source, existing)
  if (
    typeof segment.text !== 'string' ||
    !countCharacters(segment.text) ||
    !Array.isArray(segment.sourceMap) ||
    segment.sourceMap.length !== segment.text.length ||
    ![segment.from, segment.to].every(Number.isSafeInteger) ||
    segment.from < 0 ||
    segment.from > segment.to ||
    segment.to > source.length
  )
    return '分段文字与原文关联无效。'
  let previous = -1
  for (let i = 0; i < segment.sourceMap.length; i++) {
    const index = segment.sourceMap[i]
    if (index === null) continue
    if (
      !Number.isSafeInteger(index) ||
      index <= previous ||
      index < 0 ||
      index >= source.length ||
      source[index] !== segment.text[i]
    )
      return '分段文字与原文关联无效。'
    previous = index
  }
  for (const range of speechRanges(segment)) {
    if (!boundary(source, range.from) || !boundary(source, range.to))
      return '原文关联不能拆分字符。'
    if (
      existing.some(
        (entry) =>
          entry.id !== segment.id &&
          entry.kind === 'speech' &&
          speechRanges(entry).some((other) => overlaps(range.from, range.to, other.from, other.to)),
      )
    )
      return '选区包含已分配的文字，请重新选择未分配的连续文字。'
  }
  return null
}

export function buildCues(segments: Segment[]): Cue[] {
  const cues: Cue[] = []
  let end = 0
  for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
    if (segment.start > end)
      cues.push({
        id: `gap-${segment.id}`,
        kind: 'pause',
        start: end,
        end: segment.start,
        automatic: true,
      })
    cues.push(segment)
    end = segment.end
  }
  return cues
}
export function cueAt(cues: Cue[], elapsed: number): Cue | undefined {
  return (
    cues.find((cue) => elapsed >= cue.start && elapsed < cue.end) ??
    (elapsed >= (cues.at(-1)?.end ?? 0) ? cues.at(-1) : undefined)
  )
}
export function sourceRuns(source: string, segments: Segment[]) {
  const assigned = segments
    .filter((s): s is Speech => s.kind === 'speech')
    .flatMap((segment) => speechRanges(segment).map((range) => ({ ...range, segment })))
    .sort((a, b) => a.from - b.from)
  const runs: { text: string; from: number; segment?: Speech }[] = []
  let cursor = 0
  for (const { from, to, segment } of assigned) {
    if (cursor < from) runs.push({ text: source.slice(cursor, from), from: cursor })
    runs.push({ text: source.slice(from, to), from, segment })
    cursor = to
  }
  if (cursor < source.length) runs.push({ text: source.slice(cursor), from: cursor })
  return runs
}

/** Edit spoken content without deleting the original manuscript or shifting other allocations. */
export function saveSpeechText(draft: Draft, segment: Speech, text: string): Draft {
  const problem = validateSegment(segment, draft.source, draft.segments)
  if (problem) throw new Error(problem)
  if (!countCharacters(text)) throw new Error('请填写本段需要朗读的文字。')
  const others = draft.segments.filter((entry) => entry.id !== segment.id)
  const totalLength = others.reduce(
    (total, entry) =>
      total + (entry.kind === 'speech' ? speechText(draft.source, entry).length : 0),
    text.length,
  )
  const original = draft.segments.find(
    (entry) => entry.id === segment.id && entry.kind === 'speech',
  ) as Speech | undefined
  if (totalLength > MAX_SCRIPT_LENGTH && (!original || text !== speechText(draft.source, original)))
    throw new Error('修改后台本超过 1 万字符，请删减后保存。')
  const map =
    segment.text === text && segment.sourceMap
      ? [...segment.sourceMap]
      : reconcileSourceMap(speechText(draft.source, segment), text, speechSourceMap(segment))
  const ranges = mappedSourceRanges(map)
  const { text: _oldText, sourceMap: _oldMap, ...base } = segment
  const from = ranges[0]?.from ?? 0,
    to = ranges.at(-1)?.to ?? 0
  const simple =
    ranges.length === 1 && to - from === text.length && draft.source.slice(from, to) === text
  const updated: Speech = { ...base, from, to, ...(!simple ? { text, sourceMap: map } : {}) }
  const updatedProblem = validateSegment(updated, draft.source, others)
  if (updatedProblem) throw new Error(updatedProblem)
  return { ...draft, segments: [...others, updated].sort((a, b) => a.start - b.start) }
}

/** A new paragraph can be written even when the existing source has no free ranges. */
export function appendSpeechText(
  draft: Draft,
  candidate: Pick<Speech, 'id' | 'kind' | 'start' | 'end'>,
  text: string,
): Draft {
  if (draft.segments.some((segment) => segment.id === candidate.id))
    throw new Error('该分段已经存在，请编辑原分段。')
  if (!countCharacters(text)) throw new Error('请填写本段需要朗读的文字。')
  const separator = draft.source ? '\n\n' : ''
  const source = draft.source + separator + text
  const spokenLength = draft.segments.reduce(
    (total, entry) =>
      total + (entry.kind === 'speech' ? speechText(draft.source, entry).length : 0),
    text.length,
  )
  if (source.length > MAX_SCRIPT_LENGTH || spokenLength > MAX_SCRIPT_LENGTH)
    throw new Error('添加后台本超过 1 万字符，请删减后保存。')
  const segment: Speech = {
    id: candidate.id,
    kind: 'speech',
    start: candidate.start,
    end: candidate.end,
    from: draft.source.length + separator.length,
    to: source.length,
  }
  const problem = validateSegment(segment, source, draft.segments)
  if (problem) throw new Error(problem)
  return {
    ...draft,
    source,
    segments: [...draft.segments, segment].sort((a, b) => a.start - b.start),
  }
}

/** Swap durations with their content, retaining every existing pause slot and total runtime. */
export function swapSegments(segments: Segment[], firstId: string, secondId: string): Segment[] {
  if (firstId === secondId) return segments
  const cues = buildCues(segments)
  const first = cues.findIndex((cue) => cue.id === firstId && !cue.automatic)
  const second = cues.findIndex((cue) => cue.id === secondId && !cue.automatic)
  if (first < 0 || second < 0) throw new Error('请选择两个已添加的分段进行交换。')
  ;[cues[first], cues[second]] = [cues[second], cues[first]]
  let position = 0
  const result: Segment[] = []
  for (const cue of cues) {
    const duration = cue.end - cue.start
    if (!cue.automatic) {
      const { automatic: _automatic, ...segment } = cue
      result.push({ ...segment, start: position, end: position + duration })
    }
    position += duration
  }
  return result
}

export const TEMPLATE =
  '[00:00-01:20]\n在这里填写开场台本。\n\n[01:20-01:40]\n在这里填写商品介绍。\n\n[02:00-02:30]\n在这里填写下一段台本。'
export function importScript(input: string): { source: string; segments: Segment[] } {
  const text = input.replace(/\r\n?/g, '\n').trim()
  if (!text || text.length > MAX_SCRIPT_LENGTH)
    throw new Error('请粘贴台本，单次最多支持 1 万字符。')
  const pattern = /^\[(\d{1,4}):([0-5]\d)\s*[-—–]\s*(\d{1,4}):([0-5]\d)\]\s*$/gm
  const matches = [...text.matchAll(pattern)]
  if (matches.length === 0) {
    if (/^\[\d.*[:：]/m.test(text))
      throw new Error('时间模板格式有误，请使用 [00:00-01:20]，秒数需为 00–59。')
    return { source: text, segments: [] }
  }
  if (text.slice(0, matches[0].index).trim())
    throw new Error('模板首段需以 [00:00-01:20] 这样的时间标记开始。')
  let source = ''
  const segments: Segment[] = []
  matches.forEach((match, index) => {
    const body = text
      .slice(match.index! + match[0].length, matches[index + 1]?.index ?? text.length)
      .trim()
    if (/^\[\d.*[:：]/m.test(body)) throw new Error('有一处时间标记格式有误，请检查模板。')
    const start = Number(match[1]) * 60 + Number(match[2])
    const end = Number(match[3]) * 60 + Number(match[4])
    const from = source.length
    source += body
    const segment: Segment = {
      id: `import-${index}`,
      kind: 'speech',
      start,
      end,
      from,
      to: source.length,
    }
    const error = validateSegment(segment, source, segments)
    if (error) throw new Error(`第 ${index + 1} 段：${error}`)
    segments.push(segment)
    source += '\n\n'
  })
  return { source: source.trimEnd(), segments }
}

export function parseDraft(raw: string, options: { allowLegacyLength?: boolean } = {}): Draft {
  const value = JSON.parse(raw) as Draft
  if (
    !value ||
    value.schema !== 1 ||
    typeof value.title !== 'string' ||
    value.title.length > 100 ||
    typeof value.source !== 'string' ||
    value.source.length > 200000 ||
    !Number.isFinite(value.rate) ||
    value.rate < 60 ||
    value.rate > 500 ||
    !Array.isArray(value.segments) ||
    value.segments.length > 2000
  )
    throw new Error('草稿格式无效')
  if (!options.allowLegacyLength && value.source.length > MAX_SCRIPT_LENGTH)
    throw new Error('台本超过 1 万字符，请拆分后再导入。')
  const seen = new Set<string>()
  for (const s of value.segments) {
    if (
      !s ||
      !['speech', 'pause'].includes(s.kind) ||
      typeof s.id !== 'string' ||
      !s.id ||
      seen.has(s.id) ||
      validateSegment(s, value.source, value.segments)
    )
      throw new Error('草稿分段无效')
    seen.add(s.id)
  }
  return { ...value, segments: [...value.segments].sort((a, b) => a.start - b.start) }
}

export function sampleDraft(): Draft {
  const blocks = [
    '大家好，欢迎来到我们的门店。今天带大家看看最近到店的新品，也聊聊选购时容易忽略的几个细节。',
    '我们从外观、手感和实际使用三个细节说起。',
    '先别急着只看价格，我们也可以结合自己的实际需要来比较。',
    '选购时，先看看产品拿在手里是否舒服，再试一试你每天最常用的功能。参数可以作为参考，但真正适合自己的，还是实际使用时的感受。如果有机会，建议到店亲自体验，再结合自己的预算做决定。我们也会把不同版本放在一起，方便大家对比，找到更适合自己的选择。',
    '接下来，还可以根据大家的问题，继续补充不同场景下的使用建议。',
    '欢迎到店体验，有问题也可以留言。',
  ]
  const source = blocks.join('\n\n')
  return {
    schema: 1,
    title: '门店新品介绍',
    source,
    rate: 220,
    segments: [
      { id: 'sample-1', kind: 'speech', start: 0, end: 80, from: 0, to: blocks[0].length },
      {
        id: 'sample-2',
        kind: 'speech',
        start: 80,
        end: 100,
        from: source.indexOf(blocks[1]),
        to: source.indexOf(blocks[1]) + blocks[1].length,
      },
      {
        id: 'sample-4',
        kind: 'speech',
        start: 120,
        end: 150,
        from: source.indexOf(blocks[5]),
        to: source.length,
      },
    ],
  }
}
