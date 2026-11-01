import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { preview } from 'vite'
import { chromium } from 'playwright-core'

const output = process.argv[2] || '/tmp/caibao-catalog-navigation'
await mkdir(output, { recursive: true })
const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } })
const base = server.resolvedUrls.local[0]
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  chromiumSandbox: true,
})
const page = await browser.newPage({
    viewport: { width: 1280, height: 850 },
    reducedMotion: 'reduce',
  }),
  errors = []
page.on('pageerror', (error) => errors.push(error.message))
await page.addInitScript(() => {
  window.__scrolled = []
  const scroll = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = function (...args) {
    window.__scrolled.push(this.id)
    return scroll.apply(this, args)
  }
})
try {
  await page.goto(base)
  await page.locator('#home-title').waitFor()
  await page.evaluate(() => {
    location.hash = '#home-title'
  })
  await page.waitForFunction(() => window.__scrolled.includes('home-title'))
  await page.evaluate(() => {
    const el = document.createElement('div')
    el.id = '特殊 [标题'
    el.textContent = '锚点测试'
    document.body.append(el)
    location.hash = encodeURIComponent(el.id)
  })
  await page.waitForFunction(() => window.__scrolled.includes('特殊 [标题'))
  for (const hash of ['#[', '#%E0%A4%A', '#missing', '#']) {
    await page.evaluate((hash) => {
      location.hash = hash
    }, hash)
    await page.waitForTimeout(50)
    assert.equal(await page.locator('#home-title').count(), 1)
  }
  assert.deepEqual(errors, [])
  await page.screenshot({ path: `${output}/catalog.png` })
  const report = { url: page.url(), title: await page.title(), checkedHashes: 6, errors }
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally {
  await browser.close()
  await new Promise((resolve) => server.httpServer.close(resolve))
}
