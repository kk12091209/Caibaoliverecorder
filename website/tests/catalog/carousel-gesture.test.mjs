import test from 'node:test'
import assert from 'node:assert/strict'
import { carouselGestureAxis, carouselHasDesktopControls, carouselSwipeDirection } from '../../src/features/catalog/lib/carousel-gesture.ts'

test('image edge controls are only enabled for a desktop with a fine hover pointer', () => {
  const desktop = { userAgent: 'Macintosh; Intel Mac OS X', maxTouchPoints: 0 }
  assert.equal(carouselHasDesktopControls(desktop, true), true)
  assert.equal(carouselHasDesktopControls(desktop, false), false)
  for (const userAgent of ['iPhone', 'iPad', 'Android', 'Macintosh; Intel Mac OS X']) {
    assert.equal(carouselHasDesktopControls({ userAgent, maxTouchPoints: 5 }, true), false)
  }
  // A Windows laptop with a touch screen can still use its desktop mouse.
  assert.equal(carouselHasDesktopControls({ userAgent: 'Windows NT 10.0', maxTouchPoints: 10 }, true), true)
})

test('swiping left advances and swiping right returns on phone and desktop widths', () => {
  for (const width of [272, 342, 661]) {
    assert.equal(carouselSwipeDirection(-120, 8, width), 1)
    assert.equal(carouselSwipeDirection(120, -8, width), -1)
  }
  assert.equal(carouselSwipeDirection(-40, 0, 272), 1)
  assert.equal(carouselSwipeDirection(-40, 0, 661), 0)
})

test('tap jitter and vertical or ambiguous diagonal page scrolling never turn a slide', () => {
  for (const [dx, dy] of [[0, 0], [6, 4], [-20, 0], [60, 150], [-150, -200], [80, 80]]) {
    assert.equal(carouselSwipeDirection(dx, dy, 342), 0)
  }
  assert.equal(carouselGestureAxis(3, 40), 'vertical')
  assert.equal(carouselGestureAxis(-40, 3), 'horizontal')
  assert.equal(carouselGestureAxis(20, 20), null)
})

test('zero-size frames and invalid pointer coordinates cannot cause an unintended turn', () => {
  for (const width of [0, -100, NaN, Infinity]) assert.equal(carouselSwipeDirection(-100, 0, width), 0)
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.equal(carouselSwipeDirection(invalid, 0, 342), 0)
    assert.equal(carouselSwipeDirection(-100, invalid, 342), 0)
  }
})
