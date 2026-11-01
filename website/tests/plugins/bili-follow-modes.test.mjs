import test from 'node:test'
import assert from 'node:assert/strict'
import { followHarness } from '../helpers/bili-follow-harness.mjs'

const person = h => h.api.begin({uid: '11', name: '锁定用户'})
const historyRow = (uid, text, timeline = '2026-10-28 12:00:01') => ({uid, text, timeline})
const historyResponse = room => ({ok: true, json: async () => ({code: 0, data: {room}})})
const translation = (request, text) => request.onload({status: 200, responseText: JSON.stringify([[[text]]])})

for (const auxiliaries of [
  {externalEnabled: true}, {foreignEnabled: true}, {externalEnabled: true, foreignEnabled: true},
]) test(`auxiliary switches ${JSON.stringify(auxiliaries)} never read, translate or send without a primary mode`, async () => {
  const h = followHarness({chat: true}); h.api.bindChat(); person(h)
  h.api.changeSettings({externalRoom: '3003', ...auxiliaries})
  h.api.processRow(h.row('11', '已经锁定但主模式未开启')); await h.tick(60000)
  assert.equal(h.posts.length, 0); assert.equal(h.histories.length, 0); assert.equal(h.translations.length, 0)
  assert.equal(h.inspect().queued, 0); assert.equal(h.inspect().randomReady, false)
})

for (const mode of ['target', 'local-random', 'external-random']) {
  for (const foreignEnabled of [false, true]) test(`${mode}, translation ${foreignEnabled}: short messages are ineligible; three digits qualify`, async () => {
    let rows = []
    const h = followHarness({chat: true, random: () => 0, history: () => historyResponse(rows)})
    h.api.bindChat(); person(h)
    h.api.changeSettings({foreignEnabled, targetEnabled: mode === 'target', random: mode !== 'target',
      externalEnabled: mode === 'external-random', externalRoom: '3003'})
    if (mode !== 'target') await h.tick(6000)
    const short = ['', 'a', '12', '你好', '1 2', ' \t\n ', '😀😀😀', '你😀好', 'e\u0301e\u0301', '𠮷𠮷']
    if (mode === 'external-random') {
      rows = short.map((text, index) => historyRow(11, text, String(index)))
      await h.tick(6000)
    } else {
      for (let i = 0; i < short.length; i++) h.api.processRow(h.row('11', short[i], `short-${i}`))
      await h.tick()
      if (mode === 'local-random') assert.equal(h.inspect().randomReady, true, 'Short messages do not consume a random opportunity')
    }
    assert.equal(h.posts.length, 0); assert.equal(h.translations.length, 0)
    assert.equal(h.inspect().queued, 0); assert.equal(h.inspect().pending, false)
    if (mode === 'external-random') {rows.push(historyRow(11, '123')); await h.tick(6000)}
    else {h.api.processRow(h.row('11', '123')); await h.tick()}
    assert.deepEqual(h.posts.map(p => p.body.msg), [foreignEnabled ? 'Hello' : '123'])
    assert.equal(h.translations.length, foreignEnabled ? 1 : 0)
  })
}

test('three Chinese characters and three full Unicode characters pass the minimum in selected-user mode', async () => {
  for (const text of ['你好呀', '𠮷𠮷𠮷', 'e\u0301e\u0301e\u0301']) {
    const h = followHarness(); person(h); h.api.toggleTarget()
    h.api.processRow(h.row('11', text)); await h.tick()
    assert.equal(h.posts[0]?.body.msg, text)
  }
})

for (const translated of ['Hi', '你好', '1 2', '😀😀😀', '123']) test(`translated output ${translated} must also contain three visible characters`, async () => {
  const h = followHarness({translate: request => {queueMicrotask(() => translation(request, translated)); return {abort() {}}}})
  person(h); h.api.toggleTarget(); h.api.changeSettings({foreignEnabled: true})
  h.api.processRow(h.row('11', '原文超过三个字')); await h.tick()
  assert.equal(h.translations.length, 1)
  assert.deepEqual(h.posts.map(p => p.body.msg), translated === '123' ? ['123'] : [])
})

for (const [random, interval] of [[0, 6000], [.999999, 15000]]) test(`external reads follow the ${interval}ms random cycle and choose only one current eligible message`, async () => {
  let rows = [historyRow(11, '连接前的历史')]
  const h = followHarness({random: () => random, history: () => historyResponse(rows)})
  h.api.changeSettings({random: true, externalEnabled: true, externalRoom: '3003'}); await h.tick()
  assert.equal(h.histories.length, 1, 'Activation takes one baseline only')
  rows.push(historyRow(11, '旧一点的合格弹幕'), historyRow(22, '123'), historyRow(33, '太短'), historyRow(99, '自己的弹幕'))
  await h.tick(interval - 1); assert.equal(h.histories.length, 1); assert.equal(h.posts.length, 0)
  await h.tick(1)
  assert.deepEqual(h.posts.map(p => p.body.msg), ['123']); assert.equal(h.histories.length, 2)
  assert.equal(h.inspect().queued, 0)
  h.api.processRow(h.row('99', '123', 'ack')); await h.tick(interval)
  assert.equal(h.histories.length, 3); assert.equal(h.posts.length, 1, 'Other messages in the previous snapshot are never backfilled')
  assert.deepEqual(h.histories.map(p => p.at), [100000, 100000 + interval, 100000 + interval * 2])
})

test('the five-second sending cooldown survives mode switches and applies to translated sends', async () => {
  const h = followHarness(); person(h); h.api.toggleTarget()
  h.api.processRow(h.row('11', '第一条')); await h.tick()
  h.api.processRow(h.row('99', '第一条', 'ack1')); await h.tick(1000)
  h.api.toggleTarget(); h.api.toggleTarget(); h.api.processRow(h.row('11', '第二条'))
  await h.tick(3999); assert.equal(h.posts.length, 1)
  await h.tick(1); assert.equal(h.posts.length, 2)
  h.api.processRow(h.row('99', '第二条', 'ack2')); h.api.changeSettings({foreignEnabled: true})
  h.api.processRow(h.row('11', '翻译之后发送')); await h.tick(4999)
  assert.equal(h.translations.length, 0); assert.equal(h.posts.length, 2)
  await h.tick(1)
  assert.deepEqual(h.posts.map(p => p.at), [100000, 105000, 110000])
  assert.equal(h.posts[2].body.msg, 'Hello')
})

test('locking three users and upgrading old settings cannot send until the independent switch is enabled', async () => {
  const saved = new Map([['bcp.liveFollow.room.v2.1001', JSON.stringify({targets: [{uid: '11'}]})]])
  const h = followHarness({saved})
  h.api.begin({uid: '22', name: '第二人'}); h.api.begin({uid: '33', name: '第三人'})
  h.api.processRow(h.row('11', '开关未开启')); await h.tick(20000)
  assert.equal(h.posts.length, 0); assert.equal(h.inspect().settings.targetEnabled, false)
  h.api.toggleTarget(); h.api.processRow(h.row('22', '开启后新弹幕')); await h.tick()
  assert.deepEqual(h.posts.map(p => p.body.msg), ['开启后新弹幕'])
  h.api.processRow(h.row('33', '还未发送的队列')); h.api.toggleTarget(); await h.tick(20000)
  assert.equal(h.posts.length, 1); assert.equal(h.inspect().queued, 0)
  assert.deepEqual(h.inspect().settings.targets.map(p => p.uid), ['11', '22', '33'])
  h.api.toggleTarget(); await h.tick(20000)
  assert.equal(h.posts.length, 1, 'Re-enabling never replays previously observed messages')
  h.api.processRow(h.row('33', '重新开启后的新弹幕')); await h.tick()
  assert.equal(h.posts.length, 2)
})

test('mode switches are mutually exclusive while locked users survive random mode', async () => {
  const h = followHarness({chat: true}); h.api.bindChat(); person(h)
  h.api.toggleRandom(); h.api.toggleTarget()
  assert.equal(h.inspect().settings.random, true); assert.equal(h.inspect().settings.targetEnabled, false)
  h.api.toggleRandom(); h.api.toggleTarget(); h.api.toggleRandom()
  assert.equal(h.inspect().settings.targetEnabled, true); assert.equal(h.inspect().settings.random, false)
  h.api.changeSettings({externalRoom: '3003'}); h.api.toggleExternal()
  assert.equal(h.inspect().settings.externalEnabled, false)
  h.api.toggleTarget(); h.api.toggleExternal(); h.api.toggleTarget()
  assert.equal(h.inspect().settings.externalEnabled, true); assert.equal(h.inspect().settings.targetEnabled, false)
  h.api.toggleRandom(); await h.tick(15000)
  assert.equal(h.inspect().settings.targets[0].uid, '11')
  h.api.toggleRandom(); h.api.toggleExternal(); h.api.toggleTarget()
  assert.equal(h.inspect().settings.targetEnabled, true)
  h.api.removeTarget('11'); assert.equal(h.inspect().settings.targetEnabled, false)
})

test('external room validation canonicalizes short ids and rejects the current room and unrelated links', async () => {
  const h = followHarness()
  assert.equal(h.api.parseExternalRoom(' https://live.bilibili.com/blanc/3003?from=search '), '3003')
  for (const input of ['0', '-3', 'abc', 'https://example.com/3003', 'https://live.bilibili.com.evil.test/3003', 'https://live.bilibili.com/3003/foo', 'https://me@live.bilibili.com/3003']) {
    await assert.rejects(h.api.setExternalRoom(input), /请输入正确/)
  }
  await assert.rejects(h.api.setExternalRoom('1001'), /当前直播间/)
  assert.equal(await h.api.setExternalRoom('https://live.bilibili.com/3003'), true)
  assert.equal(h.inspect().settings.externalRoom, '3003')
  assert.equal(h.inspect().settings.externalEnabled, false); assert.equal(h.histories.length, 0)
  await h.api.setExternalRoom('4004')
  assert.equal(h.inspect().settings.externalRoom, '4004', 'Only one external room is saved')
  const controller = new AbortController(); controller.abort()
  assert.equal(await h.api.setExternalRoom('5005', controller.signal), false)
  assert.equal(h.inspect().settings.externalRoom, '4004')
})

for (const order of ['external-first', 'random-first']) test(`${order}: both switches are required; external reads never change the destination room`, async () => {
  let rows = [historyRow(11, '连接前的历史')]
  const h = followHarness({chat: true, random: () => 0, history: () => historyResponse(rows)})
  h.api.bindChat(); h.api.changeSettings({externalRoom: '3003'})
  if (order === 'external-first') {
    h.api.toggleExternal(); await h.tick(10000); assert.equal(h.histories.length, 0)
    h.api.toggleRandom()
  } else {
    h.api.toggleRandom(); await h.tick(1000); assert.equal(h.histories.length, 0)
    h.api.toggleExternal()
  }
  await h.tick(6000); assert.equal(h.posts.length, 0)
  assert.equal(h.inspect().externalReady, true)
  h.api.processRow(h.row('22', '外地车开启时的本地弹幕')); await h.tick()
  assert.equal(h.posts.length, 0)
  rows = [...rows, historyRow(22, '外地直播间的新弹幕')]; await h.tick(6000)
  assert.deepEqual(h.posts.map(p => p.body.msg), ['外地直播间的新弹幕'])
  assert.equal(h.posts[0].body.roomid, '9001')
  assert.ok(h.histories.every(p => new URL(p.url).searchParams.get('roomid') === '3003'))
  h.api.processRow(h.row('99', '外地直播间的新弹幕', 'ack')); await h.tick(3000)
  assert.equal(h.posts.length, 1, 'Overlapping history windows are deduplicated')
  h.api.toggleExternal(); const reads = h.histories.length; await h.tick(6000)
  h.api.processRow(h.row('33', '恢复本直播间后新弹幕')); await h.tick()
  assert.deepEqual(h.posts.map(p => p.body.msg), ['外地直播间的新弹幕', '恢复本直播间后新弹幕'])
  assert.equal(h.histories.length, reads)
})

test('external whitelist, self messages and empty emoji do not produce extra sends', async () => {
  let rows = []
  const h = followHarness({random: () => 0, history: () => historyResponse(rows)})
  h.api.changeSettings({random: true, externalEnabled: true, externalRoom: '3003'})
  h.api.addWhitelist({uid: '11', name: '跳过'})
  await h.tick(6000)
  rows = [historyRow(11, '白名单'), historyRow(99, '自己的弹幕'), historyRow(22, '可以跟发')]
  await h.tick(6000)
  assert.deepEqual(h.posts.map(p => p.body.msg), ['可以跟发'])
})

test('failed external reads never fall back to local messages; reconnect baselines history', async () => {
  let rows = [], failed = false
  const h = followHarness({chat: true, random: () => 0, history: () => failed ? {ok: false, status: 403} : historyResponse(rows)})
  h.api.bindChat(); h.api.changeSettings({random: true, externalEnabled: true, externalRoom: '3003'})
  await h.tick(6000); failed = true; await h.tick(6000)
  assert.equal(h.inspect().externalReady, false); assert.match(h.inspect().externalStatus, /读取失败/)
  h.api.processRow(h.row('11', '不可退回本地')); await h.tick()
  assert.equal(h.posts.length, 0)
  failed = false; rows = [historyRow(11, '断线期间历史')]; await h.tick(6000)
  assert.equal(h.inspect().externalReady, true); assert.equal(h.posts.length, 0)
  rows.push(historyRow(22, '重连后的新弹幕')); await h.tick(6000)
  assert.deepEqual(h.posts.map(p => p.body.msg), ['重连后的新弹幕'])
})

test('old external responses and in-flight translations cannot leak across source switches', async () => {
  let finishOld
  const h = followHarness({chat: true, random: () => 0, history: () => new Promise(resolve => {finishOld = resolve})})
  h.api.bindChat(); h.api.changeSettings({random: true, externalEnabled: true, externalRoom: '3003'}); await h.tick()
  const oldSignal = h.histories[0].init.signal
  h.api.toggleExternal(); assert.equal(oldSignal.aborted, true)
  finishOld(historyResponse([historyRow(11, '过期来源')])); await h.tick(6000)
  assert.equal(h.inspect().externalReady, false); assert.equal(h.histories.length, 1)
  h.api.processRow(h.row('22', '当前本地来源')); await h.tick()
  assert.deepEqual(h.posts.map(p => p.body.msg), ['当前本地来源'])
})

test('closing external car cancels its unfinished translation before resuming translated local messages', async () => {
  let rows = [], request, aborted = 0
  const h = followHarness({chat: true, random: () => 0, history: () => historyResponse(rows),
    translate: value => {request = value; return {abort() {aborted++}}}})
  h.api.bindChat(); h.api.changeSettings({random: true, externalEnabled: true, externalRoom: '3003', foreignEnabled: true})
  await h.tick(6000); rows = [historyRow(11, '正在翻译的外地弹幕')]; await h.tick(6000)
  const old = request; assert.ok(old)
  h.api.toggleExternal(); translation(old, 'Stale external message'); await h.tick(6000)
  assert.equal(aborted, 1); assert.equal(h.posts.length, 0)
  h.api.processRow(h.row('22', '新的本地弹幕')); await h.tick()
  translation(request, 'Current local message'); await h.tick()
  assert.deepEqual(h.posts.map(p => p.body.msg), ['Current local message'])
  assert.equal(h.posts[0].body.roomid, '9001')
})

for (const language of ['en', 'ja', 'ko']) test(`foreign car translates selected messages to ${language}, acknowledges translated echo and preserves drafts`, async () => {
  const expected = {en: 'Hello', ja: 'こんにちは', ko: '안녕하세요'}[language]
  const h = followHarness({translate: request => {queueMicrotask(() => translation(request, expected)); return {abort() {}}}})
  person(h); h.api.toggleTarget(); h.api.changeSettings({foreignEnabled: true, language})
  h.api.processRow(h.row('11', '你好呀')); await h.tick()
  assert.deepEqual(h.posts.map(p => p.body.msg), [expected])
  const request = h.translations[0], url = new URL(request.url)
  assert.equal(url.searchParams.get('tl'), language); assert.equal(url.searchParams.get('q'), '你好呀')
  assert.equal(request.anonymous, true)
  h.api.processRow(h.row('99', expected, 'translated-ack')); await h.tick()
  assert.equal(h.inspect().acknowledged, 1)
  assert.equal(h.input.value, '我正在输入的草稿'); assert.deepEqual(h.counters(), {inputWrites: 0, inputEvents: 0, clicks: 0})
})

test('foreign car alone never sends and composes with both local and external random sources', async () => {
  let rows = []
  const h = followHarness({chat: true, random: () => 0, history: () => historyResponse(rows)})
  h.api.bindChat(); h.api.changeSettings({foreignEnabled: true}); h.api.processRow(h.row('11', '仅翻译开关')); await h.tick(15000)
  assert.equal(h.translations.length, 0)
  h.api.toggleRandom(); await h.tick(6000); h.api.processRow(h.row('11', '本地翻译')); await h.tick()
  assert.deepEqual(h.posts.map(p => p.body.msg), ['Hello'])
  h.api.processRow(h.row('99', 'Hello', 'ack')); await h.tick(16000)
  h.api.changeSettings({externalRoom: '3003', externalEnabled: true}); await h.tick(6000)
  rows = [historyRow(22, '外地翻译')]; await h.tick(6000)
  assert.deepEqual(h.posts.map(p => p.body.msg), ['Hello', 'Hello'])
})

for (const action of ['disable', 'language', 'room', 'stop-target', 'storage']) test(`late translation after ${action} cannot send`, async () => {
  let request, aborted = 0
  const h = followHarness({translate: value => {request = value; return {abort() {aborted++}}}})
  person(h); h.api.toggleTarget(); h.api.changeSettings({foreignEnabled: true})
  h.api.processRow(h.row('11', '翻译尚未完成')); await h.tick()
  if (action === 'disable') h.api.changeSettings({foreignEnabled: false})
  if (action === 'language') h.api.changeSettings({language: 'ja'})
  if (action === 'room') {h.location.pathname = '/2002'; h.api.checkRoom()}
  if (action === 'stop-target') h.api.toggleTarget()
  if (action === 'storage') h.api.acceptSettings({...h.inspect().settings, language: 'ko'})
  translation(request, 'Late result'); await h.tick(20000)
  assert.equal(aborted, 1); assert.equal(h.posts.length, 0); assert.equal(h.inspect().pending, false)
})

for (const failure of ['network', 'timeout', 'invalid', 'long', 'permission', '429']) test(`translation ${failure} skips the message without sending its original text`, async () => {
  const h = followHarness({noTranslator: failure === 'permission', translate: request => {
    queueMicrotask(() => {
      if (failure === 'network') request.onerror()
      if (failure === 'invalid') request.onload({status: 200, responseText: '{}'})
      if (failure === 'long') translation(request, 'x'.repeat(101))
      if (failure === '429') request.onload({status: 429})
    })
    return {abort() {}}
  }})
  person(h); h.api.toggleTarget(); h.api.changeSettings({foreignEnabled: true})
  h.api.processRow(h.row('11', '绝不能降级发原文')); await h.tick(6000)
  assert.equal(h.posts.length, 0); assert.equal(h.inspect().pending, false)
  assert.equal(h.inspect().settings.targetEnabled, true); assert.match(h.inspect().lastDetail, /已跳过/)
  if (failure === '429') {
    h.api.processRow(h.row('11', '限流期间新弹幕')); await h.tick()
    assert.equal(h.translations.length, 1)
  }
})

test('translation cache avoids repeated lookups; language changes and disabling foreign mode affect only new messages', async () => {
  const h = followHarness({translate: request => {
    queueMicrotask(() => translation(request, new URL(request.url).searchParams.get('tl') === 'en' ? 'Hello' : 'こんにちは'))
    return {abort() {}}
  }})
  person(h); h.api.toggleTarget(); h.api.changeSettings({foreignEnabled: true})
  h.api.processRow(h.row('11', '你好呀', '1')); await h.tick()
  h.api.processRow(h.row('99', 'Hello', 'ack1')); await h.tick(16000)
  h.api.processRow(h.row('11', '你好呀', '2')); await h.tick()
  assert.equal(h.translations.length, 1); assert.equal(h.posts.length, 2)
  h.api.changeSettings({language: 'ja'}); h.api.processRow(h.row('11', '你好呀', '3')); await h.tick(5000)
  assert.equal(h.translations.length, 2); assert.equal(h.posts.at(-1).body.msg, 'こんにちは')
  h.api.changeSettings({foreignEnabled: false}); h.api.processRow(h.row('11', '回到原文', '4')); await h.tick(5000)
  assert.equal(h.posts.at(-1).body.msg, '回到原文'); assert.equal(h.translations.length, 2)
})
test('new tabs preserve targets but never restore or remotely inherit running switches', async () => {
  const first = followHarness()
  first.api.begin({ uid: '11', name: '目标' }); first.api.toggleTarget()
  const second = followHarness({ saved: first.saved })
  assert.equal(first.inspect().settings.targetEnabled, true)
  assert.equal(second.inspect().settings.targetEnabled, false)
  assert.equal(second.inspect().settings.targets[0].uid, '11')
  second.api.acceptSettings({ ...first.inspect().settings, random: true })
  second.api.processRow(second.row('11', '不应自动发送'))
  await second.tick(20000)
  assert.equal(second.posts.length, 0)
  first.api.acceptSettings({ ...first.inspect().settings, targetEnabled: false, random: false })
  assert.equal(first.inspect().settings.targetEnabled, true)
})
