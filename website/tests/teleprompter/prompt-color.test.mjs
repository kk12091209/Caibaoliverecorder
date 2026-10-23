import test from 'node:test'
import assert from 'node:assert/strict'
import { hexToHsv, hexToRgb, hsvToHex, normalizeHex, rgbToHex, saturationValueAt } from '../../src/features/teleprompter/model/prompt-color.ts'

test('HEX input accepts shorthand and canonical colors but rejects CSS and malformed input', () => {
  assert.equal(normalizeHex(' #FcA '), '#ffccaa')
  assert.equal(normalizeHex('Eeb8C3'), '#eeb8c3')
  for (const value of ['', '#', '#12', '#12345g', '#12345678', 'red', 'url(x)', null, 123]) assert.equal(normalizeHex(value), null)
})

test('the hue strip covers every primary and secondary color and closes the red endpoint', () => {
  for (const [h, expected] of [[0, '#ff0000'], [60, '#ffff00'], [120, '#00ff00'], [180, '#00ffff'], [240, '#0000ff'], [300, '#ff00ff'], [360, '#ff0000']]) {
    assert.equal(hsvToHex({ h, s: 1, v: 1 }), expected)
  }
  assert.equal(hsvToHex({ h: 240, s: 0, v: 1 }), '#ffffff')
  assert.equal(hsvToHex({ h: 240, s: 1, v: 0 }), '#000000')
  assert.equal(hexToHsv('#ffffff', 210).h, 210)
  assert.equal(hexToHsv('#000000', 120).h, 120)
})

test('precise RGB and HSV entry preserve colors, including near-black and near-white values', () => {
  for (const color of ['#000000', '#ffffff', '#808080', '#fefdfc', '#010203', '#4a2432', '#c34433', '#fedcba', '#123456']) {
    assert.equal(rgbToHex(hexToRgb(color)), color)
    assert.equal(hsvToHex(hexToHsv(color)), color)
  }
  assert.equal(rgbToHex([-10, 100.6, 999]), '#0065ff')
})

test('dragging beyond the color square stays at its edges on desktop and phone', () => {
  for (const [width, height] of [[498, 240], [324, 210]]) {
    assert.deepEqual(saturationValueAt(0, 0, width, height), { s: 0, v: 1 })
    assert.deepEqual(saturationValueAt(width, height, width, height), { s: 1, v: 0 })
    assert.deepEqual(saturationValueAt(width / 2, height / 2, width, height), { s: .5, v: .5 })
    assert.deepEqual(saturationValueAt(-100, height + 100, width, height), { s: 0, v: 0 })
  }
  assert.deepEqual(saturationValueAt(NaN, Infinity, 0, 0), { s: 0, v: 1 })
})
