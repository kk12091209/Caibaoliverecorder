import test from 'node:test'
import assert from 'node:assert/strict'
import { RecordingSession, recordingExtension, recordingFilename, recordingMime, recordingNameIssue, recordingSaveName } from '../../src/features/teleprompter/model/recording.ts'
import { advanceTimeline, readingGlyphs } from '../../src/features/teleprompter/model/reading-progress.ts'

class Recorder {
  state = 'inactive'
  mimeType = 'video/webm'
  constructor() { this.stops = 0 }
  start() { this.state = 'recording' }
  pause() { this.state = 'paused' }
  resume() { this.state = 'recording' }
  stop() { this.stops++; this.state = 'inactive' }
  chunk(text) { this.ondataavailable?.({ data: new Blob([text], { type: this.mimeType }) }) }
  finish() { this.onstop?.() }
}
const setup = (extra = {}) => {
  const recorder = new Recorder()
  let now = 0
  let finished
  const session = new RecordingSession({}, 'video', { create: () => recorder, supported: () => false, now: () => now, finished: (result, error) => { finished = { result, error } }, ...extra })
  return { recorder, session, time: (value) => { now = value }, finished: () => finished }
}
test('recorder includes the last dataavailable after stop and deduplicates stop calls', async () => {
  const { recorder, session, time } = setup()
  session.start(); recorder.chunk('first'); time(2000)
  const pending = session.stop(); const repeated = session.stop()
  assert.equal(recorder.stops, 1)
  assert.equal(pending, repeated)
  recorder.chunk('last'); recorder.finish()
  const result = await pending
  assert.equal(await result.blob.text(), 'firstlast')
  assert.equal(result.duration, 2)
  assert.equal(session.status, 'ready')
})
test('pause/resume excludes the paused interval, preserves chunks and supports stopping while paused', async () => {
  const { recorder, session, time } = setup()
  session.start(); time(1000); session.pause(); time(10000)
  assert.equal(session.elapsed, 1)
  session.resume(); time(12000); session.pause()
  assert.equal(session.elapsed, 3)
  const pending = session.stop(); recorder.chunk('data'); recorder.finish()
  assert.equal((await pending).duration, 3)
})
test('native recording error waits for browser final data rather than dropping it', async () => {
  const { recorder, session, time } = setup()
  session.start(); time(1000); recorder.state = 'inactive'; recorder.onerror()
  assert.equal(session.status, 'stopping')
  recorder.chunk('salvaged-final-data'); recorder.finish()
  const result = await session.stop()
  assert.equal(await result.blob.text(), 'salvaged-final-data')
  assert.match(result.warning, /中断/)
})
test('automatic track end, buffer cutoff, zero data, and disposed sessions are handled', async () => {
  const first = setup(); first.session.start(); first.time(1500); first.recorder.chunk('x'); first.recorder.state = 'inactive'; first.recorder.finish()
  assert.equal(first.finished().result.duration, 1.5)
  const limited = setup({ limit: 3 }); limited.session.start(); limited.recorder.chunk('123'); limited.recorder.chunk('final'); limited.recorder.finish()
  assert.match(limited.finished().result.warning, /缓冲/)
  const empty = setup(); empty.session.start(); const p = empty.session.stop(); empty.recorder.finish(); assert.equal(await p, null)
  const disposed = setup(); disposed.session.start(); const pending = disposed.session.stop(); disposed.session.dispose(); disposed.recorder.chunk('ignored'); disposed.recorder.finish(); assert.equal(await pending, null)
})
test('actual MIME determines extension and unsupported preferred types fall back safely', () => {
  assert.equal(recordingMime('video', (s) => s === 'video/webm'), 'video/webm')
  assert.equal(recordingMime('audio', () => false), '')
  assert.equal(recordingExtension('audio/mp4;codecs=mp4a.40.2', 'audio'), 'm4a')
  assert.equal(recordingExtension('video/webm', 'video'), 'webm')
  assert.equal(recordingFilename('a/b:test', '2026-10-16T00:00:00.000Z'), 'a_b_test-20261016000000')
})
test('saving requires a user filename and preserves it without timestamp or duplicate extension', () => {
  assert.match(recordingNameIssue(''), /填写/)
  for (const invalid of ['../test', 'CON', 'aux.mp4', 'name.', '.mp4', 'a:b']) assert.notEqual(recordingNameIssue(invalid), '')
  assert.equal(recordingSaveName('我的口播教程', 'mp4'), '我的口播教程.mp4')
  assert.equal(recordingSaveName('我的口播教程.MP4', 'mp4'), '我的口播教程.mp4')
  assert.equal(recordingSaveName('我的口播教程.mp4', 'm4a', '-音频'), '我的口播教程-音频.m4a')
  assert.throws(() => recordingSaveName(' ', 'mp4'), /填写/)
})
test('live pace changes advance continuously; planned pauses keep their intended seconds', () => {
  const cues = [{ kind: 'speech', id: 'a', start: 0, end: 10, from: 0, to: 10 }, { kind: 'pause', id: 'p', start: 10, end: 15 }, { kind: 'speech', id: 'b', start: 15, end: 25, from: 10, to: 20 }]
  assert.equal(advanceTimeline(cues, 0, 2, 1), 2)
  assert.equal(advanceTimeline(cues, 2, 2, 2), 6)
  assert.equal(advanceTimeline(cues, 6, 2, .5), 7)
  assert.equal(advanceTimeline(cues, 8, 4, 2), 13)
  assert.equal(advanceTimeline(cues, 13, 4, 2), 19)
  assert.equal(advanceTimeline(cues, 19, 100, 1), 25)
  assert.deepEqual(readingGlyphs('你😀e\u0301好'), ['你', '😀', 'e\u0301', '好'])
})
