import { chromium } from 'playwright-core'
import { access } from 'node:fs/promises'
import { DESKTOP_UA } from './network.mjs'
import { findDouyinItem, douyinScriptItem } from '../platforms/douyin.mjs'

let browserPromise
async function executable() {
  if (process.platform === 'linux' && !process.env.DOWNLOADER_CHROME) {
    const bundled = chromium.executablePath()
    try {
      await access(bundled)
      return bundled
    } catch {
      /* Try a system browser if no bundled runtime is installed. */
    }
  }
  for (const path of [
    process.env.DOWNLOADER_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean)) {
    try {
      await access(path)
      return path
    } catch {
      /* Try the next installed browser. */
    }
  }
  throw new Error('这条抖音作品需要浏览器解析，请安装 Chrome 后重试。')
}
async function browser() {
  if (!browserPromise)
    browserPromise = executable()
      .then((executablePath) =>
        chromium.launch({ executablePath, headless: true, chromiumSandbox: true }),
      )
      .catch((error) => {
        browserPromise = null
        throw error
      })
  return browserPromise
}
export async function browserResolve(id, type, signal) {
  signal?.throwIfAborted()
  const instance = await browser()
  const context = await instance.newContext({
    userAgent: DESKTOP_UA,
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
  })
  const page = await context.newPage()
  let timer, found, settle
  const waiting = new Promise((resolve) => {
    settle = resolve
    timer = setTimeout(() => resolve(null), 45000)
  })
  const abort = () => {
    settle(null)
    void context.close()
  }
  signal?.addEventListener('abort', abort, { once: true })
  page.on('response', async (response) => {
    if (
      found ||
      !response.url().includes('douyin.com/') ||
      !/(?:aweme\/detail|iteminfo|slidesinfo)/.test(response.url())
    )
      return
    try {
      const item = findDouyinItem(await response.json(), id)
      if (item) {
        found = item
        settle(item)
      }
    } catch {
      /* Some platform responses are not JSON. */
    }
  })
  try {
    await page.route('**/*', (route) =>
      ['font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue(),
    )
    await page.goto(`https://www.douyin.com/${type === 'note' ? 'note' : 'video'}/${id}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    })
    // Public hydration scripts are part of the response, and can contain the
    // main item before the browser issues an asynchronous detail request.
    const scripts = await page.locator('script').allTextContents()
    const hydrated = douyinScriptItem(scripts, id)
    if (hydrated) {
      found = hydrated
      settle(hydrated)
    }
    const item = found || (await waiting)
    signal?.throwIfAborted()
    if (!item) {
      const text = await page
        .locator('body')
        .innerText()
        .catch(() => '')
      if (/验证|验证码|安全检测/.test(text) && !/愿人随春好/.test(text))
        throw new Error('抖音要求网页验证，暂时无法自动解析这条作品，请稍后重试。')
      throw new Error('抖音没有返回作品媒体信息，请稍后重新解析。')
    }
    return item
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    await context.close()
  }
}
export async function closeBrowser() {
  if (browserPromise) {
    await (await browserPromise).close()
    browserPromise = null
  }
}
