import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { openRemote } from '../infrastructure/network.mjs'
import { WorkPool } from '../infrastructure/cache.mjs'
import { sizeLimitError } from '../infrastructure/limits.mjs'
import { upstreamError } from '../infrastructure/remote-body.mjs'
import { withDeadline } from '../infrastructure/deadline.mjs'

// Four actual block transfers across streaming jobs, rotated by visitor. A
// paused input holds at most two 1 MiB blocks, never a whole source in memory.
const transfers = new WorkPool(4)

export async function mediaSource(
  urls,
  {
    signal,
    referer,
    maxBytes,
    open = openRemote,
    owner = '',
    onRecovery = () => {},
    onActivity = () => {},
    chunkBytes = 1024 ** 2,
    firstBytes = 64 * 1024,
    parallel = 2,
    retries = 2,
    retryDelayMs = 400,
  } = {},
) {
  let initial, last, selected
  for (const url of urls) {
    signal?.throwIfAborted()
    try {
      const response = await open(url, { signal, headers: { Referer: referer }, timeout: 60000 })
      const total = Number(response.headers['content-length']) || 0
      if (
        response.status !== 200 ||
        /text\/|application\/(?:json|xml)/i.test(response.headers['content-type'] || '')
      ) {
        response.stream.destroy()
        throw upstreamError(`视频源暂时不可用（${response.status}）。`, 'UPSTREAM_STATUS', url)
      }
      if (total > maxBytes) {
        response.stream.destroy()
        throw sizeLimitError(maxBytes, '视频源')
      }
      initial = { ...response, total }
      selected = url
      break
    } catch (error) {
      last = error
      if (signal?.aborted) throw signal.reason
    }
  }
  if (!initial) throw last || new Error('没有可用的视频源。')
  const etag = initial.headers.etag
  if (
    !initial.total ||
    !/^bytes$/i.test(initial.headers['accept-ranges'] || '') ||
    !etag ||
    etag.startsWith('W/')
  ) {
    // Without a strong validator, a new response cannot safely be appended to
    // bytes already handed to FFmpeg. Keep the demand-aware sequential path.
    return initial
  }
  // Some CDN edges advertise Range but return a full body or a different (or
  // missing) validator for conditional ranges. Negotiate before giving FFmpeg
  // any bytes; retain the original response as a safe streaming fallback.
  const firstEnd = Math.min(initial.total - 1, firstBytes - 1)
  let firstBlock
  try {
    firstBlock = await transfers.run(
      () =>
        withDeadline(signal, 5000, async (probeSignal) => {
          const response = await open(selected, {
            signal: probeSignal,
            timeout: 5000,
            headers: { Referer: referer, Range: `bytes=0-${firstEnd}`, 'If-Range': etag },
          })
          try {
            if (
              response.status !== 206 ||
              response.headers.etag !== etag ||
              response.headers['content-range'] !== `bytes 0-${firstEnd}/${initial.total}` ||
              (response.headers['content-length'] !== undefined &&
                Number(response.headers['content-length']) !== firstEnd + 1)
            )
              return null
            const buffer = Buffer.allocUnsafe(firstEnd + 1)
            let offset = 0
            for await (const chunk of response.stream) {
              onActivity()
              if (offset + chunk.length > buffer.length) return null
              buffer.set(chunk, offset)
              offset += chunk.length
            }
            return offset === buffer.length ? buffer : null
          } finally {
            response.stream.destroy()
          }
        }),
      { signal, owner },
    )
  } catch (error) {
    if (signal?.aborted) {
      initial.stream.destroy()
      throw signal.reason
    }
  }
  if (!firstBlock) return initial
  initial.stream.destroy()
  const controller = new AbortController()
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const total = initial.total
  async function block(start, end) {
    let failure
    for (let attempt = 0; attempt <= retries; attempt++) {
      combined.throwIfAborted()
      // An opaque ETag is not portable across CDN hosts. Resume only against
      // the endpoint whose representation we negotiated, never mix mirrors.
      const url = selected
      try {
        const data = await transfers.run(
          async () => {
            const response = await open(url, {
              signal: combined,
              timeout: 60000,
              headers: { Referer: referer, Range: `bytes=${start}-${end}`, 'If-Range': etag },
            })
            try {
              if ([408, 429].includes(response.status) || response.status >= 500) {
                const error = upstreamError(
                  `平台暂时繁忙（${response.status}）。`,
                  'UPSTREAM_BUSY',
                  url,
                )
                const retryAfter = response.headers['retry-after']
                const waitMs = /^\d+$/.test(retryAfter || '')
                  ? Number(retryAfter) * 1000
                  : Date.parse(retryAfter) - Date.now()
                error.retryAfterMs = Number.isFinite(waitMs)
                  ? Math.min(30000, Math.max(0, waitMs))
                  : 0
                throw error
              }
              if ([401, 403, 404, 410].includes(response.status))
                throw upstreamError(
                  `视频源暂时不可访问（${response.status}），请重新解析。`,
                  'UPSTREAM_DENIED',
                  url,
                )
              if (
                response.status !== 206 ||
                response.headers['content-range'] !== `bytes ${start}-${end}/${total}` ||
                response.headers.etag !== etag
              )
                throw upstreamError('视频源发生变化，请重新解析后下载。', 'SOURCE_CHANGED', url)
              if (
                response.headers['content-length'] !== undefined &&
                Number(response.headers['content-length']) !== end - start + 1
              )
                throw upstreamError('视频分段长度不一致。', 'SOURCE_CHANGED', url)
              const buffer = Buffer.allocUnsafe(end - start + 1)
              let offset = 0
              for await (const chunk of response.stream) {
                combined.throwIfAborted()
                onActivity()
                if (offset + chunk.length > buffer.length)
                  throw upstreamError('视频分段超出预期。', 'SOURCE_CHANGED', url)
                buffer.set(chunk, offset)
                offset += chunk.length
              }
              if (offset !== buffer.length)
                throw upstreamError('视频分段未传输完整。', 'UPSTREAM_TRUNCATED', url)
              return buffer
            } finally {
              response.stream.destroy()
            }
          },
          { signal: combined, owner },
        )
        onRecovery({ start, retrying: false })
        return data
      } catch (error) {
        if (combined.aborted) throw combined.reason
        failure = error
        error.sourceHost ||= upstreamError('', '', url).sourceHost
        error.sourceOffset = start
        if (['SOURCE_CHANGED', 'UPSTREAM_DENIED'].includes(error.code) || attempt === retries)
          throw error
        onRecovery({
          start,
          retrying: true,
          attempt: attempt + 1,
          code: error.code || 'UPSTREAM_RESET',
          host: error.sourceHost,
        })
        await delay(Math.max(error.retryAfterMs || 0, retryDelayMs * 2 ** attempt), undefined, {
          signal: combined,
        })
      }
    }
    throw failure
  }
  async function* ordered() {
    const window = [Promise.resolve({ value: firstBlock })]
    let next = firstEnd + 1
    const fill = () => {
      while (window.length < Math.max(1, Math.min(parallel, 2)) && next < total) {
        const start = next,
          end = Math.min(total - 1, start + (start === 0 ? firstBytes : chunkBytes) - 1)
        next = end + 1
        // Catch immediately: a later block may fail while an earlier one is
        // still being consumed. Never leave a rejected prefetch unobserved.
        window.push(
          block(start, end).then(
            (value) => ({ value }),
            (error) => ({ error }),
          ),
        )
      }
    }
    try {
      fill()
      while (window.length) {
        const result = await window[0]
        if (result.error) throw result.error
        yield result.value
        window.shift()
        fill()
      }
    } finally {
      controller.abort()
      await Promise.all(window)
    }
  }
  const stream = Readable.from(ordered(), { objectMode: false, highWaterMark: 64 * 1024 })
  stream.on('error', () => {})
  // A sibling input can fail while this iterator has not started yet.
  stream.once('close', () => controller.abort())
  return { ...initial, stream }
}
