import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib'

// Bound both compressed input and expanded HTML. A compressed page must not
// evade the page-size limit, and decoder failures must close the upstream.
export async function readRemoteText(response, { maxBytes = 12 * 1024 * 1024 } = {}) {
  const encoding = String(response.headers['content-encoding'] || 'identity')
    .trim()
    .toLowerCase()
  const factories = {
    gzip: createGunzip,
    'x-gzip': createGunzip,
    deflate: createInflate,
    br: createBrotliDecompress,
  }
  if (encoding !== 'identity' && !Object.hasOwn(factories, encoding)) {
    response.stream.destroy()
    throw upstreamError('平台页面压缩格式暂不支持。', 'UPSTREAM_ENCODING', response.url)
  }
  const tooLarge = () =>
    upstreamError('平台返回的数据过大。', 'UPSTREAM_TEXT_TOO_LARGE', response.url)
  const decoder = encoding === 'identity' ? null : factories[encoding]()
  let work,
    wireBytes = 0
  const chunks = []
  let size = 0
  if (decoder) {
    const limit = new Transform({
      transform(chunk, _encoding, done) {
        wireBytes += chunk.length
        done(wireBytes > maxBytes ? tooLarge() : null, chunk)
      },
    })
    work = pipeline(response.stream, limit, decoder)
    work.catch(() => {})
  }
  try {
    for await (const chunk of decoder || response.stream) {
      size += chunk.length
      if (size > maxBytes) throw tooLarge()
      chunks.push(chunk)
    }
    if (work) await work
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    response.stream.destroy()
    decoder?.destroy()
    if (work) await work.catch(() => {})
  }
}

export function upstreamError(message, code, url, cause) {
  let host
  try {
    host = new URL(url).hostname
  } catch {
    /* Injected/local sources need no URL. */
  }
  return Object.assign(new Error(message, { cause }), { code, sourceHost: host })
}

// Time actual reads, rather than socket inactivity while FFmpeg has paused an
// input. This wrapper supports both pipe() and async iteration. Its buffer is
// bounded; no timer runs while a pipe consumer is paused or data awaits reading.
export function remoteBody(source, { timeout, url } = {}) {
  const iterator = source[Symbol.asyncIterator]()
  let pending = false,
    iteratorMode = false,
    iteratorDemand = 0,
    paused = false,
    timer
  const clear = () => {
    clearTimeout(timer)
    timer = null
  }
  const arm = () => {
    if (!timeout || timer || !pending || (paused && !iteratorDemand) || body.destroyed) return
    if (iteratorMode && !iteratorDemand && body.readableFlowing !== true) return
    timer = setTimeout(() => {
      timer = null
      if (body.readableLength || paused) return
      body.destroy(
        upstreamError('平台传输长时间没有返回数据，请重试。', 'UPSTREAM_BODY_TIMEOUT', url),
      )
    }, timeout)
    timer.unref?.()
  }
  const body = new Readable({
    highWaterMark: 64 * 1024,
    read() {
      if (pending) {
        arm()
        return
      }
      pending = true
      arm()
      iterator.next().then(
        ({ done, value }) => {
          pending = false
          clear()
          if (!body.destroyed) body.push(done ? null : value)
        },
        (error) => {
          pending = false
          clear()
          body.destroy(
            upstreamError('平台连接中断，请重试。', error.code || 'UPSTREAM_RESET', url, error),
          )
        },
      )
    },
    destroy(error, done) {
      clear()
      source.destroy()
      done(error)
    },
  })
  body.on('pause', () => {
    paused = true
    clear()
  })
  body.on('resume', () => {
    paused = false
    arm()
  })
  // The caller may still be opening the other audio/video input.
  body.on('error', () => {})
  body[Symbol.asyncIterator] = function () {
    iteratorMode = true
    const reads = Readable.prototype[Symbol.asyncIterator].call(body)
    return {
      async next() {
        iteratorDemand++
        arm()
        try {
          return await reads.next()
        } finally {
          if (!--iteratorDemand && body.readableFlowing !== true) clear()
        }
      },
      return: (value) => reads.return(value),
      throw: (error) => reads.throw(error),
      [Symbol.asyncIterator]() {
        return this
      },
    }
  }
  source.on('error', (error) =>
    body.destroy(
      upstreamError('平台连接中断，请重试。', error.code || 'UPSTREAM_RESET', url, error),
    ),
  )
  return body
}
