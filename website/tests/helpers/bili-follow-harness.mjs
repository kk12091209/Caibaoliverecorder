import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { createSharedAutoSender } from '../../scripts/lib/auto-sender.mjs'

export const scriptSource = readFileSync(new URL('../../public/plugins/bili-comment-blindbox.user.js', import.meta.url), 'utf8')

export function followHarness(options = {}) {
  const clock = { now: 100_000 }, timers = new Map(), saved = options.saved ?? new Map(), posts = [], lookups = [], histories = [], translations = []
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
  const chat = { isConnected: true, querySelectorAll: () => [], contains: () => true }
  const document = {
    documentElement: (() => { const attributes = options.senderAttributes ?? new Map(); return {
      getAttribute: name => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name),
    } })(),
    cookie: options.cookie ?? 'DedeUserID=99; bili_jct=qa-token', activeElement: input,
    getElementById: id => id === 'control-panel-ctnr-box' ? controls : id === 'chat-items' && options.chat ? chat : null,
    querySelectorAll: () => [], addEventListener: () => {},
  }
  const location = { pathname: options.pathname ?? '/1001' }
  const window = {}; window.self = window.top = window
  const timeout = (fn, ms) => { const id = nextTimer++; timers.set(id, { at: clock.now + Math.max(0, ms || 0), fn }); return id }
  async function fetch(url, init = {}) {
    if (url.startsWith('https://api.live.bilibili.com/room/v1/Room/room_init?')) {
      lookups.push(url)
      if (options.lookup) return options.lookup(url, init)
      const source = new URL(url).searchParams.get('id')
      return { ok: true, json: async () => ({ code: 0, data: { room_id: source === '1001' ? 9001 : source } }) }
    }
    if (url.startsWith('https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory?')) {
      histories.push({url, init, at: clock.now})
      if (options.history) return options.history(url, init)
      return {ok: true, json: async () => ({code: 0, data: {room: []}})}
    }
    if (url !== 'https://api.live.bilibili.com/msg/send') throw new Error('Unexpected network destination')
    const request = { url, body: Object.fromEntries(init.body), at: clock.now, init }
    posts.push(request)
    if (options.post) return options.post(request)
    return { ok: true, json: async () => ({ code: 0 }) }
  }
  class TestDate extends Date { static now() { return clock.now } }
  const math = Object.create(Math); math.random = options.random ?? Math.random
  const GM_xmlhttpRequest = options.noTranslator ? undefined : request => {
    translations.push(request)
    if (options.translate) return options.translate(request)
    queueMicrotask(() => request.onload({status: 200, responseText: JSON.stringify([[['Hello']]])}))
    return {abort() { request.onabort?.() }}
  }
  const heldLocks = new Set()
  const locks = options.locks ?? { async request(name, _options, callback) {
    if (heldLocks.has(name)) return callback(null)
    heldLocks.add(name)
    try { return await callback({ name }) } finally { heldLocks.delete(name) }
  } }
  const context = vm.createContext({ window, document, location, navigator: { locks }, URLSearchParams, URL: options.URL ?? URL, Image: options.Image, AbortController, Date: TestDate, Math: math, fetch,
    GM_xmlhttpRequest,
    getComputedStyle: options.getComputedStyle ?? (() => ({ visibility: 'visible' })), setTimeout: timeout, clearTimeout: id => timers.delete(id),
    queueMicrotask, MutationObserver: class { observe() {} disconnect() {} takeRecords() { return [] } },
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
  })
  const marker = "    if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot, {once: true});"
  let module = scriptSource.slice(scriptSource.indexOf('  function installLiveFollow() {'), scriptSource.lastIndexOf('\n})();'))
  if (!module.includes(marker)) throw new Error('Live module test boundary changed')
  module = module.replace(marker, `    return {normalizeSettings, begin, removeTarget, processRow, changeSettings, checkRoom, acceptSettings,
      addWhitelist, removeWhitelist, clearWhitelist, isWhitelisted, bindChat,
      toggleTarget, toggleRandom, toggleExternal, parseExternalRoom, setExternalRoom,
      fitCoverRect, dragCoverRect, coverPictureBox, coverContainer, chooseCoverFile, chooseCoverColor, resetCover,
      normalizeStyleCurve, normalizeStylePreset, normalizeStyleSettings, sampleStyleCurve, styleTables,
      readStyleSettings, writeStyleSettings, styleMediaIn, syncStyleTargets, restoreStyleTargets,
      inspectStyle: () => JSON.stringify(styleSettings),
      inspectCover: () => JSON.stringify(cover),
      inspect: () => JSON.stringify({settings, room, queued: sendQueue.length, pending: !!pending, randomReady, externalReady, externalStatus, lastDetail, submitted, acknowledged})};`)
  const api = vm.runInContext(`${createSharedAutoSender.toString()}\n${module}\ninstallLiveFollow()`, context)
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
  return { api, tick, posts, lookups, histories, translations, saved, document, input, location, row,
    inspect: () => JSON.parse(api.inspect()), normalize: raw => JSON.parse(JSON.stringify(api.normalizeSettings(raw))),
    counters: () => ({ inputWrites, inputEvents, clicks }),
  }
}
