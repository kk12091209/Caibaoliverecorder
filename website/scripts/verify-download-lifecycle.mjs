import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { chromium } from 'playwright-core'

const output = process.argv[2] || '/tmp/caibao-download-lifecycle'
await mkdir(output, { recursive: true })
let source = await readFile(
  new URL('../src/features/downloader/lib/desktop-download.ts', import.meta.url),
  'utf8',
)
source = source.replace(
  "import { saveFile } from './media-downloader.ts'",
  "function saveFile(url, name) { const a=document.createElement('a');a.href=url;a.download=name;a.click(); }",
)
const module = ts.transpile(source, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ES2022,
})
const bytes = Buffer.alloc(3 * 1024 * 1024, 71),
  hash = (value) => createHash('sha256').update(value).digest('hex')
const assets = new Map(
  await Promise.all(
    ['downloader-transfer-worker.js', 'downloader-range-transfer.mjs'].map(async (file) => [
      '/' + file,
      await readFile(new URL('../public/' + file, import.meta.url)),
    ]),
  ),
)
const timers = new Set()
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  if (assets.has(path) || path === '/desktop.js') {
    res.writeHead(200, {
      'Content-Type': 'text/javascript',
      'Service-Worker-Allowed': '/api/downloader/',
    })
    res.end(assets.get(path) || module)
    return
  }
  if (path.startsWith('/api/downloader/jobs/')) {
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '')
    const start = range ? Number(range[1]) : 0,
      end = range ? Math.min(bytes.length - 1, Number(range[2])) : bytes.length - 1
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/mp4',
      'Content-Disposition': 'attachment; filename="fixture.mp4"',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ETag: '"fixture"',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}),
    })
    res.write(bytes.subarray(start, Math.min(start + 1, end + 1)))
    const timer = setTimeout(
      () => {
        timers.delete(timer)
        res.end(bytes.subarray(start + 1, end + 1))
      },
      end > start ? 500 : 0,
    )
    timers.add(timer)
    return
  }
  if (path === '/favicon.ico') {
    res.writeHead(204)
    res.end()
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(
    '<!doctype html><title>下载生命周期本地验证</title><h1>下载生命周期本地验证</h1><button id="download">下载测试文件</button><script type="module">import { startBrowserDownload, prepareParallelDownloads } from "/desktop.js";window.startBrowserDownload=startBrowserDownload;window.prepareParallelDownloads=prepareParallelDownloads;document.querySelector("button").onclick=()=>startBrowserDownload("/api/downloader/jobs/' +
      'a'.repeat(36) +
      '/download","fixture.mp4");</script>',
  )
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  chromiumSandbox: true,
})
const context = await browser.newContext({ acceptDownloads: true }),
  page = await context.newPage(),
  errors = []
page.on('pageerror', (error) => errors.push(error.message))
try {
  await page.goto(base)
  assert.equal(await page.evaluate(() => window.prepareParallelDownloads()), true)
  const downloads = []
  for (let i = 0; i < 6; i++) {
    const pending = page.waitForEvent('download')
    await page.locator('#download').click()
    const download = await pending
    assert.equal(await page.locator('iframe').count(), 1, 'slow body still owns its frame')
    const file = await download.path()
    assert.equal(await download.failure(), null)
    assert.equal(hash(await readFile(file)), hash(bytes))
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 0)
    downloads.push({ name: download.suggestedFilename(), bytes: bytes.length })
  }
  assert.deepEqual(errors, [])
  await page.screenshot({ path: `${output}/downloads.png` })
  const report = {
    browser: browser.version(),
    url: page.url(),
    title: await page.title(),
    downloads,
    remainingFrames: await page.locator('iframe').count(),
    errors,
  }
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally {
  await browser.close()
  for (const timer of timers) clearTimeout(timer)
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
