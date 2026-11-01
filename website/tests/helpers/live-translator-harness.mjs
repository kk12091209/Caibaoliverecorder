import vm from 'node:vm'
import { readFileSync } from 'node:fs'

export const translatorSource = readFileSync(new URL('../../public/plugins/caibao-live-translator.user.js', import.meta.url), 'utf8')

export function translatorHarness(extra = {}) {
  const clock = { now: 100_000 }, timers = new Map()
  let serial = 0
  const later = (fn, ms = 0) => { const id = ++serial; timers.set(id, { fn, at: clock.now + Math.max(0, ms) }); return id }
  class ClockDate extends Date { static now() { return clock.now } }
  const context = vm.createContext({ Date: ClockDate, setTimeout: later, clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
    AbortController, URL, URLSearchParams, performance: { now: () => clock.now }, ...extra })
  const coreSource = translatorSource.slice(translatorSource.indexOf('function createLiveCore()'), translatorSource.indexOf('const Core = createLiveCore();'))
  const sessionStart = translatorSource.indexOf('class ElevenSession {')
  const sessionSource = translatorSource.slice(sessionStart, translatorSource.indexOf('const records = [];', sessionStart))
  const trimSource = translatorSource.slice(translatorSource.indexOf('function trimLiveQueue('), translatorSource.indexOf('let resolvedRoom = null;'))
  const tokenSource = translatorSource.slice(translatorSource.indexOf('function requestToken('), translatorSource.indexOf('const PCM_WORKLET ='))
  const api = vm.runInContext(`${coreSource}\nconst Core = createLiveCore();\n${tokenSource}\n${sessionSource}\n${trimSource}\n({Core, createDanmakuSender, createAutoSendLease, createKeyVault, waitForPlayerInput, createEchoTracker, createLiveRoomMonitor, ElevenSession, trimLiveQueue})`, context)
  const flush = () => new Promise(resolve => setImmediate(resolve))
  async function tick(ms = 0) {
    const end = clock.now + ms
    await flush()
    for (let count = 0; count < 5000; count++) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      clock.now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush()
      if (count === 4999) throw Error('Timer loop did not settle')
    }
    clock.now = end; await flush()
  }
  return { ...api, tick, clock, context, timers }
}

export function transcript(id, text, createdAt = 100_000, extra = {}) {
  return { id, text, source: text, createdAt, path: '/4716648', commitBatchId: id,
    sourceLanguage: 'zh', automatic: true, ...extra }
}
