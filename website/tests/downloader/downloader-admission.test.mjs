import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { setImmediate as tick } from 'node:timers/promises'
import { createDownloaderApi } from '../../server/downloader/api.mjs'
import { DownloadAccess } from '../../server/downloader/http/access.mjs'

class Response extends Writable {
  constructor() {
    super()
    this.headers = {}
    this.statusCode = 200
    this.chunks = []
  }
  _write(chunk, _encoding, done) {
    this.chunks.push(chunk)
    done()
  }
  setHeader(key, value) {
    this.headers[key.toLowerCase()] = value
  }
  writeHead(status, headers) {
    this.statusCode = status
    for (const [k, v] of Object.entries(headers)) this.setHeader(k, v)
    this.headersSent = true
  }
  value() {
    return JSON.parse(Buffer.concat(this.chunks).toString())
  }
}
const gate = () => {
  let release
  const promise = new Promise((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const result = (text) => ({
  platform: 'douyin',
  kind: 'images',
  id: text,
  title: text,
  url: 'https://www.douyin.com/note/1',
  assets: [],
})
function request(path, { input, token, bodyGate, headers = {}, method = 'POST' } = {}) {
  const req = Readable.from(
    (async function* () {
      if (bodyGate) await bodyGate.promise
      if (input !== undefined) yield JSON.stringify(input)
    })(),
  )
  req.url = '/api/downloader/' + path
  req.method = method
  req.headers = { host: '127.0.0.1:17970', 'x-downloader-token': token, ...headers }
  req.socket = { remoteAddress: '203.0.113.1' }
  return req
}
async function call(api, req) {
  const res = new Response()
  await api.handler(req, res, () => assert.fail('unhandled'))
  return res
}
async function token(api) {
  return (await call(api, request('config', { method: 'GET' }))).value().token
}

test('different resolves whose bodies finish together cannot exceed two active parsers', async () => {
  const bodies = gate(),
    work = gate()
  let active = 0,
    peak = 0
  const api = createDownloaderApi({
    resolver: {
      async resolve(text) {
        active++
        peak = Math.max(peak, active)
        try {
          await work.promise
          return result(text)
        } finally {
          active--
        }
      },
    },
  })
  try {
    const csrf = await token(api)
    const pending = Array.from({ length: 4 }, (_, n) =>
      call(api, request('resolve', { token: csrf, input: { text: String(n) }, bodyGate: bodies })),
    )
    await tick()
    bodies.release()
    await tick()
    work.release()
    const replies = await Promise.all(pending)
    assert.equal(peak, 2)
    assert.equal(replies.filter((r) => r.statusCode === 200).length, 2)
    assert.equal(replies.filter((r) => r.statusCode === 429).length, 2)
    assert.equal(
      (await call(api, request('resolve', { token: csrf, input: { text: 'after' } }))).statusCode,
      200,
    )
  } finally {
    bodies.release()
    work.release()
    await api.close()
  }
})
test('maintenance starting while a request body is pending prevents new parsing', async () => {
  const bodies = gate()
  let calls = 0
  const api = createDownloaderApi({
    resolver: {
      async resolve(text) {
        calls++
        return result(text)
      },
    },
  })
  try {
    const csrf = await token(api),
      pending = call(
        api,
        request('resolve', { token: csrf, input: { text: 'x' }, bodyGate: bodies }),
      )
    await tick()
    api.beginDrain()
    bodies.release()
    assert.equal((await pending).statusCode, 503)
    assert.equal(calls, 0)
  } finally {
    bodies.release()
    await api.close()
  }
})
test('resolver failures release their permits', async () => {
  let calls = 0
  const api = createDownloaderApi({
    resolver: {
      async resolve(text) {
        if (++calls <= 2) throw Error('fixture failure')
        return result(text)
      },
    },
  })
  try {
    const csrf = await token(api)
    for (const expected of [400, 400, 200])
      assert.equal(
        (await call(api, request('resolve', { token: csrf, input: { text: 'x' } }))).statusCode,
        expected,
      )
  } finally {
    await api.close()
  }
})
function publicRequest(ip = '203.0.113.1', cookie) {
  return {
    method: 'GET',
    headers: { host: 'caibao.media', ...(cookie ? { cookie } : {}) },
    socket: { remoteAddress: ip },
  }
}
test('one source cannot occupy the public visitor pool across rate windows', () => {
  let now = 1000
  const access = new DownloadAccess({ publicOrigins: ['https://caibao.media'], now: () => now })
  for (let batch = 0; batch < 6; batch++) {
    for (let n = 0; n < 50; n++) {
      try {
        access.authorize(publicRequest(), new Response(), { config: true })
      } catch (e) {
        assert.equal(e.status, 429)
      }
    }
    assert.ok(
      access.visitors.size <= 32,
      'a source must not occupy more than 32 visitor identities',
    )
    now += 600001
  }
  assert.doesNotThrow(() =>
    access.authorize(publicRequest('203.0.113.2'), new Response(), { config: true }),
  )
})
test('ordinary authorization and config refresh cannot renew unused visitors', () => {
  let now = 1000
  const access = new DownloadAccess({ publicOrigins: ['https://caibao.media'], now: () => now })
  const res = new Response(),
    visitor = access.authorize(publicRequest(), res, { config: true })
  const req = publicRequest('203.0.113.1', res.headers['set-cookie'].split(';')[0]),
    expires = visitor.expires
  now += 60000
  access.authorize(req, new Response())
  access.authorize(req, new Response(), { config: true })
  assert.equal(visitor.expires, expires)
  now += 120001
  access.prune()
  assert.throws(
    () => access.authorize(req, new Response()),
    (e) => e.status === 401,
  )
})
test('a non-GET config route cannot allocate public visitors', async () => {
  const api = createDownloaderApi({ publicOrigins: ['https://caibao.media'] })
  try {
    const reply = await call(
      api,
      request('config', { method: 'PUT', headers: { host: 'caibao.media' } }),
    )
    assert.equal(reply.statusCode, 401)
    assert.equal(reply.headers['set-cookie'], undefined)
  } finally {
    await api.close()
  }
})

test('active download leases survive idle cleanup, are isolated and eventually expire', () => {
  let now = 1000
  const busy = new Set(),
    access = new DownloadAccess({
      publicOrigins: ['https://caibao.media'],
      now: () => now,
      retained: (id) => busy.has(id),
    })
  const res = new Response(),
    visitor = access.authorize(publicRequest(), res, { config: true })
  const req = publicRequest('203.0.113.2', res.headers['set-cookie'].split(';')[0])
  access.touch(visitor, res)
  busy.add(visitor.id)
  now += 7200001
  access.prune()
  assert.equal(
    access.authorize(req, new Response()).id,
    visitor.id,
    'network changes do not change ownership',
  )
  const release = access.retain(visitor)
  busy.delete(visitor.id)
  now += 7200001
  access.prune()
  assert.equal(access.visitors.has(visitor.id), true)
  release(true)
  release(true)
  assert.equal(visitor.readers, 0)
  assert.equal(access.authorize(req, new Response()).id, visitor.id)
  now += 7200001
  access.prune()
  assert.throws(
    () => access.authorize(req, new Response()),
    (e) => e.status === 401,
  )
})
test('unsuccessful requests cannot turn admission leases into active sessions', () => {
  let now = 1000
  const access = new DownloadAccess({ publicOrigins: ['https://caibao.media'], now: () => now })
  const res = new Response(),
    visitor = access.authorize(publicRequest(), res, { config: true })
  const expires = visitor.expires,
    release = access.retain(visitor)
  now += 180000
  access.prune()
  assert.equal(access.visitors.has(visitor.id), true)
  release(false)
  assert.equal(visitor.expires, expires)
  assert.equal(visitor.used, false)
  access.prune()
  assert.equal(access.visitors.has(visitor.id), false)
})
test('frequent activity renews the browser cookie before its independent expiry', () => {
  let now = 1000
  const access = new DownloadAccess({ publicOrigins: ['https://caibao.media'], now: () => now })
  const res = new Response(),
    visitor = access.authorize(publicRequest(), res, { config: true })
  const cookie = res.headers['set-cookie'].split(';')[0]
  access.touch(visitor, res)
  const originalCookieExpiry = visitor.cookieExpires
  let refreshes = 0
  for (let minute = 0; minute < 150; minute++) {
    now += 60000
    assert.ok(visitor.cookieExpires > now, 'the browser must still retain the same cookie')
    const reply = new Response()
    access.authorize(publicRequest('203.0.113.1', cookie), reply)
    access.touch(visitor, reply)
    if (reply.headers['set-cookie']) {
      assert.equal(reply.headers['set-cookie'].split(';')[0], cookie)
      refreshes++
    }
  }
  assert.equal(refreshes, 1)
  assert.ok(visitor.cookieExpires > originalCookieExpiry)
})
test('IPv6 interface changes and mapped IPv4 aliases share their source admission budget', () => {
  for (const addresses of [
    Array.from({ length: 33 }, (_, n) => `2001:db8:1234:5::${(n + 1).toString(16)}`),
    [...Array(32).fill('203.0.113.1'), '::ffff:cb00:7101'],
  ]) {
    const access = new DownloadAccess({ publicOrigins: ['https://caibao.media'] })
    for (const ip of addresses.slice(0, 32)) {
      const v = access.authorize(publicRequest(ip), new Response(), { config: true })
      access.touch(v)
    }
    assert.throws(
      () => access.authorize(publicRequest(addresses.at(-1)), new Response(), { config: true }),
      (e) => e.status === 429,
    )
    assert.doesNotThrow(() =>
      access.authorize(publicRequest('203.0.113.2'), new Response(), { config: true }),
    )
  }
})
test('capacity pressure recycles unused visitors without evicting active shared-network users', () => {
  const access = new DownloadAccess({ publicOrigins: ['https://caibao.media'] })
  const shared = []
  for (let n = 0; n < 8; n++) {
    const v = access.authorize(publicRequest(), new Response(), { config: true })
    access.touch(v)
    shared.push(v.id)
  }
  for (let n = 0; n < 280; n++)
    access.authorize(publicRequest(`2001:db8:${n.toString(16)}::1`), new Response(), {
      config: true,
    })
  assert.equal(access.visitors.size, 256)
  assert.ok(shared.every((id) => access.visitors.has(id)))
  assert.doesNotThrow(() => access.authorize(publicRequest(), new Response(), { config: true }))
})
test('unknown owned-job suffixes and invalid file IDs do not renew the visitor', async () => {
  let now = 1000
  const api = createDownloaderApi({
    publicOrigins: ['https://caibao.media'],
    accessOptions: { now: () => now },
    resolver: {
      async resolve(text) {
        return { ...result(text), assets: [{ index: 1, type: 'image', urls: [] }] }
      },
    },
    jobOptions: {
      now: () => now,
      images: {
        async download(_urls, { onProgress }) {
          onProgress(5, 5)
          return { data: Buffer.from('image'), extension: 'jpg', type: 'image/jpeg' }
        },
      },
    },
  })
  try {
    const config = await call(
      api,
      request('config', { method: 'GET', headers: { host: 'caibao.media' } }),
    )
    const headers = { host: 'caibao.media', cookie: config.headers['set-cookie'].split(';')[0] },
      csrf = config.value().token
    const session = (
      await call(api, request('resolve', { headers, token: csrf, input: { text: 'x' } }))
    ).value()
    const job = (
      await call(
        api,
        request('jobs', {
          headers,
          token: csrf,
          input: { sessionId: session.sessionId, indices: [1] },
        }),
      )
    ).value()
    await api.idle()
    assert.equal(
      (await call(api, request(`jobs/${job.id}`, { method: 'GET', headers }))).value().status,
      'done',
    )
    now += 7199999
    for (const suffix of ['garbage', `files/${'a'.repeat(36)}`, 'stream?part=999']) {
      const reply = await call(api, request(`jobs/${job.id}/${suffix}`, { method: 'GET', headers }))
      assert.equal(reply.statusCode, 404)
      assert.equal(reply.headers['set-cookie'], undefined)
    }
    now += 2
    assert.equal(
      (await call(api, request(`jobs/${job.id}`, { method: 'GET', headers }))).statusCode,
      401,
    )
  } finally {
    await api.close()
  }
})

test('client disconnects release active parsing permits and prevent parsing pending bodies', async () => {
  const entered = gate(),
    bodyGate = gate()
  let calls = 0
  const api = createDownloaderApi({
    resolver: {
      async resolve(text, { signal }) {
        if (text === 'after') return result(text)
        if (++calls === 2) entered.release()
        await new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        )
      },
    },
  })
  try {
    const csrf = await token(api)
    const requests = [0, 1].map((n) =>
      request('resolve', { token: csrf, input: { text: String(n) } }),
    )
    const responses = requests.map(() => new Response())
    const pending = requests.map((req, i) =>
      api.handler(req, responses[i], () => assert.fail('unhandled')),
    )
    await entered.promise
    requests[0].emit('aborted')
    responses[1].destroy()
    await Promise.all(pending)
    assert.equal(
      (await call(api, request('resolve', { token: csrf, input: { text: 'after' } }))).statusCode,
      200,
    )
    const slow = request('resolve', { token: csrf, input: { text: 'never' }, bodyGate })
    const parsing = call(api, slow)
    await tick()
    slow.emit('aborted')
    bodyGate.release()
    await parsing
    assert.equal(calls, 2)
  } finally {
    bodyGate.release()
    await api.close()
  }
})

test('running jobs and in-flight file reads retain their owner past idle expiry', async () => {
  let now = 1000
  const work = gate(),
    started = gate(),
    readStarted = gate(),
    finishRead = gate()
  const bytes = Buffer.from('long-running-image')
  const api = createDownloaderApi({
    publicOrigins: ['https://caibao.media'],
    accessOptions: { now: () => now },
    resolver: {
      async resolve(text) {
        return { ...result(text), assets: [{ index: 1, type: 'image', urls: [] }] }
      },
    },
    jobOptions: {
      now: () => now,
      images: {
        async download(_urls, { onProgress }) {
          started.release()
          await work.promise
          onProgress(bytes.length, bytes.length)
          return { data: bytes, extension: 'jpg', type: 'image/jpeg' }
        },
      },
    },
  })
  try {
    const config = await call(
      api,
      request('config', { method: 'GET', headers: { host: 'caibao.media' } }),
    )
    const headers = { host: 'caibao.media', cookie: config.headers['set-cookie'].split(';')[0] },
      csrf = config.value().token
    const session = (
      await call(api, request('resolve', { headers, token: csrf, input: { text: 'x' } }))
    ).value()
    const job = (
      await call(
        api,
        request('jobs', {
          headers,
          token: csrf,
          input: { sessionId: session.sessionId, indices: [1] },
        }),
      )
    ).value()
    await started.promise
    now += 7200001
    const other = await call(
      api,
      request('config', { method: 'GET', headers: { host: 'caibao.media' } }),
    )
    assert.equal(
      (await call(api, request(`jobs/${job.id}`, { method: 'GET', headers }))).value().status,
      'running',
    )
    assert.equal(
      (
        await call(
          api,
          request(`jobs/${job.id}/download`, {
            method: 'GET',
            headers: { host: 'caibao.media', cookie: other.headers['set-cookie'].split(';')[0] },
          }),
        )
      ).statusCode,
      404,
    )
    class SlowResponse extends Response {
      _write(chunk, _encoding, done) {
        this.chunks.push(chunk)
        readStarted.release()
        finishRead.promise.then(() => done())
      }
    }
    const response = new SlowResponse()
    const download = api.handler(
      request(`jobs/${job.id}/download`, { method: 'GET', headers }),
      response,
      () => assert.fail('unhandled'),
    )
    work.release()
    await readStarted.promise
    now += 7200001
    const range = await call(
      api,
      request(`jobs/${job.id}/download`, {
        method: 'GET',
        headers: { ...headers, range: 'bytes=2-6' },
      }),
    )
    assert.equal(range.statusCode, 206)
    assert.deepEqual(Buffer.concat(range.chunks), bytes.subarray(2, 7))
    finishRead.release()
    await download
    assert.deepEqual(Buffer.concat(response.chunks), bytes)
    now += 7200001
    assert.equal(
      (await call(api, request(`jobs/${job.id}`, { method: 'GET', headers }))).statusCode,
      401,
    )
  } finally {
    work.release()
    finishRead.release()
    await api.close()
  }
})
