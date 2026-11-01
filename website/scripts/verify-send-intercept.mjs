import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const output = process.argv[2] || '/tmp/caibao-send-intercept'
await mkdir(output, { recursive: true })
const source = await readFile(
  new URL('../public/plugins/bili-comment-blindbox.user.js', import.meta.url),
  'utf8',
)
const hook = source.slice(
  source.indexOf('  function installSendInterceptHook()'),
  source.indexOf('  function splitGraphemes('),
)
const fixture = `let sendHookState='pending'; const CFG={sendInterceptKey:'test-send',petKey:'test-pet',defaultPet:'cat',sendInterceptMaskLength:3}; const PETS={cat:{sound:'喵'}};function updateLanguageMenu(){} function runImmediateSweep(){}; ${hook};window.hookState=()=>sendHookState;installSendInterceptHook();`
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  chromiumSandbox: true,
})
const context = await browser.newContext(),
  errors = []
await context.route('**/*', (route) =>
  route.fulfill({
    contentType: 'text/html; charset=utf-8',
    headers: route.request().url().includes('blocked')
      ? { 'Content-Security-Policy': "script-src 'none'" }
      : {},
    body: '<!doctype html><title>发送拦截本地验证</title><h1>发送拦截：无平台提交</h1>',
  }),
)
try {
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('https://www.bilibili.com/video/fixture')
  await page.evaluate(() => {
    localStorage.setItem('test-send', '1')
    window.sent = []
    window.fetch = async (input, init) => {
      const request = new Request(input, init)
      request.signal.throwIfAborted()
      window.sent.push({
        body: await request.text(),
        type: request.headers.get('content-type'),
        credentials: request.credentials,
      })
      return new Response('{"code":0}')
    }
  })
  await page.evaluate(fixture)
  assert.equal(await page.evaluate(() => window.hookState()), 'ready')
  const result = await page.evaluate(async () => {
    const url = 'https://api.bilibili.com/x/v2/reply/add'
    await fetch(url, {
      method: 'POST',
      body: new URLSearchParams({ message: '原文一', oid: '123' }),
    })
    const original = new Request(url, {
      method: 'POST',
      credentials: 'include',
      body: new URLSearchParams({ message: '原文二', oid: '456' }),
    })
    await fetch(original)
    const form = new FormData()
    form.set('message', '原文三')
    form.set('oid', '789')
    await fetch(new Request(url, { method: 'POST', body: form }))
    await fetch(new URL(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '原文四', oid: 10 }),
    })
    let rejected = 0
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array([1]),
      })
    } catch {
      rejected++
    }
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid',
      })
    } catch {
      rejected++
    }
    const controller = new AbortController()
    controller.abort()
    try {
      await fetch(url, { method: 'POST', body: 'message=test', signal: controller.signal })
    } catch {
      rejected++
    }
    return { sent: window.sent, originalUsed: original.bodyUsed, rejected }
  })
  assert.equal(result.sent.length, 4)
  assert.equal(result.rejected, 3)
  assert.equal(result.originalUsed, false)
  for (const sent of result.sent) {
    assert.equal(decodeURIComponent(sent.body).includes('原文'), false)
    assert.ok(decodeURIComponent(sent.body).includes('喵喵喵'))
  }
  assert.equal(new URLSearchParams(result.sent[1].body).get('oid'), '456')
  assert.equal(result.sent[1].credentials, 'include')
  assert.match(result.sent[2].type, /multipart\/form-data; boundary=/)
  const blocked = await context.newPage()
  blocked.on('pageerror', (error) => errors.push(error.message))
  await blocked.goto('https://www.bilibili.com/video/blocked')
  await blocked.evaluate(fixture)
  await blocked.waitForFunction(() => window.hookState() === 'failed')
  assert.deepEqual(errors, [])
  const report = {
    browser: browser.version(),
    url: page.url(),
    title: await page.title(),
    submissions: result.sent.length,
    rejected: result.rejected,
    cspFailureDetected: true,
    errors,
  }
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally {
  await browser.close()
}
