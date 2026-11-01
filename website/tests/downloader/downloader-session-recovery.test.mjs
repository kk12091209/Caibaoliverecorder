import test from 'node:test'
import assert from 'node:assert/strict'
import { DownloadAccess } from '../../server/downloader/http/access.mjs'

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

test('a second tab rotating the shared visitor cookie does not strand the first tab token', async () => {
  let now = 1000,
    cookie = '',
    resolves = 0
  const access = new DownloadAccess({ publicOrigins: ['https://caibao.media'], now: () => now })
  const original = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    try {
      const config = url.endsWith('/config')
      const visitor = access.authorize(
        {
          method: options.method || 'GET',
          socket: { remoteAddress: '203.0.113.1' },
          headers: {
            host: 'caibao.media',
            cookie,
            'x-downloader-token': options.headers?.['X-Downloader-Token'],
          },
        },
        {
          setHeader(name, value) {
            if (name === 'Set-Cookie') cookie = value.split(';')[0]
          },
        },
        { config },
      )
      if (config) return json({ token: visitor.csrf })
      resolves++
      access.touch(visitor)
      return json({ sessionId: 'accepted' })
    } catch (error) {
      return json({ error: error.message, code: error.code }, error.status)
    }
  }
  try {
    const a =
      await import('../../src/features/downloader/lib/media-downloader.ts?shared-cookie-tab-a')
    const b =
      await import('../../src/features/downloader/lib/media-downloader.ts?shared-cookie-tab-b')
    await a.prepareDownloaderSession()
    const firstCookie = cookie
    now += 120001
    await b.prepareDownloaderSession()
    assert.notEqual(cookie, firstCookie)
    assert.equal((await a.mediaPost('resolve', { text: 'x' })).sessionId, 'accepted')
    assert.equal(resolves, 1)
  } finally {
    globalThis.fetch = original
  }
})

test('simultaneous expired resolves refresh once while platform sessions stay independent', async () => {
  const original = globalThis.fetch,
    configs = new Map(),
    attempts = []
  globalThis.fetch = async (url, options = {}) => {
    const base = url.slice(0, url.lastIndexOf('/'))
    if (url.endsWith('/config')) {
      const count = (configs.get(base) || 0) + 1
      configs.set(base, count)
      return json({ token: `${base}:${count}` })
    }
    const csrf = options.headers['X-Downloader-Token']
    attempts.push({ url, csrf })
    if (csrf === '/api/downloader:1') return json({ error: 'expired' }, 401)
    return json({ sessionId: `${base}:session` })
  }
  try {
    const { mediaPost, prepareDownloaderSession } =
      await import('../../src/features/downloader/lib/media-downloader.ts?recovery-race')
    await prepareDownloaderSession()
    await Promise.all([mediaPost('resolve', { text: 'a' }), mediaPost('resolve', { text: 'b' })])
    await mediaPost('resolve', { text: 'https://xhslink.cn/o/test' })
    assert.equal(configs.get('/api/downloader'), 2)
    assert.equal(configs.get('/api/downloader-xhs-v2'), 1)
    assert.equal(attempts.filter((x) => x.csrf === '/api/downloader:2').length, 2)
    assert.equal(attempts.at(-1).url, '/api/downloader-xhs-v2/resolve')
  } finally {
    globalThis.fetch = original
  }
})

test('expired-session retry is bounded and never replays job mutations or ambiguous failures', async () => {
  const original = globalThis.fetch
  try {
    for (const [path, status, expectedPosts, expectedConfigs] of [
      ['resolve', 401, 2, 2],
      ['jobs', 401, 1, 1],
      ['jobs/id/cancel', 401, 1, 1],
      ['resolve', 403, 1, 1],
      ['resolve', 429, 1, 1],
      ['resolve', 0, 1, 1],
    ]) {
      let posts = 0,
        configs = 0
      globalThis.fetch = async (url) => {
        if (url.endsWith('/config')) return json({ token: String(++configs) })
        posts++
        if (!status) throw new TypeError('network lost after sending')
        return json({ error: 'fixture failure' }, status)
      }
      const { mediaPost } = await import(
        `../../src/features/downloader/lib/media-downloader.ts?recovery-${path}-${status}`
      )
      await assert.rejects(mediaPost(path, { text: 'x' }), /fixture failure|network lost/)
      assert.equal(posts, expectedPosts)
      assert.equal(configs, expectedConfigs)
    }
  } finally {
    globalThis.fetch = original
  }
})

test('cancellation during session recovery prevents the second resolve submission', async () => {
  const original = globalThis.fetch,
    controller = new AbortController()
  let configs = 0,
    posts = 0
  globalThis.fetch = async (url) => {
    if (url.endsWith('/config')) {
      if (++configs === 2) controller.abort()
      return json({ token: String(configs) })
    }
    posts++
    return json({ error: 'expired' }, 401)
  }
  try {
    const { mediaPost } =
      await import('../../src/features/downloader/lib/media-downloader.ts?recovery-abort')
    await assert.rejects(mediaPost('resolve', { text: 'x' }, controller.signal), {
      name: 'AbortError',
    })
    assert.equal(posts, 1)
  } finally {
    globalThis.fetch = original
  }
})
