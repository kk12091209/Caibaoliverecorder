import vm from 'node:vm'
import { readFileSync } from 'node:fs'

export const scriptSource = readFileSync(new URL('../../public/plugins/bili-comment-blindbox.user.js', import.meta.url), 'utf8')

export function followHarness(options = {}) {
  const clock = { now: 100_000 }, timers = new Map(), saved = options.saved ?? new Map(), posts = [], lookups = []
  let nextTimer = 1, inputWrites = 0, inputEvents = 0, clicks = 0, draft = '我正在输入的草稿'
  const input = {
    isConnected: true, disabled: false, readOnly: false, maxLength: 100, className: '',
    selectionStart: 3, selectionEnd: 5, selectionDirection: 'backward',
    getClientRects: () => [{}], getAttribute: () => null,
    dispatchEvent: () => { inputEvents++ },
    get value() { return draft }, set value(value) { inputWrites++; draft = value },
  }
  const button = { isConnected: true, disabled: true, getClientRects: () => [{}], click: () => { clicks++; throw new Error('Native send must not be clicked') } }
  const controls = { querySelectorAll: selector => selector.startsWith('textarea') ? [input] : [button] }
  const document = {
    cookie: options.cookie ?? 'DedeUserID=99; bili_jct=qa-token', activeElement: input,
    getElementById: id => id === 'control-panel-ctnr-box' ? controls : null,
    querySelectorAll: () => [], addEventListener: () => {},
  }
  const location = { pathname: '/1001' }
  const window = {}; window.self = window.top = window
  const timeout = (fn, ms) => { const id = nextTimer++; timers.set(id, { at: clock.now + Math.max(0, ms || 0), fn }); return id }
  async function fetch(url, init = {}) {
    if (url.startsWith('https://api.live.bilibili.com/room/v1/Room/room_init?')) {
      lookups.push(url)
      if (options.lookup) return options.lookup(url, init)
      return { ok: true, json: async () => ({ code: 0, data: { room_id: 9001 } }) }
    }
    if (url !== 'https://api.live.bilibili.com/msg/send') throw new Error('Unexpected network destination')
    const request = { url, body: Object.fromEntries(init.body), at: clock.now, init }
    posts.push(request)
    if (options.post) return options.post(request)
    return { ok: true, json: async () => ({ code: 0 }) }
  }
  class TestDate extends Date { static now() { return clock.now } }
  const context = vm.createContext({ window, document, location, URLSearchParams, URL: options.URL ?? URL, Image: options.Image, AbortController, Date: TestDate, fetch,
    getComputedStyle: options.getComputedStyle ?? (() => ({ visibility: 'visible' })), setTimeout: timeout, clearTimeout: id => timers.delete(id),
    queueMicrotask, localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
  })
  const marker = "    if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot, {once: true});"
  let module = scriptSource.slice(scriptSource.indexOf('  function installLiveFollow() {'), scriptSource.lastIndexOf('\n})();'))
  if (!module.includes(marker)) throw new Error('Live module test boundary changed')
  module = module.replace(marker, `    return {normalizeSettings, begin, removeTarget, processRow, changeSettings, checkRoom, acceptSettings,
      fitCoverRect, dragCoverRect, coverPictureBox, coverContainer, chooseCoverFile, chooseCoverColor, resetCover,
      normalizeStyleCurve, normalizeStylePreset, normalizeStyleSettings, sampleStyleCurve, styleTables,
      readStyleSettings, writeStyleSettings, styleMediaIn, syncStyleTargets, restoreStyleTargets,
      inspectStyle: () => JSON.stringify(styleSettings),
      inspectCover: () => JSON.stringify(cover),
      inspect: () => JSON.stringify({settings, room, queued: sendQueue.length, pending: !!pending, lastDetail, submitted, acknowledged})};`)
  const api = vm.runInContext(`${module}\ninstallLiveFollow()`, context)
  const flush = () => new Promise(resolve => setImmediate(resolve))
  async function tick(ms = 0) {
    const end = clock.now + ms
    await flush()
    for (let count = 0; count < 1000; count++) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      clock.now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush()
      if (count === 999) throw new Error('Timer loop failed to settle')
    }
    clock.now = end; await flush()
  }
  function row(uid, text, id = `${uid}-${text}-${clock.now}`) {
    const attrs = { 'data-uid': String(uid), 'data-danmaku': text, 'data-id': id, 'data-uname': `用户 ${uid}` }
    return { matches: () => true, getAttribute: key => attrs[key] ?? null, hasAttribute: () => false, querySelectorAll: () => [], classList: { contains: () => false } }
  }
  return { api, tick, posts, lookups, saved, document, input, location, row,
    inspect: () => JSON.parse(api.inspect()), normalize: raw => JSON.parse(JSON.stringify(api.normalizeSettings(raw))),
    counters: () => ({ inputWrites, inputEvents, clicks }),
  }
}
