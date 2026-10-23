import test from 'node:test'
import assert from 'node:assert/strict'
import { followHarness } from '../helpers/bili-follow-harness.mjs'

const plain = value => JSON.parse(JSON.stringify(value))
const inspect = h => JSON.parse(h.api.inspectCover())
const original = { x: 80, y: 60, width: 160, height: 90 }

test('cover escapes a low video wrapper into the player shared with independent camera layers', () => {
  const h = followHarness({ getComputedStyle: element => ({ position: element.position || 'static' }) })
  const player = { position: 'relative' }
  const wrapper = { position: 'relative', parentElement: player }
  const video = { parentElement: wrapper, closest: () => player }
  assert.equal(h.api.coverContainer(video), player)
  // A fullscreen video wrapper must keep its overlay inside the fullscreen subtree.
  h.document.fullscreenElement = { contains: element => element === wrapper || element === video }
  assert.equal(h.api.coverContainer(video), wrapper)
  wrapper.position = 'static'
  assert.equal(h.api.coverContainer(video), null)
  h.document.fullscreenElement = { contains: () => true }
  assert.equal(h.api.coverContainer(video), player)
})

test('unrecognized players keep their existing positioned container instead of a page-wide overlay', () => {
  const h = followHarness({ getComputedStyle: element => ({ position: element.position || 'static' }) })
  h.document.body = {}; h.document.documentElement = {}
  const host = { position: 'relative', parentElement: h.document.body }
  const wrapper = { parentElement: host }
  assert.equal(h.api.coverContainer({ parentElement: wrapper, closest: () => null }), host)
  assert.equal(h.api.coverContainer({ position: 'absolute', parentElement: h.document.body, closest: () => null }), null)
})

test('all eight resize handles stay within the picture without flipping or shrinking below the usable minimum', () => {
  const { api } = followHarness()
  for (const edge of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    for (const dx of [-10000, -200, 0, 200, 10000]) for (const dy of [-10000, -200, 0, 200, 10000]) {
      const r = api.dragCoverRect(original, edge, dx, dy, 640, 360)
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= 640 && r.y + r.height <= 360, `${edge}: bounded`)
      assert.ok(r.width >= 24 && r.height >= 24, `${edge}: minimum`)
      if (!edge.includes('e') && !edge.includes('w')) assert.deepEqual([r.x, r.width], [original.x, original.width])
      if (!edge.includes('n') && !edge.includes('s')) assert.deepEqual([r.y, r.height], [original.y, original.height])
      if (edge.includes('w')) assert.equal(r.x + r.width, original.x + original.width)
      if (edge.includes('n')) assert.equal(r.y + r.height, original.y + original.height)
    }
  }
})

test('drag clamps at all edges; video resize and very small picture sizes remain bounded', () => {
  const { api } = followHarness()
  assert.deepEqual(plain(api.dragCoverRect(original, 'move', 10000, -10000, 640, 360)), { x: 480, y: 0, width: 160, height: 90 })
  assert.deepEqual(plain(api.dragCoverRect(original, 'move', -10000, 10000, 640, 360)), { x: 0, y: 270, width: 160, height: 90 })
  assert.deepEqual(plain(api.fitCoverRect(original, 12, 8)), { x: 0, y: 0, width: 12, height: 8 })
  assert.deepEqual(plain(api.fitCoverRect({ x: NaN, y: Infinity, width: Infinity, height: NaN }, 0, 0)), { x: 0, y: 0, width: 0, height: 0 })
})

test('portrait and landscape streams use the actual contained picture, including object position', () => {
  const { api } = followHarness()
  assert.deepEqual(plain(api.coverPictureBox(640, 360, 1080, 1920, 'contain')), { x: 218.75, y: 0, width: 202.5, height: 360 })
  assert.deepEqual(plain(api.coverPictureBox(360, 640, 1920, 1080, 'contain', '50% 0%')), { x: 0, y: 0, width: 360, height: 202.5 })
  assert.deepEqual(plain(api.coverPictureBox(640, 360, 1080, 1920, 'cover')), { x: 0, y: 0, width: 640, height: 360 })
  assert.deepEqual(plain(api.coverPictureBox(640, 360, 0, 0, 'contain')), { x: 0, y: 0, width: 640, height: 360 })
})

function imageHarness() {
  const images = [], created = [], revoked = []
  class TestImage {
    constructor() { images.push(this); this.naturalWidth = 800; this.naturalHeight = 600 }
    set src(value) { this.url = value }
  }
  const h = followHarness({ Image: TestImage, URL: {
    createObjectURL(file) { const url = `blob:local-${created.length}`; created.push({ file, url }); return url },
    revokeObjectURL(url) { revoked.push(url) },
  } })
  const file = name => ({ name, type: 'image/png', size: 500 })
  return { h, images, created, revoked, file }
}

test('local image validation rejects unsupported and oversized files without losing the active image', async () => {
  const { h, images, created, revoked, file } = imageHarness()
  const first = h.api.chooseCoverFile(file('first.png')); images[0].onload(); await first
  assert.equal(inspect(h).image, 'blob:local-0')
  await h.api.chooseCoverFile({ ...file('bad.svg'), type: 'image/svg+xml' })
  await h.api.chooseCoverFile({ ...file('large.png'), size: 21 * 1024 * 1024 })
  assert.equal(created.length, 1); assert.equal(inspect(h).image, 'blob:local-0')
  const invalid = h.api.chooseCoverFile(file('broken.png')); images[1].onerror(); await invalid
  assert.equal(inspect(h).image, 'blob:local-0'); assert.deepEqual(revoked, ['blob:local-1'])
  const huge = h.api.chooseCoverFile(file('huge.png')); images[2].naturalWidth = 10000; images[2].naturalHeight = 10000; images[2].onload(); await huge
  assert.equal(inspect(h).image, 'blob:local-0'); assert.ok(revoked.includes('blob:local-2'))
})

test('newer file selection wins a decode race; replacing with a solid color revokes local images', async () => {
  const { h, images, revoked, file } = imageHarness()
  const first = h.api.chooseCoverFile(file('slow.png')), second = h.api.chooseCoverFile(file('latest.png'))
  images[1].onload(); await second
  images[0].onload(); await first
  assert.equal(inspect(h).name, 'latest.png'); assert.equal(inspect(h).image, 'blob:local-1')
  assert.deepEqual(revoked, ['blob:local-0'])
  h.api.chooseCoverColor('#ffffff')
  assert.equal(inspect(h).image, ''); assert.equal(inspect(h).color, '#ffffff')
  assert.ok(revoked.includes('blob:local-1'))
})

test('room changes cancel in-flight image selection and do not leak image or rectangle to another room', async () => {
  const { h, images, revoked, file } = imageHarness()
  const first = h.api.chooseCoverFile(file('old-room.png'))
  h.location.pathname = '/2002'; h.api.checkRoom()
  images[0].onload(); await first
  assert.equal(inspect(h).image, ''); assert.equal(inspect(h).enabled, false)
  assert.deepEqual(revoked, ['blob:local-0'])
})

test('cover color and image operations do not reset the independent follow queue or touch the draft', async () => {
  const { h, images, file } = imageHarness()
  h.api.begin({ uid: '11', name: 'A' }); h.api.processRow(h.row('11', '第一条')); h.api.processRow(h.row('11', '第二条'))
  await h.tick()
  const before = h.inspect()
  const image = h.api.chooseCoverFile(file('cover.png')); images[0].onload(); await image
  h.api.chooseCoverColor('#2563eb')
  assert.equal(h.inspect().queued, before.queued); assert.equal(h.inspect().pending, before.pending)
  h.api.processRow(h.row('99', '第一条', 'ack')); await h.tick(2000)
  assert.deepEqual(h.posts.map(p => p.body.msg), ['第一条', '第二条'])
  assert.equal(h.input.value, '我正在输入的草稿'); assert.deepEqual(h.counters(), { inputWrites: 0, inputEvents: 0, clicks: 0 })
})

test('only follow settings persist per room; a new page never restores an image, color or enabled cover', async () => {
  const { h, images, file } = imageHarness()
  h.api.begin({ uid: '11', name: 'A' })
  const before = [...h.saved.entries()]
  const image = h.api.chooseCoverFile(file('temporary.png')); images[0].onload(); await image
  h.api.chooseCoverColor('#2563eb')
  assert.deepEqual([...h.saved.entries()], before)
  const reopened = followHarness({ saved: h.saved })
  assert.deepEqual(reopened.inspect().settings.targets, [{ uid: '11', name: 'A' }])
  assert.equal(inspect(reopened).enabled, false)
  assert.equal(inspect(reopened).image, '')
  assert.equal(inspect(reopened).color, '#000000')
  assert.equal(inspect(reopened).locked, false)
})
