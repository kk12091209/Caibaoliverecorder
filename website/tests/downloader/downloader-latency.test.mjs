import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { PlatformResolver } from '../../server/downloader/platforms/resolver.mjs'
import { browserResolve } from '../../server/downloader/infrastructure/browser.mjs'
import { DownloadJobs } from '../../server/downloader/jobs/manager.mjs'
import { withDeadline } from '../../server/downloader/infrastructure/deadline.mjs'

const id = '7695703753870370895'
const video = {
  aweme_id: id,
  desc: '测试视频',
  video: {
    width: 1080,
    height: 1920,
    play_addr: { url_list: ['https://v3.douyinvod.com/video.mp4'] },
  },
}
const html = (item) =>
  `<script id="RENDER_DATA">${encodeURIComponent(JSON.stringify({ aweme_detail: item }))}</script>`
const bv = 'BV1QHeM6fEw8'
const metadata = {
  code: 0,
  data: {
    bvid: bv,
    title: '公开视频',
    pages: [1, 2].map((page) => ({ page, cid: 100 + page, part: `P${page}`, duration: 20 })),
  },
}

test('an anonymous share result does not wait for the visitor-cookie request', async () => {
  let release,
    shareCalls = 0
  const cookie = new Promise((resolve) => {
    release = resolve
  })
  const resolver = new PlatformResolver({
    requestText: async (url, { signal }) => {
      if (url.includes('live.douyin')) {
        await cookie
        signal.throwIfAborted()
        return { headers: {} }
      }
      shareCalls++
      return { text: html(video) }
    },
  })
  try {
    const result = await Promise.race([
      resolver.resolve(`https://www.douyin.com/video/${id}`),
      delay(500).then(() => {
        throw Error('share was blocked by cookie')
      }),
    ])
    assert.equal(result.id, id)
    assert.equal(shareCalls, 1)
  } finally {
    release()
    await resolver.close()
  }
})

test('tracking variants and a resolved short link reuse a canonical result while preserving the selected P', async () => {
  let calls = 0,
    redirects = 0
  const resolver = new PlatformResolver({
    requestJson: async () => {
      calls++
      return metadata
    },
    open: async () => {
      redirects++
      return {
        url: `https://www.bilibili.com/video/${bv}/?p=2&spm_id_from=share`,
        stream: Readable.from([]),
      }
    },
  })
  try {
    const a = await resolver.resolve(`https://www.bilibili.com/video/${bv}/?p=2&share_source=copy`)
    const b = await resolver.resolve(`https://m.bilibili.com/video/${bv}?p=2&from=search`)
    const c = await resolver.resolve('https://b23.tv/example')
    assert.equal(a.current, 2)
    assert.equal(b.current, 2)
    assert.equal(c.current, 2)
    assert.equal(calls, 1)
    assert.equal(redirects, 1)
    assert.equal((await resolver.resolve(`https://www.bilibili.com/video/${bv}/?p=1`)).current, 1)
  } finally {
    await resolver.close()
  }
})

test('an overall deadline aborts slow work and a subsequent request can succeed', async () => {
  const resolver = new PlatformResolver({ budgets: { total: 30 } })
  resolver.resolveFresh = (_url, { signal }) => delay(300, {}, { signal })
  try {
    await assert.rejects(resolver.resolve(`https://www.douyin.com/video/${id}`), /解析平台超时/)
    resolver.resolveFresh = async () => ({ id })
    assert.deepEqual(await resolver.resolve(`https://www.douyin.com/video/${id}`), { id })
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      withDeadline(controller.signal, 20, () => assert.fail('aborted work started')),
      { name: 'AbortError' },
    )
  } finally {
    await resolver.close()
  }
})

test('browser detail can finish before navigation, and shutdown drains that navigation', async () => {
  const page = new EventEmitter()
  let rejectNavigation,
    scripts = 0,
    closed = false
  page.route = async () => {}
  page.goto = () => {
    queueMicrotask(() =>
      page.emit('response', {
        url: () => 'https://www.douyin.com/aweme/detail/',
        json: async () => ({ aweme_detail: video }),
      }),
    )
    return new Promise((_, reject) => {
      rejectNavigation = reject
    })
  }
  page.locator = () => ({
    allTextContents: async () => {
      scripts++
      return []
    },
    innerText: async () => '',
  })
  const context = {
    newPage: async () => page,
    close: async () => {
      closed = true
      rejectNavigation?.(Error('closed'))
    },
  }
  const result = await browserResolve(id, 'video', undefined, {
    timeout: 500,
    getBrowser: async () => ({ newContext: async () => context }),
  })
  assert.equal(result.aweme_id, id)
  assert.equal(closed, true)
  assert.equal(scripts, 0)
})

test('incomplete gallery data cannot win the early browser response race', async () => {
  const page = new EventEmitter()
  let release
  const incomplete = { aweme_id: id, images: [{ url_list: ['https://p.douyinpic.com/a.jpg'] }] }
  const complete = { ...incomplete, images: [{ ...incomplete.images[0], clip_type: 0 }] }
  page.route = async () => {}
  page.goto = async () => {
    page.emit('response', {
      url: () => 'https://www.douyin.com/aweme/detail/',
      json: async () => ({ aweme_detail: incomplete }),
    })
    await delay(15)
    page.emit('response', {
      url: () => 'https://www.douyin.com/aweme/detail/',
      json: async () => ({ aweme_detail: complete }),
    })
    await new Promise((resolve) => {
      release = resolve
    })
  }
  page.locator = () => ({ allTextContents: async () => [], innerText: async () => '' })
  const result = await browserResolve(id, 'note', undefined, {
    timeout: 500,
    getBrowser: async () => ({
      newContext: async () => ({ newPage: async () => page, close: async () => release?.() }),
    }),
  })
  assert.equal(result.images[0].clip_type, 0)
})

test('playback address prefetch shares in-flight work, retains quality, and never fetches media', async () => {
  let calls = 0
  const resolver = new PlatformResolver({
    requestJson: async (url) => {
      assert.match(url, /\/playurl\?/)
      calls++
      await delay(30)
      return {
        code: 0,
        data: {
          dash: {
            video: [{ width: 1920, height: 1080, baseUrl: 'https://a.bilivideo.com/v' }],
            audio: [{ baseUrl: 'https://a.bilivideo.com/a' }],
          },
        },
      }
    },
  })
  const result = {
    platform: 'bilibili',
    id: bv,
    url: `https://www.bilibili.com/video/${bv}`,
    current: 2,
    assets: [
      { index: 1, cid: 101 },
      { index: 2, cid: 102 },
    ],
  }
  try {
    resolver.prefetch(result)
    await delay(0)
    const streams = await resolver.bilibiliStreams(result, result.assets[1])
    assert.equal(streams.width, 1920)
    assert.equal(calls, 1)
    assert.deepEqual(await resolver.bilibiliStreams(result, result.assets[1]), streams)
    assert.equal(calls, 1)
  } finally {
    await resolver.close()
  }
})

test('a preview reuses its owners active native video but never another owners job or an album', async () => {
  const resolver = {
    bilibiliStreams: async (_result, _asset, signal) => {
      await delay(500, {}, { signal })
      throw Error('stop')
    },
  }
  const jobs = new DownloadJobs(resolver)
  const session = {
    owner: 'one',
    result: {
      platform: 'bilibili',
      id: bv,
      kind: 'video',
      title: 'test',
      assets: [{ index: 1, type: 'video' }],
    },
  }
  try {
    const a = jobs.create(session, [1], 'stream')
    assert.equal(jobs.create(session, [1], 'preview').id, a.id)
    assert.equal(jobs.create(session, [1], 'stream').id, a.id)
    assert.notEqual(jobs.create({ ...session, owner: 'two' }, [1], 'preview').id, a.id)
    assert.notEqual(jobs.create(session, [1], 'album').id, a.id)
    assert.equal(jobs.jobs.size, 3)
  } finally {
    await jobs.close()
  }
})

test('the scoped website release keeps static galleries without waiting for motion hydration', async () => {
  let browsers = 0
  const item = {
    aweme_id: id,
    images: [{ url_list: ['https://p.douyinpic.com/a.jpg'], video: video.video }],
  }
  const resolver = new PlatformResolver({
    galleryMode: 'images',
    requestText: async (url) =>
      url.includes('live.douyin') ? { headers: {} } : { text: html(item) },
    browserResolve: async () => {
      browsers++
      throw Error('unexpected browser')
    },
  })
  try {
    const result = await resolver.resolve(`https://www.douyin.com/note/${id}`)
    assert.equal(result.kind, 'images')
    assert.equal(result.assets[0].type, 'image')
    assert.equal(browsers, 0)
  } finally {
    await resolver.close()
  }
})
