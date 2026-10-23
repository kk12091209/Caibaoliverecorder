import test from 'node:test'
import assert from 'node:assert/strict'
import { appendSpeechText, validateSpeechSelection, buildCues, countCharacters, cueAt, formatTime, importScript, MAX_PAUSE_NOTE, MAX_SCRIPT_LENGTH, parseDraft, readingSeconds, recommendedCount, sampleDraft, saveSpeechText, speechText, sourceRuns, swapSegments, validateSegment } from '../../src/features/teleprompter/model/teleprompter.ts'

test('character guidance counts spoken letters and numbers, not punctuation or whitespace', () => {
  assert.equal(countCharacters('你好，世界！\n 123 👋'), 7)
  assert.equal(recommendedCount(30, 220), 110)
  assert.equal(recommendedCount(80, 180), 240)
  assert.equal(readingSeconds('你'.repeat(108), 220), 29)
})
test('selection rejects assigned text, touching ranges remain available, over-budget text is allowed', () => {
  const source = '一二三四五六七八九十'.repeat(30)
  const old = { id: 'old', kind: 'speech', start: 0, end: 10, from: 0, to: 10 }
  const next = { id: 'new', kind: 'speech', start: 10, end: 11, from: 10, to: 290 }
  assert.equal(validateSegment(next, source, [old]), null)
  assert.match(validateSegment({ ...next, from: 9 }, source, [old]), /已分配/)
  assert.match(validateSegment({ ...next, start: 9 }, source, [old]), /重叠/)
  assert.match(validateSegment({ ...next, end: 10 }, source, [old]), /起止时间/)
  assert.match(validateSegment({ ...next, to: source.length + 1 }, source, [old]), /选择/)
  assert.match(validateSegment({ ...next, from: .5 }, source, [old]), /选择/)
})
test('a range cannot split a Unicode surrogate pair', () => {
  const segment = { id: 'a', kind: 'speech', start: 0, end: 10, from: 1, to: 4 }
  assert.match(validateSegment(segment, '😀你好', []), /选择/)
  assert.equal(validateSegment({ ...segment, from: 0 }, '😀你好', []), null)
})
test('gaps become countdown cues, explicit pauses and half-open segment boundaries are preserved', () => {
  const cues = buildCues([{ id: 'b', kind: 'pause', start: 30, end: 40 }, { id: 'a', kind: 'speech', start: 5, end: 20, from: 0, to: 2 }])
  assert.deepEqual(cues.map(({ start, end, kind }) => [start, end, kind]), [[0, 5, 'pause'], [5, 20, 'speech'], [20, 30, 'pause'], [30, 40, 'pause']])
  assert.equal(cueAt(cues, 19.99)?.id, 'a')
  assert.equal(cueAt(cues, 20)?.automatic, true)
  assert.equal(cueAt(cues, 40)?.id, 'b')
  assert.equal(formatTime(80), '01:20')
})
test('template imports source ranges and leaves missing time as a pause, plain paste requires no template', () => {
  const parsed = importScript('[00:00-01:20]\n开场。\n\n[01:20-01:40]\n介绍。\n\n[02:00-02:30]\n收尾。')
  assert.equal(parsed.segments.length, 3)
  assert.equal(parsed.source.slice(parsed.segments[1].from, parsed.segments[1].to), '介绍。')
  assert.equal(buildCues(parsed.segments).filter((s) => s.kind === 'pause')[0].end, 120)
  assert.deepEqual(importScript('你好，\n这是普通台本。'), { source: '你好，\n这是普通台本。', segments: [] })
  assert.throws(() => importScript('[00:00-00:20]\n开场\n[00:15-00:30]\n冲突'), /重叠/)
  assert.throws(() => importScript('[00:60-01:20]\n错误'), /格式/)
  assert.throws(() => importScript('[00:00-01:20]\n'), /选择/)
})
test('source allocation preserves exact original positions including unallocated gaps', () => {
  const draft = sampleDraft()
  const runs = sourceRuns(draft.source, draft.segments)
  assert.equal(runs.map((r) => r.text).join(''), draft.source)
  for (const run of runs) assert.equal(draft.source.slice(run.from, run.from + run.text.length), run.text)
  assert.equal(runs.filter((r) => r.segment).length, 3)
  assert.equal(countCharacters(runs.find((r) => !r.segment && r.text.includes('选购时')).text.split('\n\n')[2]), 108)
})
test('restore validates all saved ranges, unique IDs, timing, rate and schema', () => {
  const draft = sampleDraft()
  assert.deepEqual(parseDraft(JSON.stringify(draft)), draft)
  for (const invalid of [null, { ...draft, schema: 2 }, { ...draft, rate: 0 }, { ...draft, segments: [draft.segments[0], draft.segments[0]] }, { ...draft, segments: [{ ...draft.segments[0], to: 999999 }] }, { ...draft, segments: [draft.segments[0], { ...draft.segments[1], start: 1 }] }]) {
    assert.throws(() => parseDraft(JSON.stringify(invalid)))
  }
})

test('annotating an automatic pause preserves the schedule, source allocation and note through draft restore', () => {
  const original = sampleDraft()
  const gap = buildCues(original.segments).find((cue) => cue.automatic)
  const pause = { id: gap.id, kind: 'pause', start: gap.start, end: gap.end, note: '拿起产品，展示侧面。\n看向镜头。' }
  assert.equal(validateSegment(pause, original.source, original.segments), null)
  const restored = parseDraft(JSON.stringify({ ...original, segments: [...original.segments, pause] }))
  const cues = buildCues(restored.segments)
  assert.equal(cues.length, buildCues(original.segments).length)
  assert.deepEqual(cues.map(({ start, end }) => [start, end]), buildCues(original.segments).map(({ start, end }) => [start, end]))
  assert.equal(cueAt(cues, gap.start).note, pause.note)
  assert.equal(cueAt(cues, gap.start).automatic, undefined)
  assert.deepEqual(restored.segments.filter((cue) => cue.kind === 'speech'), original.segments)
  assert.deepEqual(sourceRuns(restored.source, restored.segments), sourceRuns(original.source, original.segments))
  assert.equal(restored.source, original.source)
  assert.equal(countCharacters(restored.source), countCharacters(original.source))
})

test('pause notes are optional in old drafts and reject malformed or oversized content', () => {
  const draft = sampleDraft()
  const pause = { id: 'pause', kind: 'pause', start: 100, end: 120 }
  assert.equal(validateSegment(pause, draft.source, draft.segments), null)
  assert.equal(validateSegment({ ...pause, note: '' }, draft.source, draft.segments), null)
  assert.equal(validateSegment({ ...pause, note: '动'.repeat(MAX_PAUSE_NOTE) }, draft.source, draft.segments), null)
  assert.deepEqual(parseDraft(JSON.stringify({ ...draft, segments: [...draft.segments, pause] })).segments.find((s) => s.id === pause.id), pause)
  for (const note of [null, 123, {}, '动'.repeat(MAX_PAUSE_NOTE + 1)]) {
    assert.match(validateSegment({ ...pause, note }, draft.source, draft.segments), /动作提示/)
    assert.throws(() => parseDraft(JSON.stringify({ ...draft, segments: [...draft.segments, { ...pause, note }] })), /草稿分段/)
  }
})

test('long plain manuscripts preserve content and allocate ranges without changing earlier segments', () => {
  const text = '这是一份门店介绍台本，可以按自己的节奏安排内容。'.repeat(150)
  const draft = { schema: 1, title: '长台本', rate: 220, ...importScript(text) }
  assert.ok(draft.source.length > 2000)
  const first = { id: '1', kind: 'speech', start: 0, end: 60, from: 0, to: 220 }
  const second = { id: '2', kind: 'speech', start: 90, end: 150, from: 220, to: 440 }
  assert.equal(validateSegment(first, draft.source, []), null)
  assert.equal(validateSegment(second, draft.source, [first]), null)
  const restored = parseDraft(JSON.stringify({ ...draft, segments: [first, second] }))
  assert.deepEqual(restored.segments[0], first)
  assert.equal(restored.source, text)
  assert.equal(buildCues(restored.segments)[1].kind, 'pause')
})

test('new scripts and imported drafts enforce 10000 characters without discarding legacy browser drafts', () => {
  const source = '字'.repeat(MAX_SCRIPT_LENGTH)
  assert.equal(importScript(source).source, source)
  assert.throws(() => importScript(source + '字'), /1 万/)
  const draft = { schema: 1, title: '旧台本', source: source + '字', rate: 220, segments: [] }
  assert.throws(() => parseDraft(JSON.stringify(draft)), /1 万/)
  assert.deepEqual(parseDraft(JSON.stringify(draft), { allowLegacyLength: true }), draft)
})

test('editing spoken text preserves the original manuscript and every other allocated segment', () => {
  const draft = sampleDraft()
  const original = structuredClone(draft)
  for (const index of [0, 1, 2]) {
    const target = draft.segments[index]
    for (const text of ['改。', '这是一段重新修改的介绍，包含 emoji 😀 和换行。\n欢迎来到我们的门店。'.repeat(3)]) {
      const revised = saveSpeechText(draft, target, text)
      const edited = revised.segments.find((segment) => segment.id === target.id)
      assert.equal(speechText(revised.source, edited), text)
      assert.equal(revised.source, draft.source)
      for (const other of draft.segments.filter((segment) => segment.id !== target.id)) {
        const kept = revised.segments.find((segment) => segment.id === other.id)
        assert.equal(revised.source.slice(kept.from, kept.to), draft.source.slice(other.from, other.to))
        assert.equal(kept.start, other.start)
        assert.equal(kept.end, other.end)
      }
      assert.deepEqual(parseDraft(JSON.stringify(revised)), revised)
      assert.equal(sourceRuns(revised.source, revised.segments).map((run) => run.text).join(''), revised.source)
    }
  }
  assert.deepEqual(draft, original)
})

test('editing may reselect free source text but cannot steal another segment or save empty or oversized text', () => {
  const draft = sampleDraft()
  const target = draft.segments[0]
  const from = draft.source.indexOf('先别急着')
  const selected = { ...target, from, to: from + 12 }
  const updated = saveSpeechText(draft, selected, '重新选取的内容。')
  assert.ok(updated.source.startsWith(draft.source.slice(target.from, target.to)))
  assert.equal(speechText(updated.source, updated.segments[0]), '重新选取的内容。')
  assert.throws(() => saveSpeechText(draft, { ...target, from: draft.segments[1].from, to: draft.segments[1].to }, '错误'), /已分配/)
  assert.throws(() => saveSpeechText(draft, target, ' \n，。😀'), /朗读/)
  assert.throws(() => saveSpeechText(draft, target, '字'.repeat(MAX_SCRIPT_LENGTH)), /1 万/)
})

test('swapping moves durations with content, preserves all gaps and explicit notes, and is reversible', () => {
  const draft = sampleDraft()
  const explicit = { id: 'action', kind: 'pause', start: 100, end: 120, note: '拿起产品。' }
  const segments = [{ ...draft.segments[0], start: 5 }, draft.segments[1], explicit, draft.segments[2]]
  const snapshot = structuredClone(segments)
  for (const [first, second] of [['sample-1', 'sample-2'], ['sample-1', 'sample-4'], ['action', 'sample-1']]) {
    const reordered = swapSegments(segments, first, second)
    assert.equal(buildCues(reordered).at(-1).end, buildCues(segments).at(-1).end)
    assert.deepEqual(buildCues(reordered).filter((cue) => cue.automatic).map((cue) => cue.end - cue.start), buildCues(segments).filter((cue) => cue.automatic).map((cue) => cue.end - cue.start))
    for (const old of segments) {
      const current = reordered.find((cue) => cue.id === old.id)
      assert.equal(current.end - current.start, old.end - old.start)
      assert.equal(current.note, old.note)
      if (old.kind === 'speech') assert.equal(draft.source.slice(current.from, current.to), draft.source.slice(old.from, old.to))
      assert.equal(validateSegment(current, draft.source, reordered), null)
    }
    assert.deepEqual(swapSegments(reordered, first, second), segments)
  }
  assert.deepEqual(segments, snapshot)
  assert.equal(swapSegments(segments, 'sample-1', 'sample-1'), segments)
  assert.throws(() => swapSegments(segments, 'missing', 'sample-1'), /两个/)
  assert.throws(() => swapSegments(segments, 'gap-sample-1', 'sample-1'), /两个/)
})


test('a new paragraph appends after a fully allocated manuscript and preserves existing content and schedule', () => {
  const source = '原有的第一段。原有的第二段。'
  const draft = { schema: 1, title: '全部已分配', source, rate: 220, segments: [
    { id: 'a', kind: 'speech', start: 0, end: 10, from: 0, to: 8 },
    { id: 'b', kind: 'speech', start: 20, end: 30, from: 8, to: source.length },
  ] }
  const before = structuredClone(draft)
  const text = '这是新写的内容，并不来自之前的台本。'
  const revised = appendSpeechText(draft, { id: 'c', kind: 'speech', start: 30, end: 45 }, text)
  assert.equal(revised.source, source + '\n\n' + text)
  assert.deepEqual(revised.segments.slice(0, 2), draft.segments)
  const added = revised.segments.at(-1)
  assert.equal(revised.source.slice(added.from, added.to), text)
  assert.deepEqual(parseDraft(JSON.stringify(revised)), revised)
  assert.deepEqual(draft, before)
})

test('an empty manuscript supports direct composition and subsequent editing', () => {
  const draft = { schema: 1, title: '新台本', source: '', rate: 220, segments: [] }
  const revised = appendSpeechText(draft, { id: 'a', kind: 'speech', start: 0, end: 20 }, '新写的开场。')
  assert.equal(revised.source, '新写的开场。')
  assert.equal(revised.segments[0].from, 0)
  const edited = saveSpeechText(revised, { ...revised.segments[0], end: 30 }, '修改后的开场。')
  assert.equal(edited.source, revised.source)
  assert.equal(speechText(edited.source, edited.segments[0]), '修改后的开场。')
  assert.equal(edited.segments[0].end, 30)
  assert.deepEqual(parseDraft(JSON.stringify(edited)), edited)
})

test('appending rejects invalid text, duplicate IDs, overlapping times and the aggregate length including separators', () => {
  const draft = sampleDraft()
  const candidate = { id: 'new', kind: 'speech', start: 150, end: 180 }
  assert.throws(() => appendSpeechText(draft, candidate, ' \n，。😀'), /朗读/)
  assert.throws(() => appendSpeechText(draft, { ...candidate, id: draft.segments[0].id }, '重复。'), /已经存在/)
  assert.throws(() => appendSpeechText(draft, { ...candidate, start: 149 }, '冲突。'), /重叠/)
  assert.throws(() => appendSpeechText(draft, { ...candidate, end: 150 }, '无时长。'), /起止时间/)
  const available = MAX_SCRIPT_LENGTH - draft.source.length - 2
  const exact = appendSpeechText(draft, candidate, '字'.repeat(available))
  assert.equal(exact.source.length, MAX_SCRIPT_LENGTH)
  assert.deepEqual(parseDraft(JSON.stringify(exact)), exact)
  assert.throws(() => appendSpeechText(draft, candidate, '字'.repeat(available + 1)), /1 万/)
})

test('choosing source text is independent of unfinished time fields but still protects allocations', () => {
  const draft = sampleDraft()
  const from = draft.source.indexOf('选购时，先看看')
  assert.equal(validateSpeechSelection({ id: 'new', from, to: from + 10 }, draft.source, draft.segments), null)
  assert.match(validateSpeechSelection({ id: 'new', from: 0, to: 10 }, draft.source, draft.segments), /已分配/)
  assert.equal(validateSpeechSelection(draft.segments[0], draft.source, draft.segments), null)
})
