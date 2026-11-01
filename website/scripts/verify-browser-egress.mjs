import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import https from 'node:https'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium } from 'playwright-core'
import { createBrowserEgress } from '../server/downloader/infrastructure/browser-egress.mjs'
import { browserResolve } from '../server/downloader/infrastructure/browser.mjs'
const run = promisify(execFile),
  root = await fs.mkdtemp('/private/tmp/caibao-egress-'),
  out = process.argv[2] || '/private/tmp/caibao-upgrade-local-20261101/browser-egress'
await fs.mkdir(out, { recursive: true })
await run('openssl', [
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  path.join(root, 'key.pem'),
  '-out',
  path.join(root, 'cert.pem'),
  '-days',
  '1',
  '-subj',
  '/CN=www.douyin.com',
])
const seen = [],
  resolutions = [],
  dials = []
const id = '1234567890123456789',
  item = { aweme_id: id, images: [{ url_list: ['https://p1.douyinpic.com/local-image.jpg'] }] }
const upstream = https.createServer(
  {
    key: await fs.readFile(path.join(root, 'key.pem')),
    cert: await fs.readFile(path.join(root, 'cert.pem')),
  },
  (req, res) => {
    seen.push(req.headers.host)
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(
      '<!doctype html><script type="application/json">' +
        JSON.stringify(item) +
        '</script><h1>Isolated platform fixture</h1>',
    )
  },
)
await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
const egress = await createBrowserEgress({
  resolve: async (host) => {
    resolutions.push(host)
    return [{ address: host === 'www.douyin.com' ? '1.1.1.1' : '127.0.0.1', family: 4 }]
  },
  connect: (options) => {
    dials.push(options)
    assert.equal(options.host, '1.1.1.1')
    return net.connect({ host: '127.0.0.1', port: upstream.address().port })
  },
})
let browser
try {
  browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    proxy: egress.proxy,
    args: [
      '--proxy-bypass-list=<-loopback>',
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
  })
  const context = await browser.newContext({ ignoreHTTPSErrors: true }),
    page = await context.newPage()
  await page.goto('https://www.douyin.com/note/' + id)
  const failures = await page.evaluate(async () =>
    Promise.all(
      ['https://evil.invalid/', 'https://private.douyin.com/', 'http://127.0.0.1:1/'].map(
        async (url) => {
          try {
            await fetch(url)
            return false
          } catch {
            return true
          }
        },
      ),
    ),
  )
  assert.deepEqual(failures, [true, true, true])
  await context.close()
  const wrapped = {
    newContext: (options) => browser.newContext({ ...options, ignoreHTTPSErrors: true }),
  }
  const found = await browserResolve(id, 'note', undefined, {
    getBrowser: async () => wrapped,
    timeout: 4000,
    galleryMode: 'images',
  })
  assert.equal(found.aweme_id, id)
  assert.ok(seen.every((host) => host === 'www.douyin.com'))
  assert.ok(dials.length > 0)
  await fs.writeFile(
    path.join(out, 'results.json'),
    JSON.stringify(
      {
        hydration: true,
        blocked: failures,
        upstreamHosts: seen,
        pinned: dials.map((d) => d.host),
        resolutions,
      },
      null,
      2,
    ),
  )
  console.log(
    'Native Chromium CONNECT, pinned destination, denied exits and parser hydration passed',
  )
} finally {
  await browser?.close()
  await egress.close()
  upstream.closeAllConnections()
  await new Promise((r) => upstream.close(r))
  await fs.rm(root, { recursive: true, force: true })
}
