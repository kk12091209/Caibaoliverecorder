import test from 'node:test'
import assert from 'node:assert/strict'
import { translatorHarness, transcript } from '../helpers/live-translator-harness.mjs'
import { followHarness } from '../helpers/bili-follow-harness.mjs'

test('a long utterance is split without loss and actual request starts stay at least five seconds apart', async () => {
  const h = translatorHarness(), starts = [], text = '这是连续讲话需要完整保留的直播字幕内容'.repeat(4)
  const sender = h.createDanmakuSender(h.Core, { send: async (text, path, current, check, attempted, accepted) => {
    attempted(); starts.push({ at: h.clock.now, text }); accepted({ code: 0 }); return { code: 0, confirmed: true }
  } })
  sender.enqueue(transcript(1, text)); await h.tick(19000)
  assert.ok(starts.length > 2)
  assert.equal(starts.map(x => x.text.slice(1, -1)).join(''), text)
  assert.ok(starts.every(x => x.text.length <= 30))
  assert.ok(starts.slice(1).every((x, i) => x.at - starts[i].at >= 5000))
})

test('clearing and restarting the queue cannot bypass its five-second cooldown', async () => {
  const h = translatorHarness(), starts = []
  const sender = h.createDanmakuSender(h.Core, { send: async (text, path, current, check, attempted) => {
    attempted(); starts.push(h.clock.now); return { confirmed: true }
  } })
  sender.enqueue(transcript(1, '第一句已经足够长可以立即进行发送')); await h.tick()
  sender.clear(); sender.enqueue(transcript(2, '第二句同样足够长但是需要等待冷却'))
  await h.tick(4999); assert.equal(starts.length, 1)
  await h.tick(1); assert.deepEqual(starts, [100000, 105000])
})

test('rate feedback slows requests and successful sends never lower the floor below five seconds', async () => {
  const h = translatorHarness(), starts = []; let reject = true
  const sender = h.createDanmakuSender(h.Core, { send: async (text, path, current, check, attempted) => {
    attempted(); starts.push(h.clock.now)
    if (reject) { reject = false; throw Object.assign(Error('发送过快'), { rateLimited: true, retryAfterMs: 9000 }) }
    return { confirmed: true }
  } })
  sender.enqueue(transcript(1, '第一句被平台限流后应当自动放慢')); await h.tick()
  sender.enqueue(transcript(2, '第二句需要同时尊重平台建议的等待'))
  await h.tick(8999); assert.equal(starts.length, 1)
  await h.tick(1); assert.equal(starts[1], 109000)
  for (let i = 3; i < 8; i++) { sender.enqueue(transcript(i, '后续成功以后仍然保持至少五秒间隔', h.clock.now)); await h.tick(10000) }
  assert.ok(sender.paceMs >= 5000)
  assert.ok(starts.slice(1).every((x, i) => x - starts[i] >= 5000))
})

test('translation pressure drops a waiting old sentence while preserving the currently running translation', async () => {
  const h = translatorHarness(), started = [], cancelled = []; let finishFirst
  const queue = new h.Core.OrderedQueue()
  function add(id) {
    h.trimLiveQueue(queue, true)
    queue.enqueue({ id, record: { createdAt: h.clock.now }, cancel: () => cancelled.push(id), run: async () => {
      started.push(id)
      if (id === 1) await new Promise(resolve => { finishFirst = resolve })
    } })
  }
  add(1); add(2); add(3); add(4); await h.tick()
  assert.deepEqual(started, [1]); assert.deepEqual(cancelled, [2])
  finishFirst(); await h.tick()
  assert.deepEqual(started, [1, 3, 4]); assert.equal(queue.items.length, 0)
})

test('player preparation can become ready later without invoking any shared-capture fallback', async () => {
  const h = translatorHarness(), controller = new AbortController(), track = { live: true }; let ready = false, result
  const pending = h.waitForPlayerInput({ capture: () => ready ? track : null, signal: controller.signal,
    now: () => h.clock.now, setTimer: (fn, ms) => { const id = h.timers.size + 50; h.timers.set(id, { fn, at: h.clock.now + ms }); return id }, clearTimer: id => h.timers.delete(id) }).then(value => { result = value })
  await h.tick(600); assert.equal(result, undefined)
  ready = true; await h.tick(200); await pending; assert.equal(result, track)
})

test('player wait is bounded and cancellation leaves no timers', async () => {
  const h = translatorHarness(), controller = new AbortController()
  const pending = h.waitForPlayerInput({ capture: () => null, signal: controller.signal })
  controller.abort(); await assert.rejects(pending, { name: 'Cancelled' }); assert.equal(h.timers.size, 0)
  const second = h.waitForPlayerInput({ capture: () => null, signal: new AbortController().signal })
  await h.tick(4000); assert.equal(await second, null)
})

test('pause disconnects recognition without releasing audio; resume does not reuse stale audio', () => {
  const h = translatorHarness(), session = new h.ElevenSession({}, {}); let stopped = 0, flushed = 0
  session.graphReady = true; session.context = { currentTime: 9, close() { stopped++ } }
  session.stream = { getTracks: () => [{ stop() { stopped++ } }] }
  session.node = { port: { postMessage(type) { if (type === 'flush') flushed++ } } }
  session.lastAudibleAt = 100
  assert.equal(session.pause(), true); assert.equal(session.userPaused, true); assert.equal(stopped, 0)
  assert.equal(session.resume(), true); assert.equal(flushed, 1); assert.equal(session.resumeAudioFrom, 9)
  assert.equal(session.lastAudibleAt, undefined)
})

test('manual pause prevents recognition reconnect even when audio is available', async () => {
  const h = translatorHarness(), session = new h.ElevenSession({}, { canConnect: () => true })
  session.graphReady = true; session.userPaused = true
  await session.connectRecognition('not-a-real-key'); assert.equal(session.connecting, false)
})

test('saved keys stay out of inputs and an explicit replacement is cleared after capture', () => {
  const h = translatorHarness(); let saved = 'saved-key'
  const vault = h.createKeyVault({ read: () => saved, write: value => { saved = value }, remove: () => { saved = '' } })
  const input = { value: '' }; assert.equal(vault.get(), 'saved-key'); assert.equal(input.value, '')
  input.value = ' replacement '; vault.capture(input, true)
  assert.equal(vault.get(), 'replacement'); assert.equal(saved, 'replacement'); assert.equal(input.value, '')
  vault.capture(input, false); assert.equal(saved, ''); assert.equal(vault.get(), 'replacement')
})

test('the private key goes only to the ElevenLabs token endpoint; the WebSocket URL contains only the temporary token', async () => {
  const requests = [], urls = [], secret = 'private-key-sentinel-for-test'
  class Socket { constructor(url) { urls.push(String(url)) } close() {} }
  const h = translatorHarness({ WebSocket: Socket, GM_xmlhttpRequest: request => {
    requests.push(request)
    queueMicrotask(() => request.onload({ status: 200, responseText: '{"token":"single-use-test-token"}' }))
    return { abort() {} }
  } })
  const session = new h.ElevenSession({ language: 'zh', silence: 1.2 }, { canConnect: () => true, connecting() {} })
  session.graphReady = true; await session.connectRecognition(secret)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe')
  assert.equal(requests[0].headers['xi-api-key'], secret)
  assert.equal(new URL(urls[0]).searchParams.get('token'), 'single-use-test-token')
  assert.equal(urls[0].includes(secret), false)
  session.suspendRecognition()
})

test('echo confirmation excludes history and other users and accepts only a new matching self message', async () => {
  const h = translatorHarness(), rows = [{ key: 1, uid: '99', text: '【字幕】' }]
  const tracker = h.createEchoTracker({ readMessages: () => rows, ownUid: () => '99' })
  let result; const receipt = tracker.expect('【字幕】'); receipt.promise.then(value => { result = value })
  rows.push({ key: 2, uid: '11', text: '【字幕】' }); await h.tick(500); assert.equal(result, undefined)
  rows.push({ key: 3, uid: '99', text: '【字幕】' }); await h.tick(100); assert.equal(await receipt.promise, true)
})

test('missing echoes and explicit cancellation are unconfirmed and never trigger a new request', async () => {
  const h = translatorHarness(), tracker = h.createEchoTracker({ readMessages: () => [], ownUid: () => '99' })
  const receipt = tracker.expect('【字幕】'); await h.tick(8000); assert.equal(await receipt.promise, false)
  const cancelled = tracker.expect('【下一句】'); tracker.cancelAll(); assert.equal(await cancelled.promise, false)
  assert.equal(h.timers.size, 0)
})

test('the two current userscripts cannot claim automatic sending at the same time', () => {
  const h = followHarness(); h.api.begin({ uid: '11', name: '跟车对象' })
  const translator = translatorHarness().createAutoSendLease(h.document, 'live-translator')
  h.api.toggleTarget(); assert.equal(translator.claim(), false)
  h.api.toggleTarget(); assert.equal(translator.claim(), true)
  h.api.toggleRandom(); assert.equal(h.inspect().settings.random, false)
  translator.release(); h.api.toggleRandom(); assert.equal(h.inspect().settings.random, true)
  assert.equal(translator.claim(), false)
})

test('provider errors never echo the permanent API key or response body into UI errors', async () => {
  const secret = 'private-provider-key-sentinel', errors = []
  const h = translatorHarness({ GM_xmlhttpRequest: request => {
    queueMicrotask(() => request.onload({ status: 401, responseText: JSON.stringify({ detail: secret }) }))
    return { abort() {} }
  } })
  const session = new h.ElevenSession({ language: 'zh', silence: 1.2 }, { canConnect: () => true, connecting() {}, error: error => errors.push(String(error)) })
  session.graphReady = true
  try { await session.connectRecognition(secret) } catch (error) { errors.push(String(error)) }
  assert.equal(errors.length, 1)
  assert.match(errors[0], /HTTP 401/)
  assert.ok(!JSON.stringify(errors).includes(secret))
  assert.equal(session.connecting, false)
  session.suspendRecognition()
})
