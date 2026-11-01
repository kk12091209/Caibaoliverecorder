import { createBrowserEgress } from './browser-egress.mjs'
import { chromium } from 'playwright-core'
import { access } from 'node:fs/promises'
import { DESKTOP_UA, approvedUrl } from './network.mjs'
import { findDouyinItem, douyinScriptItem } from '../platforms/douyin.mjs'
import { needsGalleryHydration } from '../platforms/resolver.mjs'
import { xiaohongshuId, xiaohongshuNote, xhsHosts } from '../platforms/xiaohongshu.mjs'
import { setTimeout as delay } from 'node:timers/promises'

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
  throw new Error('这条作品需要浏览器解析，请安装 Chrome 后重试。')
}
async function browser() {
  if (!browserPromise)
    browserPromise = (async () => {
      const executablePath = await executable(),
        egress = await createBrowserEgress()
      try {
        const instance = await chromium.launch({
          executablePath,
          headless: true,
          chromiumSandbox: true,
          proxy: egress.proxy,
          args: [
            '--proxy-bypass-list=<-loopback>',
            '--disable-quic',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          ],
        })
        instance.once('disconnected', () => {
          browserPromise = null
          void egress.close()
        })
        return instance
      } catch (error) {
        await egress.close()
        throw error
      }
    })().catch((error) => {
      browserPromise = null
      throw error
    })
  return browserPromise
}
export async function browserResolve(
  id,
  type,
  signal,
  { getBrowser = browser, timeout = 25000, galleryMode = 'complete' } = {},
) {
  signal?.throwIfAborted()
  const instance = await getBrowser()
  signal?.throwIfAborted()
  const context = await instance.newContext({
    serviceWorkers: 'block',
    userAgent: DESKTOP_UA,
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
  })
  const page = await context.newPage()
  let timer, found, settle, navigation
  const waiting = new Promise((resolve) => {
    settle = resolve
    timer = setTimeout(() => resolve(null), timeout)
  })
  const abort = () => {
    settle(null)
    void context.close().catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  page.on('response', async (response) => {
    if (
      found ||
      !response.url().includes('douyin.com/') ||
      !/(?:aweme\/detail|iteminfo|slidesinfo)/.test(response.url())
    )
      return
    try {
      const item = findDouyinItem(await response.json(), id)
      if (item && (galleryMode === 'images' || !needsGalleryHydration(item))) {
        found = item
        settle(item)
      }
    } catch {
      /* Some platform responses are not JSON. */
    }
  })
  try {
    await page.route('**/*', (route) => {
      try {
        const url = approvedUrl(route.request().url())
        return url.protocol !== 'https:' ||
          ['font', 'media', 'image'].includes(route.request().resourceType())
          ? route.abort()
          : route.continue()
      } catch {
        return route.abort()
      }
    })
    // A validated detail response may arrive before DOMContentLoaded. Let it
    // finish the request immediately; hydration is only the competing fallback.
    navigation = (async () => {
      await page.goto(`https://www.douyin.com/${type === 'note' ? 'note' : 'video'}/${id}`, {
        waitUntil: 'domcontentloaded',
        timeout,
      })
      if (found) return
      const hydrated = douyinScriptItem(await page.locator('script').allTextContents(), id)
      if (hydrated && (galleryMode === 'images' || !needsGalleryHydration(hydrated))) {
        found = hydrated
        settle(hydrated)
      }
    })().catch(() => {
      /* A detail response can still arrive after navigation fails. */
    })
    const item = await waiting
    signal?.throwIfAborted()
    if (!item) {
      const text = await page
        .locator('body')
        .innerText({ timeout: 1000 })
        .catch(() => '')
      if (/验证|验证码|安全检测/.test(text) && !/愿人随春好/.test(text))
        throw new Error('抖音要求网页验证，暂时无法自动解析这条作品，请稍后重试。')
      throw new Error('抖音没有返回作品媒体信息，请稍后重新解析。')
    }
    return item
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    await context.close().catch(() => {})
    await navigation
  }
}
export async function closeBrowser() {
  if (browserPromise) {
    await (await browserPromise).close()
    browserPromise = null
  }
}

export async function browserResolveXiaohongshu(
  input,
  signal,
  { getBrowser = browser, timeout = 25000 } = {},
) {
  const url = approvedUrl(input)
  const id = xiaohongshuId(url)
  if (!xhsHosts.has(url.hostname) || !id) throw new Error('请使用小红书单篇笔记的分享链接。')
  signal?.throwIfAborted()
  const instance = await getBrowser()
  signal?.throwIfAborted()
  // A fresh, disposable context. Never open a user's profile or import cookies.
  const context = await instance.newContext({
    serviceWorkers: 'block',
    userAgent: DESKTOP_UA,
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
  })
  const abort = () => {
    void context.close().catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  let timer
  const expired = new AbortController()
  timer = setTimeout(() => {
    expired.abort()
    abort()
  }, timeout)
  const active = signal ? AbortSignal.any([signal, expired.signal]) : expired.signal
  let pageText = ''
  try {
    active.throwIfAborted()
    const page = await context.newPage()
    await page.route('**/*', (route) => {
      const request = route.request()
      try {
        if (approvedUrl(request.url()).protocol !== 'https:') return route.abort()
        return ['font', 'media', 'image'].includes(request.resourceType())
          ? route.abort()
          : route.continue()
      } catch {
        return route.abort()
      }
    })
    // Initialize only this disposable anonymous visitor before opening a
    // signed note. A fresh note navigation can otherwise land on /login and
    // stay there even after the site's guest initialization has completed.
    await page
      .goto('https://www.xiaohongshu.com/', {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(timeout, 7000),
      })
      .catch(() => {})
    const visitorUntil = Date.now() + 3000
    while (Date.now() < visitorUntil && !active.aborted) {
      const guestReady = (await context.cookies('https://www.xiaohongshu.com/')).some(
        (item) => item.name === 'a1',
      )
      if (guestReady) break
      await delay(200, undefined, { signal: active })
    }
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout }).catch(() => {
      // The share page may navigate itself again after initializing a visitor.
      // Inspect the resulting document before classifying the initial page.
    })
    do {
      active.throwIfAborted()
      const scripts = await page
        .locator('script')
        .allTextContents()
        .catch(() => [])
      const found = xiaohongshuNote(scripts.map((text) => `<script>${text}</script>`).join(''), id)
      if (found) return found
      pageText = await page
        .locator('body')
        .innerText({ timeout: 1000 })
        .catch(() => '')
      await delay(200, undefined, { signal: active })
    } while (!active.aborted)
    throw new Error('小红书要求登录或验证，当前无法匿名解析这条笔记，请稍后重试。')
  } catch (error) {
    signal?.throwIfAborted()
    if (expired.signal.aborted)
      throw new Error(
        /登录后|登录小红书|验证码|安全验证/.test(pageText)
          ? '小红书要求登录或验证，当前无法匿名解析这条笔记，请稍后重试。'
          : '小红书网页解析超时，请稍后重试。',
      )
    if (/小红书要求/.test(error.message)) throw error
    throw new Error('小红书网页暂时未返回笔记内容，请稍后重试。')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    await context.close().catch(() => {})
  }
}
