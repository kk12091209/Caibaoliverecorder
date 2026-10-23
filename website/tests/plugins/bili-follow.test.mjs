import test from 'node:test'
import assert from 'node:assert/strict'
import { followHarness, scriptSource } from '../helpers/bili-follow-harness.mjs'

const selectThree = h => ['11', '22', '33'].forEach(uid => h.api.begin({ uid, name: `用户 ${uid}` }))

test('legacy single-person settings migrate; invalid, duplicate and fourth targets are rejected', () => {
  const h = followHarness()
  assert.deepEqual(h.normalize({ target: { uid: 11, name: '旧对象' }, random: true }).targets, [{ uid: '11', name: '旧对象' }])
  const normalized = h.normalize({ targets: [{ uid: '11' }, { uid: '11' }, { uid: '0' }, { uid: 'bad' }, { uid: '22' }, { uid: '33' }, { uid: '44' }], random: true })
  assert.deepEqual(normalized.targets.map(p => p.uid), ['11', '22', '33'])
  assert.equal(normalized.random, false)
  selectThree(h); h.api.begin({ uid: '44', name: '第四人' })
  assert.deepEqual(h.inspect().settings.targets.map(p => p.uid), ['11', '22', '33'])
  assert.match(h.inspect().lastDetail, /最多同时跟车 3 人/)
  h.api.removeTarget('22')
  assert.deepEqual(h.inspect().settings.targets.map(p => p.uid), ['11', '33'])
  h.api.begin({ uid: '44', name: '替补' })
  assert.deepEqual(h.inspect().settings.targets.map(p => p.uid), ['11', '33', '44'])
  const restored = h.normalize([...h.saved.values()].at(-1))
  assert.deepEqual(restored.targets.map(p => p.uid), ['11', '33', '44'])
})

test('all three people are followed in order with shared cooldown and canonical short-room resolution', async () => {
  const h = followHarness(); selectThree(h)
  h.api.processRow(h.row('11', '第一条')); h.api.processRow(h.row('22', '第二条')); h.api.processRow(h.row('33', '第三条'))
  await h.tick()
  assert.equal(h.posts.length, 1)
  h.api.processRow(h.row('99', '第一条', 'ack-1')); await h.tick(1999)
  assert.equal(h.posts.length, 1)
  await h.tick(1); assert.equal(h.posts.length, 2)
  h.api.processRow(h.row('99', '第二条', 'ack-2')); await h.tick(2000)
  assert.deepEqual(h.posts.map(p => p.body.msg), ['第一条', '第二条', '第三条'])
  assert.deepEqual(h.posts.map(p => p.at), [100000, 102000, 104000])
  assert.equal(h.lookups.length, 1)
  assert.ok(h.posts.every(p => p.body.roomid === '9001' && p.init.credentials === 'include' && p.body.csrf === 'qa-token'))
  assert.equal(h.inspect().queued, 0)
})

test('focused drafts, selection and ongoing edits remain untouched during asynchronous automatic sending', async () => {
  let complete
  const h = followHarness({ post: () => new Promise(resolve => { complete = resolve }) })
  h.api.begin({ uid: '11', name: '对象' }); h.api.processRow(h.row('11', '自动跟发的文字')); await h.tick()
  assert.equal(h.posts.length, 1)
  assert.equal(h.input.value, '我正在输入的草稿')
  h.input.value = '我继续输入，还没发送'
  const before = h.counters()
  complete({ ok: true, json: async () => ({ code: 0 }) }); await h.tick()
  h.api.processRow(h.row('99', '自动跟发的文字', 'ack')); await h.tick()
  assert.equal(h.input.value, '我继续输入，还没发送')
  assert.equal(h.document.activeElement, h.input)
  assert.deepEqual([h.input.selectionStart, h.input.selectionEnd, h.input.selectionDirection], [3, 5, 'backward'])
  assert.deepEqual(h.counters(), before)
  assert.deepEqual(before, { inputWrites: 1, inputEvents: 0, clicks: 0 })
})

test('duplicates and self messages never generate extra requests', async () => {
  const h = followHarness(); selectThree(h)
  h.api.processRow(h.row('11', '相同内容', 'first')); h.api.processRow(h.row('22', '相同内容', 'duplicate'))
  h.api.processRow(h.row('99', '我自己的文字', 'own')); await h.tick()
  h.api.processRow(h.row('99', '相同内容', 'ack')); await h.tick(2000)
  h.api.processRow(h.row('33', '相同内容', 'later')); await h.tick()
  assert.equal(h.posts.length, 1)
  h.api.begin({ uid: '99', name: '自己' }); assert.equal(h.inspect().settings.targets.length, 3)
})

test('cancel, room changes and disable abort pending work and do not send old queued messages', async () => {
  let lookupComplete
  const h = followHarness({ lookup: () => new Promise(resolve => { lookupComplete = resolve }) })
  selectThree(h); h.api.processRow(h.row('11', '旧房间文字')); h.api.processRow(h.row('22', '排队文字')); await h.tick()
  h.location.pathname = '/2002'; h.api.checkRoom()
  lookupComplete({ ok: true, json: async () => ({ code: 0, data: { room_id: 9001 } }) }); await h.tick(3000)
  assert.equal(h.posts.length, 0)
  assert.deepEqual(h.inspect().settings.targets, [])
  assert.equal(h.inspect().queued, 0)
})

test('API refusal and missing login stop safely without retries; acknowledgment timeout clears the queue', async () => {
  const denied = followHarness({ post: async () => ({ ok: true, json: async () => ({ code: -101, message: '请重新登录' }) }) })
  selectThree(denied); denied.api.processRow(denied.row('11', '失败')); await denied.tick(20000)
  assert.equal(denied.posts.length, 1); assert.equal(denied.inspect().settings.disabled, true)
  assert.match(denied.inspect().lastDetail, /请重新登录/)
  const noCookie = followHarness({ cookie: 'DedeUserID=99' }); noCookie.api.begin({ uid: '11', name: '对象' }); noCookie.api.processRow(noCookie.row('11', '文字')); await noCookie.tick()
  assert.equal(noCookie.posts.length, 0); assert.equal(noCookie.inspect().settings.disabled, true)
  const timed = followHarness(); selectThree(timed); timed.api.processRow(timed.row('11', '没有回显')); timed.api.processRow(timed.row('22', '排队')); await timed.tick(8000)
  assert.equal(timed.inspect().settings.disabled, true); assert.equal(timed.inspect().queued, 0)
  await timed.tick(60000); assert.equal(timed.posts.length, 1)
})

test('the supplied script remains inert source text for the website and has installable metadata', () => {
  assert.ok(scriptSource.startsWith('// ==UserScript==\n'))
  assert.match(scriptSource, /^\/\/ @version\s+\d+\.\d+\.\d+\s*$/m)
  assert.match(scriptSource, /@homepageURL\s+https:\/\/greasyfork.org\/zh-CN\/scripts\/585978/)
  new Function(scriptSource)
})
