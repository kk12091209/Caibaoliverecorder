import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

// Isolated documents, native DOM/MutationObserver, and no platform requests.
const sourcePath =
  process.argv[2] || new URL('../public/plugins/bili-comment-blindbox.user.js', import.meta.url)
const output = process.argv[3] || '/tmp/caibao-plugin-dom'
const measureOnly = process.argv.includes('--measure-only')
await mkdir(output, { recursive: true })
const source = (await readFile(sourcePath, 'utf8')).replace(
  /\n\}\)\(\);\s*$/,
  '\nwindow.__maskQa = { sweep: runImmediateSweep, roots: () => knownRoots.size };\n})();',
)
const browser = await chromium.launch({
  executablePath:
    process.env.DOWNLOADER_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  chromiumSandbox: true,
})
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await context.newPage(),
  errors = []
page.on('pageerror', (error) => errors.push(error.message))
const fixture =
  '<!doctype html><html><head><title>菜包评论防护本地验证</title></head><body><h1>评论防护测试</h1><section id="comment"><div class="reply-item"><img id="qa-face" class="bili-avatar-img" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E" width="48" height="48"><span class="user-name">测试用户</span><span class="reply-content">这是用于验证的评论。</span></div></section></body></html>'
await page.route('**/*', (route) =>
  route.request().resourceType() === 'document'
    ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture })
    : route.abort(),
)
try {
  await page.goto('https://www.bilibili.com/video/local-dom-fixture')
  await page.evaluate(() => {
    const NativeObserver = window.MutationObserver
    window.__domCounts = { callbacks: 0, records: 0, frames: 0 }
    window.__lastMutations = []
    window.MutationObserver = class extends NativeObserver {
      constructor(callback) {
        super((records, observer) => {
          window.__domCounts.callbacks++
          window.__domCounts.records += records.length
          window.__lastMutations.push(
            ...records.map((record) => ({
              type: record.type,
              id: record.target.id,
              tag: record.target.nodeName,
              attribute: record.attributeName,
              old: record.oldValue,
              value: record.attributeName ? record.target.getAttribute(record.attributeName) : '',
            })),
          )
          window.__lastMutations = window.__lastMutations.slice(-20)
          callback(records, observer)
        })
      }
    }
    const frame = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = (callback) =>
      frame((time) => {
        window.__domCounts.frames++
        callback(time)
      })
  })
  await page.addScriptTag({ content: source })
  await page.waitForFunction(() =>
    document.querySelector('#qa-face')?.classList.contains('bcp-masked-avatar'),
  )
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  const metrics = async () =>
    Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]),
    )
  await page.waitForTimeout(2200)
  const before = await page.evaluate(() => ({ ...window.__domCounts })),
    cpuBefore = await metrics()
  await page.waitForTimeout(1500)
  const after = await page.evaluate(() => ({ ...window.__domCounts })),
    cpuAfter = await metrics()
  const stable = Object.fromEntries(
    Object.keys(before).map((key) => [key, after[key] - before[key]]),
  )
  const report = {
    url: page.url(),
    title: await page.title(),
    stable,
    taskSeconds: cpuAfter.TaskDuration - cpuBefore.TaskDuration,
    heapBytes: cpuAfter.JSHeapUsedSize,
    errors,
  }
  if (stable.records) console.log('mutations', await page.evaluate(() => window.__lastMutations))
  if (!measureOnly) {
    assert.equal(
      stable.records,
      0,
      'a stable document must not keep rewriting its own observed attributes',
    )
    await page.evaluate(() => {
      const host = document.createElement('bili-comment-renderer')
      host.id = 'qa-shadow-host'
      host.attachShadow({ mode: 'open' }).innerHTML =
        '<div class="reply-item"><img id="shadow-face" class="bili-avatar-img" src="data:image/svg+xml,%3Csvg/%3E" width="48" height="48"></div>'
      document.querySelector('#comment').append(host)
    })
    await page.waitForFunction(() =>
      document
        .querySelector('#qa-shadow-host')
        .shadowRoot.querySelector('img')
        .classList.contains('bcp-masked-avatar'),
    )
    assert.equal(await page.evaluate(() => window.__maskQa.roots()), 2)
    await page.evaluate(() => {
      window.__removedHost = document.querySelector('#qa-shadow-host')
      window.__removedHost.remove()
    })
    await page.waitForFunction(() => window.__maskQa.roots() === 1)
    await page.evaluate(() => document.querySelector('#comment').append(window.__removedHost))
    await page.waitForFunction(() => window.__maskQa.roots() === 2)
    await page.evaluate(() =>
      window.__removedHost.shadowRoot
        .querySelector('img')
        .setAttribute('src', 'data:image/svg+xml,%3Csvg id=%22changed%22/%3E'),
    )
    await page.waitForFunction(() =>
      window.__removedHost.shadowRoot
        .querySelector('img')
        .getAttribute('src')
        .includes('charset=UTF-8'),
    )
    const settled = await page.evaluate(() => window.__domCounts.records)
    await page.waitForTimeout(1500)
    assert.equal(await page.evaluate(() => window.__domCounts.records), settled)
    await page.getByRole('button', { name: '评论防护：开', exact: true }).click()
    await page.waitForFunction(
      () => !document.querySelector('#qa-face').classList.contains('bcp-masked-avatar'),
    )
    await page.getByRole('button', { name: '评论防护：关', exact: true }).click()
    await page.waitForFunction(() =>
      document.querySelector('#qa-face').classList.contains('bcp-masked-avatar'),
    )
    report.interactions =
      'dynamic shadow root, detach/reconnect, platform avatar replacement, protection off/on'
  }
  assert.deepEqual(errors, [])
  await page.screenshot({ path: path.join(output, 'comments.png') })
  await writeFile(path.join(output, 'metrics.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await context.close()
  await browser.close()
}
