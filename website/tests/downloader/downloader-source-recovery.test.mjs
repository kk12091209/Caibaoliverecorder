import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable, PassThrough, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { remoteBody } from '../../server/downloader/infrastructure/remote-body.mjs'
import { mediaSource } from '../../server/downloader/media/source.mjs'

const collect = async (stream) => {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}
function fixture({ fail, changed, validator = true, pause = 0 } = {}) {
  const data = Buffer.alloc(256 * 1024 + 17)
  for (let i = 0; i < data.length; i++) data[i] = i % 251
  const calls = new Map()
  let active = 0,
    peak = 0
  const open = async (url, { headers = {}, signal } = {}) => {
    const match = /bytes=(\d+)-(\d+)/.exec(headers.Range || '')
    const responseHeaders = {
      'content-length': String(data.length),
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes',
      ...(validator ? { etag: '"same"' } : {}),
    }
    if (!match) return { status: 200, headers: responseHeaders, stream: Readable.from([data]) }
    const [start, end] = match.slice(1).map(Number)
    assert.equal(headers['If-Range'], '"same"')
    const key = `${start}-${end}`,
      count = (calls.get(key) || 0) + 1
    calls.set(key, count)
    return {
      status: 206,
      headers: {
        ...responseHeaders,
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${data.length}`,
        etag: changed?.(start, count) ? '"different"' : '"same"',
      },
      stream: Readable.from(
        (async function* () {
          active++
          peak = Math.max(peak, active)
          try {
            await delay(pause, undefined, { signal })
            if (fail?.(start, count)) {
              yield data.subarray(start, start + 13)
              throw Object.assign(new Error('reset'), { code: 'ECONNRESET' })
            }
            yield data.subarray(start, end + 1)
          } finally {
            active--
          }
        })(),
      ),
    }
  }
  return { data, open, calls, peak: () => peak, active: () => active }
}

test('source retries only the failed small block, yields in order, and never duplicates bytes', async () => {
  const fake = fixture({ fail: (start, count) => start === 32768 && count === 1 })
  const events = []
  const result = await mediaSource(['https://a.bilivideo.com/video'], {
    open: fake.open,
    firstBytes: 32768,
    chunkBytes: 65536,
    maxBytes: 1024 ** 2,
    retryDelayMs: 1,
    onRecovery: (state) => events.push(state),
  })
  assert.deepEqual(await collect(result.stream), fake.data)
  assert.equal(fake.calls.get('32768-98303'), 2)
  assert.equal([...fake.calls.values()].filter((count) => count > 1).length, 1)
  assert.ok(events.some((state) => state.retrying))
  assert.ok(events.some((state) => state.start === 32768 && !state.retrying))
})

test('source refuses changed representations and does not retry them into a mixed MP4', async () => {
  const fake = fixture({ changed: (start) => start >= 32768 })
  const result = await mediaSource(['https://a.bilivideo.com/video'], {
    open: fake.open,
    firstBytes: 32768,
    chunkBytes: 65536,
    maxBytes: 1024 ** 2,
  })
  await assert.rejects(collect(result.stream), { code: 'SOURCE_CHANGED' })
  assert.ok([...fake.calls.values()].every((count) => count === 1))
})

test('media without a strong validator uses its original sequential response', async () => {
  const fake = fixture({ validator: false })
  const result = await mediaSource(['https://a.bilivideo.com/video'], {
    open: fake.open,
    maxBytes: 1024 ** 2,
  })
  assert.deepEqual(await collect(result.stream), fake.data)
  assert.equal(fake.calls.size, 0)
})

test('streaming block connections are globally bounded and cancellation drains prefetched work', async () => {
  const fake = fixture({ pause: 5 }),
    controller = new AbortController()
  const streams = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      mediaSource(['https://a.bilivideo.com/video'], {
        open: fake.open,
        owner: String(i),
        signal: controller.signal,
        firstBytes: 32768,
        chunkBytes: 65536,
        maxBytes: 1024 ** 2,
      }),
    ),
  )
  await Promise.all(streams.map((result) => collect(result.stream)))
  assert.ok(fake.peak() <= 4)
  assert.equal(fake.active(), 0)
  const slow = fixture({ pause: 100 })
  const result = await mediaSource(['https://a.bilivideo.com/video'], {
    open: slow.open,
    signal: controller.signal,
    maxBytes: 1024 ** 2,
  })
  const reading = collect(result.stream)
  await delay(5)
  controller.abort(new Error('test cancelled'))
  await assert.rejects(reading, /test cancelled/)
  assert.equal(slow.active(), 0)
})

test('body deadline ignores a paused slow pipe and retains all bytes', async () => {
  const raw = new PassThrough({ highWaterMark: 16 * 1024 })
  const source = remoteBody(raw, {
    timeout: 25,
    url: 'https://a.bilivideo.com/signed?secret=hidden',
  })
  let bytes = 0
  const consume = pipeline(
    source,
    new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, done) {
        bytes += chunk.length
        setTimeout(done, 45)
      },
    }),
  )
  raw.end(Buffer.alloc(128 * 1024, 7))
  await consume
  assert.equal(bytes, 128 * 1024)
})

test('body deadline detects real stalls during async iteration and preserves a useful cause', async () => {
  const raw = new PassThrough(),
    hold = setTimeout(() => {}, 500)
  const body = remoteBody(raw, { timeout: 20, url: 'https://a.bilivideo.com/signed?secret=hidden' })
  try {
    await assert.rejects(
      collect(body),
      (error) =>
        error.code === 'UPSTREAM_BODY_TIMEOUT' &&
        error.sourceHost === 'a.bilivideo.com' &&
        !error.message.includes('secret'),
    )
    assert.equal(raw.destroyed, true)
  } finally {
    clearTimeout(hold)
    body.destroy()
  }
})

test('async iteration can pause longer than the body deadline between reads', async () => {
  const raw = new PassThrough(),
    body = remoteBody(raw, { timeout: 20 })
  const iterator = body[Symbol.asyncIterator]()
  raw.write(Buffer.from('first'))
  assert.equal((await iterator.next()).value.toString(), 'first')
  await delay(60)
  raw.write(Buffer.from('buffered'))
  raw.end(Buffer.from('last'))
  assert.equal((await collect(Readable.from(iterator))).toString(), 'bufferedlast')
})

test('an input reset before its consumer starts is observed without an unhandled error', async () => {
  const raw = new PassThrough(),
    body = remoteBody(raw, { timeout: 20, url: 'https://a.bilivideo.com/video' })
  raw.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }))
  await delay(5)
  await assert.rejects(
    collect(body),
    (error) => error.code === 'ECONNRESET' && error.sourceHost === 'a.bilivideo.com',
  )
})

test('denied sources stop with a specific error instead of retrying indefinitely', async () => {
  const fake = fixture()
  let requests = 0
  const open = async (url, options) => {
    if (!options.headers.Range || options.headers.Range.startsWith('bytes=0-'))
      return fake.open(url, options)
    requests++
    return { status: 403, headers: {}, stream: Readable.from([]) }
  }
  const result = await mediaSource(['https://a.bilivideo.com/video'], {
    open,
    maxBytes: 1024 ** 2,
    retryDelayMs: 1,
  })
  await assert.rejects(collect(result.stream), { code: 'UPSTREAM_DENIED' })
  assert.ok(requests <= 2, 'at most the bounded prefetch should have started')
})

for (const mode of ['ignored-range', 'missing-etag', 'different-etag', 'wrong-range']) {
  test(`a CDN with ${mode} falls back before emitting bytes and keeps the exact original media`, async () => {
    const fake = fixture()
    let probes = 0
    const open = async (url, options) => {
      const response = await fake.open(url, options)
      if (options.headers.Range) {
        probes++
        if (mode === 'ignored-range') response.status = 200
        if (mode === 'missing-etag') delete response.headers.etag
        if (mode === 'different-etag') response.headers.etag = '"edge-specific"'
        if (mode === 'wrong-range') response.headers['content-range'] = 'bytes 0-99/100'
      }
      return response
    }
    const source = await mediaSource(['https://a.bilivideo.com/video'], {
      open,
      maxBytes: 1024 ** 2,
    })
    assert.deepEqual(await collect(source.stream), fake.data)
    assert.equal(probes, 1)
  })
}

test('range recovery stays on the negotiated CDN instead of combining opaque mirror validators', async () => {
  const fake = fixture({ fail: (start, count) => start === 32768 && count === 1 })
  const primary = 'https://a.bilivideo.com/video'
  const source = await mediaSource([primary, 'https://b.bilivideo.com/video'], {
    open: (url, options) => {
      assert.equal(url, primary)
      return fake.open(url, options)
    },
    firstBytes: 32768,
    chunkBytes: 65536,
    maxBytes: 1024 ** 2,
    retryDelayMs: 1,
  })
  assert.deepEqual(await collect(source.stream), fake.data)
  assert.equal(fake.calls.get('32768-98303'), 2)
})
