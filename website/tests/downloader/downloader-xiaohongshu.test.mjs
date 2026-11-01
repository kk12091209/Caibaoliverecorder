import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { unzipSync } from 'fflate'
import { approvedUrl, MOBILE_UA } from '../../server/downloader/infrastructure/network.mjs'
import {
  PlatformResolver,
  canonicalShareUrl,
  shareUrl,
} from '../../server/downloader/platforms/resolver.mjs'
import {
  xiaohongshuNote,
  xiaohongshuImages,
  xiaohongshuResult,
  xiaohongshuVideo,
} from '../../server/downloader/platforms/xiaohongshu.mjs'
import { DownloadJobs } from '../../server/downloader/jobs/manager.mjs'
import { MediaImages } from '../../server/downloader/media/images.mjs'
import { runMedia } from '../../server/downloader/media/process.mjs'
import { mediaTool } from '../../server/downloader/media/tools.mjs'
import { browserResolveXiaohongshu } from '../../server/downloader/infrastructure/browser.mjs'

const id = '674051740000000007027a15'
const other = '6411cf99000000001300b6d9'
const url = `https://www.xiaohongshu.com/explore/${id}?xsec_token=test-signed-value%3D&xsec_source=app_share&app_platform=ios`
const photo = (n = 1) => ({
  width: 2400,
  height: 3200,
  fileId: `notes_pre_post/key-${n}`,
  urlDefault: `http://sns-webpic-qc.xhscdn.com/20261029/abcdef/notes_pre_post/key-${n}!nd_dft_wlteh_webp_3`,
})
const stream = (height = 1080, extra = {}) => ({
  width: (height * 16) / 9,
  height,
  streamType: 258,
  duration: 12000,
  masterUrl: `https://sns-video-bd.xhscdn.com/${height}.mp4`,
  ...extra,
})
const video = (extra = {}) => ({
  noteId: id,
  type: 'video',
  title: '测试 undefined 作品',
  user: { nickname: '作者' },
  imageList: [photo()],
  video: { media: { stream: { h264: [stream()] } } },
  ...extra,
})
const html = (note) =>
  `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [id]: { note } } } })};</script>`

test('XHS share text and canonical cache keys retain all signature/source parameters', () => {
  assert.equal(shareUrl(`推荐看看 ${url}，复制打开小红书`).href, url)
  assert.equal(canonicalShareUrl(url), url)
  assert.notEqual(
    canonicalShareUrl(url),
    canonicalShareUrl(url.replace('test-signed-value', 'new-signature')),
  )
  assert.equal(
    shareUrl('小红书 http://xhslink.com/o/example，').href,
    'https://xhslink.com/o/example',
  )
  assert.equal(
    shareUrl(
      '小个子这样穿好乖啊！！！！！ https://xhslink.cn/o/54WpHA6HDfP 跳转【小红书】看看笔记详情~',
    ).href,
    'https://xhslink.cn/o/54WpHA6HDfP',
  )
  for (const bad of [
    'https://www.xiaohongshu.com.evil.example/explore/' + id,
    'https://sns-video-bd.xhscdn.com/' + id,
    'https://www.xiaohongshu.com:444/explore/' + id,
    'https://user:secret@www.xiaohongshu.com/explore/' + id,
    'https://xhslink.cn.evil.example/o/example',
    'https://xhslink.cn:444/o/example',
    'https://user:secret@xhslink.cn/o/example',
  ])
    assert.throws(() => shareUrl(bad))
  for (const host of ['sns-img-bd.xhscdn.com', 'sns-webpic-qc.xhscdn.com', 'ci.xiaohongshu.com']) {
    assert.equal(approvedUrl(`https://${host}/file`).hostname, host)
    assert.throws(() => approvedUrl(`https://${host}.evil.example/file`))
  }
})

test('desktop/mobile serialized notes must match the requested note; undefined text is preserved', () => {
  assert.equal(
    xiaohongshuNote(html(video()).replace('};</script>', ',"unused":undefined};</script>'), id)
      .title,
    '测试 undefined 作品',
  )
  assert.equal(xiaohongshuNote(html(video({ noteId: other })), id), null)
  assert.equal(xiaohongshuNote(html(video()), other), null)
  const mobile = `<script>window.__INITIAL_STATE__=${JSON.stringify({ noteData: { data: { noteData: video() } } })}</script>`
  assert.equal(xiaohongshuNote(mobile, id).noteId, id)
  assert.equal(xiaohongshuNote(mobile.replace(id, other), id), null)
  globalThis.__caibaoUnsafeXhs = false
  assert.equal(
    xiaohongshuNote(
      `<script>window.__INITIAL_STATE__=(()=>{globalThis.__caibaoUnsafeXhs=true;return {}})()</script>`,
      id,
    ),
    null,
  )
  assert.equal(globalThis.__caibaoUnsafeXhs, false)
  delete globalThis.__caibaoUnsafeXhs
})

test('XHS galleries keep order and full-resolution sources independent of card thumbnails', () => {
  const images = Array.from({ length: 30 }, (_, i) => photo(i + 1))
  const result = xiaohongshuResult({ noteId: id, type: 'normal', imageList: images }, id, url)
  assert.equal(result.assets.length, 30)
  assert.equal(result.assets[29].index, 30)
  assert.equal(result.assets[29].urls[0], 'https://sns-img-bd.xhscdn.com/notes_pre_post/key-30')
  assert.equal(result.assets[0].width, 2400)
  assert.ok(result.assets.every((a) => a.urls.every((u) => !/!|\/w\/\d+/.test(u))))
  const derived = xiaohongshuImages({ ...photo(), fileId: '' })
  assert.deepEqual(derived.urls, result.assets[0].urls)
  assert.throws(
    () =>
      xiaohongshuResult(
        { type: 'normal', imageList: [{ urlPre: 'https://evil.example/card' }] },
        id,
        url,
      ),
    /原图/,
  )
  assert.equal(xiaohongshuImages({ fileId: '../private?token=secret' }).urls.length, 0)
})

test('XHS selects the best actual video and never falls back to a known watermarked stream', () => {
  const selected = xiaohongshuVideo({
    media: {
      stream: {
        h264: [stream(720), stream(2160, { streamType: 259 }), stream(1080)],
        h265: [stream(1080, { masterUrl: 'https://sns-video-bd.xhscdn.com/hevc' })],
      },
    },
  })
  assert.equal(selected.height, 1080)
  assert.equal(selected.urls[0], 'https://sns-video-bd.xhscdn.com/1080.mp4')
  for (const marked of [
    stream(1080, { streamType: 309 }),
    stream(1080, { hasWatermark: true }),
    stream(1080, { streamDesc: 'MINI_APP' }),
    stream(1080, { masterUrl: 'https://sns-video-bd.xhscdn.com/watermark/clip.mp4' }),
  ])
    assert.equal(xiaohongshuVideo({ media: { stream: { h264: [marked] } } }), null)
  const original = xiaohongshuVideo({
    consumer: { originVideoKey: 'stream/original.mp4' },
    media: { stream: { h264: [stream()] } },
  })
  assert.equal(original.urls[0], 'https://sns-video-bd.xhscdn.com/stream/original.mp4')
  assert.equal(original.urls[1], 'https://sns-video-bd.xhscdn.com/1080.mp4')
  assert.equal(
    xiaohongshuVideo({ consumer: { originVideoKey: 'https://evil.example/private' } }),
    null,
  )
  assert.throws(() => xiaohongshuResult(video({ video: {} }), id, url), /无水印视频源/)
})

test('XHS Live Photos retain their motion stream or report missing motion explicitly', () => {
  const result = xiaohongshuResult(
    { type: 'normal', imageList: [{ ...photo(), livePhoto: true, stream: { h264: [stream()] } }] },
    id,
    url,
  )
  assert.equal(result.assets[0].type, 'livePhoto')
  assert.equal(result.assets[0].photoUrls[0], xiaohongshuImages(photo()).urls[0])
  assert.equal(result.assets[0].urls[0], stream().masterUrl)
  assert.throws(
    () =>
      xiaohongshuResult({ type: 'normal', imageList: [{ ...photo(), livePhoto: true }] }, id, url),
    /动态片段/,
  )
})

test('new EF codec names select 1080P video with a separate AAC stream instead of a silent file', () => {
  const note = {
    media: {
      stream: {
        EF4: [stream(720, { videoCodec: 'EF4', audioCodec: 'aac', audioChannels: 2 })],
        EF5: [stream(1080, { videoCodec: 'EF5', audioChannels: 0, streamType: 3091 })],
      },
    },
    mediaV2: JSON.stringify({
      audio_stream: {
        AAC: [
          { audio_bitrate: 96000, master_url: 'https://sns-audio.xhscdn.com/low.m4a' },
          {
            audio_bitrate: 192000,
            master_url: 'https://sns-audio.xhscdn.com/high.m4a',
            backup_urls: ['https://sns-bak-v1.xhscdn.com/audio'],
          },
        ],
      },
    }),
  }
  const selected = xiaohongshuVideo(note)
  assert.equal(selected.height, 1080)
  assert.equal(selected.urls[0], stream(1080).masterUrl)
  assert.deepEqual(selected.audioUrls, [
    'https://sns-audio.xhscdn.com/high.m4a',
    'https://sns-bak-v1.xhscdn.com/audio',
  ])
  const withoutAudio = xiaohongshuVideo({ ...note, mediaV2: undefined })
  assert.equal(withoutAudio.height, 720)
  assert.equal(withoutAudio.audioUrls, undefined)
  assert.equal(xiaohongshuVideo({ media: { stream: { EF5: note.media.stream.EF5 } } }), null)
})

test('short links resolve without stripping signatures and XHS never calls Douyin or reads cookies', async () => {
  const reads = []
  const resolver = new PlatformResolver({
    open: async () => ({ url, stream: Readable.from([]) }),
    requestText: async (input, options) => {
      reads.push(input)
      assert.equal(input, url)
      assert.equal(options.headers['User-Agent'], MOBILE_UA)
      assert.equal(options.headers.Cookie, undefined)
      assert.equal(options.headers.Accept, 'text/html,application/xhtml+xml')
      assert.equal(options.headers['Accept-Encoding'], 'gzip, deflate, br')
      assert.equal(options.headers['Accept-Language'], 'zh-CN,zh;q=0.9,en;q=0.8')
      return { url, text: html(video()) }
    },
    browserResolve: () => assert.fail('no personal browser access'),
    requestJson: () => assert.fail('no API signatures or unrelated platform requests'),
  })
  try {
    for (const host of ['xhslink.com', 'xhslink.cn', 'www.xhslink.cn']) {
      const result = await resolver.resolve(
        `分享 http://${host}/o/example 跳转【小红书】看看笔记详情~`,
      )
      assert.equal(result.platform, 'xiaohongshu')
      assert.equal(result.url, url)
      assert.equal(result.assets[0].duration, 12)
    }
    await resolver.resolve(url)
    assert.equal(reads.length, 1)
  } finally {
    await resolver.close()
  }
})

test('anonymous browser fallback receives the exact signed URL and only follows a missing note', async () => {
  let calls = 0
  const resolver = new PlatformResolver({
    requestText: async () => ({ url: 'https://www.xiaohongshu.com/login', text: '<p>登录</p>' }),
    browserResolveXhs: async (input, signal) => {
      assert.equal(input, url)
      signal.throwIfAborted()
      calls++
      return video()
    },
  })
  try {
    assert.equal((await resolver.resolve(url)).platform, 'xiaohongshu')
    assert.equal(calls, 1)
  } finally {
    await resolver.close()
  }
  const complete = new PlatformResolver({
    requestText: async () => ({ url, text: html(video()) }),
    browserResolveXhs: () => assert.fail('already have complete note'),
  })
  try {
    assert.equal((await complete.resolve(url)).assets.length, 1)
  } finally {
    await complete.close()
  }
})

test('XHS browser fallback has a fresh anonymous context, blocks unknown requests and always closes', async () => {
  let closed = 0,
    policy,
    contextOptions
  const page = {
    route: async (_pattern, handler) => {
      policy = handler
    },
    goto: async (input) => assert.ok([url, 'https://www.xiaohongshu.com/'].includes(input)),
    locator: (selector) =>
      selector === 'script'
        ? { allTextContents: async () => [html(video()).slice(8, -9)] }
        : { innerText: async () => '' },
  }
  const getBrowser = async () => ({
    newContext: async (options) => {
      contextOptions = options
      return {
        newPage: async () => page,
        cookies: async () => [{ name: 'a1', value: 'anonymous-test-only' }],
        close: async () => {
          closed++
        },
      }
    },
  })
  assert.equal((await browserResolveXiaohongshu(url, undefined, { getBrowser })).noteId, id)
  assert.equal(closed, 1)
  assert.equal(contextOptions.storageState, undefined)
  let aborted = 0,
    continued = 0
  for (const [url, type] of [
    ['http://127.0.0.1/private', 'script'],
    ['https://evil.example/', 'script'],
    ['https://sns-webpic-qc.xhscdn.com/photo', 'image'],
    ['https://www.xiaohongshu.com/script.js', 'script'],
  ])
    await policy({
      request: () => ({ url: () => url, resourceType: () => type }),
      abort: () => aborted++,
      continue: () => continued++,
    })
  assert.equal(aborted, 3)
  assert.equal(continued, 1)
  page.locator = (selector) =>
    selector === 'script'
      ? { allTextContents: async () => [] }
      : { innerText: async () => '登录后继续' }
  await assert.rejects(
    browserResolveXiaohongshu(url, undefined, { getBrowser, timeout: 15 }),
    /要求登录/,
  )
  assert.ok(closed >= 2)
  const controller = new AbortController()
  page.goto = async () => {
    controller.abort(new Error('stopped'))
    throw new Error('closed')
  }
  await assert.rejects(browserResolveXiaohongshu(url, controller.signal, { getBrowser }), /stopped/)
  assert.ok(closed >= 3)
})

test('UA fallback, cancellation, unsupported pages and access failures have bounded safe behavior', async () => {
  let calls = 0
  const resolver = new PlatformResolver({
    requestText: async (input) => {
      calls++
      return { url: input, text: calls === 1 ? '<p>登录</p>' : html(video()) }
    },
  })
  try {
    assert.equal((await resolver.resolve(url)).id, id)
    assert.equal(calls, 2)
    await assert.rejects(
      resolver.resolve('https://www.xiaohongshu.com/user/profile/' + id),
      /单篇笔记/,
    )
    const stop = new AbortController()
    stop.abort(new Error('test cancelled'))
    await assert.rejects(resolver.resolve(url, { signal: stop.signal }), /test cancelled/)
  } finally {
    await resolver.close()
  }
  const blocked = new PlatformResolver({
    requestText: async () => ({
      url: 'https://www.xiaohongshu.com/404/sec_test',
      text: '<p>安全验证</p>',
    }),
  })
  try {
    await assert.rejects(blocked.resolve(url), (error) => {
      assert.match(error.message, /完整分享内容/)
      assert.doesNotMatch(error.message, /test-signed-value|xsec_token/)
      return true
    })
  } finally {
    await blocked.close()
  }
})

test('XHS images pass through the original-image pipeline, ZIP selection and fallback CDN', async () => {
  const source = await sharp({
    create: { width: 1200, height: 1800, channels: 3, background: '#b6d4d0' },
  })
    .jpeg()
    .toBuffer()
  const images = new MediaImages({
    open: async (input) => ({
      status: input.includes('sns-img-bd') ? 403 : 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': String(source.length) },
      stream: Readable.from([source]),
    }),
  })
  const jobs = new DownloadJobs({}, { images })
  try {
    const result = xiaohongshuResult(
      { type: 'normal', title: '图片', imageList: [photo(1), photo(2), photo(3)] },
      id,
      url,
    )
    const created = jobs.create({ owner: 'owner', result }, [1, 3])
    const job = jobs.jobs.get(created.id)
    await jobs.wait(job)
    assert.equal(job.status, 'done', job.error)
    assert.equal(job.files.length, 2)
    assert.deepEqual(
      job.files.map((f) => f.index),
      [1, 3],
    )
    for (const file of job.files) {
      assert.equal(file.width, 1200)
      assert.equal(file.height, 1800)
      assert.deepEqual(await readFile(file.path), source)
    }
    const zip = unzipSync(await readFile(job.archive.path))
    assert.equal(Object.keys(zip).length, 2)
    for (const bytes of Object.values(zip)) assert.deepEqual(Buffer.from(bytes), source)
  } finally {
    await jobs.close()
    await images.close()
  }
})

test('XHS video uses direct media download, keeps progressive MP4 bytes and avoids Bilibili APIs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caibao-xhs-video-'))
  const source = path.join(root, 'source.mp4')
  const audio = path.join(root, 'audio.m4a')
  let jobs
  try {
    await runMedia(await mediaTool('ffmpeg'), [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=320x240:r=10',
      '-t',
      '0.6',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-movflags',
      '+faststart',
      source,
    ])
    jobs = new DownloadJobs(
      { bilibiliStreams: () => assert.fail('wrong platform') },
      {
        saveMedia: async (urls, target, { onProgress }) => {
          const input = urls[0].endsWith('/qa-audio.m4a') ? audio : source
          if (input === source) assert.equal(urls[0], stream().masterUrl)
          await copyFile(input, target)
          const size = (await readFile(input)).length
          onProgress(size, size)
        },
      },
    )
    const created = jobs.create(
      { owner: 'owner', result: xiaohongshuResult(video(), id, url) },
      [1],
      'stream',
    )
    const job = jobs.jobs.get(created.id)
    await jobs.wait(job)
    assert.equal(job.status, 'done', job.error)
    assert.equal(job.originalMp4, 1)
    assert.equal(job.files[0].width, 320)
    assert.equal(job.files[0].height, 240)
    assert.deepEqual(await readFile(job.files[0].path), await readFile(source))
    await runMedia(await mediaTool('ffmpeg'), [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=f=440:r=48000',
      '-t',
      '0.6',
      '-c:a',
      'aac',
      audio,
    ])
    const split = xiaohongshuResult(
      video({
        video: {
          media: { stream: { EF5: [stream(1080, { audioChannels: 0 })] } },
          mediaV2: JSON.stringify({
            audio_stream: {
              AAC: [
                { master_url: 'https://sns-audio.xhscdn.com/qa-audio.m4a', audio_bitrate: 128000 },
              ],
            },
          }),
        },
      }),
      id,
      url,
    )
    const next = jobs.create({ owner: 'owner', result: split }, [1])
    const muxed = jobs.jobs.get(next.id)
    await jobs.wait(muxed)
    assert.equal(muxed.status, 'done', muxed.error)
    assert.equal(muxed.files[0].hasAudio, true)
    assert.equal(muxed.files[0].width, 320)
    assert.equal(muxed.files[0].height, 240)
    assert.ok(muxed.files[0].duration >= 0.6)
  } finally {
    await jobs?.close()
    await rm(root, { recursive: true, force: true })
  }
})
