import { stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import { PlatformResolver, newId } from './platforms/resolver.mjs'
import { browserResolve, closeBrowser } from './infrastructure/browser.mjs'
import { DownloadJobs } from './jobs/manager.mjs'
import { approvedUrl } from './infrastructure/network.mjs'
import { DownloadAccess } from './http/access.mjs'
import { MediaImages } from './media/images.mjs'
import { growingFile } from './media/streaming.mjs'

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(data))
}
async function body(req) {
  let text = ''
  for await (const chunk of req) {
    text += chunk
    if (Buffer.byteLength(text) > 20000) throw new Error('分享内容过长。')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求内容无效。')
  }
}
function disposition(name, download) {
  const extension = /\.(zip|mp4|jpg|jpeg|png)$/i.exec(name)?.[0] || '.jpg'
  return `${download ? 'attachment' : 'inline'}; filename="download${extension}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()]/g, escape)}`
}
function directImage(source) {
  if (!source) return ''
  try {
    const url = approvedUrl(source)
    url.protocol = 'https:'
    return url.href
  } catch {
    return ''
  }
}
export function createDownloaderApi({
  resolver: providedResolver,
  publicOrigins = [],
  trustProxy = false,
  galleryMode = 'complete',
  jobOptions = {},
} = {}) {
  const access = new DownloadAccess({ publicOrigins, trustProxy })
  const images = new MediaImages(),
    resolver = providedResolver || new PlatformResolver({ browserResolve, galleryMode }),
    jobs = new DownloadJobs(resolver, { images, publicMode: access.publicMode, ...jobOptions }),
    sessions = new Map()
  let resolving = 0
  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const [id, s] of sessions) if (now - s.created > 2 * 3600000) sessions.delete(id)
    access.prune()
    void jobs.prune().catch(() => console.error('download cache cleanup failed'))
  }, 60000)
  cleanup.unref()
  const publicResult = (session) => {
    const { result, id } = session
    const { assets, avatar, cover, ...rest } = result
    return {
      ...rest,
      sessionId: id,
      cover: cover ? `/api/downloader/media/${id}/cover` : '',
      directCover: directImage(cover),
      avatar: avatar ? `/api/downloader/media/${id}/avatar` : '',
      directAvatar: directImage(avatar),
      assets: assets.map(({ urls: _urls, photoUrls: _photos, thumbnail, cid: _cid, ...asset }) => ({
        ...asset,
        thumbnail: `/api/downloader/media/${id}/${asset.index}`,
        preview: `/api/downloader/media/${id}/${asset.index}?size=full`,
        directThumbnail: directImage(thumbnail),
        directPreview: directImage(
          asset.type === 'image' ? _urls?.[0] || thumbnail : _photos?.[0] || thumbnail,
        ),
      })),
    }
  }
  async function downloadFile(url, visitor, signal) {
    const parts = url.pathname.split('/').filter(Boolean)
    if (
      !/^\/api\/downloader\/jobs\/[0-9a-f]{36}\/(download|files\/[0-9a-f]{36})$/.test(url.pathname)
    )
      throw Object.assign(new Error('文件不存在。'), { status: 404 })
    const job = jobs.jobs.get(parts[3])
    if (!job || job.session.owner !== visitor.id)
      throw Object.assign(new Error('下载已过期，请重新解析。'), { status: 404 })
    if (parts[4] === 'download') await jobs.wait(job, signal)
    if (
      job.status !== 'done' &&
      !(parts[4] === 'files' && job.album && ['running', 'failed'].includes(job.status))
    )
      throw Object.assign(new Error(job.error || '文件尚未准备完成或已取消。'), {
        status: 409,
      })
    const file =
      parts[4] === 'download'
        ? job.archive || job.files[0]
        : [...job.files, job.archive].filter(Boolean).find((f) => f.id === parts[5])
    if (!file) throw Object.assign(new Error('文件不存在。'), { status: 404 })
    return {
      file,
      download: parts[4] === 'download' || url.searchParams.get('download') === '1',
    }
  }
  const handler = async (req, res, next) => {
    if (!req.url?.startsWith('/api/downloader')) return next()
    const url = new URL(req.url, 'http://localhost'),
      parts = url.pathname.split('/').filter(Boolean)
    const controller = new AbortController()
    req.on('aborted', () => controller.abort())
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })
    try {
      const visitor = access.authorize(req, res, {
        config: parts.length === 3 && parts[2] === 'config',
        health: parts.length === 3 && parts[2] === 'health',
      })
      if (req.method === 'GET' && parts.length === 3 && parts[2] === 'health')
        return json(res, jobs.draining ? 503 : 200, {
          status: jobs.draining ? 'draining' : 'ok',
          build: process.env.DOWNLOADER_BUILD || 'local',
        })
      if (req.method === 'GET' && parts.length === 3 && parts[2] === 'config')
        return json(res, 200, {
          token: visitor.csrf,
          mode: access.publicMode ? 'public' : 'local',
        })
      if (req.method === 'GET' && parts.length === 3 && parts[2] === 'authorize-file') {
        if (!jobs.fileServer) return json(res, 404, { error: '接口不存在。' })
        const original = req.headers['x-forwarded-uri']
        if (
          !['GET', 'HEAD'].includes(req.headers['x-forwarded-method']) ||
          typeof original !== 'string' ||
          !original.startsWith('/api/downloader/jobs/')
        )
          return json(res, 404, { error: '文件不存在。' })
        const { file, download } = await downloadFile(
          new URL(original, 'http://localhost'),
          visitor,
          controller.signal,
        )
        const relative = path.relative(jobs.tempDir, file.path)
        if (
          relative.startsWith('..') ||
          path.isAbsolute(relative) ||
          !relative.startsWith(path.basename(await jobs.root) + '/')
        )
          throw new Error('文件路径无效。')
        await stat(file.path)
        res.writeHead(204, {
          'X-Caibao-File': '/' + relative,
          'X-Caibao-Type': file.type,
          'X-Caibao-Disposition': disposition(file.name, download),
          'Cache-Control': 'no-store',
        })
        return res.end()
      }
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'resolve') {
        if (jobs.draining) return json(res, 503, { error: '下载服务正在维护，请稍后重试。' })
        if (resolving >= 2) return json(res, 429, { error: '正在解析其他作品，请稍后重试。' })
        access.consume(visitor, 'resolve', 20, 600000)
        const input = await body(req)
        resolving++
        try {
          let timing
          const result = await resolver.resolve(input.text, {
              signal: controller.signal,
              onTiming: (value) => {
                timing = value
              },
            }),
            id = newId()
          const session = { id, result, owner: visitor.id, created: Date.now() }
          sessions.set(id, session)
          if (sessions.size > 80) sessions.delete(sessions.keys().next().value)
          if (timing)
            res.setHeader(
              'Server-Timing',
              [
                `resolve;dur=${timing.elapsedMs}`,
                ...Object.entries(timing.stages)
                  .filter(([name]) => /^[a-z]+$/.test(name))
                  .map(([name, ms]) => `${name};dur=${ms}`),
              ].join(', '),
            )
          resolver.prefetch?.(result)
          return json(res, 200, publicResult(session))
        } finally {
          resolving--
        }
      }
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'jobs') {
        if (jobs.draining) return json(res, 503, { error: '下载服务正在维护，请稍后重试。' })
        const data = await body(req),
          session = sessions.get(data.sessionId)
        if (!session || session.owner !== visitor.id)
          throw new Error('作品信息已过期，请重新解析。')
        access.consume(visitor, 'jobs', 12, 600000)
        await jobs.ensureCapacity()
        return json(res, 201, jobs.create(session, data.indices, data.delivery))
      }
      if (parts[2] === 'jobs' && parts[3]) {
        const job = jobs.jobs.get(parts[3])
        if (!job || job.session.owner !== visitor.id)
          return json(res, 404, { error: '下载任务已过期。' })
        if (req.method === 'GET' && parts.length === 4) return json(res, 200, jobs.public(job))
        if (req.method === 'POST' && parts[4] === 'cancel') {
          jobs.cancel(job.id)
          return json(res, 200, jobs.public(job))
        }
        if (['GET', 'HEAD'].includes(req.method) && parts.length === 5 && parts[4] === 'stream') {
          if (!job.attachment) return json(res, 404, { error: '文件不存在。' })
          // HEAD/resume wait for the immutable completed file. Never pretend a
          // growing MP4 has a fixed length or serve ranges from a partial file.
          if (req.method === 'HEAD' || req.headers.range) await jobs.wait(job, controller.signal)
          if (['failed', 'cancelled'].includes(job.status))
            return json(res, 409, { error: job.error || '下载已取消。' })
          if (job.status === 'done') {
            res.writeHead(307, {
              Location: `/api/downloader/jobs/${job.id}/download`,
              'Cache-Control': 'no-store',
            })
            return res.end()
          }
          // Let the browser accept the attachment before resolving sources or
          // merging media. Do not invent a length or send placeholder file bytes.
          res.writeHead(200, {
            'Content-Type': job.attachment.type,
            'Content-Disposition': disposition(job.attachment.name, true),
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Accel-Buffering': 'no',
          })
          res.flushHeaders()
          await jobs.waitStream(job, controller.signal)
          // Once attachment headers have been sent, failure must break the
          // transfer, never turn an empty or truncated file into a success.
          if (['failed', 'cancelled'].includes(job.status))
            throw new Error(job.error || '下载已取消。')
          const source = job.stream?.bytes
            ? Readable.from(growingFile(job, controller.signal))
            : createReadStream((job.archive || job.files[0]).path)
          await pipeline(source, res, { signal: controller.signal })
          return
        }
        if (
          ['GET', 'HEAD'].includes(req.method) &&
          (parts[4] === 'download' || parts[4] === 'files')
        ) {
          const { file, download } = await downloadFile(url, visitor, controller.signal)
          const { size } = await stat(file.path)
          const range = req.headers.range
          let start = 0,
            end = size - 1,
            status = 200
          if (range) {
            const m = /^bytes=(\d*)-(\d*)$/.exec(range)
            if (!m || (!m[1] && !m[2])) {
              res.writeHead(416, { 'Content-Range': `bytes */${size}` })
              return res.end()
            }
            if (m[1]) {
              start = Number(m[1])
              end = m[2] ? Math.min(Number(m[2]), end) : end
            } else start = Math.max(0, size - Number(m[2]))
            if (
              !Number.isSafeInteger(start) ||
              !Number.isSafeInteger(end) ||
              start > end ||
              start >= size
            ) {
              res.writeHead(416, { 'Content-Range': `bytes */${size}` })
              return res.end()
            }
            status = 206
          }
          res.writeHead(status, {
            'Content-Type': file.type,
            'Content-Length': end - start + 1,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, no-store',
            'Content-Disposition': disposition(file.name, download),
            'X-Content-Type-Options': 'nosniff',
            ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
          })
          if (req.method === 'HEAD') return res.end()
          await pipeline(createReadStream(file.path, { start, end }), res, {
            signal: controller.signal,
          })
          return
        }
      }
      if (req.method === 'GET' && parts[2] === 'media' && parts.length === 5) {
        const session = sessions.get(parts[3])
        if (!session || session.owner !== visitor.id)
          return json(res, 404, { error: '预览已过期，请重新解析。' })
        const key = parts[4],
          asset = session.result.assets.find((a) => String(a.index) === key)
        const source =
          key === 'cover'
            ? session.result.cover
            : key === 'avatar'
              ? session.result.avatar
              : asset?.thumbnail
        if (!source) return json(res, 404, { error: '没有可用的预览图片。' })
        const full = url.searchParams.get('size') === 'full'
        const value = await images.preview(
          full && asset?.type === 'image'
            ? asset.urls[0]
            : full && asset?.type === 'livePhoto'
              ? asset.photoUrls[0]
              : source,
          {
            referer: session.result.url,
            signal: controller.signal,
            owner: visitor.id,
            size: full ? 'full' : key === 'cover' ? 'cover' : key === 'avatar' ? 'avatar' : 'thumb',
          },
        )
        res.writeHead(200, {
          'Content-Type': value.type,
          'Content-Length': value.data.length,
          'Cache-Control': 'private, max-age=600',
          'X-Content-Type-Options': 'nosniff',
        })
        res.end(value.data)
        return
      }
      json(res, 404, { error: '接口不存在。' })
    } catch (error) {
      if (controller.signal.aborted) return
      if (res.headersSent) {
        res.destroy(error)
        return
      }
      json(res, error.status || 400, { error: error.message || '操作失败，请重试。' })
    }
  }
  return {
    handler,
    beginDrain: () => jobs.beginDrain(),
    idle: () => jobs.idle(),
    close: async () => {
      clearInterval(cleanup)
      if (!providedResolver) await resolver.close()
      await closeBrowser()
      await jobs.close()
      await images.close()
    },
  }
}
