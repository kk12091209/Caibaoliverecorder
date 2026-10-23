import test from 'node:test'
import assert from 'node:assert/strict'
import { clampPromptRect, defaultAppearance, parseAppearance, PROMPT_THEMES, promptBackground, promptTextMetrics, fitPromptRect, resolvePromptTheme } from '../../src/features/teleprompter/model/prompt-style.ts'

test('dragging and resizing never move the prompt outside its stage, including corrupt numeric inputs', () => {
  for (const x of [-100, 0, .4, 1, NaN, Infinity]) for (const y of [-10, .5, 10]) for (const width of [-1, .5, 100, NaN]) {
    const rect = clampPromptRect({ x, y, width, height: y })
    assert.ok(rect.width >= .3 && rect.height >= .12)
    assert.ok(rect.x >= 0 && rect.y >= 0)
    assert.ok(rect.x + rect.width <= 1.000001 && rect.y + rect.height <= 1.000001)
    assert.ok(Object.values(rect).every(Number.isFinite))
    // The same normalized layout remains contained on desktop and narrow phones.
    for (const stage of [{ width: 814, height: 540 }, { width: 288, height: 520 }]) {
      assert.ok((rect.x + rect.width) * stage.width <= stage.width + .001)
      assert.ok((rect.y + rect.height) * stage.height <= stage.height + .001)
    }
  }
})

test('appearance persistence restores all settings and safely recovers malformed or out-of-range values', () => {
  const settings = { font: 56, textOpacity: 65, backgroundOpacity: 30, theme: 'ink-blue', narrow: true, stripY: .6, rect: { x: .1, y: .2, width: .7, height: .4 } }
  assert.deepEqual(parseAppearance(JSON.stringify(settings)), settings)
  assert.deepEqual(parseAppearance(null), defaultAppearance())
  assert.deepEqual(parseAppearance('{broken'), defaultAppearance())
  const bounded = parseAppearance(JSON.stringify({ font: 10000, textOpacity: -1, backgroundOpacity: 500, theme: 'unknown', rect: { x: 1, width: 1, y: -9, height: 1 } }))
  assert.equal(bounded.font, 72); assert.equal(bounded.textOpacity, 0); assert.equal(bounded.backgroundOpacity, 100)
  assert.equal(bounded.theme, 'caibao'); assert.deepEqual(bounded.rect, { x: 0, y: 0, width: 1, height: 1 })
})

test('custom reading colors survive reloads and preset switching without replacing legacy preferences', () => {
  const customColors = { unread: '#123456', read: '#fedcba', background: '#fafafa' }
  const custom = { ...defaultAppearance(), theme: 'custom', customColors }
  assert.deepEqual(parseAppearance(JSON.stringify(custom)), custom)
  assert.equal(resolvePromptTheme(custom).read, customColors.read)
  const preset = parseAppearance(JSON.stringify({ ...custom, theme: 'yellow' }))
  assert.equal(resolvePromptTheme(preset).read, '#ffdc59')
  assert.deepEqual(preset.customColors, customColors)
  assert.equal(resolvePromptTheme({ ...preset, theme: 'custom' }).background, '#fafafa')
  assert.equal(parseAppearance(JSON.stringify({ theme: 'pink', backgroundOpacity: 30 })).theme, 'pink')
  assert.equal(resolvePromptTheme(defaultAppearance()).id, 'caibao')
})

test('malformed stored custom colors recover safely; valid short hex colors are normalized', () => {
  for (const customColors of [null, [], {}, { unread: '#fff', read: 'url(https://bad)', background: '#000' }]) {
    const result = parseAppearance(JSON.stringify({ theme: 'custom', customColors }))
    assert.equal(result.theme, 'caibao')
    assert.equal(result.customColors, undefined)
  }
  const valid = parseAppearance(JSON.stringify({ theme: 'custom', customColors: { unread: '#ABC', read: '123456', background: ' #FfeEfF ' } }))
  assert.deepEqual(valid.customColors, { unread: '#aabbcc', read: '#123456', background: '#ffeeff' })
})

test('every KTV preset has distinct unread/read colors and a valid adjustable backing color', () => {
  assert.equal(new Set(PROMPT_THEMES.map((theme) => theme.id)).size, PROMPT_THEMES.length)
  for (const theme of PROMPT_THEMES) {
    assert.notEqual(theme.unread, theme.read)
    for (const color of [theme.unread, theme.read, theme.background]) assert.match(color, /^#[a-f0-9]{6}$/i)
    assert.match(promptBackground(theme.background, 30), /^rgba\(\d+, \d+, \d+, 0.3\)$/)
    assert.match(promptBackground(theme.background, -10), /, 0\)$/)
    assert.match(promptBackground(theme.background, 150), /, 1\)$/)
  }
})


test('frames preserve the chosen font and complete rows at every supported font size on desktop and phone', () => {
  for (const stage of [{ width: 720, height: 440 }, { width: 358, height: 410 }, { width: 288, height: 410 }]) {
    for (const font of [16, 34, 56, 72]) {
      const metrics = promptTextMetrics(font)
      const wide = fitPromptRect({ x: .9, y: .95, width: .3, height: .12 }, stage, font, false)
      const strip = fitPromptRect({ x: .9, y: .95, width: .3, height: .12 }, stage, font, true)
      assert.equal(metrics.font, font)
      assert.ok(wide.height * stage.height >= metrics.lineHeight * 3 + metrics.padding * 2)
      assert.equal(strip.width, 1); assert.equal(strip.x, 0)
      assert.ok(Math.abs(strip.height * stage.height - metrics.stripHeight) < .001)
      for (const rect of [wide, strip]) {
        assert.ok(rect.x >= 0 && rect.y >= 0)
        assert.ok(rect.x + rect.width <= 1.000001 && rect.y + rect.height <= 1.000001)
      }
    }
  }
})

test('narrow mode ignores requested width and height, keeps its position bounded, and does not overwrite the normal frame', () => {
  const settings = { ...defaultAppearance(), rect: { x: .1, y: .2, width: .7, height: .7 }, narrow: true, stripY: .4 }
  const restored = parseAppearance(JSON.stringify(settings))
  const stage = { width: 720, height: 440 }
  for (const width of [.3, .8, 1]) for (const height of [.12, .5, 1]) {
    const strip = fitPromptRect({ width, height, x: .4, y: restored.stripY }, stage, restored.font, true)
    assert.equal(strip.width, 1); assert.equal(strip.height * stage.height, promptTextMetrics(restored.font).stripHeight)
  }
  assert.deepEqual(fitPromptRect(restored.rect, stage, restored.font, false), settings.rect)
  assert.deepEqual(restored.rect, settings.rect)
  const legacy = parseAppearance(JSON.stringify({ font: 34, rect: { height: .12 } }))
  assert.equal(legacy.narrow, false)
  assert.ok(fitPromptRect(legacy.rect, stage, legacy.font, false).height * stage.height >= promptTextMetrics(34).normalMinHeight)
})
