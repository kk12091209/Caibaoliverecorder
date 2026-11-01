import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const originalSource = await readFile(
  new URL('../public/plugins/caibao-live-translator.user.js', import.meta.url),
  'utf8',
)
const source = originalSource
  .replace(
    'function dispose() {',
    'function dispose() { window.__qa.disposed = (window.__qa.disposed || 0) + 1;',
  )
  .replace(
    'function startCaibaoApp() {',
    'function startCaibaoApp() { window.__qa.started = (window.__qa.started || 0) + 1;',
  )
const output = process.argv[2] || '/tmp/caibao-translator-lifecycle'
await mkdir(output, { recursive: true })
const server = http.createServer((req, res) => {
  if (req.url === '/plugin.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
    res.end(source)
    return
  }
  if (req.url === '/favicon.ico') {
    res.writeHead(204)
    res.end()
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(
    `<!doctype html><meta charset="utf-8"><title>同传本地生命周期验证</title><h1>同传本地生命周期验证</h1><p>离线夹具，不连接直播平台。</p>${req.url === '/4716648' ? '<a href="/away">离开</a><script src="/plugin.js"></script>' : '<p>另一页面</p>'}`,
  )
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  chromiumSandbox: true,
  ignoreDefaultArgs: ['--disable-back-forward-cache'],
})
const context = await browser.newContext({ viewport: { width: 1280, height: 850 } })
await context.addInitScript(() => {
  window.__qa = { restored: 0, captures: 0, intervals: new Set() }
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) window.__qa.restored++
  })
  const attach = Element.prototype.attachShadow
  Element.prototype.attachShadow = function (options) {
    return attach.call(this, { ...options, mode: 'open' })
  }
  const interval = window.setInterval.bind(window),
    clear = window.clearInterval.bind(window)
  window.setInterval = (...args) => {
    const id = interval(...args)
    window.__qa.intervals.add(id)
    return id
  }
  window.clearInterval = (id) => {
    window.__qa.intervals.delete(id)
    clear(id)
  }
  const values = { 'elive.apiKey': 'local-sentinel-key-not-real' }
  window.GM_getValue = (key, fallback) => values[key] ?? fallback
  window.GM_setValue = (key, value) => {
    values[key] = value
  }
  window.GM_deleteValue = (key) => {
    delete values[key]
  }
  window.GM_registerMenuCommand = () => {}
  navigator.mediaDevices.getDisplayMedia = async () => {
    window.__qa.captures++
    throw new Error('Unexpected capture')
  }
})
const page = await context.newPage(),
  errors = [],
  unexpected = []
page.setDefaultTimeout(5000)
page.on('pageerror', (e) => errors.push(e.message))
page.on('request', (request) => {
  if (!request.url().startsWith(base)) unexpected.push(request.url())
})
try {
  await page.goto(`${base}/4716648`)
  await page.locator('#launcher').click()
  await page.locator('#keyStatus').waitFor({ state: 'attached' })
  assert.equal(await page.locator('#key').inputValue(), '')
  // Setting the UI flag alone cannot start capture or sending.
  await page.locator('#autoSend').evaluate((el) => {
    el.checked = true
  })
  for (let round = 1; round <= 3; round++) {
    await page.locator('#autoSend').evaluate((el) => {
      el.checked = true
    })
    await page.evaluate(() => {
      window.__oldHost = document.getElementById('eleven-live-control')
    })
    await page.locator('a').click()
    await page.waitForURL(`${base}/away`)
    await page.goBack({ waitUntil: 'commit' })
    await page.waitForFunction((round) => window.__qa.restored === round, round)
    console.log(
      'restored',
      await page.evaluate(() => ({ ...window.__qa, intervals: window.__qa.intervals.size })),
    )
    assert.equal(
      await page.evaluate(
        () => window.__oldHost === document.getElementById('eleven-live-control'),
      ),
      false,
    )
    if (await page.locator('#launcher').isVisible()) await page.locator('#launcher').click()
    assert.equal(await page.locator('#eleven-live-control').count(), 1)
    assert.equal(await page.locator('#eleven-live-captions').count(), 1)
    assert.equal(await page.locator('#autoSend').isChecked(), false)
    assert.equal(await page.locator('#start').isEnabled(), true)
    assert.equal(await page.locator('#key').inputValue(), '')
    assert.equal(await page.evaluate(() => window.__qa.intervals.size), 1)
    assert.equal(
      await page.evaluate(() => window.__qa.restored),
      round,
      'must exercise real BFCache, not a reload',
    )
  }
  const restored = await page.evaluate(() => window.__qa.restored)
  await page.reload()
  assert.equal(await page.evaluate(() => window.__qa.restored), 0)
  assert.equal(await page.evaluate(() => window.__qa.captures), 0)
  await page.locator('#launcher').click()
  assert.equal(await page.locator('#autoSend').isChecked(), false)
  const html = await page.content()
  assert.equal(html.includes('local-sentinel-key-not-real'), false)
  assert.deepEqual(unexpected, [])
  assert.deepEqual(errors, [])
  await page.screenshot({ path: `${output}/restored.png` })
  const report = {
    browser: browser.version(),
    url: page.url(),
    title: await page.title(),
    restored,
    captures: 0,
    activeIntervals: 1,
    errors,
    unexpectedRequests: unexpected,
  }
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally {
  if (errors.length) console.error('page errors', errors)
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
