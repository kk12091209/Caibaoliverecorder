import { approvedUrl, DESKTOP_UA, MOBILE_UA } from '../infrastructure/network.mjs'
import { withDeadline } from '../infrastructure/deadline.mjs'

const noteId = /^[\da-f]{24}$/i
export const xhsHosts = new Set(['xiaohongshu.com', 'www.xiaohongshu.com'])
export const xhsShortHosts = new Set([
  'xhslink.com',
  'www.xhslink.com',
  'xhslink.cn',
  'www.xhslink.cn',
])
export function xiaohongshuId(url) {
  return (
    url.pathname.match(/^\/(?:explore|discovery\/item)\/([\da-f]{24})(?:\/|$)/i)?.[1] ||
    url.pathname.match(/^\/user\/profile\/[\da-f]{24}\/([\da-f]{24})(?:\/|$)/i)?.[1]
  )?.toLowerCase()
}

// Parse serialized data only. Quoted "undefined" is text, and page code is
// never evaluated. Limit both the script size and the selected note identity.
export function xiaohongshuNote(html, id) {
  if (!noteId.test(id)) return null
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1].length > 12 * 1024 * 1024) continue
    const assignment = match[1].match(/^\s*window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)\s*;?\s*$/)
    if (!assignment) continue
    try {
      const state = JSON.parse(
        assignment[1].replace(/"(?:\\.|[^"\\])*"|\bundefined\b/g, (token) =>
          token === 'undefined' ? 'null' : token,
        ),
      )
      const selected = state.note?.noteDetailMap?.[id]?.note
      const mobile = state.noteData?.data?.noteData || state.noteData?.note
      for (const candidate of [selected, mobile]) {
        if (!candidate || typeof candidate !== 'object') continue
        const actual = candidate.noteId || candidate.id
        if (
          (actual && String(actual).toLowerCase() !== id.toLowerCase()) ||
          (!actual && candidate !== selected)
        )
          continue
        if (candidate.video || Array.isArray(candidate.imageList)) return candidate
      }
    } catch {
      // Unexpected executable syntax is not a supported data representation.
    }
  }
  return null
}

function mediaUrl(value) {
  if (typeof value !== 'string' || !value) return ''
  try {
    const url = approvedUrl(value.replace(/\\u002[fF]/g, '/'))
    if (
      !['xhscdn.com', 'xiaohongshu.com'].some(
        (root) => url.hostname === root || url.hostname.endsWith('.' + root),
      )
    )
      return ''
    if (/watermark|playwm|[?&](?:wm|watermark)=/i.test(url.href)) return ''
    url.protocol = 'https:'
    return url.href
  } catch {
    return ''
  }
}
const unique = (items) => [...new Set(items.filter(Boolean))]
const validKey = (value) =>
  typeof value === 'string' &&
  /^[\w-]+(?:\/[\w.-]+)*$/.test(value) &&
  !value.split('/').includes('..')
    ? value
    : ''

export function xiaohongshuImages(image = {}) {
  const info = Array.isArray(image.infoList) ? image.infoList : []
  const previews = unique(
    [image.urlDefault, image.url, ...info.map((v) => v?.url), image.urlPre].map(mediaUrl),
  )
  let key = validKey(image.fileId)
  if (!key)
    for (const value of previews) {
      const url = new URL(value)
      if (/^sns-webpic-[\w-]+\.xhscdn\.com$/.test(url.hostname)) {
        key = validKey(url.pathname.match(/^\/\d+\/[\da-z]+\/(.+?)(?:!|$)/i)?.[1])
      } else if (
        /^sns-img-[\w-]+\.xhscdn\.com$/.test(url.hostname) ||
        url.hostname === 'ci.xiaohongshu.com'
      ) {
        key = validKey(url.pathname.slice(1).split('!')[0])
      }
      if (key) break
    }
  // No resize directive: never download a card/preview as an original image.
  const urls = key
    ? [
        `https://sns-img-bd.xhscdn.com/${key}`,
        `https://ci.xiaohongshu.com/${key}?imageView2/format/jpg`,
        `https://sns-img-qc.xhscdn.com/${key}`,
      ]
    : []
  return { urls, thumbnail: previews[0] || urls[0] || '' }
}

export function xiaohongshuVideo(video = {}, { allowSilent = false } = {}) {
  let mediaV2 = video.mediaV2
  if (typeof mediaV2 === 'string') {
    try {
      mediaV2 = JSON.parse(mediaV2)
    } catch {
      mediaV2 = null
    }
  }
  const variants = []
  const stream = video.media?.stream || video.stream || mediaV2?.stream || {}
  for (const [codec, entries] of Object.entries(stream))
    for (const item of Array.isArray(entries) ? entries : []) {
      if (!item || typeof item !== 'object') continue
      if (
        [259, 309].includes(Number(item.streamType ?? item.stream_type)) ||
        item.hasWatermark ||
        item.isWatermark ||
        /watermark|mini.?app/i.test(item.streamDesc || item.stream_desc || '')
      )
        continue
      const backup = item.backupUrls || item.backup_urls
      const urls = unique(
        [item.masterUrl || item.master_url, ...(Array.isArray(backup) ? backup : [])].map(mediaUrl),
      )
      if (!urls.length) continue
      variants.push({
        urls,
        width: Number(item.width) || 0,
        height: Number(item.height) || 0,
        duration: (Number(item.duration) || 0) / 1000,
        bitrate:
          Number(item.avgBitrate || item.avg_bitrate || item.videoBitrate || item.video_bitrate) ||
          0,
        codec: codec === 'EF4' ? 'h264' : codec,
        videoOnly:
          Number(item.audioChannels ?? item.audio_channels) === 0 &&
          !(item.audioCodec || item.audio_codec),
      })
    }
  variants.sort(
    (a, b) =>
      b.width * b.height - a.width * a.height ||
      Number(b.codec === 'h264') - Number(a.codec === 'h264') ||
      b.bitrate - a.bitrate,
  )
  const audio = Object.values(mediaV2?.audio_stream || video.media?.audioStream || {})
    .flatMap((entries) => (Array.isArray(entries) ? entries : []))
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const backup = entry.backupUrls || entry.backup_urls
      return {
        bitrate:
          Number(
            entry.audioBitrate || entry.audio_bitrate || entry.avgBitrate || entry.avg_bitrate,
          ) || 0,
        urls: unique(
          [entry.masterUrl || entry.master_url, ...(Array.isArray(backup) ? backup : [])].map(
            mediaUrl,
          ),
        ),
      }
    })
    .filter((entry) => entry.urls.length)
    .sort((a, b) => b.bitrate - a.bitrate)[0]
  let best = variants.find((entry) => !entry.videoOnly || audio || allowSilent)
  const origin =
    video.consumer?.originVideoKey ||
    video.originVideoKey ||
    mediaV2?.video?.consumer?.originVideoKey ||
    mediaV2?.consumer?.originVideoKey
  const original =
    mediaUrl(origin) || (validKey(origin) ? `https://sns-video-bd.xhscdn.com/${origin}` : '')
  const opaque = mediaV2?.video?.opaque1 || {}
  const originals = unique([
    original,
    mediaUrl(opaque.hd_screencast_stream),
    mediaUrl(opaque.default_screencast_stream),
  ])
  // An original MP4 and a separate video-only stream cannot share one audio
  // contract. Only append complete MP4 alternatives to an original source.
  if (originals.length) best = variants.find((entry) => !entry.videoOnly || allowSilent)
  const urls = unique([...originals, ...(best?.urls || [])])
  if (!urls.length) return null
  return {
    width: Number(video.width || video.basicInfo?.width) || best?.width || 0,
    height: Number(video.height || video.basicInfo?.height) || best?.height || 0,
    duration: best?.duration || Number(video.basicInfo?.duration) || 0,
    urls,
    ...(!originals.length && best?.videoOnly && audio ? { audioUrls: audio.urls } : {}),
  }
}

export function xiaohongshuResult(note, id, url) {
  const images = Array.isArray(note.imageList) ? note.imageList : []
  const common = {
    platform: 'xiaohongshu',
    id,
    title: note.title || note.desc || `小红书笔记 ${id}`,
    author: note.user?.nickname || note.user?.nickName || '小红书作者',
    avatar: mediaUrl(note.user?.avatar),
    url,
    cover: images.length ? xiaohongshuImages(images[0]).thumbnail : '',
    notice: '下载平台返回的无水印原图或视频源，不放大转码；作者已嵌入画面的文字和水印会保留。',
  }
  if (note.type === 'video' || (note.video && note.type !== 'normal')) {
    const chosen = xiaohongshuVideo(note.video)
    if (!chosen) throw new Error('小红书没有返回可用的无水印视频源，请重新复制完整分享链接后重试。')
    return {
      ...common,
      kind: 'video',
      assets: [
        {
          index: 1,
          type: 'video',
          title: common.title,
          ...chosen,
          thumbnail: common.cover,
          quality:
            chosen.width && chosen.height ? `${chosen.width} × ${chosen.height}` : '原始视频源',
        },
      ],
    }
  }
  if (!images.length) throw new Error('小红书没有返回可下载的图片，请重新复制完整分享链接后重试。')
  const assets = images.map((image, i) => {
    const sources = xiaohongshuImages(image)
    if (!sources.urls.length) throw new Error(`第 ${i + 1} 张图片没有返回原图地址，请稍后重试。`)
    const base = {
      index: i + 1,
      type: 'image',
      title: `图片 ${i + 1}`,
      width: Number(image.width) || 0,
      height: Number(image.height) || 0,
      ...sources,
    }
    if (!image.livePhoto) return base
    const motion = xiaohongshuVideo({ stream: image.stream }, { allowSilent: true })
    if (!motion) throw new Error(`第 ${i + 1} 张是实况，但平台没有返回动态片段，请稍后重试。`)
    return {
      ...base,
      type: 'livePhoto',
      title: `实况 ${i + 1}`,
      photoUrls: sources.urls,
      urls: motion.urls,
      ...(motion.audioUrls ? { audioUrls: motion.audioUrls } : {}),
      duration: motion.duration,
      motionWidth: motion.width,
      motionHeight: motion.height,
    }
  })
  return { ...common, kind: 'images', assets }
}

export async function resolveXiaohongshu(
  url,
  { requestText, browserResolve, signal, timeout = 7000 } = {},
) {
  const id = xiaohongshuId(url)
  if (!id) throw new Error('请使用小红书单篇笔记的完整分享链接，暂不支持主页或合集。')
  const agents =
    url.searchParams.get('xsec_source') === 'app_share' || url.searchParams.has('app_platform')
      ? [MOBILE_UA, DESKTOP_UA]
      : [DESKTOP_UA, MOBILE_UA]
  let failure
  for (const agent of agents) {
    let note
    signal?.throwIfAborted()
    try {
      const response = await withDeadline(
        signal,
        timeout,
        (bounded) =>
          requestText(url.href, {
            signal: bounded,
            headers: {
              'User-Agent': agent,
              Accept: 'text/html,application/xhtml+xml',
              'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
              'Accept-Encoding': 'gzip, deflate, br',
              Referer: 'https://www.xiaohongshu.com/',
            },
          }),
        '连接小红书超时，请稍后重试。',
      )
      signal?.throwIfAborted()
      const final = approvedUrl(response.url || url)
      if (!xhsHosts.has(final.hostname)) continue
      note = xiaohongshuNote(response.text, id)
      if (/^\/404\/?$/.test(final.pathname) && final.searchParams.get('source') === 'note')
        throw Object.assign(new Error('该小红书笔记已失效或不公开，无法下载。'), {
          code: 'XHS_UNAVAILABLE',
        })
    } catch (error) {
      signal?.throwIfAborted()
      if (error.code === 'XHS_UNAVAILABLE') throw error
      failure = error
    }
    if (note) return xiaohongshuResult(note, id, url.href)
  }
  if (browserResolve) {
    const note = await browserResolve(url.href, signal)
    signal?.throwIfAborted()
    if (note) return xiaohongshuResult(note, id, url.href)
  }
  // Never expose signed URLs or read a user's browser cookies to work around
  // a login/verification response. A new full share link may still work.
  throw new Error(
    failure?.message === '连接小红书超时，请稍后重试。'
      ? '连接小红书超时，请稍后重试。'
      : '小红书暂未开放这条笔记的媒体信息，可能需要登录、验证或分享链接已过期。请从小红书重新复制完整分享内容后重试。',
  )
}
