import test from 'node:test'
import assert from 'node:assert/strict'

test('interleaved XHS and existing downloads retain their own session, CSRF and job routes', async () => {
  const original = globalThis.fetch,
    calls = []
  globalThis.fetch = async (url, options = {}) => {
    const base = url.startsWith('/api/downloader-xhs-v2/')
      ? '/api/downloader-xhs-v2'
      : '/api/downloader'
    const payload = options.body ? JSON.parse(options.body) : {}
    calls.push({ url, options, payload })
    let value
    if (url.endsWith('/config')) value = { token: base }
    else {
      if (options.method === 'POST') assert.equal(options.headers['X-Downloader-Token'], base)
      value = url.endsWith('/resolve')
        ? { sessionId: base + '-session' }
        : url.endsWith('/jobs')
          ? { id: base + '-job' }
          : { status: 'done' }
    }
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const { mediaPost, getDownloadJob } =
      await import('../../src/features/downloader/lib/media-downloader.ts?routing-test')
    const xhs = await mediaPost('resolve', {
        text: '分享 https://www.xiaohongshu.com/discovery/item/6abc8c7400000000020282ff?xsec_token=test',
      }),
      bili = await mediaPost('resolve', { text: 'https://www.bilibili.com/video/BV1dELb62EBy/' })
    const b = await mediaPost('jobs', { sessionId: bili.sessionId, indices: [1] }),
      x = await mediaPost('jobs', { sessionId: xhs.sessionId, indices: [1] })
    await getDownloadJob(x.id)
    assert.equal(calls.at(-1).url, '/api/downloader-xhs-v2/jobs/' + x.id)
    await getDownloadJob(b.id)
    assert.equal(calls.at(-1).url, '/api/downloader/jobs/' + b.id)
    await mediaPost('resolve', { text: '文字 https://xhslink.com/a/test 文字' })
    assert.equal(calls.at(-1).url, '/api/downloader-xhs-v2/resolve')
    await mediaPost('resolve', {
      text: '小个子这样穿好乖啊！！！！！ https://xhslink.cn/o/54WpHA6HDfP 跳转【小红书】看看笔记详情~',
    })
    assert.equal(calls.at(-1).url, '/api/downloader-xhs-v2/resolve')
    await mediaPost('resolve', { text: 'https://xhslink.cn.evil.example/o/test' })
    assert.equal(calls.at(-1).url, '/api/downloader/resolve')
    await mediaPost('resolve', { text: 'https://www.xiaohongshu.com.evil.example/a' })
    assert.equal(calls.at(-1).url, '/api/downloader/resolve')
    assert.equal(calls.filter((c) => c.url.endsWith('/config')).length, 2)
  } finally {
    globalThis.fetch = original
  }
})
