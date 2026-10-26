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

test('room changes abort pending work and do not send old queued messages', async () => {
  let lookupComplete
  const h = followHarness({ lookup: () => new Promise(resolve => { lookupComplete = resolve }) })
  selectThree(h); h.api.processRow(h.row('11', '旧房间文字')); h.api.processRow(h.row('22', '排队文字')); await h.tick()
  h.location.pathname = '/2002'; h.api.checkRoom()
  lookupComplete({ ok: true, json: async () => ({ code: 0, data: { room_id: 9001 } }) }); await h.tick(3000)
  assert.equal(h.posts.length, 0)
  assert.deepEqual(h.inspect().settings.targets, [])
  assert.equal(h.inspect().queued, 0)
})

for (const failure of [
  { name: 'API login refusal', response: () => ({ ok: true, json: async () => ({ code: -101, message: '请重新登录' }) }) },
  { name: 'API frequency refusal', response: () => ({ ok: true, json: async () => ({ code: 10031, message: '发送频率过高' }) }) },
  { name: 'HTTP refusal', response: () => ({ ok: false, status: 429 }) },
  { name: 'network failure', response: () => { throw new Error('network unavailable') } },
]) test(`${failure.name} skips one message and preserves the selected people and cooldown for the next`, async () => {
  const h = followHarness({ post: request => h.posts.length === 1 ? failure.response() : { ok: true, json: async () => ({ code: 0 }) } })
  selectThree(h); h.api.processRow(h.row('11', '失败的这一条')); await h.tick()
  assert.equal(h.posts.length, 1); assert.equal(h.inspect().pending, false)
  assert.deepEqual(h.inspect().settings.targets.map(p => p.uid), ['11', '22', '33'])
  assert.equal(h.inspect().settings.disabled, undefined); assert.match(h.inspect().lastDetail, /跟车保持开启/)
  h.api.processRow(h.row('22', '下一条符合规则')); await h.tick(1999)
  assert.equal(h.posts.length, 1)
  await h.tick(1); assert.equal(h.posts.length, 2)
  assert.deepEqual(h.posts.map(p => p.body.msg), ['失败的这一条', '下一条符合规则'])
  await h.tick(60000); assert.equal(h.posts.length, 2, 'Neither failed nor unacknowledged text is retried')
})

test('missing login never persists a stop; adding credentials lets the next new message send', async () => {
  for (const cookie of ['DedeUserID=99', '']) {
    const h = followHarness({ cookie }); h.api.begin({ uid: '11', name: '对象' })
    h.api.processRow(h.row('11', '未登录时的文字')); await h.tick()
    assert.equal(h.posts.length, 0); assert.equal(h.inspect().settings.disabled, undefined)
    assert.equal(h.inspect().settings.targets[0].uid, '11')
    h.document.cookie = 'DedeUserID=99; bili_jct=qa-token'
    h.api.processRow(h.row('11', '登录后的新文字')); await h.tick()
    assert.deepEqual(h.posts.map(p => p.body.msg), ['登录后的新文字'])
  }
})

test('missing acknowledgment releases one flight and allows the next queued message without disabling follow', async () => {
  const h = followHarness(); selectThree(h)
  h.api.processRow(h.row('11', '没有回显')); h.api.processRow(h.row('22', '下一条排队'))
  await h.tick(7999); assert.equal(h.posts.length, 1)
  await h.tick(1); assert.equal(h.posts.length, 2)
  assert.equal(h.inspect().settings.disabled, undefined)
  assert.deepEqual(h.inspect().settings.targets.map(p => p.uid), ['11', '22', '33'])
  h.api.processRow(h.row('99', '下一条排队', 'ack')); await h.tick()
  assert.equal(h.inspect().acknowledged, 1); assert.equal(h.inspect().pending, false)
  h.api.processRow(h.row('33', '后续仍可触发')); await h.tick(2000)
  assert.deepEqual(h.posts.map(p => p.body.msg), ['没有回显', '下一条排队', '后续仍可触发'])
})

test('a late response after timeout cannot finish or disable a newer flight', async () => {
  let finishOld
  const h = followHarness({ post: () => h.posts.length === 1 ? new Promise(resolve => { finishOld = resolve }) : { ok: true, json: async () => ({ code: 0 }) } })
  h.api.begin({ uid: '11', name: '对象' })
  h.api.processRow(h.row('11', '旧请求')); h.api.processRow(h.row('11', '新请求'))
  await h.tick(8000); assert.equal(h.posts.length, 2)
  finishOld({ ok: true, json: async () => ({ code: -101, message: '旧请求失败' }) }); await h.tick()
  assert.equal(h.inspect().pending, true)
  h.api.processRow(h.row('99', '新请求', 'ack')); await h.tick()
  assert.equal(h.inspect().acknowledged, 1); assert.equal(h.inspect().pending, false)
  assert.equal(h.inspect().settings.targets[0].uid, '11')
})

test('legacy disabled rooms restore their saved mode; whitelist identities are normalized and deduplicated', () => {
  const h = followHarness()
  const state = h.normalize({ target: { uid: 11, name: '旧对象' }, disabled: true, whitelist: [{ uid: 22, name: '名单用户' }, { uid: '22' }, { uid: '0' }, { uid: 'bad' }, { uid: '33', name: 'x'.repeat(200) }] })
  assert.deepEqual(state.targets, [{ uid: '11', name: '旧对象' }]); assert.equal(state.disabled, undefined)
  assert.deepEqual(state.whitelist.map(p => p.uid), ['22', '33']); assert.equal(state.whitelist[1].name.length, 120)
  assert.equal(h.normalize({ random: true, disabled: true }).random, true)
  assert.deepEqual(h.normalize('{').whitelist, [])
})

test('whitelist persists independently per room and supports removal and clearing without touching another room', () => {
  const h = followHarness()
  h.api.addWhitelist({ uid: '11', name: '第一房间' }); h.api.addWhitelist({ uid: '11', name: '重复' })
  h.api.addWhitelist({ uid: 'bad', name: '无效' }); assert.equal(h.inspect().settings.whitelist.length, 1)
  h.location.pathname = '/2002'; h.api.checkRoom()
  assert.deepEqual(h.inspect().settings.whitelist, [])
  h.api.addWhitelist({ uid: '22', name: '第二房间' })
  const secondSaved = h.saved.get('bcp.liveFollow.room.v2.2002')
  h.location.pathname = '/1001'; h.api.checkRoom()
  assert.deepEqual(h.inspect().settings.whitelist, [{ uid: '11', name: '第一房间' }])
  h.api.removeWhitelist('11'); assert.deepEqual(h.inspect().settings.whitelist, [])
  h.api.addWhitelist({ uid: '33', name: 'A' }); h.api.addWhitelist({ uid: '44', name: 'B' }); h.api.clearWhitelist()
  assert.deepEqual(h.inspect().settings.whitelist, []); assert.equal(h.saved.get('bcp.liveFollow.room.v2.2002'), secondSaved)
  assert.deepEqual(followHarness({ saved: h.saved, pathname: '/2002' }).inspect().settings.whitelist, [{ uid: '22', name: '第二房间' }])
  assert.deepEqual(followHarness({ saved: h.saved }).inspect().settings.whitelist, [])
})

test('whitelisted rows leave random ready for the next eligible person and do not consume a random trigger', async () => {
  const h = followHarness({ chat: true }); h.api.bindChat(); h.api.changeSettings({ random: true })
  h.api.addWhitelist({ uid: '11', name: '跳过此人' }); await h.tick(15000)
  assert.equal(h.inspect().randomReady, true)
  h.api.processRow(h.row('11', '不应该跟发')); await h.tick()
  assert.equal(h.posts.length, 0); assert.equal(h.inspect().randomReady, true)
  h.api.processRow(h.row('22', '可以跟发')); await h.tick()
  assert.deepEqual(h.posts.map(p => p.body.msg), ['可以跟发'])
  assert.equal(h.inspect().settings.random, true)
})

test('adding to whitelist cancels an unsubmitted random flight; stale room resolution cannot send it', async () => {
  let finishLookup
  const h = followHarness({ chat: true, lookup: () => new Promise(resolve => { finishLookup = resolve }) })
  h.api.bindChat(); h.api.changeSettings({ random: true }); await h.tick(15000)
  h.api.processRow(h.row('11', '解析期间加入白名单')); await h.tick()
  assert.equal(h.inspect().pending, true)
  h.api.addWhitelist({ uid: '11', name: '现在跳过' }); assert.equal(h.inspect().pending, false)
  finishLookup({ ok: true, json: async () => ({ code: 0, data: { room_id: 9001 } }) }); await h.tick()
  assert.equal(h.posts.length, 0); assert.equal(h.inspect().settings.random, true)
})

test('a newly whitelisted random message is removed from the queue without interrupting an already submitted request', async () => {
  const h = followHarness({ chat: true, random: () => 0 }); h.api.bindChat(); h.api.changeSettings({ random: true })
  await h.tick(15000); h.api.processRow(h.row('11', '正在等待回显')); await h.tick()
  assert.equal(h.posts.length, 1)
  // The deterministic six-second timer becomes ready while the first
  // request is still inside its eight-second acknowledgment window.
  await h.tick(6000)
  h.api.processRow(h.row('22', '等待期间的新弹幕'))
  assert.equal(h.inspect().queued, 1)
  h.api.addWhitelist({ uid: '22', name: '从此跳过' })
  assert.equal(h.inspect().queued, 0); assert.equal(h.inspect().pending, true)
  h.api.processRow(h.row('99', '正在等待回显', 'ack')); await h.tick(2000)
  assert.equal(h.posts.length, 1)
})

test('whitelist edits and remote changes leave explicitly selected people, pending requests and drafts intact', async () => {
  const h = followHarness(); h.api.begin({ uid: '11', name: '手动指定' })
  h.api.processRow(h.row('11', '第一条')); h.api.processRow(h.row('11', '第二条')); await h.tick()
  h.api.addWhitelist({ uid: '11', name: '仅过滤随机车' })
  assert.equal(h.inspect().pending, true); assert.equal(h.inspect().queued, 1)
  h.api.acceptSettings({ ...h.inspect().settings, whitelist: [{ uid: '11', name: '远程更新' }, { uid: '22', name: '另一个人' }] })
  assert.equal(h.inspect().pending, true); assert.equal(h.inspect().queued, 1)
  h.api.processRow(h.row('99', '第一条', 'ack')); await h.tick(2000)
  assert.deepEqual(h.posts.map(p => p.body.msg), ['第一条', '第二条'])
  assert.equal(h.input.value, '我正在输入的草稿'); assert.deepEqual(h.counters(), { inputWrites: 0, inputEvents: 0, clicks: 0 })
})

test('random follow stays on after a refused send and processes the next random trigger', async () => {
  const h = followHarness({ chat: true, post: () => h.posts.length === 1 ? { ok: true, json: async () => ({ code: 10031, message: '过于频繁' }) } : { ok: true, json: async () => ({ code: 0 }) } })
  h.api.bindChat(); h.api.changeSettings({ random: true }); await h.tick(15000)
  h.api.processRow(h.row('11', '本条被拒绝')); await h.tick()
  assert.equal(h.inspect().settings.random, true); assert.equal(h.inspect().pending, false)
  await h.tick(15000); h.api.processRow(h.row('22', '下一次随机触发')); await h.tick()
  assert.deepEqual(h.posts.map(p => p.body.msg), ['本条被拒绝', '下一次随机触发'])
})

test('the supplied script remains inert source text for the website and has installable metadata', () => {
  assert.ok(scriptSource.startsWith('// ==UserScript==\n'))
  assert.match(scriptSource, /^\/\/ @version\s+\d+\.\d+\.\d+\s*$/m)
  assert.match(scriptSource, /@homepageURL\s+https:\/\/greasyfork.org\/zh-CN\/scripts\/585978/)
  new Function(scriptSource)
})
