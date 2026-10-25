import { randomBytes } from 'node:crypto'
import {
  approvedUrl,
  openRemote,
  remoteText,
  remoteJson,
  MOBILE_UA,
  DESKTOP_UA,
} from '../infrastructure/network.mjs'
import { ExpiringCache, SharedWork, WorkPool } from '../infrastructure/cache.mjs'
import { withDeadline } from '../infrastructure/deadline.mjs'
import { douyinScriptItem } from './douyin.mjs'
import { bilibiliMetadata } from './bilibili.mjs'

const inputHosts = new Set([
  'b23.tv',
  'www.bilibili.com',
  'bilibili.com',
  'm.bilibili.com',
  'v.douyin.com',
  'www.douyin.com',
  'douyin.com',
  'www.iesdouyin.com',
  'iesdouyin.com',
])
export function shareUrl(text) {
  const normalized = String(text).replace(/\\([:_])/g, '$1')
  const link = normalized
    .match(/https?:\/\/[^\s<>「」“”\p{Script=Han}]+/iu)?.[0]
    ?.replace(/[，。；！、）】)\],.]+$/u, '')
  if (!link) throw new Error('请粘贴抖音或 B 站分享链接，也可以粘贴整段分享文字。')
  const u = approvedUrl(link)
  if (!inputHosts.has(u.hostname)) throw new Error('目前支持抖音和 B 站的作品链接。')
  if (u.protocol !== 'https:') u.protocol = 'https:'
  if (u.searchParams.has('p'))
    u.searchParams.set('p', u.searchParams.get('p').replace(/[，。；！）]+$/u, ''))
  return u
}
export function canonicalShareUrl(input) {
  const url = shareUrl(input)
  const bvid = url.pathname.match(/\/(BV[0-9A-Za-z]{10})(?:\/|$)/)?.[1]
  if (url.hostname.endsWith('bilibili.com') && bvid) {
    const current = Math.max(1, Math.floor(Number(url.searchParams.get('p')) || 1))
    return `https://www.bilibili.com/video/${bvid}/?p=${current}`
  }
  const id =
    url.pathname.match(/\/(?:video|note|slides)\/(\d{10,25})/)?.[1] ||
    url.searchParams.get('modal_id')
  if (url.hostname.endsWith('douyin.com') && /^\d{10,25}$/.test(id || ''))
    return `https://www.douyin.com/${/\/(?:note|slides)\//.test(url.pathname) ? 'note' : 'video'}/${id}`
  return url.href
}
const listUrls = (value) =>
  safeUrls(Array.isArray(value) ? value : value?.url_list || value?.urlList || [])
export function routerItem(html, id) {
  return douyinScriptItem(
    [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]),
    id,
  )
}
function safeUrls(values) {
  return (Array.isArray(values) ? values : [])
    .map((v) => (typeof v === 'string' ? v : v?.src))
    .filter((v) => {
      try {
        approvedUrl(v)
        return true
      } catch {
        return false
      }
    })
}
const cleanImageUrls = (values) =>
  safeUrls(values).filter((u) => !/(?:watermark|\/playwm\/|tplv[^?]*water)/i.test(u))
function douyinVideo(video = {}) {
  if (!video || typeof video !== 'object') return null
  const rates = video.bit_rate || video.bitRate || video.bitRateList
  const variants = (Array.isArray(rates) ? rates : []).map((v) => ({
    width: v.width || v.play_addr?.width || video.width || 0,
    height: v.height || v.play_addr?.height || video.height || 0,
    bitrate: v.bit_rate || v.bitRate || 0,
    urls: listUrls(v.play_addr || v.playAddr),
  }))
  variants.push({
    width: video.width || 0,
    height: video.height || 0,
    bitrate: 0,
    urls: listUrls(video.play_addr || video.playAddr),
  })
  for (const variant of variants) {
    variant.urls = variant.urls
      .map((value) => {
        const url = new URL(value)
        if (url.pathname.includes('/playwm/')) {
          url.pathname = url.pathname.replace('/playwm/', '/play/')
          url.searchParams.delete('logo_name')
          url.searchParams.set('ratio', '1080p')
        }
        return url.href
      })
      .filter((u) => !/(?:watermark|\/playwm\/|\.(?:mp3|m4a|aac)(?:\?|$)|mime_type=audio)/i.test(u))
  }
  return variants
    .filter((v) => v.urls.length)
    .sort((a, b) => b.width * b.height - a.width * a.height || b.bitrate - a.bitrate)[0]
}
export function needsGalleryHydration(item) {
  const images = item?.images || item?.image_post_info?.images || []
  return images.some(
    (image) =>
      !['video', 'clip_type', 'clipType', 'live_photo_type', 'livePhotoType'].some((key) =>
        Object.hasOwn(image, key),
      ),
  )
}
export function rankBilibiliVideo(videos) {
  return videos
    .filter((v) => v.baseUrl || v.base_url)
    .sort(
      (a, b) =>
        b.width * b.height - a.width * a.height ||
        b.id - a.id ||
        Number(/avc/i.test(b.codecs)) - Number(/avc/i.test(a.codecs)) ||
        b.bandwidth - a.bandwidth,
    )
}
export function douyinResult(item) {
  const images = item.images || item.image_post_info?.images || []
  const id = String(item.aweme_id || item.awemeId),
    author = item.author?.nickname || item.authorInfo?.nickname || '抖音作者'
  const common = {
    platform: 'douyin',
    id,
    title: item.desc || `抖音作品 ${id}`,
    author,
    url: `https://www.douyin.com/${images.length ? 'note' : 'video'}/${id}`,
    avatar: listUrls(item.author?.avatar_thumb || item.authorInfo?.avatarThumb)[0] || '',
    cover: listUrls(item.video?.cover || item.video?.coverUrlList)[0] || '',
    notice: '下载平台提供的无水印媒体；保持原始画质，不放大转码。',
  }
  if (images.length) {
    const assets = images.map((image, index) => {
      const sources = cleanImageUrls([
        ...listUrls(image.origin_image),
        ...listUrls(image.display_image),
        ...listUrls(image.url_list || image.urlList),
      ])
      if (!sources.length) throw new Error(`第 ${index + 1} 张图片没有返回无水印原图地址，请重试。`)
      const base = {
        index: index + 1,
        type: 'image',
        title: `图片 ${index + 1}`,
        width: image.width || image.origin_image?.width || 0,
        height: image.height || image.origin_image?.height || 0,
        urls: sources,
        thumbnail: cleanImageUrls(listUrls(image.thumbnail))[0] || sources[0],
      }
      const motion = douyinVideo(image.video)
      if (motion)
        return {
          ...base,
          type: 'livePhoto',
          title: `实况 ${index + 1}`,
          photoUrls: sources,
          urls: motion.urls,
          duration: (image.video.duration || 0) / 1000,
          motionWidth: motion.width,
          motionHeight: motion.height,
          quality: `${motion.width} × ${motion.height}`,
        }
      if (
        Number(image.live_photo_type || image.livePhotoType) > 0 ||
        Number(image.clip_type || image.clipType) === 5
      )
        throw new Error(`第 ${index + 1} 张是实况，但平台暂未返回动态片段，请稍后重试。`)
      return base
    })
    return { ...common, kind: 'images', cover: assets[0].thumbnail, assets }
  }
  const video = item.video || {}
  const chosen = douyinVideo(video)
  if (!chosen) throw new Error('作品没有返回可下载的视频。')
  const urls = chosen.urls
  if (!urls.length) throw new Error('未获取到无水印视频源，请重试。')
  return {
    ...common,
    kind: 'video',
    assets: [
      {
        index: 1,
        type: 'video',
        title: common.title,
        duration: (video.duration || item.duration || 0) / 1000,
        width: chosen.width,
        height: chosen.height,
        urls,
        thumbnail: common.cover,
        quality: `${chosen.width} × ${chosen.height}`,
      },
    ],
  }
}

export class PlatformResolver {
  constructor({
    browserResolve,
    requestJson = remoteJson,
    requestText = remoteText,
    open = openRemote,
    budgets = {},
    galleryMode = 'complete',
  } = {}) {
    this.browserResolve = browserResolve
    this.requestJson = requestJson
    this.requestText = requestText
    this.open = open
    this.galleryMode = galleryMode
    this.budgets = {
      total: 45000,
      cookie: 2500,
      page: 7000,
      metadata: 7000,
      browser: 25000,
      ...budgets,
    }
    this.visitor = null
    this.cache = new ExpiringCache()
    this.streamCache = new ExpiringCache({ maxEntries: 40, ttl: 45000 })
    this.shared = new SharedWork()
    this.prefetchPool = new WorkPool(2, 4)
    this.prefetchController = new AbortController()
  }
  async cookie(signal) {
    if (this.visitor?.until > Date.now()) return this.visitor.cookie
    return this.shared.run(
      'visitor-cookie',
      (active) =>
        withDeadline(active, this.budgets.cookie, async (bounded) => {
          const result = await this.requestText('https://live.douyin.com/', {
            headers: { 'User-Agent': DESKTOP_UA },
            signal: bounded,
          })
          bounded.throwIfAborted()
          const values = (result.headers['set-cookie'] || [])
            .map((x) => x.split(';')[0])
            .filter((x) => /^(ttwid|UIFID|UIFID_TEMP|__ac_nonce)=/.test(x))
          const cookie = values.join('; ')
          if (cookie) this.visitor = { cookie, until: Date.now() + 8 * 60000 }
          return cookie
        }),
      signal,
    )
  }
  async resolve(input, { signal, onTiming } = {}) {
    const started = performance.now(),
      stages = {}
    const measure = async (name, work) => {
      const began = performance.now()
      try {
        return await work()
      } finally {
        stages[name] = (stages[name] || 0) + Math.round(performance.now() - began)
      }
    }
    const key = canonicalShareUrl(input),
      cached = this.cache.get(key)
    signal?.throwIfAborted()
    if (cached) {
      onTiming?.({ elapsedMs: Math.round(performance.now() - started), cached: true, stages })
      return cached
    }
    try {
      return await this.shared.run(
        key,
        (active) =>
          withDeadline(
            active,
            this.budgets.total,
            async (bounded) => {
              const result = await this.resolveFresh(key, { signal: bounded, measure })
              active.throwIfAborted()
              bounded.throwIfAborted()
              return this.cache.set(key, result)
            },
            '解析平台超时，请稍后重试。',
          ),
        signal,
      )
    } finally {
      onTiming?.({ elapsedMs: Math.round(performance.now() - started), cached: false, stages })
    }
  }
  async close() {
    this.prefetchController.abort()
    await this.shared.close()
    this.cache.clear()
    this.streamCache.clear()
  }
  async resolveFresh(input, { signal, measure = (_name, work) => work() } = {}) {
    let url = shareUrl(input)
    if (url.hostname === 'b23.tv' || url.hostname === 'v.douyin.com') {
      const response = await measure('redirect', () =>
        withDeadline(signal, this.budgets.page, (bounded) =>
          this.open(url, { headers: { 'User-Agent': MOBILE_UA }, signal: bounded }),
        ),
      )
      response.stream.destroy()
      url = shareUrl(response.url)
      if (url.hostname === 'b23.tv' || url.hostname === 'v.douyin.com')
        throw new Error('分享短链没有返回作品地址，请使用完整链接。')
      return measure('detail', () => this.resolve(url.href, { signal }))
    }
    const bvid = url.pathname.match(/\/(BV[0-9A-Za-z]{10})(?:\/|$)/)?.[1]
    if (url.hostname.endsWith('bilibili.com') && bvid)
      return measure('metadata', () =>
        this.bilibili(bvid, Number(url.searchParams.get('p')) || 1, signal),
      )
    const id =
      url.pathname.match(/\/(?:video|note|slides)\/(\d{10,25})/)?.[1] ||
      url.searchParams.get('modal_id')
    if (!id || !/^\d{10,25}$/.test(id)) throw new Error('请使用视频或图文作品的分享链接。')
    // The public share page usually works without a cookie. Start it immediately
    // while refreshing the anonymous visitor, then retry only when needed.
    const initialCookie = this.visitor?.until > Date.now() ? this.visitor.cookie : ''
    const cookieTask = measure('visitor', () => this.cookie(signal)).catch(() => '')
    let item
    const isGallery = /\/(?:note|slides)\//.test(url.pathname)
    for (const type of new Set([isGallery ? 'note' : 'video', 'video'])) {
      const readPage = (cookie) =>
        measure('share', () =>
          withDeadline(signal, this.budgets.page, (bounded) =>
            this.requestText(`https://www.iesdouyin.com/share/${type}/${id}/`, {
              headers: { 'User-Agent': MOBILE_UA, Cookie: cookie },
              signal: bounded,
            }),
          ),
        ).catch(() => null)
      const page = await readPage(initialCookie)
      item = page && routerItem(page.text, id)
      if (!item && !initialCookie) {
        const cookie = await cookieTask
        signal?.throwIfAborted()
        if (cookie) {
          const retry = await readPage(cookie)
          item = retry && routerItem(retry.text, id)
        }
      }
      if (item) break
    }
    signal?.throwIfAborted()
    // Mobile share pages omit all motion fields, even for genuine Live Photos.
    // Confirm these galleries against desktop detail data before classifying.
    if (
      (!item || (this.galleryMode !== 'images' && needsGalleryHydration(item))) &&
      this.browserResolve
    )
      item = await measure('browser', () =>
        withDeadline(signal, this.budgets.browser, (bounded) =>
          this.browserResolve(id, isGallery || item?.images?.length ? 'note' : 'video', bounded, {
            galleryMode: this.galleryMode,
          }),
        ),
      )
    if (item && this.galleryMode !== 'images' && needsGalleryHydration(item))
      throw new Error('暂未获取到完整图文信息，无法确认是否包含实况，请稍后重试。')
    if (!item) throw new Error('抖音暂时没有返回作品内容，请稍后重试。')
    // Incremental website releases can retain the existing static-gallery
    // contract while the complete Live Photo interface is still local-only.
    if (this.galleryMode === 'images') {
      const images = item.images || item.image_post_info?.images
      if (images?.length)
        item = {
          ...item,
          images: images.map((image) => ({
            ...image,
            video: undefined,
            clip_type: 0,
            clipType: 0,
            live_photo_type: 0,
            livePhotoType: 0,
          })),
        }
    }
    return douyinResult(item)
  }
  async bilibili(bvid, current, signal) {
    const data = await bilibiliMetadata(bvid, {
      requestJson: (url, options) =>
        withDeadline(options.signal, this.budgets.metadata, (bounded) =>
          this.requestJson(url, { ...options, signal: bounded }),
        ),
      signal,
    })
    return {
      platform: 'bilibili',
      kind: 'video',
      id: data.bvid,
      title: data.title,
      author: data.owner?.name || '哔哩哔哩',
      cover: data.pic || '',
      avatar: data.owner?.face || '',
      url: `https://www.bilibili.com/video/${data.bvid}/`,
      notice:
        '免登录优先获取 1080P，自动选择平台实际提供的最高可用画质；原视频清晰度较低时使用对应画质。',
      current: Math.min(Math.max(1, current), data.pages.length),
      assets: data.pages.map((p) => ({
        index: p.page,
        type: 'video',
        title: p.part,
        cid: p.cid,
        duration: p.duration,
        width: p.dimension?.width || 0,
        height: p.dimension?.height || 0,
        thumbnail: p.first_frame || data.pic,
      })),
    }
  }
  async bilibiliStreams(result, asset, signal) {
    const key = `streams:${result.id}:${asset.cid}`,
      cached = this.streamCache.get(key)
    signal?.throwIfAborted()
    if (cached) return cached
    return this.shared.run(
      key,
      (active) =>
        withDeadline(active, this.budgets.metadata, async (bounded) => {
          const streams = await this.bilibiliStreamsFresh(result, asset, bounded)
          bounded.throwIfAborted()
          return this.streamCache.set(key, streams)
        }),
      signal,
    )
  }
  prefetch(result) {
    if (result.platform !== 'bilibili' || this.prefetchController.signal.aborted) return
    const asset = result.assets.find((a) => a.index === result.current) || result.assets[0]
    if (!asset) return
    void this.prefetchPool
      .run(() => this.bilibiliStreams(result, asset, this.prefetchController.signal), {
        signal: this.prefetchController.signal,
      })
      .catch(() => {})
  }
  async bilibiliStreamsFresh(result, asset, signal) {
    // The guest playback flag exposes the available 720P/1080P DASH streams.
    // Without it the API can advertise quality=64 while only returning 480P URLs.
    const response = await this.requestJson(
      `https://api.bilibili.com/x/player/playurl?bvid=${result.id}&cid=${asset.cid}&qn=80&fnval=4048&try_look=1`,
      { signal, headers: { Referer: result.url } },
    )
    if (response.code !== 0 || !response.data)
      throw new Error('B 站暂时没有返回视频播放地址，请重试。')
    const data = response.data
    const videos = rankBilibiliVideo(data.dash?.video || [])
    const audios = (data.dash?.audio || [])
      .filter((a) => a.baseUrl || a.base_url)
      .sort((a, b) => b.bandwidth - a.bandwidth)
    const addresses = (v) =>
      safeUrls([v.baseUrl || v.base_url, ...(v.backupUrl || v.backup_url || [])])
    if (videos.length && audios.length) {
      const v = videos[0]
      const support = data.support_formats?.find((q) => q.quality === v.id)
      return {
        video: addresses(v),
        audio: addresses(audios[0]),
        width: v.width,
        height: v.height,
        quality: support?.new_description || support?.display_desc || `${v.height}p`,
        referer: result.url,
      }
    }
    if (data.durl?.length)
      return {
        segments: data.durl.map((v) => safeUrls([v.url, ...(v.backup_url || [])])),
        quality:
          (data.accept_description || [])[(data.accept_quality || []).indexOf(data.quality)] ||
          `${data.quality}`,
        referer: result.url,
      }
    throw new Error('该视频当前没有可用的下载画质。')
  }
}
export const newId = () => randomBytes(18).toString('hex')
