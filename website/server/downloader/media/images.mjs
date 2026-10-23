import sharp from 'sharp'
import { openRemote } from '../infrastructure/network.mjs'
import { ExpiringCache, WorkPool, waitFor } from '../infrastructure/cache.mjs'

sharp.concurrency(1)
sharp.cache({ memory: 16, files: 0, items: 32 })
const maxInputBytes = 40 * 1024 ** 2
const inputOptions = { limitInputPixels: 40000000, failOn: 'error' }

export async function compatibleImage(input) {
  const image = sharp(input, inputOptions),
    metadata = await image.metadata()
  // Existing JPEG/PNG files can keep their original bytes and resolution.
  if (metadata.format === 'jpeg')
    return {
      data: input,
      type: 'image/jpeg',
      extension: 'jpg',
      width: metadata.width,
      height: metadata.height,
    }
  if (metadata.format === 'png')
    return {
      data: input,
      type: 'image/png',
      extension: 'png',
      width: metadata.width,
      height: metadata.height,
    }
  const output = metadata.hasAlpha
    ? await image.rotate().png({ compressionLevel: 6 }).toBuffer({ resolveWithObject: true })
    : await image
        .rotate()
        .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
        .toBuffer({ resolveWithObject: true })
  return {
    data: output.data,
    type: metadata.hasAlpha ? 'image/png' : 'image/jpeg',
    extension: metadata.hasAlpha ? 'png' : 'jpg',
    width: output.info.width,
    height: output.info.height,
  }
}

export class MediaImages {
  constructor({ open = openRemote, maxBytes = 64 * 1024 ** 2 } = {}) {
    this.open = open
    this.cache = new ExpiringCache({ maxBytes, maxEntries: 160, ttl: 600000 })
    this.pending = new Map()
    this.fetches = new WorkPool(4)
    this.conversions = new WorkPool(1)
    this.controller = new AbortController()
  }
  async cached(key, load, signal) {
    const cached = this.cache.get(key)
    if (cached) return cached
    let pending = this.pending.get(key)
    if (!pending) {
      pending = load()
        .then((value) => this.cache.set(key, value, value.data.length))
        .finally(() => this.pending.delete(key))
      this.pending.set(key, pending)
    }
    return waitFor(pending, signal)
  }
  async original(urls, { referer, signal, onProgress } = {}) {
    const result = await this.cached(
      'raw:' + urls.join('\n'),
      () =>
        this.fetches.run(async () => {
          let last
          for (const url of urls) {
            try {
              const response = await this.open(url, {
                headers: { Referer: referer },
                signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(45000)]),
              })
              const type = response.headers['content-type'] || '',
                total = Number(response.headers['content-length']) || 0
              if (
                response.status !== 200 ||
                !/^image\/(?:jpe?g|png|webp|avif|gif|bmp|heic|heif)(?:;|$)/i.test(type) ||
                total > maxInputBytes
              ) {
                response.stream.destroy()
                throw new Error('图片地址没有返回可处理的图片。')
              }
              const chunks = []
              let bytes = 0
              for await (const chunk of response.stream) {
                bytes += chunk.length
                if (bytes > maxInputBytes) {
                  response.stream.destroy()
                  throw new Error('图片文件过大。')
                }
                chunks.push(chunk)
              }
              if (!bytes || (total && bytes !== total)) throw new Error('图片未下载完整，请重试。')
              return { data: Buffer.concat(chunks), type: type.split(';')[0] }
            } catch (error) {
              last = error
              if (this.controller.signal.aborted) throw error
            }
          }
          throw last || new Error('没有可用的图片地址。')
        }),
      signal,
    )
    signal?.throwIfAborted()
    onProgress?.(result.data.length, result.data.length)
    return result
  }
  async download(urls, options = {}) {
    const key = 'compatible:' + urls.join('\n'),
      cached = this.cache.get(key)
    options.signal?.throwIfAborted()
    if (cached) {
      options.onProgress?.(cached.sourceBytes, cached.sourceBytes)
      return cached
    }
    const original = await this.original(urls, options)
    return this.cached(
      key,
      () =>
        this.conversions.run(async () => ({
          ...(await compatibleImage(original.data)),
          sourceBytes: original.data.length,
        })),
      options.signal,
    )
  }
  async preview(source, { referer, signal, size = 'thumb' } = {}) {
    const width = size === 'avatar' ? 128 : size === 'cover' ? 800 : 360
    const key = `preview:${width}:${source}`,
      cached = size === 'full' ? null : this.cache.get(key)
    signal?.throwIfAborted()
    if (cached) return cached
    const original = await this.original([source], { referer, signal })
    if (size === 'full') return original
    return this.cached(
      key,
      () =>
        this.conversions.run(async () => ({
          data: await sharp(original.data, inputOptions)
            .rotate()
            .resize({ width, withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer(),
          type: 'image/jpeg',
        })),
      signal,
    )
  }
  async close() {
    this.controller.abort()
    await Promise.allSettled(this.pending.values())
    this.cache.clear()
  }
}
