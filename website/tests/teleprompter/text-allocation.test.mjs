import test from 'node:test'
import assert from 'node:assert/strict'
import { allocatedCharacterCount, parseDraft, saveSpeechText, sourceRuns, speechSourceMap, speechText, validateSpeechSelection, validateSegment } from '../../src/features/teleprompter/model/teleprompter.ts'
import { reconcileSourceMap, sourceMapForRange } from '../../src/features/teleprompter/model/text-allocation.ts'

const makeDraft = (source) => ({ schema: 1, title: '', source, rate: 220, segments: [{ id: 'first', kind: 'speech', start: 0, end: 30, from: 0, to: source.length }] })
const available = (draft) => sourceRuns(draft.source, draft.segments).filter((run) => !run.segment && run.text.length).map((run) => ({ from: run.from, to: run.from + run.text.length, text: run.text }))

test('200 original characters shortened to 100 releases the deleted half for the second segment', () => {
  const source = '甲'.repeat(100) + '乙'.repeat(100)
  const draft = makeDraft(source)
  const saved = saveSpeechText(draft, draft.segments[0], source.slice(0, 100))
  assert.equal(saved.source, source)
  assert.equal(allocatedCharacterCount(saved), 100)
  assert.deepEqual(available(saved), [{ from: 100, to: 200, text: '乙'.repeat(100) }])
  const second = { id: 'second', kind: 'speech', start: 30, end: 60, from: 100, to: 200 }
  assert.equal(validateSpeechSelection(second, saved.source, saved.segments), null)
  const reused = saveSpeechText(saved, second, source.slice(100))
  assert.equal(reused.source, source)
  assert.equal(allocatedCharacterCount(reused), 200)
  assert.equal(speechText(reused.source, reused.segments[1]), '乙'.repeat(100))
})

test('deleting the beginning or middle releases the actual original positions, not a length-sized tail', () => {
  const source = '甲'.repeat(50) + '乙'.repeat(100) + '丙'.repeat(50)
  for (const [text, ranges] of [
    [source.slice(100), [{ from: 0, to: 100, text: source.slice(0, 100) }]],
    [source.slice(0, 50) + source.slice(150), [{ from: 50, to: 150, text: '乙'.repeat(100) }]],
  ]) {
    const draft = makeDraft(source)
    const saved = saveSpeechText(draft, draft.segments[0], text)
    assert.equal(saved.source, source)
    assert.deepEqual(available(saved), ranges)
    assert.equal(speechText(saved.source, saved.segments[0]), text)
    assert.equal(allocatedCharacterCount(saved), 100)
    assert.deepEqual(parseDraft(JSON.stringify(saved)), saved)
  }
})

test('repeated words follow the actual backward and forward delete positions', () => {
  const source = '甲'.repeat(200)
  for (const [inputType, removed] of [['deleteContentBackward', 99], ['deleteContentForward', 100]]) {
    const draft = makeDraft(source), text = source.slice(1)
    const map = reconcileSourceMap(source, text, sourceMapForRange(0, 200), { start: 100, end: 100, inputType })
    const saved = saveSpeechText(draft, { ...draft.segments[0], text, sourceMap: map }, text)
    assert.deepEqual(available(saved), [{ from: removed, to: removed + 1, text: '甲' }])
    assert.equal(allocatedCharacterCount(saved), 199)
  }
})

test('later edits keep released text available without stealing it back from another segment', () => {
  const draft = makeDraft('甲乙丙丁戊己庚辛壬癸')
  const first = saveSpeechText(draft, draft.segments[0], '甲丁戊己庚辛壬癸')
  const second = saveSpeechText(first, { id: 'second', kind: 'speech', start: 30, end: 40, from: 1, to: 3 }, '乙丙')
  const saved = saveSpeechText(second, second.segments[0], '甲戊己庚辛壬癸')
  assert.equal(saved.source, draft.source)
  assert.deepEqual(saved.segments[1], second.segments[1])
  assert.deepEqual(available(saved), [{ from: 3, to: 4, text: '丁' }])
  assert.match(validateSpeechSelection({ id: 'third', from: 1, to: 3 }, saved.source, saved.segments), /已分配/)
  assert.equal(validateSpeechSelection({ id: 'third', from: 3, to: 4 }, saved.source, saved.segments), null)
})

test('newly typed words and Unicode edits do not erase or split the original source', () => {
  const source = '甲😀乙e\u0301丙', draft = makeDraft(source)
  const saved = saveSpeechText(draft, draft.segments[0], '甲乙丙')
  assert.equal(saved.source, source)
  assert.deepEqual(available(saved), [{ from: 1, to: 3, text: '😀' }, { from: 4, to: 6, text: 'e\u0301' }])
  assert.deepEqual(parseDraft(JSON.stringify(saved)), saved)
  const replaced = saveSpeechText(draft, draft.segments[0], '全新内容')
  assert.equal(replaced.source, source)
  assert.equal(speechText(replaced.source, replaced.segments[0]), '全新内容')
  assert.equal(allocatedCharacterCount(replaced), 0)
  assert.deepEqual(available(replaced), [{ from: 0, to: source.length, text: source }])
  const again = saveSpeechText(replaced, replaced.segments[0], '新内容')
  assert.deepEqual(speechSourceMap(again.segments[0]), [null, null, null])
})

test('invalid provenance cannot claim other content, duplicate positions or overlap another segment', () => {
  const draft = makeDraft('甲乙丙丁')
  for (const sourceMap of [[0, 0], [1, 0], [0, 99], [0], [null, '1']]) {
    const invalid = { ...draft.segments[0], text: '甲乙', sourceMap }
    assert.ok(validateSegment(invalid, draft.source, []))
    assert.throws(() => parseDraft(JSON.stringify({ ...draft, segments: [invalid] })))
  }
  const first = saveSpeechText(draft, draft.segments[0], '甲丁')
  const overlapping = { id: 'second', kind: 'speech', start: 30, end: 40, from: 0, to: 1, text: '甲', sourceMap: [0] }
  assert.match(validateSegment(overlapping, first.source, first.segments), /已分配/)
})
