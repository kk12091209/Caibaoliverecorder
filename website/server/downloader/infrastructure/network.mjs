import http from 'node:http'
import https from 'node:https'
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { createWriteStream } from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { ExpiringCache } from './cache.mjs'
import { setTimeout as delay } from 'node:timers/promises'

export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1'
export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const blockedV4 = new BlockList(),
  blockedV6 = new BlockList()
for (const [ip, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['224.0.0.0', 3],
])
  blockedV4.addSubnet(ip, bits, 'ipv4')
for (const [ip, bits] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
])
  blockedV6.addSubnet(ip, bits, 'ipv6')
// Keep the complete IPv4-mapped IPv6 range blocked. Node's BlockList also
// matches ordinary IPv4 against that range, so the families need separate lists.
export function permittedAddress(address, family) {
  return family === 6
    ? !blockedV6.check(address, 'ipv6')
    : family === 4 && !blockedV4.check(address, 'ipv4')
}
// Local TUN proxies map public sites to 198.18/15. These addresses are
// usable only for the fixed platform allowlist below; TLS host verification
// remains enabled, and private/loopback targets remain blocked.
const roots = [
  'douyin.com',
  'iesdouyin.com',
  'douyinvod.com',
  'douyinpic.com',
  'byteimg.com',
  'snssdk.com',
  'bytecdn.cn',
  'bytecdn.com',
  'ibytedtos.com',
  'bilibili.com',
  'b23.tv',
  'bilivideo.com',
  'bilivideo.cn',
  'hdslb.com',
  'biliimg.com',
  'acgvideo.com',
]
// Observed as the media redirect from Douyin's official aweme.snssdk.com
// playback endpoint. Keep this CDN exception exact instead of allowing zjcdn.
const mediaHosts = new Set(['v3-dy-o.zjcdn.com'])
const dnsCache = new ExpiringCache({ maxEntries: 256, ttl: 30000 })
const agents = {
  http: new http.Agent({ keepAlive: true, maxSockets: 8, maxTotalSockets: 32 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 8, maxTotalSockets: 32 }),
}

export function approvedUrl(input) {
  let u
  try {
    u = new URL(String(input).startsWith('//') ? 'https:' + input : input)
  } catch {
    throw new Error('媒体地址无效。')
  }
  if (
    !['https:', 'http:'].includes(u.protocol) ||
    u.port ||
    u.username ||
    u.password ||
    isIP(u.hostname) ||
    (!mediaHosts.has(u.hostname) &&
      !roots.some((root) => u.hostname === root || u.hostname.endsWith('.' + root)))
  )
    throw new Error('不支持这个媒体地址。')
  return u
}

export async function openRemote(
  input,
  { headers = {}, signal, timeout = 30000, redirects = 6 } = {},
) {
  let url = approvedUrl(input)
  for (let attempt = 0; attempt <= redirects; attempt++) {
    signal?.throwIfAborted()
    let addresses = dnsCache.get(url.hostname)
    if (!addresses) {
      addresses = await lookup(url.hostname, { all: true })
      dnsCache.set(url.hostname, addresses)
    }
    if (!addresses.length || addresses.some((a) => !permittedAddress(a.address, a.family)))
      throw new Error('媒体地址不能指向本地网络。')
    const selected = addresses.find((a) => a.family === 4) || addresses[0]
    const response = await new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).get(
        url,
        {
          agent: url.protocol === 'https:' ? agents.https : agents.http,
          headers: { 'User-Agent': DESKTOP_UA, ...headers },
          signal,
          lookup: (_hostname, options, callback) =>
            options?.all
              ? callback(null, [selected])
              : callback(null, selected.address, selected.family),
        },
        resolve,
      )
      request.on('error', reject)
      request.setTimeout(timeout, () => request.destroy(new Error('连接平台超时，请重试。')))
    })
    if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
      response.destroy()
      const next = approvedUrl(new URL(response.headers.location, url))
      if (next.hostname !== url.hostname) {
        headers = { ...headers }
        delete headers.Cookie
        delete headers.cookie
      }
      url = next
      continue
    }
    return {
      status: response.statusCode,
      headers: response.headers,
      stream: response,
      url: url.href,
    }
  }
  throw new Error('分享链接跳转次数过多。')
}

export async function remoteText(url, options = {}) {
  const response = await openRemote(url, options)
  if (response.status !== 200) {
    response.stream.destroy()
    throw Object.assign(new Error(`平台请求失败（${response.status}），请稍后重试。`), {
      upstreamStatus: response.status,
    })
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.stream) {
    size += chunk.length
    if (size > (options.maxBytes || 12 * 1024 * 1024)) {
      response.stream.destroy()
      throw new Error('平台返回的数据过大。')
    }
    chunks.push(chunk)
  }
  return { ...response, text: Buffer.concat(chunks).toString('utf8') }
}
export async function remoteJson(url, options = {}) {
  const { text } = await remoteText(url, options)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('平台暂未返回作品信息，请重试。')
  }
}

async function saveResponse(
  response,
  target,
  { signal, onProgress, maxBytes, start = 0, expected, total },
) {
  let bytes = 0
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > maxBytes || (expected !== undefined && bytes > expected))
        return callback(new Error('媒体文件长度超出预期。'))
      try {
        onProgress?.(bytes, total)
        callback(null, chunk)
      } catch (error) {
        error.progressFailure = true
        callback(error)
      }
    },
  })
  await pipeline(
    response.stream,
    meter,
    createWriteStream(target, { flags: start || expected !== undefined ? 'r+' : 'w', start }),
    { signal },
  )
  if (!bytes || (expected !== undefined && bytes !== expected))
    throw new Error('媒体文件没有下载完整，请重试。')
  return bytes
}

async function saveRanges(
  response,
  target,
  { headers, signal, onProgress, maxBytes, open, total, retryDelayMs = 250 },
) {
  response.stream.destroy()
  const file = await openFile(target, 'w')
  try {
    await file.truncate(total)
  } finally {
    await file.close()
  }
  const controller = new AbortController(),
    combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    counts = [0, 0, 0],
    size = Math.ceil(total / 3),
    etag =
      response.headers.etag && !response.headers.etag.startsWith('W/')
        ? response.headers.etag
        : null
  const tasks = counts.map(async (_, index) => {
    const start = index * size,
      end = Math.min(total - 1, start + size - 1)
    for (let attempt = 0; ; attempt++) {
      try {
        combined.throwIfAborted()
        const part = await open(response.url, {
          headers: {
            ...headers,
            Range: `bytes=${start}-${end}`,
            ...(etag ? { 'If-Range': etag } : {}),
          },
          signal: combined,
          timeout: 60000,
        })
        if (
          part.status !== 206 ||
          part.headers['content-range'] !== `bytes ${start}-${end}/${total}` ||
          (etag && part.headers.etag !== etag)
        ) {
          part.stream.destroy()
          throw Object.assign(new Error('媒体源发生变化或不支持分段下载。'), { rangeChanged: true })
        }
        return await saveResponse(part, target, {
          signal: combined,
          start,
          expected: end - start + 1,
          total,
          maxBytes,
          onProgress: (bytes) => {
            counts[index] = Math.max(counts[index], bytes)
            onProgress?.(
              counts.reduce((a, b) => a + b, 0),
              total,
            )
          },
        })
      } catch (error) {
        // Without a strong validator, retaining successful ranges across a new
        // request could silently combine different versions of the media.
        if (
          !etag ||
          attempt >= 2 ||
          combined.aborted ||
          error.progressFailure ||
          error.rangeChanged
        )
          throw error
        await delay(retryDelayMs * (attempt + 1), undefined, { signal: combined })
      }
    }
  })
  try {
    await Promise.all(tasks)
    return { bytes: total, parts: 3 }
  } catch (error) {
    controller.abort()
    await Promise.allSettled(tasks)
    throw error
  }
}

export async function saveRemote(
  urls,
  target,
  {
    referer,
    signal,
    onProgress,
    maxBytes = 8 * 1024 ** 3,
    parallel = true,
    open = openRemote,
    retryDelayMs,
  } = {},
) {
  let last
  for (const url of urls) {
    try {
      const headers = { Referer: referer || 'https://www.douyin.com/' }
      let response = await open(url, { headers, signal, timeout: 60000 })
      if (response.status !== 200) {
        response.stream.destroy()
        throw new Error(`媒体下载失败（${response.status}）。`)
      }
      const type = String(response.headers['content-type'] || '')
      if (/text\/|application\/(?:json|xml)/i.test(type)) {
        response.stream.destroy()
        throw new Error('媒体地址返回了错误页面，请重新解析链接。')
      }
      const total = Number(response.headers['content-length']) || 0
      if (total > maxBytes) {
        response.stream.destroy()
        throw new Error('文件超出本地初版的单文件大小限制。')
      }
      if (
        parallel &&
        total >= 8 * 1024 ** 2 &&
        /^bytes$/i.test(response.headers['accept-ranges'] || '')
      ) {
        try {
          return {
            ...(await saveRanges(response, target, {
              headers,
              signal,
              onProgress,
              maxBytes,
              open,
              total,
              retryDelayMs,
            })),
            type,
          }
        } catch (error) {
          if (signal?.aborted || error.progressFailure) throw error
          response = await open(url, { headers, signal, timeout: 60000 })
          if (response.status !== 200 || Number(response.headers['content-length']) !== total) {
            response.stream.destroy()
            throw new Error('媒体源发生变化，请重新解析。')
          }
        }
      }
      const bytes = await saveResponse(response, target, {
        signal,
        onProgress,
        maxBytes,
        total,
        expected: undefined,
      })
      if (total && bytes !== total) throw new Error('媒体文件没有下载完整，请重试。')
      return { bytes, type, parts: 1 }
    } catch (error) {
      last = error
      if (signal?.aborted || error.progressFailure) throw error
    }
  }
  throw last || new Error('没有可用的媒体地址。')
}
