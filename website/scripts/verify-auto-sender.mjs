import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'

const output = process.argv[2] || '/tmp/caibao-auto-sender'
await mkdir(output, { recursive: true })
const sources = await Promise.all(
  ['bili-comment-blindbox.user.js', 'caibao-live-translator.user.js'].map(async (file) => {
    const source = await readFile(new URL('../public/plugins/' + file, import.meta.url), 'utf8')
    return source.match(/\/\/ BEGIN SHARED AUTO SENDER([\s\S]*?)\/\/ END SHARED AUTO SENDER/)[1]
  }),
)
assert.equal(sources[0], sources[1], 'both installed scripts must contain the same coordinator')
const browser = await chromium.launch({
  executablePath:
    process.env.DOWNLOADER_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  chromiumSandbox: true,
})
const context = await browser.newContext(),
  posts = [],
  errors = []
await context.route('**/*', async (route) => {
  if (route.request().url().endsWith('/local-test-send')) {
    posts.push(JSON.parse(route.request().postData()))
    return route.fulfill({ contentType: 'application/json', body: '{"code":0}' })
  }
  if (route.request().resourceType() === 'document')
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>菜包自动发送本地验证</title><h1>共享发送验证：仅本地请求</h1>',
    })
  return route.abort()
})
async function install(page, copy) {
  await page.addScriptTag({
    content: sources[copy] + '\nwindow.sender = createSharedAutoSender();',
  })
}
async function tab(copy) {
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('https://live.bilibili.com/1001')
  await install(page, copy)
  return page
}
async function send(page, room, text, fail = false) {
  return page.evaluate(
    async ({ room, text, fail }) => {
      try {
        await window.sender.send({ uid: '99', room, text }, () => {
          if (fail) throw new TypeError('unknown network result')
          return fetch('/local-test-send', {
            method: 'POST',
            body: JSON.stringify({ room, text, at: Date.now() }),
          })
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: error.message }
      }
    },
    { room, text, fail },
  )
}
try {
  const a = await tab(0),
    b = await tab(0),
    translator = await tab(1)
  const race = await Promise.all([send(a, '9001', '并发甲'), send(b, '9001', '并发乙')])
  assert.equal(race.filter((r) => r.ok).length, 1)
  assert.equal(posts.length, 1)
  const owner = race[0].ok ? a : b,
    waiting = race[0].ok ? b : a
  assert.match((await send(translator, '9002', '另一直播间同传')).reason, /5 秒/)
  await new Promise((resolve) => setTimeout(resolve, 5050))
  assert.equal((await send(translator, '9002', '另一直播间同传')).ok, true)
  assert.ok(posts[1].at - posts[0].at >= 5000)
  await new Promise((resolve) => setTimeout(resolve, 5050))
  assert.match((await send(translator, '9002', '另一直播间同传')).reason, /相同内容/)
  await owner.close()
  assert.equal((await send(waiting, '9001', '原标签页关闭后接续')).ok, true)
  await waiting.reload()
  await install(waiting, 0)
  assert.match((await send(waiting, '9001', '刷新后不能绕过冷却')).reason, /5 秒/)
  await new Promise((resolve) => setTimeout(resolve, 5050))
  assert.match((await send(waiting, '9001', '失败的请求', true)).reason, /unknown network/)
  assert.match((await send(translator, '9002', '失败后仍需冷却')).reason, /5 秒/)
  assert.equal(posts.length, 3)
  await waiting.evaluate(() => {
    window.sender.release()
    Storage.prototype.setItem = () => {
      throw new Error('denied')
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 5050))
  assert.match((await send(waiting, '9001', '存储不可用')).reason, /无法保存/)
  assert.equal(posts.length, 3)
  assert.deepEqual(errors, [])
  const report = {
    browser: await browser.version(),
    documents: 3,
    posts,
    race,
    checks: [
      'same-room concurrent ownership',
      'cross-plugin account cooldown',
      '15-second duplicate guard',
      'owner tab close',
      'reload preserves cooldown',
      'ambiguous failure keeps cooldown',
      'storage failure blocks submission',
    ],
    errors,
  }
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await context.close()
  await browser.close()
}
