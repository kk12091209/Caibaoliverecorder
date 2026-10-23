import test from 'node:test'
import assert from 'node:assert/strict'
import { cameraConstraints, isMobileCameraDevice, requireLiveTracks } from '../../src/features/teleprompter/model/capture-media.ts'
import { selectionBoundaries, touchedRange } from '../../src/features/teleprompter/model/source-selection.ts'

test('front is preferred initially, explicit flip requires the requested physical facing', () => {
  assert.deepEqual(cameraConstraints('', 'user').facingMode, { ideal: 'user' })
  assert.deepEqual(cameraConstraints('', 'environment', true).facingMode, { exact: 'environment' })
  assert.deepEqual(cameraConstraints('', 'user', true).facingMode, { exact: 'user' })
  const camera = cameraConstraints('usb-camera', 'user')
  assert.deepEqual(camera.deviceId, { exact: 'usb-camera' })
  assert.equal(camera.facingMode, undefined)
})
test('mobile camera controls cover iPhone, Android and desktop-mode iPad, excluding laptops', () => {
  for (const userAgent of ['iPhone', 'iPad', 'Android Mobile']) assert.equal(isMobileCameraDevice({ userAgent, maxTouchPoints: 5 }), true)
  assert.equal(isMobileCameraDevice({ userAgent: 'Macintosh Safari', maxTouchPoints: 5 }), true)
  assert.equal(isMobileCameraDevice({ userAgent: 'Macintosh Safari', maxTouchPoints: 0 }), false)
  assert.equal(isMobileCameraDevice({ userAgent: 'Windows Chrome', maxTouchPoints: 10 }), false)
})
test('recording cannot proceed with missing, disabled or ended microphone tracks', () => {
  const stream = (tracks) => ({ getAudioTracks: () => tracks, getVideoTracks: () => [] })
  for (const tracks of [[], [{ readyState: 'ended', enabled: true }], [{ readyState: 'live', enabled: false }]]) assert.throws(() => requireLiveTracks(stream(tracks), 'audio'), /麦克风音轨/)
  assert.doesNotThrow(() => requireLiveTracks(stream([{ readyState: 'live', enabled: true }]), 'audio'))
  assert.throws(() => requireLiveTracks(stream([]), 'video'), /摄像头画面/)
})
test('touch immediately selects a character and drags in both directions', () => {
  const positions = selectionBoundaries('你好欢迎光临', 10)
  assert.deepEqual(touchedRange(positions, 11, 11), { from: 11, to: 12 })
  assert.deepEqual(touchedRange(positions, 11, 14), { from: 11, to: 15 })
  assert.deepEqual(touchedRange(positions, 14, 11), { from: 11, to: 15 })
})
test('touch ranges stop at assigned boundaries and never split emoji or combining marks', () => {
  const text = '你😀e\u0301好'
  const positions = selectionBoundaries(text, 5)
  assert.deepEqual(positions, [5, 6, 8, 10, 11])
  assert.deepEqual(touchedRange(positions, 7, 7), { from: 6, to: 8 })
  assert.deepEqual(touchedRange(positions, 9, 9), { from: 8, to: 10 })
  assert.deepEqual(touchedRange(positions, 7, -100), { from: 5, to: 8 })
  assert.deepEqual(touchedRange(positions, 7, 100), { from: 6, to: 11 })
})
