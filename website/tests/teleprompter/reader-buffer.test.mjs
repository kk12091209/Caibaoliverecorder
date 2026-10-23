import test from 'node:test'
import assert from 'node:assert/strict'
import { bufferedReadingOffset, horizontalReadingOffset, updateStripBuffer, STRIP_BUFFER_SECONDS } from '../../src/features/teleprompter/model/reading-progress.ts'

test('normal reading does not move halfway through a line and keeps the preceding line above the active line', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ start: i * 10, end: (i + 1) * 10, y: 12 + i * 58, height: 40 }))
  const anchor = 70
  for (const start of [0, 10, 20, 30]) {
    const offset = bufferedReadingOffset(rows, start, anchor)
    for (const fraction of [.1, .5, .999]) assert.equal(bufferedReadingOffset(rows, start + fraction * 10, anchor), offset)
    if (start >= 10) {
      const row = rows[start / 10]
      assert.equal(row.y - offset, anchor)
      assert.ok(rows[start / 10 - 1].y - offset >= 12)
    }
  }
  assert.equal(bufferedReadingOffset(rows, 50, anchor), bufferedReadingOffset(rows, 49.9, anchor))
})

test('horizontal reading keeps two read characters visible and never scrolls short text or beyond the final tail', () => {
  const font = 34
  const glyphs = Array.from({ length: 40 }, (_, i) => ({ x: font + i * font, width: font }))
  for (const progress of [5, 5.5, 15, 25]) {
    const offset = horizontalReadingOffset(glyphs, progress, 358, font * 42, font)
    const index = Math.floor(progress)
    assert.ok(glyphs[index - 2].x - offset >= font / 2)
    assert.ok(glyphs[index].x - offset < 358 - font)
  }
  assert.equal(horizontalReadingOffset(glyphs, 40, 358, font * 42, font), font * 42 - 358)
  assert.equal(horizontalReadingOffset(glyphs.slice(0, 2), 2, 358, font * 4, font), 0)
})

test('a natural segment boundary retains its predecessor for 1.5 active seconds while the new segment advances', () => {
  let state = updateStripBuffer(null, { index: 0, elapsed: 9.99, now: 1000, playing: true, revision: 0 })
  state = updateStripBuffer(state, { index: 1, elapsed: 10.01, now: 1020, playing: true, revision: 0 })
  assert.equal(state.holding, 0); assert.equal(state.remaining, STRIP_BUFFER_SECONDS)
  for (let i = 1; i <= 7; i++) state = updateStripBuffer(state, { index: 1, elapsed: 10.01 + i * .4, now: 1020 + i * 200, playing: true, revision: 0 })
  assert.equal(state.holding, 0)
  state = updateStripBuffer(state, { index: 1, elapsed: 13.01, now: 2520, playing: true, revision: 0 })
  assert.equal(state.holding, null)
  assert.equal(state.elapsed, 13.01) // No grace is inserted into the playback/recording timeline.
})

test('pausing freezes grace; seeks, jumps and restarting cannot leave a stale previous segment in the strip', () => {
  let state = updateStripBuffer(null, { index: 0, elapsed: 4.99, now: 0, playing: true, revision: 0 })
  state = updateStripBuffer(state, { index: 1, elapsed: 5, now: 10, playing: true, revision: 0 })
  state = updateStripBuffer(state, { index: 1, elapsed: 5.1, now: 110, playing: false, revision: 0 })
  const remaining = state.remaining
  state = updateStripBuffer(state, { index: 1, elapsed: 5.1, now: 50110, playing: false, revision: 0 })
  assert.equal(state.remaining, remaining)
  state = updateStripBuffer(state, { index: 1, elapsed: 5.1, now: 50210, playing: true, revision: 0 })
  assert.equal(state.remaining, remaining)
  for (const next of [{ index: 1, elapsed: 5.2, revision: 1 }, { index: 0, elapsed: 0, revision: 0 }, { index: 3, elapsed: 20, revision: 0 }]) {
    assert.equal(updateStripBuffer(state, { ...next, now: 50310, playing: true }).holding, null)
  }
})

test('very short segments replace the buffer with the immediate predecessor instead of piling up old text', () => {
  let state = updateStripBuffer(null, { index: 0, elapsed: .99, now: 0, playing: true, revision: 0 })
  state = updateStripBuffer(state, { index: 1, elapsed: 1.01, now: 20, playing: true, revision: 0 })
  state = updateStripBuffer(state, { index: 2, elapsed: 1.2, now: 200, playing: true, revision: 0 })
  assert.equal(state.holding, 1)
  assert.equal(state.index, 2)
})
