// ==UserScript==
// @name         菜包直播同传
// @namespace    local.elevenlabs.live-captions
// @version      0.2.6
// @homepageURL  https://caibao.media/works/browser-plugins/caibao-live-translator
// @downloadURL  https://caibao.media/plugins/caibao-live-translator.user.js
// @updateURL    https://caibao.media/plugins/caibao-live-translator.user.js
// @description  实时字幕与本地翻译，弹幕至少间隔5秒、每条含【】最多30字；优先直读播放器，支持暂停继续、回显确认和开播值守。
// @author       Local project
// @license      AGPL-3.0-only
// @match        https://live.bilibili.com/*
// @connect      api.elevenlabs.io
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_addElement
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// ==/UserScript==


(function caibaoLiveUserscript() {
'use strict';
// BEGIN SHARED AUTO SENDER
function createSharedAutoSender(env = globalThis) {
  const locks = env.navigator?.locks
  let held = null,
    pending = null,
    generation = 0
  const failure = (message) => new Error(message)
  function release() {
    generation++
    held?.release()
    held = null
    pending = null
  }
  async function claim(uid, room) {
    if (!locks?.request)
      throw failure('此浏览器无法协调多个标签页，自动发送已暂停。请使用支持 Web Locks 的浏览器。')
    if (!/^\d{1,24}$/.test(uid) || !/^\d{1,24}$/.test(room))
      throw failure('无法确认当前账号或直播间，自动发送已暂停。')
    const key = `caibao:auto-sender:v1:room:${uid}:${room}`
    if (held?.key === key) return
    if (pending?.key === key) return pending.promise
    release()
    const version = generation
    let ready, reject
    const promise = new Promise((resolve, fail) => {
      ready = resolve
      reject = fail
    })
    pending = { key, promise }
    void locks
      .request(key, { ifAvailable: true }, async (lock) => {
        if (version !== generation) throw failure('自动发送状态已变化，本条已取消。')
        if (!lock)
          throw failure('此账号在这个直播间已有另一个标签页自动发送，请先关闭那里的自动发送。')
        let finish
        const lifetime = new Promise((resolve) => {
          finish = resolve
        })
        held = { key, release: finish }
        ready()
        await lifetime
      })
      .catch(reject)
    try {
      await promise
    } finally {
      if (pending?.promise === promise) pending = null
    }
  }
  async function send({ uid, room, text, isCurrent = () => true }, submit) {
    await claim(uid, room)
    const version = generation
    const reserved = await locks.request(
      `caibao:auto-sender:v1:account:${uid}`,
      { ifAvailable: true },
      (lock) => {
        if (!lock) throw failure('此账号的另一个发送请求尚未结束，本条跳过。')
        if (version !== generation || !held || !isCurrent())
          throw failure('自动发送状态已变化，本条已取消。')
        const key = `caibao:auto-sender:v1:history:${uid}`
        let previous
        try {
          previous = JSON.parse(env.localStorage.getItem(key) || '{"lastAt":0,"recent":[]}')
        } catch {
          throw failure('无法读取共享发送记录，自动发送已暂停。')
        }
        if (
          !Number.isFinite(previous?.lastAt) ||
          previous.lastAt < 0 ||
          !Array.isArray(previous.recent) ||
          previous.recent.length > 64 ||
          previous.recent.some((item) => typeof item?.key !== 'string' || !Number.isFinite(item.at))
        )
          throw failure('共享发送记录异常，自动发送已暂停。')
        const now = env.Date.now()
        if (previous.lastAt && now - previous.lastAt < 5000)
          throw failure('此账号距离上次自动发送不足 5 秒，本条跳过。')
        const recent = previous.recent.filter((item) => now - item.at < 15000)
        const fingerprint = `${room}:${text}`
        if (recent.some((item) => item.key === fingerprint))
          throw failure('此直播间 15 秒内已自动发送相同内容，本条跳过。')
        // Reserve BEFORE submission. Ambiguous network failures must retain the
        // cooldown and duplicate guard; no implicit retry or rollback.
        try {
          env.localStorage.setItem(
            key,
            JSON.stringify({
              lastAt: now,
              recent: [...recent.slice(-63), { key: fingerprint, at: now }],
            }),
          )
        } catch {
          throw failure('无法保存共享发送记录，自动发送已暂停。')
        }
        // The atomic lock covers reservation and starting the request, not an
        // unresponsive network promise. The persisted clock protects later sends.
        return { result: submit() }
      },
    )
    return reserved.result
  }
  return { send, release }
}
// END SHARED AUTO SENDER
if (window.top !== window.self || document.getElementById('eleven-live-control')) return;
const CAIBAO_BUILD_VERSION = "0.2.6";
const CAIBAO_BUILD_REVISION = "stable-audio-and-five-second-pacing";
// SPDX-License-Identifier: AGPL-3.0-only
function createLiveCore() {
  const graphemes = (text) => typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), x => x.segment)
    : Array.from(text);
  const clean = text => String(text ?? '').replace(/\s+/gu, ' ').trim();
  const translationLanguages = ['zh', 'en', 'ko', 'ja'];
  const LIVE_MAX_AGE_MS = 20000;
  const LIVE_PENDING_LIMIT = 3;
  const liveExpired = (createdAt, now = Date.now()) => Number.isFinite(createdAt) && now - createdAt >= LIVE_MAX_AGE_MS;
  function outputLanguage(value) {
    if (value === 'translated') return 'zh'; // Migrate the former Chinese-only option.
    return translationLanguages.includes(value) ? value : '';
  }
  function detectedLanguage(results) {
    const candidates = Array.isArray(results) ? results : [];
    const top = [...candidates].sort((a, b) => Number(b.confidence) - Number(a.confidence))[0];
    if (!top || Number(top.confidence) < .6 || !Number.isFinite(Number(top.confidence))) return '';
    return String(top.detectedLanguage || '').toLowerCase().split('-')[0];
  }
  function contextSnippet(text, limit = 49) {
    let result = '';
    for (const char of graphemes(clean(text))) {
      if (Array.from(result + char).length > limit) break;
      result += char;
    }
    return result;
  }
  function canSendReviewed({ text, requireReview = false, approvedText = null }) {
    return Boolean(clean(text)) && (!requireReview || text === approvedText);
  }
  function joinText(a, b, language = 'auto') {
    a = clean(a); b = clean(b);
    if (!a || !b) return a || b;
    const noSpace = /^(zh|ja)/u.test(language) || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(a)
      || /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(b)
      || /^[，。！？、；：）】」』]/u.test(b);
    return a + (noSpace ? '' : ' ') + b;
  }
  function extractSentences(text) {
    const sentences = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (!/[。！？!?\.]/u.test(c)) continue;
      if (c === '.') {
        if (/[0-9]/u.test(text[i - 1] || '') && /[0-9]/u.test(text[i + 1] || '')) continue;
        if (/[A-Za-z0-9]/u.test(text[i + 1] || '')) continue;
        const prefix = text.slice(start, i + 1);
        if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e)\.$/iu.test(prefix)) continue;
        if (/\b[A-Z]\.$/u.test(prefix)) continue;
      }
      let end = i + 1;
      while (/[。！？!?\."'”’」』）】]/u.test(text[end] || '\0')) end++;
      const sentence = clean(text.slice(start, end));
      if (sentence) sentences.push(sentence);
      start = end;
      i = end - 1;
    }
    return { sentences, rest: clean(text.slice(start)) };
  }
  class RealtimeCommitGuard {
    constructor({ now = Date.now } = {}) { this.now = now; this.reset(); }
    reset() {
      this.partial = ''; this.audioMs = 0; this.pendingAudioMs = 0;
      this.awaitingSince = null; this.retryAt = 0;
    }
    notePartial(text) {
      text = clean(text);
      if (!this.partial && text && this.awaitingSince === null) this.audioMs = 0;
      this.partial = text;
    }
    noteCommitted() {
      if (this.awaitingSince === null) this.audioMs = 0;
      this.partial = ''; this.pendingAudioMs = 0; this.awaitingSince = null;
      this.retryAt = this.now() + 2000;
    }
    noteThrottled() {
      if (this.awaitingSince !== null) this.audioMs += this.pendingAudioMs;
      this.pendingAudioMs = 0; this.awaitingSince = null; this.retryAt = this.now() + 2000;
    }
    get timedOut() { return this.awaitingSince !== null && this.now() - this.awaitingSince >= 8000; }
    nextAudio(sampleCount, sampleRate = 16000) {
      if (this.partial || this.awaitingSince !== null) this.audioMs += sampleCount * 1000 / sampleRate;
      if (this.awaitingSince !== null || this.now() < this.retryAt || !/[\p{L}\p{N}]/u.test(this.partial)) return false;
      const length = this.partial.length;
      if (!(this.audioMs >= 6000 || (this.audioMs >= 2000 && length >= 28))) return false;
      this.pendingAudioMs = this.audioMs; this.audioMs = 0; this.awaitingSince = this.now();
      return true;
    }
  }
  class SentenceAssembler {
    constructor({ onSentence, language = 'auto', graceMs = 900, maxWaitMs = 4000, now = Date.now }) {
      Object.assign(this, { onSentence, language, graceMs, maxWaitMs, now });
      this.pending = ''; this.startedAt = null; this.activityAt = 0; this.partial = '';
    }
    notePartial(text) {
      text = clean(text);
      // Empty/repeated keepalives must not postpone a real utterance indefinitely.
      if (text && text !== this.partial) this.activityAt = this.now();
      this.partial = text;
    }
    push(text) {
      text = clean(text);
      if (!text) return;
      if (this.startedAt === null) this.startedAt = this.now();
      this.activityAt = this.now(); this.partial = '';
      const combined = extractSentences(joinText(this.pending, text, this.language));
      this.pending = combined.rest;
      for (const sentence of combined.sentences) this.onSentence(sentence, 'punctuation');
      // Only stable text enters here. A long unpunctuated confirmation must not
      // wait for another complete sentence or grow into a paragraph.
      if (this.pending.length >= 28) {
        const parts = splitForLimit(this.pending, 28, false, { balanceTail: false });
        const tail = parts.pop();
        for (const part of parts) this.onSentence(part, 'length');
        this.pending = tail || '';
        if (this.pending.length === 28) { this.onSentence(this.pending, 'length'); this.pending = ''; }
        if (parts.length) this.startedAt = this.now();
      }
      if (!this.pending) this.startedAt = null;
      else if (combined.sentences.length) this.startedAt = this.now();
    }
    tick() {
      if (!this.pending) return;
      const t = this.now();
      if ((!this.partial && t - this.activityAt >= this.graceMs) || t - this.startedAt >= this.maxWaitMs) this.flush();
    }
    flush() {
      const text = this.pending;
      this.pending = ''; this.startedAt = null;
      if (text) this.onSentence(text, 'pause');
    }
  }
  const danmakuLength = text => String(text).length;
  function unwrapDanmaku(text) {
    let result = clean(text);
    while (result.startsWith('【') && result.endsWith('】')) {
      let depth = 0; let coversWhole = true;
      for (let i = 0; i < result.length; i++) {
        if (result[i] === '【') depth++;
        else if (result[i] === '】') depth--;
        if (depth === 0 && i < result.length - 1) { coversWhole = false; break; }
      }
      if (!coversWhole || depth !== 0) break;
      result = clean(result.slice(1, -1));
    }
    return result;
  }
  function danmakuBody(text) {
    const body = unwrapDanmaku(text).replace(/^[，,。.!！?？；;：:、…）)\]】》”’」』]+/u, '').trim();
    return /[\p{L}\p{N}\p{S}]/u.test(body) ? body : '';
  }
  function splitForLimit(text, maximum, brackets = false, { balanceTail = true } = {}) {
    const limit = Math.min(30, Math.max(brackets ? 4 : 2, Math.floor(Number(maximum) || 30)));
    const max = limit - (brackets ? 2 : 0);
    const closing = value => /^[，,。.!！?？；;：:、…）)\]】》”’」』]/u.test(value || '');
    const opening = value => /^[（(\[【《“‘「『]$/u.test(value || '');
    const meaningful = value => /[\p{L}\p{N}\p{S}]/u.test(value);
    const normalized = danmakuBody(text);
    if (!meaningful(normalized)) return [];
    const chars = graphemes(normalized);
    const parts = [];
    let start = 0;
    while (start < chars.length) {
      let end = start; let length = 0;
      while (end < chars.length && length + danmakuLength(chars[end]) <= max) length += danmakuLength(chars[end++]);
      if (end === start) throw new Error('一个表情或组合字符超过单条字数限制，请检查后修改发送内容');
      if (end < chars.length) {
        const minimum = start + Math.max(1, Math.floor((end - start) / 2));
        let cut = -1;
        for (const separators of [/[。！？!?]/u, /[，,、；;：:]/u, /\s/u]) {
          for (let j = end - 1; j >= minimum; j--) {
            if (!separators.test(chars[j])) continue;
            if (/[.,]/u.test(chars[j]) && /\d/u.test(chars[j - 1] || '') && /\d/u.test(chars[j + 1] || '')) continue;
            cut = j + 1; break;
          }
          if (cut !== -1) break;
        }
        if (cut !== -1) end = cut;
        // Move a word/character with following punctuation into the next part.
        while (end > start + 1 && closing(chars[end])) end--;
        while (end > start + 1 && opening(chars[end - 1])) end--;
      }
      const part = chars.slice(start, end).join('').trim();
      if (part && meaningful(part)) parts.push(part);
      else if (part) throw new Error('标点过长，无法在字数上限内完整分段，请检查后修改发送内容');
      start = end;
    }
    if (balanceTail && parts.length > 1) {
      const tail = graphemes(parts.at(-1)); const previous = graphemes(parts.at(-2));
      const minimumTail = Math.min(4, Math.max(2, Math.floor(max / 7)));
      while ((tail.length < minimumTail || opening(previous.at(-1))) && previous.length > 1) {
        const char = previous.at(-1);
        if (closing(char) || danmakuLength(char + tail.join('')) > max) break;
        tail.unshift(previous.pop());
      }
      parts[parts.length - 2] = previous.join('').trim(); parts[parts.length - 1] = tail.join('').trim();
    }
    return parts.map(part => {
      const result = brackets ? `【${part}】` : part;
      if (danmakuLength(result) > limit) throw new Error('分段后的弹幕超出总长上限，请检查内容');
      return result;
    });
  }
  class Cancelled extends Error { constructor() { super('已取消'); this.name = 'Cancelled'; } }
  class Skipped extends Error { constructor(message) { super(message); this.name = 'Skipped'; } }
  class OrderedQueue {
    constructor({ gapMs = 0, onChange = () => {}, onError = () => 'pause', maxPending = 100, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
      Object.assign(this, { gapMs, onChange, onError, maxPending, now, sleep });
      this.items = []; this.running = false; this.paused = false; this.lastFinished = null; this.epoch = 0;
    }
    enqueue(task) {
      if (this.items.some(x => x.id === task.id)) return false;
      if (this.items.length >= this.maxPending) throw new Error('队列已满，请先处理积压的句子');
      task.status = 'queued'; this.items.push(task); this.onChange(task); void this.pump(); return true;
    }
    async pump() {
      if (this.running || this.paused) return;
      this.running = true;
      try {
        while (this.items.length && !this.paused) {
          const task = this.items[0]; const epoch = this.epoch;
          const isCurrent = () => this.epoch === epoch && this.items.includes(task);
          task.status = 'running'; this.onChange(task);
          try {
            if (this.lastFinished !== null) {
              const wait = Math.max(0, this.gapMs - (this.now() - this.lastFinished));
              if (wait > 0) await this.sleep(wait);
            }
            if (!isCurrent()) throw new Cancelled();
            await task.run(isCurrent);
            task.status = isCurrent() ? 'done' : 'cancelled';
          } catch (err) {
            if (!isCurrent() || err instanceof Cancelled) { if (task.status !== 'skipped') task.status = 'cancelled'; }
            else if (err instanceof Skipped || this.onError(task, err) === 'skip') { task.status = 'skipped'; task.error = err.message || String(err); }
            else { task.status = 'failed'; task.error = err.message || String(err); this.paused = true; }
          } finally { this.lastFinished = this.now(); }
          this.onChange(task);
          if (task.status === 'failed') break;
          if (this.items[0] === task) this.items.shift();
        }
      } finally { this.running = false; }
    }
    retry() {
      if (this.items[0]?.status === 'failed') { this.items[0].error = ''; this.items[0].status = 'queued'; }
      this.paused = false; void this.pump();
    }
    skip() {
      if (this.items[0]?.status === 'failed') { const task = this.items.shift(); task.status = 'skipped'; this.onChange(task); }
      this.paused = false; void this.pump();
    }
    clear() {
      this.epoch++;
      for (const task of this.items) { task.cancel?.(); task.status = 'cancelled'; this.onChange(task); }
      this.items = []; this.paused = false;
    }
    dropWhere(predicate, reason) {
      const removed = this.items.filter(predicate);
      const headRemoved = removed.includes(this.items[0]);
      this.items = this.items.filter(task => !removed.includes(task));
      for (const task of removed) { task.cancel?.(); task.status = 'skipped'; task.error = reason; this.onChange(task); }
      if (headRemoved) this.paused = false;
      if (removed.length) void this.pump();
      return removed.length;
    }
  }
  return { clean, joinText, extractSentences, SentenceAssembler, splitForLimit, danmakuBody, OrderedQueue, Cancelled, graphemes,
    contextSnippet, canSendReviewed, danmakuLength, translationLanguages, outputLanguage, detectedLanguage,
    LIVE_MAX_AGE_MS, LIVE_PENDING_LIMIT, liveExpired, Skipped, RealtimeCommitGuard };
}


// SPDX-License-Identifier: AGPL-3.0-only
// Room state is independent of audio energy: a quiet or buffering live room is
// not an offline room. Only explicit platform status 0 / 2 can stop a session.
function createAutoSendLease(doc, owner, shared) {
  const attribute = 'data-caibao-auto-sender';
  const current = () => doc.documentElement?.getAttribute(attribute) || '';
  return {
    blocked: () => Boolean(current() && current() !== owner),
    claim() {
      if (current() && current() !== owner) return false;
      doc.documentElement?.setAttribute(attribute, owner); return true;
    },
    release() { shared?.release(); if (current() === owner) doc.documentElement?.removeAttribute(attribute); }
  };
}

function createKeyVault({ read, write, remove }) {
  let key = String(read() || '').trim();
  return {
    get: () => key,
    capture(input, remember) {
      if (input.value.trim()) key = input.value.trim();
      input.value = '';
      if (remember && key) write(key); else remove();
      return key;
    },
    forgetSaved: () => remove()
  };
}

// Waiting never opens a browser picker: the fallback has its own fresh user click.
function waitForPlayerInput({ capture, signal, waitMs = 4000, intervalMs = 200,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  return new Promise((resolve, reject) => {
    let timer = null, settled = false;
    const until = now() + waitMs;
    const finish = (value, error) => {
      if (settled) return; settled = true; clearTimer(timer);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve(value);
    };
    const aborted = () => finish(null, Object.assign(new Error('已取消'), { name: 'Cancelled' }));
    const check = () => {
      if (signal.aborted) return aborted();
      const input = capture();
      if (input || now() >= until) return finish(input);
      timer = setTimer(check, Math.min(intervalMs, until - now()));
    };
    signal.addEventListener('abort', aborted, { once: true }); check();
  });
}

function createEchoTracker({ readMessages, ownUid, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = 8000 }) {
  const pending = new Set();
  return {
    expect(text, isCurrent = () => true) {
      const baseline = new Set(readMessages().map(message => message.key));
      const uid = ownUid(), deadline = now() + timeoutMs;
      let timer = null, done = false, resolve;
      const promise = new Promise(value => { resolve = value; });
      const cancel = () => finish(false);
      function finish(confirmed) {
        if (done) return; done = true; clearTimer(timer); pending.delete(cancel); resolve(confirmed);
      }
      function check() {
        if (!isCurrent() || !uid) return finish(false);
        if (readMessages().some(message => !baseline.has(message.key) && message.uid === uid && message.text === text)) return finish(true);
        if (now() >= deadline) return finish(false);
        timer = setTimer(check, Math.min(100, deadline - now()));
      }
      pending.add(cancel); check(); return { promise, cancel };
    },
    cancelAll() { for (const cancel of [...pending]) cancel(); }
  };
}

function createLiveRoomMonitor({
  readStatus, onOffline = () => {}, onUnknown = () => {}, onLive = () => {}, onStatus = () => {},
  continuous = false, intervalMs = 15000, waitingIntervalMs = 30000, confirmMs = 3000,
  now = () => typeof performance !== 'undefined' ? performance.now() : Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout
}) {
  if (typeof readStatus !== 'function') throw new TypeError('readStatus must be a function');
  let active = false, generation = 0, timer = null, controller = null, inFlight = null;
  let lastStatus = null, confirmedStatus = null, suspectAt = null, unknownNotified = false;
  const cancelTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const current = run => active && generation === run;
  function stop() {
    active = false; generation++; cancelTimer(); controller?.abort(); controller = null;
    inFlight = null; suspectAt = null;
  }
  function schedule(delay, run) {
    if (!current(run)) return;
    cancelTimer();
    timer = setTimer(() => { timer = null; void check(false); }, Math.max(0, delay));
  }
  function check(initial) {
    if (!active) return Promise.resolve(null);
    if (inFlight) return inFlight.promise;
    const run = generation;
    // Repeated recovery notifications must not turn two same-instant reads into
    // an offline confirmation. Keep the existing confirmation timer instead.
    if (!initial && suspectAt !== null && now() - suspectAt < confirmMs) return Promise.resolve(lastStatus);
    cancelTimer();
    const request = { run, promise: null };
    const signal = controller.signal;
    request.promise = (async () => {
      let result = null, failure = null;
      try {
        const value = await readStatus(signal);
        if (value === 0 || value === 1 || value === 2) result = value;
      } catch (error) { failure = error; }
      if (!current(run) || signal.aborted) return null;
      lastStatus = result;
      onStatus(result);
      if (!current(run) || signal.aborted) return null;
      if (result === null) {
        // Unknown breaks a suspect sequence; network errors never confirm a
        // shutdown. Notify once per unknown streak instead of flooding logs.
        suspectAt = null;
        if (!unknownNotified) { unknownNotified = true; onUnknown(failure); }
        schedule(intervalMs, run);
      } else {
        unknownNotified = false;
        if (result === 1) {
          suspectAt = null;
          if (confirmedStatus !== 1) { confirmedStatus = 1; onLive(); }
          schedule(intervalMs, run);
        }
        else if (continuous && confirmedStatus !== 1) {
          suspectAt = null;
          if (confirmedStatus === null || initial) onOffline(result, { initial });
          confirmedStatus = result; schedule(waitingIntervalMs, run);
        }
        else if (initial || suspectAt !== null) {
          if (continuous) {
            suspectAt = null; confirmedStatus = result;
            onOffline(result, { initial }); schedule(waitingIntervalMs, run);
          } else {
            // Close first so callback-triggered cleanup cannot leave a timer alive.
            stop(); onOffline(result, { initial });
          }
        } else {
          suspectAt = now(); schedule(confirmMs, run);
        }
      }
      return result;
    })().finally(() => { if (inFlight === request) inFlight = null; });
    inFlight = request;
    return request.promise;
  }
  return {
    start() {
      if (active) return inFlight?.promise || Promise.resolve(lastStatus);
      active = true; generation++; controller = new AbortController();
      lastStatus = null; confirmedStatus = null; suspectAt = null; unknownNotified = false;
      return check(true);
    },
    checkNow() { return check(false); },
    stop,
    get active() { return active; },
    get lastStatus() { return lastStatus; }
  };
}


// SPDX-License-Identifier: AGPL-3.0-only
// Formatting owns source ranges and immutable text; transport consumes each
// finalized packet once. Platform waiting never changes the preview's wording.
function createDanmakuSender(Core, {
  send, onPacket = () => {}, onSending = () => {}, onUpdate = () => {}, onNotice = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
  maxPending = Core.LIVE_PENDING_LIMIT, maxAge = Core.LIVE_MAX_AGE_MS
}) {
  let drafts = [], queue = [], inFlight = null, formatTimer = null, formatAt = null, sendTimer = null;
  let generation = 0, packetId = 0, formatting = false;
  const minimumPaceMs = 5000, mergeWindowMs = 1000, longSentenceLength = 14, states = new WeakMap();
  let pauseUntil = 0, learnedPace = minimumPaceMs, rejectionStreak = 0, lastRequestAt = null, pauseReason = '';
  // A failed-request pause is temporary. Only explicit rate feedback adjusts
  // the normal request cadence; every request still respects the five-second floor.
  const nextRequestAt = () => Math.max(pauseUntil, lastRequestAt === null ? 0 : lastRequestAt + learnedPace);
  const expired = fragment => now() - fragment.createdAt >= maxAge;
  const batch = fragment => fragment.record.commitBatchId ?? fragment.record;
  function update(record) {
    const fragments = states.get(record).fragments;
    record.parts = fragments.map(fragment => `【${fragment.text}】`);
    record.sentParts = fragments.filter(fragment => fragment.status === 'done').length;
    record.previewedParts = fragments.filter(fragment => fragment.status === 'previewed').length;
    record.status = fragments.some(fragment => fragment.status === 'running') ? 'running'
      : drafts.some(fragment => fragment.record === record) || fragments.some(fragment => fragment.status === 'queued') ? 'queued'
      : fragments.some(fragment => fragment.status === 'skipped') ? 'skipped'
      : fragments.some(fragment => fragment.status === 'cancelled') ? 'cancelled'
      : fragments.some(fragment => fragment.status === 'previewed') ? 'previewed' : 'done';
    if (record.status === 'done') record.sentAt = now();
    onUpdate(record);
  }
  function mark(fragments, status, reason = '') {
    const owners = new Set();
    for (const fragment of fragments) {
      fragment.status = status; owners.add(fragment.record);
      if (reason) fragment.record.skipReason = reason;
    }
    for (const record of owners) update(record);
  }
  function discardDrafts(predicate, status, reason) {
    const removed = drafts.filter(predicate); drafts = drafts.filter(fragment => !predicate(fragment));
    for (const fragment of removed) states.get(fragment.record).fragments.push(fragment);
    mark(removed, status, reason);
  }
  function packets() {
    const groups = [];
    for (const fragment of drafts) {
      const record = fragment.record, automatic = record.automatic !== false;
      const key = record.path + '\0' + (record.targetLanguage || record.sourceLanguage || 'auto') + '\0' + automatic;
      let group = groups.at(-1);
      if (group?.key !== key) { group = { key, body: '', ranges: [], path: record.path, automatic }; groups.push(group); }
      group.body = Core.joinText(group.body, fragment.text, record.targetLanguage || record.sourceLanguage);
      group.ranges.push({ fragment, start: group.body.length - fragment.text.length, end: group.body.length });
    }
    const result = [];
    for (const group of groups) {
      let cursor = 0;
      for (const text of Core.splitForLimit(group.body, 30, true)) {
        const body = text.slice(1, -1), start = group.body.indexOf(body, cursor), end = start + body.length;
        if (start < cursor) throw new Error('弹幕分段与原文位置不一致');
        cursor = end;
        const fragments = group.ranges.flatMap(range => {
          const from = Math.max(start, range.start), to = Math.min(end, range.end);
          return to > from ? [{ ...range.fragment, parent: range.fragment, text: group.body.slice(from, to),
            start: range.fragment.start + from - range.start, end: range.fragment.start + to - range.start, status: 'queued' }] : [];
        });
        result.push({ body, path: group.path, automatic: group.automatic, fragments });
      }
    }
    return result;
  }
  function readyAt(grouped) {
    const first = grouped[0];
    if (!first) return null;
    if (first.body.length >= 28 || first.fragments.some(fragment => fragment.parent.text.length >= longSentenceLength) || grouped.length > 1) return now();
    return Math.min(...first.fragments.map(fragment => fragment.queuedAt)) + mergeWindowMs;
  }
  function scheduleFormat() {
    if (!drafts.length) {
      if (formatTimer !== null) clearTimer(formatTimer);
      formatTimer = null; formatAt = null; return;
    }
    const due = Math.max(now(), readyAt(packets()));
    if (formatTimer !== null && formatAt <= due) return;
    if (formatTimer !== null) clearTimer(formatTimer);
    formatAt = due;
    formatTimer = setTimer(() => { formatTimer = null; formatAt = null; formatReady(); }, Math.max(0, due - now()));
  }
  function skipPacket(packet, status, reason) {
    packet.event.status = status; packet.event.reason = reason;
    mark(packet.fragments, status, reason);
  }
  function pruneQueue() {
    const stale = queue.filter(packet => packet.fragments.some(expired));
    queue = queue.filter(packet => !stale.includes(packet));
    stale.forEach(packet => skipPacket(packet, 'skipped', '待发内容已超过20秒'));
    const capacity = maxPending + (!inFlight && now() >= nextRequestAt() ? 1 : 0);
    const cutoff = Math.max(0, queue.length - capacity);
    const retained = new Set(queue.slice(cutoff).flatMap(packet => packet.fragments.map(batch)));
    const old = queue.slice(0, cutoff).filter(packet => !packet.fragments.some(fragment => retained.has(batch(fragment))));
    queue = queue.filter(packet => !old.includes(packet));
    old.forEach(packet => skipPacket(packet, 'skipped', '弹幕积压，保留较新的待发内容'));
  }
  function scheduleSend() {
    if (sendTimer !== null) clearTimer(sendTimer);
    sendTimer = null;
    if (!queue.length || inFlight) return;
    if (now() >= nextRequestAt()) { void pump(); return; }
    const expiresAt = Math.min(...queue.flatMap(packet => packet.fragments.map(fragment => fragment.createdAt + maxAge)));
    const due = Math.min(Math.max(now(), nextRequestAt()), expiresAt);
    sendTimer = setTimer(() => { sendTimer = null; void pump(); }, Math.max(0, due - now()));
  }
  function finalize(packet) {
    for (const fragment of packet.fragments) {
      const parent = fragment.parent, used = fragment.end - parent.start;
      const remaining = parent.text.slice(used), trimmed = remaining.trimStart();
      parent.start = fragment.end + remaining.length - trimmed.length; parent.text = trimmed;
      delete fragment.parent; states.get(fragment.record).fragments.push(fragment);
    }
    drafts = drafts.filter(fragment => fragment.text);
    const owners = [...new Set(packet.fragments.map(fragment => fragment.record))];
    const event = { id: ++packetId, recordIds: Object.freeze(owners.map(record => record.id)),
      sourceRanges: Object.freeze(packet.fragments.map(fragment => Object.freeze({ recordId: fragment.record.id, start: fragment.start, end: fragment.end }))),
      automatic: packet.automatic, previewedAt: now(), startedAt: null, finishedAt: null,
      status: packet.automatic ? 'queued' : 'previewed', reason: '' };
    Object.defineProperty(event, 'text', { value: `【${packet.body}】`, enumerable: true });
    packet.event = event;
    for (const record of owners) record.previewEvents.push(event);
    onPacket(event);
    if (packet.automatic) queue.push(packet);
    mark(packet.fragments, packet.automatic ? 'queued' : 'previewed');
  }
  function formatReady() {
    if (formatting) return;
    formatting = true;
    try {
      discardDrafts(expired, 'skipped', '待发内容已超过20秒');
      while (drafts.length) {
        const grouped = packets();
        if (now() < readyAt(grouped)) break;
        finalize(grouped[0]);
      }
      pruneQueue(); scheduleFormat(); scheduleSend();
    } finally { formatting = false; }
  }
  function cancelRelated(owners, reason) {
    // A frozen packet may contain the end of one sentence and the beginning of
    // another. If it is skipped, that second sentence's tail cannot stand alone.
    let grew;
    do {
      grew = false;
      for (const packet of queue) {
        if (!packet.fragments.some(fragment => owners.has(fragment.record))) continue;
        for (const fragment of packet.fragments) if (!owners.has(fragment.record)) { owners.add(fragment.record); grew = true; }
      }
    } while (grew);
    discardDrafts(fragment => owners.has(fragment.record), 'skipped', reason);
    const related = queue.filter(packet => packet.fragments.some(fragment => owners.has(fragment.record)));
    queue = queue.filter(packet => !related.includes(packet));
    related.forEach(packet => skipPacket(packet, 'skipped', reason));
  }
  async function pump() {
    pruneQueue();
    if (!queue.length || inFlight) return;
    if (now() < nextRequestAt()) { scheduleSend(); return; }
    const packet = queue.shift(), event = packet.event, owners = [...new Set(packet.fragments.map(fragment => fragment.record))];
    const epoch = generation; inFlight = packet; event.status = 'preparing';
    const isCurrent = () => generation === epoch && inFlight === packet;
    const checkCurrent = () => {
      if (!isCurrent()) throw new Core.Cancelled();
      if (packet.fragments.some(expired)) throw new Core.Skipped('待发内容已超过20秒');
    };
    const attempted = (requestInfo = {}) => {
      checkCurrent();
      if (event.startedAt !== null) throw new Error('同一条弹幕不能重复提交');
      event.startedAt = now(); event.status = 'sending';
      onSending(event);
      lastRequestAt = event.startedAt;
      event.requestInfo = { signed: requestInfo.signed === true, webLocation: String(requestInfo.webLocation || ''),
        bodyFields: Array.isArray(requestInfo.bodyFields) ? requestInfo.bodyFields.map(String) : [],
        fields: Object.fromEntries(Object.entries(requestInfo.fields || {}).filter(([name]) => ['roomid','room_type','jumpfrom','reply_mid','reply_attr','replay_dmid','color','mode','bubble','fontsize','rnd','dm_type','statistics'].includes(name))) };
      for (const record of owners) { record.sendEvents.push(event); update(record); }
    };
    mark(packet.fragments, 'running');
    try {
      checkCurrent();
      const accepted = response => {
        event.httpStatus = response?.httpStatus ?? null; event.responseCode = response?.code ?? null;
        event.responseMessage = String(response?.message || response?.msg || '');
        event.status = 'submitted';
        if (isCurrent()) for (const record of owners) onUpdate(record);
      };
      const response = await send(event.text, packet.path, isCurrent, checkCurrent, attempted, accepted);
      event.httpStatus = response?.httpStatus ?? null; event.responseCode = response?.code ?? null;
      event.responseMessage = String(response?.message || response?.msg || '');
      event.finishedAt = now(); event.status = response?.confirmed === true ? 'echoed' : response?.confirmed === false ? 'unconfirmed' : 'submitted'; rejectionStreak = 0; pauseUntil = 0; pauseReason = '';
      learnedPace = Math.max(minimumPaceMs, Math.floor(learnedPace * .75));
      if (isCurrent()) { mark(packet.fragments, 'done'); onNotice(event.status === 'unconfirmed' ? '已提交但未看到本人回显，本条不会自动补发。' : ''); }
    } catch (error) {
      event.finishedAt = now(); event.reason = error.message || String(error);
      event.httpStatus = error.httpStatus ?? null; event.responseCode = error.responseCode ?? null;
      event.responseMessage = String(error.responseMessage || '');
      event.status = error.unconfirmed ? 'unconfirmed' : error instanceof Core.Cancelled ? 'cancelled' : error instanceof Core.Skipped ? 'skipped' : 'failed';
      const attemptedRequest = Number.isFinite(event.startedAt), rejected = attemptedRequest && !(error instanceof Core.Cancelled || error instanceof Core.Skipped);
      if (error.rateLimited || rejected) {
        if (error.rateLimited) {
          rejectionStreak++;
          const suggested = Math.max(0, Number(error.retryAfterMs) || 0);
          learnedPace = Math.min(30000, Math.max(minimumPaceMs, Math.ceil(learnedPace * 1.5)));
          pauseUntil = now() + Math.max(suggested, learnedPace); pauseReason = 'rate';
        } else {
          rejectionStreak++;
          if (rejectionStreak >= 3) {
            const pause = Math.min(10000, 3000 * 2 ** Math.min(rejectionStreak - 3, 2));
            pauseUntil = now() + pause; pauseReason = 'rejected';
          }
        }
      }
      if (isCurrent()) {
        mark(packet.fragments, error instanceof Core.Cancelled ? 'cancelled' : 'skipped', event.reason);
        cancelRelated(new Set(owners), '同一句的前一分段未发送，后续分段已跳过');
        if (error.rateLimited) onNotice('平台提示发送过快，已自动调整发送节奏；本条跳过');
        else if (rejected && rejectionStreak >= 3) onNotice('连续请求未获受理，已暂缓发送；字幕继续显示');
        else if (!(error instanceof Core.Cancelled || error instanceof Core.Skipped)) onNotice(`弹幕未发送：${event.reason.slice(0, 90)}`);
      }
    } finally {
      if (!isCurrent()) for (const record of owners) onUpdate(record);
      if (inFlight === packet) inFlight = null;
      pruneQueue(); scheduleFormat(); scheduleSend();
    }
  }
  return {
    enqueue(record) {
      if (states.has(record)) return;
      const body = Core.danmakuBody(record.text);
      if (!body) { record.status = 'skipped'; record.skipReason = '没有可发送的正文'; onUpdate(record); return; }
      Core.splitForLimit(body, 30, true);
      record.queuedAt = now(); record.sendEvents = []; record.previewEvents = []; record.parts = []; record.sentParts = 0;
      states.set(record, { fragments: [] });
      drafts.push({ record, text: body, start: 0, end: body.length, createdAt: record.createdAt,
        queuedAt: record.queuedAt, status: 'queued' });
      update(record); scheduleFormat();
    },
    prune() { formatReady(); },
    clear(reason = '已取消待发内容') {
      generation++;
      if (formatTimer !== null) clearTimer(formatTimer); if (sendTimer !== null) clearTimer(sendTimer);
      formatTimer = null; formatAt = null; sendTimer = null;
      discardDrafts(() => true, 'cancelled', reason);
      const cancelled = queue; queue = []; cancelled.forEach(packet => skipPacket(packet, 'cancelled', reason));
      if (inFlight) mark(inFlight.fragments, 'cancelled', reason);
    },
    get pendingCount() { return queue.length + packets().length; },
    get waitingMs() { return queue.length || drafts.some(fragment => fragment.record.automatic !== false) ? Math.max(0, nextRequestAt() - now()) : 0; },
    get waitReason() { return pauseUntil > now() ? pauseReason : learnedPace > minimumPaceMs ? 'feedback' : 'pace'; },
    get paceMs() { return learnedPace; }
  };
}


// SPDX-License-Identifier: AGPL-3.0-only
// WBI parameter ordering/mixing follows the user-provided LAPLACE Chatterbox
// 4.6.0 reference (https://github.com/laplace-live/chatterbox).
// MD5 is required by this request protocol; it is not used for secret storage.
function createBilibiliProtocol() {
  const mix = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
  function md5(text) {
    const bytes = new TextEncoder().encode(String(text));
    const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
    padded.set(bytes); padded[bytes.length] = 128;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, bytes.length * 8, true);
    view.setUint32(padded.length - 4, Math.floor(bytes.length / 0x20000000), true);
    let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
    const shifts = [[7,12,17,22],[5,9,14,20],[4,11,16,23],[6,10,15,21]];
    for (let offset = 0; offset < padded.length; offset += 64) {
      let aa = a, bb = b, cc = c, dd = d;
      for (let i = 0; i < 64; i++) {
        const round = Math.floor(i / 16);
        const f = round === 0 ? (bb & cc) | (~bb & dd) : round === 1 ? (dd & bb) | (~dd & cc) : round === 2 ? bb ^ cc ^ dd : cc ^ (bb | ~dd);
        const index = round === 0 ? i : round === 1 ? (5 * i + 1) % 16 : round === 2 ? (3 * i + 5) % 16 : 7 * i % 16;
        const sum = (aa + f + Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) + view.getUint32(offset + index * 4, true)) | 0;
        const shift = shifts[round][i % 4];
        const next = (bb + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
        aa = dd; dd = cc; cc = bb; bb = next;
      }
      a = (a + aa) | 0; b = (b + bb) | 0; c = (c + cc) | 0; d = (d + dd) | 0;
    }
    return [a,b,c,d].map(word => [0,8,16,24].map(shift => ((word >>> shift) & 255).toString(16).padStart(2, '0')).join('')).join('');
  }
  function keysFromNav(body) {
    if (body?.code !== 0) throw new Error('未能取得B站发送签名，请确认登录状态后重试');
    const read = name => String(body.data?.wbi_img?.[name] || '').split('/').pop().split('.')[0];
    const img_key = read('img_url'), sub_key = read('sub_url');
    if (!/^[a-f\d]{32}$/iu.test(img_key) || !/^[a-f\d]{32}$/iu.test(sub_key)) throw new Error('B站发送签名数据不完整，本条已跳过');
    return { img_key, sub_key };
  }
  function sign(params, keys, now = Date.now()) {
    if (!/^[a-f\d]{32}$/iu.test(keys?.img_key || '') || !/^[a-f\d]{32}$/iu.test(keys?.sub_key || '')) throw new Error('B站发送签名数据无效');
    const original = keys.img_key + keys.sub_key, key = mix.map(index => original[index]).join('').slice(0,32);
    const values = { ...params, wts: Math.round(now / 1000) };
    const query = Object.keys(values).sort().map(name => `${encodeURIComponent(name)}=${encodeURIComponent(String(values[name] ?? '').replace(/[!'()*]/gu, ''))}`).join('&');
    return query + '&w_rid=' + md5(query + key);
  }
  return { md5, keysFromNav, sign };
}


// SPDX-License-Identifier: AGPL-3.0-only
// Read-only diagnostic observer. Never sends, rewrites, retries or cancels a request.
function createNativeSendObserver(win, { onRecord, isOwnRequest = () => false, now = Date.now }) {
  let stopped = false;
  const xhrInfo = new WeakMap();
  const allowed = new Set(['msg','roomid','room_type','jumpfrom','reply_mid','reply_attr','replay_dmid','color','mode','bubble','fontsize','rnd','dm_type']);
  function target(value) {
    try {
      const url = new win.URL(String(value), win.location.href);
      if (url.protocol !== 'https:' || !['api.live.bilibili.com','live.bilibili.com'].includes(url.hostname)
        || !/^\/(?:msg\/send|xlive\/web-room\/v\d+\/dM\/send[^/]*)$/iu.test(url.pathname)) return null;
      return { endpoint: url.origin + url.pathname, queryFields: [...url.searchParams.keys()].sort(),
        webLocation: url.searchParams.get('web_location') || '', signed: url.searchParams.has('w_rid') };
    } catch { return null; }
  }
  async function summarizeBody(body) {
    let entries = [], encoding = '未识别';
    try {
      if (body && typeof body.entries === 'function') { entries = [...body.entries()]; encoding = typeof body.getAll === 'function' && body.constructor?.name === 'FormData' ? 'FormData' : 'URLSearchParams'; }
      else if (typeof body === 'string') {
        if (/^\s*\{/u.test(body)) { entries = Object.entries(JSON.parse(body)); encoding = 'JSON'; }
        else { entries = [...new win.URLSearchParams(body).entries()]; encoding = '表单编码'; }
      }
    } catch { encoding = '无法读取'; }
    const fields = {}, names = [], withheld = [];
    for (const [rawName, value] of entries) {
      const name = String(rawName); names.push(name);
      if (allowed.has(name) && ['string','number','boolean'].includes(typeof value)) fields[name] = String(value).slice(0, name === 'msg' ? 500 : 100);
      else if (name === 'statistics') {
        try { const data = typeof value === 'string' ? JSON.parse(value) : value;
          fields.statistics = JSON.stringify({ appId: data?.appId ?? null, platform: data?.platform ?? null });
        } catch { fields.statistics = '无法解析'; }
      } else withheld.push(name);
    }
    return { bodyEncoding: encoding, bodyFields: names.sort(), fields, withheldFields: withheld.sort() };
  }
  function responseInfo(status, body) {
    return { httpStatus: Number(status) || 0, responseCode: ['number','string'].includes(typeof body?.code) ? body.code : null,
      responseMessage: String(body?.message || body?.msg || '').slice(0,160) };
  }
  function publish(meta, body, response) {
    void Promise.resolve(body).then(summary => {
      if (!stopped) onRecord({ ...meta, ...summary, ...response, finishedAt: now() });
    }).catch(() => {});
  }
  const originalFetch = win.fetch;
  function observedFetch(...args) {
    const own = isOwnRequest(), input = args[0], options = args[1] || {};
    // Return the very same promise and preserve every argument and receiver.
    const result = Reflect.apply(originalFetch, this, args);
    if (stopped || own) return result;
    const info = target(typeof input === 'string' || input instanceof win.URL ? input : input?.url);
    const method = String(options.method || input?.method || 'GET').toUpperCase();
    if (!info || method !== 'POST') return result;
    let body, headers;
    try {
      body = options.body !== undefined ? summarizeBody(options.body) : input?.clone ? input.clone().text().then(summarizeBody) : summarizeBody(null);
      headers = new win.Headers(options.headers || input?.headers);
    } catch { body = summarizeBody(null); }
    const meta = { ...info, transport: 'fetch', method, startedAt: now(), credentials: options.credentials || input?.credentials || 'same-origin',
      contentType: headers?.get('content-type') || '', headerFields: headers ? [...headers.keys()].sort() : [] };
    void Promise.resolve(result).then(async response => {
      let data = null; try { data = await response.clone().json(); } catch {}
      publish(meta, body, responseInfo(response.status, data));
    }, () => publish(meta, body, responseInfo(0, null))).catch(() => {});
    return result;
  }
  const proto = win.XMLHttpRequest?.prototype, originalOpen = proto?.open, originalSend = proto?.send, originalHeader = proto?.setRequestHeader;
  function observedOpen(...args) {
    const result = Reflect.apply(originalOpen, this, args);
    const info = target(args[1]);
    xhrInfo.set(this, info ? { ...info, method: String(args[0]).toUpperCase(), headerFields: [], contentType: '' } : null);
    return result;
  }
  function observedHeader(...args) {
    const result = Reflect.apply(originalHeader, this, args), info = xhrInfo.get(this);
    if (info) { const name = String(args[0]).toLowerCase(); info.headerFields.push(name);
      if (name === 'content-type') info.contentType = String(args[1]).slice(0,100); }
    return result;
  }
  function observedSend(...args) {
    const info = xhrInfo.get(this);
    if (!stopped && !isOwnRequest() && info?.method === 'POST') {
      const meta = { ...info, transport: 'XMLHttpRequest', credentials: this.withCredentials ? 'include' : 'same-origin', startedAt: now() };
      const body = summarizeBody(args[0]);
      this.addEventListener('loadend', () => {
        if (stopped) return;
        let data = null;
        try { data = this.responseType === 'json' ? this.response : JSON.parse(this.responseText); } catch {}
        publish(meta, body, responseInfo(this.status, data));
      }, { once: true });
    }
    return Reflect.apply(originalSend, this, args);
  }
  try { win.fetch = observedFetch; } catch {}
  try { if (proto) { proto.open = observedOpen; proto.send = observedSend; proto.setRequestHeader = observedHeader; } } catch {}
  return {
    get supported() { return win.fetch === observedFetch || proto?.send === observedSend; },
    get status() { return { fetch: win.fetch === observedFetch, xhr: proto?.send === observedSend && proto?.open === observedOpen }; },
    stop() {
      stopped = true;
      try { if (win.fetch === observedFetch) win.fetch = originalFetch; } catch {}
      try { if (proto?.open === observedOpen) proto.open = originalOpen;
        if (proto?.send === observedSend) proto.send = originalSend;
        if (proto?.setRequestHeader === observedHeader) proto.setRequestHeader = originalHeader; } catch {}
    }
  };
}


// SPDX-License-Identifier: AGPL-3.0-only
// Bootstrap before the UI/body exists. Page-side code receives only diagnostic
// channel names and a read-only observer, never GM APIs, cookies or ASR keys.
function startEarlyNativeCapture(win, injectElement) {
  const slot = Symbol.for('caibao.native.capture.bridge');
  if (win[slot]?.active) return win[slot];
  const doc = win.document, nonce = Array.from(win.crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('');
  const names = { data: 'caibao-native-data-' + nonce, ack: 'caibao-native-ack-' + nonce, command: 'caibao-native-command-' + nonce };
  const records = []; let nextId = 1, ownDepth = 0, stopped = false, subscriber = null, rootWait = null, ackTimer = null;
  let fallback = null;
  const state = { pageAcknowledged: false, mode: '等待网页确认', readyState: doc.readyState, fetch: false, xhr: false, error: '' };
  const changed = () => { try { subscriber?.(); } catch {} };
  const append = record => { if (stopped) return; records.push({ ...record, id: nextId++ }); if (records.length > 20) records.shift(); changed(); };
  function command(type) { try { doc.dispatchEvent(new win.CustomEvent(names.command, { detail: type })); } catch {} }
  function onData(event) {
    if (!state.pageAcknowledged || typeof event.detail !== 'string' || event.detail.length > 32768) return;
    try {
      const record = JSON.parse(event.detail);
      if (!record || !['fetch','XMLHttpRequest'].includes(record.transport) || !Array.isArray(record.bodyFields) || !record.fields || typeof record.fields !== 'object') return;
      const endpoint = new win.URL(String(record.endpoint));
      if (endpoint.protocol !== 'https:' || !['api.live.bilibili.com','live.bilibili.com'].includes(endpoint.hostname)) return;
      const names = value => Array.isArray(value) ? value.slice(0,80).map(item => String(item).slice(0,80)) : [];
      const fields = {}, allowed = ['msg','roomid','room_type','jumpfrom','reply_mid','reply_attr','replay_dmid','color','mode','bubble','fontsize','rnd','dm_type'];
      for (const name of allowed) if (typeof record.fields[name] === 'string') fields[name] = record.fields[name].slice(0,name === 'msg' ? 500 : 100);
      if (record.fields.statistics) { try { const value = JSON.parse(record.fields.statistics);
        fields.statistics = JSON.stringify({ appId: Number.isFinite(Number(value.appId)) ? Number(value.appId) : null, platform: Number.isFinite(Number(value.platform)) ? Number(value.platform) : null }); } catch {} }
      append({ endpoint: endpoint.origin + endpoint.pathname, transport: record.transport, method: 'POST',
        startedAt: Number.isFinite(record.startedAt) ? record.startedAt : null, finishedAt: Number.isFinite(record.finishedAt) ? record.finishedAt : null,
        credentials: String(record.credentials || '').slice(0,32), bodyEncoding: String(record.bodyEncoding || '').slice(0,32),
        contentType: String(record.contentType || '').slice(0,100), headerFields: names(record.headerFields), queryFields: names(record.queryFields),
        webLocation: String(record.webLocation || '').slice(0,64), signed: record.signed === true, bodyFields: names(record.bodyFields), fields,
        withheldFields: names(record.withheldFields), httpStatus: Number(record.httpStatus) || 0,
        responseCode: ['string','number'].includes(typeof record.responseCode) ? record.responseCode : null,
        responseMessage: String(record.responseMessage || '').slice(0,160) });
    } catch {}
  }
  function onAck(event) {
    if (typeof event.detail !== 'string') return;
    try {
      const receipt = JSON.parse(event.detail);
      if (receipt.channel !== names.data) return;
      clearTimeout(ackTimer); fallback?.stop(); fallback = null;
      Object.assign(state, { pageAcknowledged: true, mode: receipt.fetch || receipt.xhr ? '网页环境已确认' : '网页已执行但未能挂接', readyState: String(receipt.readyState || ''), fetch: receipt.fetch === true, xhr: receipt.xhr === true, error: '' });
      changed();
    } catch {}
  }
  doc.addEventListener(names.data, onData); doc.addEventListener(names.ack, onAck);
  function pageBootstrap(channels, createObserver) {
    const pageSlot = Symbol.for('caibao.native.capture.page');
    const previous = window[pageSlot];
    if (previous?.channel === channels.data) { previous.ack(); return; }
    previous?.stop();
    let own = 0, closed = false;
    const observer = createObserver(window, { isOwnRequest: () => own > 0,
      onRecord: record => { if (!closed) document.dispatchEvent(new CustomEvent(channels.data, { detail: JSON.stringify(record) })); } });
    const onCommand = event => {
      if (event.detail === 'begin') own++;
      else if (event.detail === 'end') own = Math.max(0, own - 1);
      else if (event.detail === 'stop') stop();
    };
    function ack() { document.dispatchEvent(new CustomEvent(channels.ack, { detail: JSON.stringify({ channel: channels.data, readyState: document.readyState, ...observer.status }) })); }
    function stop() {
      if (closed) return; closed = true; observer.stop();
      document.removeEventListener(channels.command, onCommand); window.removeEventListener('pagehide', stop);
      if (window[pageSlot]?.channel === channels.data) delete window[pageSlot];
    }
    document.addEventListener(channels.command, onCommand); window.addEventListener('pagehide', stop, { once: true });
    window[pageSlot] = { channel: channels.data, ack, stop }; ack();
  }
  const source = `;(${pageBootstrap.toString()})(${JSON.stringify(names)},(${createNativeSendObserver.toString()}));`;
  function directFallback(reason) {
    if (stopped || state.pageAcknowledged || fallback) return;
    state.mode = '网页未确认，仅备用观察'; state.error = reason;
    fallback = createNativeSendObserver(win, { isOwnRequest: () => ownDepth > 0, onRecord: append });
    state.fetch = fallback.status.fetch; state.xhr = fallback.status.xhr; changed();
  }
  function install() {
    if (stopped || state.pageAcknowledged) return;
    let node = null;
    try { if (injectElement) node = injectElement('script', { textContent: source }); }
    catch (error) { state.error = String(error.message || error).slice(0,160); }
    if (!state.pageAcknowledged) {
      try { const script = doc.createElement('script'); script.textContent = source; (doc.head || doc.documentElement).append(script); script.remove(); }
      catch (error) { state.error = String(error.message || error).slice(0,160); }
    }
    try { node?.remove?.(); } catch {}
    if (!state.pageAcknowledged) ackTimer = setTimeout(() => directFallback(state.error || '未收到网页环境确认，可能被页面策略阻止'), 1000);
  }
  const controller = {
    records, state,
    get active() { return !stopped; },
    get supported() { return state.pageAcknowledged && (state.fetch || state.xhr); },
    subscribe(callback) { subscriber = callback; changed(); },
    runOwn(operation) { ownDepth++; command('begin'); try { return operation(); } finally { command('end'); ownDepth--; } },
    stop() {
      if (stopped) return; stopped = true; command('stop'); fallback?.stop();
      clearTimeout(ackTimer); rootWait?.disconnect();
      doc.removeEventListener(names.data,onData); doc.removeEventListener(names.ack,onAck); win.removeEventListener('pagehide',controller.stop);
      subscriber = null; if (win[slot] === controller) delete win[slot];
    }
  };
  win[slot] = controller; win.addEventListener('pagehide',controller.stop,{ once:true });
  if (doc.documentElement) install();
  else { rootWait = new win.MutationObserver(() => { if (doc.documentElement) { rootWait.disconnect(); install(); } }); rootWait.observe(doc,{ childList:true,subtree:true }); }
  return controller;
}


const Core = createLiveCore();
const Bilibili = createBilibiliProtocol();
function createOptionalNativeCapture(win, injectElement) {
  let instance = null, subscriber = null;
  const records = [];
  const disabled = { pageAcknowledged: false, mode: '诊断模式未开启', readyState: win.document.readyState, fetch: false, xhr: false, error: '' };
  const changed = () => { records.splice(0, records.length, ...(instance?.records || [])); subscriber?.(); };
  return {
    records,
    get state() { return instance?.state || disabled; },
    get supported() { return Boolean(instance?.supported); },
    subscribe(callback) { subscriber = callback; changed(); },
    setEnabled(enabled) {
      if (enabled && !instance) { instance = startEarlyNativeCapture(win, injectElement); instance.subscribe(changed); }
      if (!enabled && instance) { instance.stop(); instance = null; }
      changed();
    },
    runOwn(operation) { return instance ? instance.runOwn(operation) : operation(); },
    stop() { instance?.stop(); instance = null; changed(); }
  };
}
const earlyNativeCapture = createOptionalNativeCapture(window, typeof GM_addElement === 'function' ? GM_addElement : null);
function startCaibaoApp() {
// SPDX-License-Identifier: AGPL-3.0-only
// Focused implementation inspired by the STT workflow in LAPLACE Chatterbox 4.6.0.
if (window.top !== window.self || document.getElementById('eleven-live-control')) return;
let disposed = false;
const lifetime = new AbortController();
const listen = (target, name, callback) => target.addEventListener(name, callback, { signal: lifetime.signal });
const pageWindow = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
const CAIBAO_FIXED_SETTINGS = Object.freeze({ quiet: false, silence: 1.2, grace: 900, maxLength: 30,
  brackets: true, fontSize: 28, contextText: '', reviewBeforeSend: false, sendMode: 'live' });
const CAIBAO_DEFAULT_SETTINGS = { source: 'tab', language: 'zh', output: 'original', captions: true, ...CAIBAO_FIXED_SETTINGS };
const readValue = (key, fallback) => { try { return GM_getValue(key, fallback); } catch { return fallback; } };
let saved = readValue('elive.settings', {});
if (!saved || typeof saved !== 'object') saved = {};
const settings = { ...CAIBAO_DEFAULT_SETTINGS, ...saved, ...CAIBAO_FIXED_SETTINGS };
delete settings.gap;
// Keep an explicit automatic-language choice when upgrading.
if (!saved.language) settings.language = 'zh';
settings.output = Core.outputLanguage(saved.output) || 'original';
// Replace legacy mute/custom-timing preferences with the fixed live-caption rules.
if (Object.hasOwn(saved, 'gap') || Object.keys(CAIBAO_FIXED_SETTINGS).some(key => Object.hasOwn(saved, key) && saved[key] !== CAIBAO_FIXED_SETTINGS[key])) {
  try { GM_setValue('elive.settings', settings); } catch {}
}
const host = document.createElement('div');
host.id = 'eleven-live-control';
host.style.cssText = 'position:fixed;right:20px;bottom:100px;width:36px;height:36px;z-index:2147483646;color-scheme:light;font:14px/1.5 system-ui,sans-serif;';
const shadow = host.attachShadow({ mode: 'closed' });
shadow.innerHTML = `
<style>
:host{all:initial;color-scheme:light;font:14px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:#252b33}
*{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer;border:1px solid #d9dfe6;border-radius:7px;padding:7px 11px;background:#fff;color:#303743}button:hover:not(:disabled){background:#f1f5f7}button:disabled{opacity:.5;cursor:default}button.primary{background:#258a73;border-color:#258a73;color:#fff}button.primary:hover:not(:disabled){background:#207762}button.danger{color:#b13f43}input,select{min-width:0;border:1px solid #d9dfe6;border-radius:6px;background:#fff;color:#252b33;padding:6px 8px;width:100%}input[type=checkbox]{width:15px;height:15px;margin:0;accent-color:#258a73}label{display:flex;gap:7px;align-items:center}.panel{width:370px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 100px);overflow:auto;border:1px solid #dbe1e6;border-radius:12px;background:#fff;box-shadow:0 10px 42px #172b3a25}.head{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;border-bottom:1px solid #edf0f3}.head strong{font-size:15px}.head button{border:0;padding:3px 6px;color:#737d88}.body{padding:14px 16px}.row{display:flex;align-items:center;gap:8px;margin:9px 0}.row>label{flex:1}.field{display:grid;grid-template-columns:92px 1fr;align-items:center;gap:8px;margin:9px 0}.muted{color:#7a8490;font-size:12px}.hint{font-size:12px;color:#647080;margin:7px 0;line-height:1.65}.error{color:#b33a43}.status{font-size:13px;font-weight:600;overflow-wrap:anywhere}.meter{height:4px;background:#e9eef0;border-radius:4px;overflow:hidden;margin:8px 0}.meter span{display:block;height:100%;width:0;background:#36a185;transition:width .15s}details{border-top:1px solid #edf0f3;margin-top:14px;padding-top:11px}summary{cursor:pointer;font-size:13px;color:#4d5865;user-select:none}.preview{margin-top:12px;background:#f6f8fa;border-radius:7px;padding:10px 12px;min-height:72px;max-height:150px;overflow:auto;overflow-wrap:anywhere}.preview div{white-space:pre-wrap}.preview .draft{color:#83909a}.actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}.history{margin-top:8px;max-height:240px;overflow:auto}.entry{padding:9px 0;border-bottom:1px solid #edf0f3;font-size:13px;overflow-wrap:anywhere}.entry .meta{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-top:5px;color:#7a8490;font-size:11px}.entry button{font-size:12px;padding:3px 7px}.entry .source{color:#7a8490;font-size:12px}.log{margin-top:8px;max-height:110px;overflow:auto;font-size:11px;color:#78828d;overflow-wrap:anywhere}.log div{margin:3px 0}.launcher{display:none;box-shadow:0 3px 20px #172b3a20;background:#fff;padding:10px 13px}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid #258a73;outline-offset:2px}.queue-alert{padding:9px;background:#fff5f3;border-radius:7px;margin-top:9px;font-size:12px}.queue-alert[hidden]{display:none}
.panel{position:fixed;max-height:calc(100dvh - 24px)}
.launcher{display:flex;align-items:center;justify-content:center;position:relative;width:36px;height:36px;padding:0;border-radius:50%;border:1px solid #cbd9d4;background:#fff;color:#26735f;font-size:11px;font-weight:400;box-shadow:none;opacity:.85;touch-action:none;user-select:none;cursor:grab}
.launcher:hover:not(:disabled),.launcher:focus-visible{opacity:1;background:#f3f8f5}.launcher.dragging{cursor:grabbing}.launcher:focus-visible{outline:2px solid #258a73;outline-offset:3px}
[hidden]{display:none!important}
.entry .text,.entry .source{white-space:pre-wrap}
</style>
<button class="launcher" id="launcher" type="button" aria-label="展开菜包直播同传，可拖动" aria-expanded="false" aria-controls="controlPanel" title="菜包直播同传 · 点击展开，拖动移动">菜包</button>
<section class="panel" id="controlPanel" aria-label="菜包直播同传" hidden>
  <div class="head"><strong>菜包直播同传</strong><button id="collapse" aria-label="收起面板">收起</button></div>
  <div class="body">
    <div id="status" class="status" role="status">未启动</div>
    <div class="meter" role="meter" aria-label="采集音量" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="level"></span></div>
    <div class="field"><label for="language">识别语言</label><select id="language"><option value="auto">自动识别</option><option value="zh">中文</option><option value="en">英语</option><option value="ko">韩语</option><option value="ja">日语</option><option value="ru">俄语</option><option value="es">西班牙语</option><option value="fr">法语</option><option value="de">德语</option></select></div>
    <div class="field"><label for="output">输出为</label><select id="output"><option value="original">不翻译（默认）</option><option value="zh">中文</option><option value="en">英语</option><option value="ko">韩语</option><option value="ja">日语</option></select></div>
    <div id="outputHint" class="hint">识别时保留直播原声。</div>
    <div class="actions"><button id="start" class="primary">开始同传</button><button id="pause" disabled>暂停同传</button><button id="stop" disabled>结束同传</button></div>
    <div class="actions"><button id="shareAudio" hidden>选择共享音频</button></div>
    <div class="row"><label><input id="localMute" type="checkbox">静音直播，继续识别</label></div>
    <div id="audioHint" class="hint">默认保留原声；直接读取播放器时，可在识别中随时切换。</div>
    <div class="preview" aria-label="最终弹幕预览"><div id="previewState" class="muted">弹幕效果预览</div><div id="final">最终弹幕会显示在这里。</div><div id="draft" class="draft"></div></div>
    <div class="row"><label><input id="autoSend" type="checkbox">自动发送字幕弹幕</label></div>
    <div id="sendTiming" class="hint">每条30字以内（含【】），至少间隔5秒；短句最多合并1秒，限流后继续放慢。</div>
    <details id="connectionSettings"><summary>设置</summary>
      <div class="field"><label for="key">API Key</label><input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="ElevenLabs API Key"></div>
      <div id="keyStatus" class="hint"></div>
      <div class="row"><label class="muted"><input id="remember" type="checkbox">在本机记住 Key</label><button id="save">保存</button></div>
      <div class="field"><label for="source">音源</label><select id="source"><option value="tab">直播间声音</option><option value="screen">系统 / 屏幕声音</option></select></div>
      <div class="row"><label><input id="captions" type="checkbox">在播放器上显示字幕</label></div>
      <div class="hint">优先读取本页播放器；无法读取时，请选择直播标签页并勾选「共享音频」。</div>
      <div id="translationSettings" hidden>
        <button id="prepareTranslation">准备翻译</button><div id="translationStatus" class="hint" role="status"></div>
      </div>
    </details>
    <details id="historySettings"><summary>记录 <span id="counts" class="muted">0 句</span></summary>
      <div class="row"><label><input id="diagnostics" type="checkbox">诊断模式：记录网页发送对照（最近20条）</label></div>
      <div id="history" class="history"><div id="emptyHistory" class="hint">识别原文和发送状态保留在这里。</div></div>
      <div class="actions"><button id="export">导出记录</button></div><div id="logs" class="log"></div>
    </details>
  </div>
</section>
`;
document.body.append(host);
const $ = id => shadow.getElementById(id);
for (const [key, value] of Object.entries(settings)) {
  if (!$(key)) continue;
  if ($(key).type === 'checkbox') $(key).checked = Boolean(value); else $(key).value = value;
}
$('autoSend').checked = false; $('diagnostics').checked = false;
const keyVault = createKeyVault({ read: () => readValue('elive.apiKey', ''),
  write: value => GM_setValue('elive.apiKey', value), remove: () => GM_deleteValue('elive.apiKey') });
const sharedAutoSender = createSharedAutoSender();
const autoSendLease = createAutoSendLease(document, 'live-translator', sharedAutoSender);
function updateKeyStatus() { $('keyStatus').textContent = keyVault.get() ? ($('remember').checked ? 'Key 已保存在脚本管理器中；输入新 Key 可替换。' : 'Key 仅在当前页面使用；刷新后需重新输入。') : '填写 ElevenLabs Key 后开始同传，音频会发送到 ElevenLabs 识别。'; }
$('key').value = '';
$('remember').checked = Boolean(keyVault.get());
$('connectionSettings').open = !keyVault.get();
updateKeyStatus();
function config() {
  return { ...CAIBAO_FIXED_SETTINGS, source: $('source').value, language: $('language').value,
    output: $('output').value, captions: $('captions').checked };
}
function save() {
  try {
    GM_setValue('elive.settings', config());
    keyVault.capture($('key'), $('remember').checked); updateKeyStatus();
    log('设置已保存');
  } catch { log('无法保存设置，本次仍可使用', true); }
}
function log(message, error = false) {
  const row = document.createElement('div');
  row.textContent = `${new Date().toLocaleTimeString()} ${message}`;
  if (error) row.className = 'error';
  $('logs').prepend(row);
  while ($('logs').children.length > 40) $('logs').lastElementChild.remove();
}
let statusMessage = '未启动', statusError = false, sendNotice = '', captionNotice = '', roomNotice = '';
function renderStatus() {
  const notices = statusError ? [] : [session ? captionNotice : '', $('autoSend').checked ? sendNotice : '', session ? roomNotice : ''].filter(Boolean);
  $('status').textContent = [statusMessage, ...notices].join(' · ');
  $('status').classList.toggle('error', statusError);
  updateLauncherStatus();
}
function status(message, error = false) { statusMessage = message; statusError = error; renderStatus(); }
$('save').onclick = save;
$('remember').onchange = () => { if (!$('remember').checked) { try { keyVault.forgetSaved(); } catch {} } updateKeyStatus(); };
const floatingSize = 36; const floatingMargin = 12;
let panelOpen = false; let floatingPosition = readValue('elive.launcherPosition', null); let floatingDrag = null; let suppressFloatingClickUntil = 0;
if (!floatingPosition || !Number.isFinite(floatingPosition.x) || !Number.isFinite(floatingPosition.y)) floatingPosition = { x: 1, y: .85 };
const clampFloating = value => Math.min(1, Math.max(0, value));
floatingPosition = { x: clampFloating(floatingPosition.x), y: clampFloating(floatingPosition.y) };
function floatingBounds() {
  return { x: Math.max(0, innerWidth - floatingSize - floatingMargin * 2), y: Math.max(0, innerHeight - floatingSize - floatingMargin * 2) };
}
function positionFloatingControl() {
  const bounds = floatingBounds();
  const x = floatingMargin + floatingPosition.x * bounds.x; const y = floatingMargin + floatingPosition.y * bounds.y;
  host.style.right = 'auto'; host.style.bottom = 'auto'; host.style.left = `${x}px`; host.style.top = `${y}px`;
  if (!panelOpen) return;
  const panel = $('controlPanel'); const rect = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(floatingMargin, Math.min(x + floatingSize - rect.width, innerWidth - rect.width - floatingMargin))}px`;
  panel.style.top = `${Math.max(floatingMargin, Math.min(y + floatingSize - rect.height, innerHeight - rect.height - floatingMargin))}px`;
}
function updateLauncherStatus() {
  const current = $('status'); const launcher = $('launcher');
  launcher.dataset.state = current.classList.contains('error') ? 'error' : state;
  launcher.title = `菜包直播同传 · ${current.textContent} · 点击展开，拖动移动`;
  launcher.setAttribute('aria-label', `展开菜包直播同传，${current.textContent}，可拖动`);
}
function setPanelOpen(open, focus = true) {
  panelOpen = open; $('controlPanel').hidden = !open; $('launcher').hidden = open;
  $('launcher').setAttribute('aria-expanded', String(open));
  positionFloatingControl();
  if (focus) (open ? $('collapse') : $('launcher')).focus({ preventScroll: true });
}
$('collapse').onclick = () => setPanelOpen(false);
$('launcher').onclick = event => { if (event.detail !== 0 && performance.now() < suppressFloatingClickUntil) return; setPanelOpen(true); };
$('launcher').addEventListener('pointerdown', event => {
  if (event.button !== 0 || !event.isPrimary) return;
  floatingDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, start: { ...floatingPosition }, moved: false };
  try { $('launcher').setPointerCapture(event.pointerId); } catch {}
});
$('launcher').addEventListener('pointermove', event => {
  if (!floatingDrag || floatingDrag.id !== event.pointerId) return;
  const dx = event.clientX - floatingDrag.x; const dy = event.clientY - floatingDrag.y;
  if (!floatingDrag.moved && Math.hypot(dx, dy) < 5) return;
  floatingDrag.moved = true; $('launcher').classList.add('dragging'); event.preventDefault();
  const bounds = floatingBounds();
  floatingPosition = { x: clampFloating(floatingDrag.start.x + dx / (bounds.x || 1)), y: clampFloating(floatingDrag.start.y + dy / (bounds.y || 1)) };
  positionFloatingControl();
});
function finishFloatingDrag(event) {
  if (!floatingDrag || floatingDrag.id !== event.pointerId) return;
  if (floatingDrag.moved) { suppressFloatingClickUntil = performance.now() + 350; try { GM_setValue('elive.launcherPosition', floatingPosition); } catch {} }
  floatingDrag = null; $('launcher').classList.remove('dragging');
  try { $('launcher').releasePointerCapture(event.pointerId); } catch {}
}
$('launcher').addEventListener('pointerup', finishFloatingDrag);
$('launcher').addEventListener('pointercancel', finishFloatingDrag);
shadow.addEventListener('keydown', event => {
  if (event.key === 'Escape' && panelOpen) { event.preventDefault(); setPanelOpen(false); }
});
host.addEventListener('caibao-show', () => setPanelOpen(true));
listen(window, 'resize', positionFloatingControl);
const floatingPanelObserver = new ResizeObserver(positionFloatingControl);
floatingPanelObserver.observe($('controlPanel'));
listen(document, 'fullscreenchange', () => {
  const full = document.fullscreenElement;
  (full && full.tagName !== 'VIDEO' ? full : document.body)?.append(host);
  positionFloatingControl();
});
// A separate shadow root keeps the caption style isolated from the live page.
const captionHost = document.createElement('div');
captionHost.id = 'eleven-live-captions';
captionHost.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;';
const captionShadow = captionHost.attachShadow({ mode: 'open' });
captionShadow.innerHTML = `<style>:host{all:initial;pointer-events:none}*{box-sizing:border-box}.lines{font:600 28px/1.45 system-ui,"Microsoft YaHei",sans-serif;text-align:center;color:white;text-shadow:0 2px 4px #000,1px 0 2px #000,-1px 0 2px #000;white-space:pre-wrap;overflow-wrap:anywhere}.line{display:table;margin:3px auto;max-width:100%;padding:2px 10px;border-radius:4px;background:#0009}.draft{font-size:.85em;font-weight:400;color:#e0e5eb}.line:empty{display:none}</style><div class="lines" aria-label="直播识别字幕"><div class="line" id="stable"></div><div class="line draft" id="interim"></div></div>`;
document.body.append(captionHost);
const caption = { stable: captionShadow.getElementById('stable'), interim: captionShadow.getElementById('interim') };
let finalPreview = ''; let draftPreview = ''; let finalPacket = null; let captionText = '';
function updateCaptions() {
  if (disposed) return;
  captionHost.hidden = !$('captions').checked;
  const cfg = config(); captionShadow.querySelector('.lines').style.fontSize = `${cfg.fontSize}px`;
  caption.stable.textContent = captionText; caption.interim.textContent = draftPreview;
  const fullscreen = document.fullscreenElement;
  const parent = fullscreen && fullscreen.tagName !== 'VIDEO' ? fullscreen : document.body;
  if (captionHost.parentElement !== parent) parent.append(captionHost);
  let best = null; let area = 0;
  for (const video of document.querySelectorAll('video')) {
    const r = video.getBoundingClientRect();
    if (r.width * r.height > area && r.width > 100 && r.height > 60) { area = r.width * r.height; best = r; }
  }
  const r = best || { left: 0, top: 0, width: innerWidth, height: innerHeight, bottom: innerHeight };
  const left = Math.max(8, r.left + r.width * .05);
  captionHost.style.left = `${left}px`;
  captionHost.style.width = `${Math.max(120, Math.min(r.width * .9, innerWidth - left - 8))}px`;
  captionHost.style.bottom = `${Math.max(35, innerHeight - r.bottom + r.height * .10)}px`;
}
function updatePreviewStatus() {
  const states = { queued: '待发送', preparing: '准备发送', sending: '发送中', submitted: '已提交，等待回显', echoed: '已回显', failed: '发送失败，已跳过', skipped: '已跳过', unconfirmed: '发送结果未确认', cancelled: '已取消发送' };
  $('previewState').textContent = !finalPacket ? '弹幕效果预览' : !finalPacket.automatic ? '仅预览 · 不会发送到直播间' : states[finalPacket.status] || '准备发送';
}
function previewFinal(text, packet = null) {
  finalPreview = text; finalPacket = packet;
  $('final').textContent = text || '最终弹幕会显示在这里。'; updatePreviewStatus(); updateCaptions();
}
function previewDraft(text) { draftPreview = text; $('draft').textContent = text; updateCaptions(); }
$('captions').onchange = updateCaptions;
listen(window, 'resize', updateCaptions);
listen(document, 'fullscreenchange', updateCaptions);

const languageNames = { zh: '中文', en: '英语', ko: '韩语', ja: '日语', ru: '俄语', es: '西班牙语', fr: '法语', de: '德语' };
const translators = new Map(); let languageDetector = null; let preparing = false; let preparedTranslation = '';
const translationKey = (source, target) => `${source}:${target}`;
function outputDescription(cfg) {
  return Core.outputLanguage(cfg.output) ? `输出${languageNames[Core.outputLanguage(cfg.output)]}` : '原文字幕';
}
function translationReady(cfg) {
  const target = Core.outputLanguage(cfg.output);
  return !target || cfg.language === target || preparedTranslation === translationKey(cfg.language, target);
}
async function prepareTranslation() {
  if (disposed || preparing) return;
  const cfg = config(); const targetLanguage = Core.outputLanguage(cfg.output);
  if (!targetLanguage) { $('translationStatus').textContent = '输出为「不翻译」，字幕和弹幕使用识别原文，无需准备语言包。'; return; }
  const sourceLanguage = cfg.language;
  if (sourceLanguage === targetLanguage) { $('translationStatus').textContent = `主播语言和输出均为${languageNames[targetLanguage]}，直接使用原文。`; return; }
  const api = pageWindow.Translator || globalThis.Translator;
  if (!api?.create) { $('translationStatus').textContent = '当前浏览器没有本地翻译接口。可继续使用原文字幕；本地翻译建议使用支持 Translator API 的桌面 Chrome。'; return; }
  const detectorApi = pageWindow.LanguageDetector || globalThis.LanguageDetector;
  if (sourceLanguage === 'auto' && !languageDetector && !detectorApi?.create) {
    $('translationStatus').textContent = '当前浏览器没有自动语言判断接口。请手动选择主播语言后准备翻译；不翻译时仍可自动识别语音。'; return;
  }
  preparing = true; $('prepareTranslation').disabled = true;
  $('start').disabled = true; $('language').disabled = true; $('output').disabled = true;
  $('translationStatus').textContent = '正在准备语言包，首次可能需要下载…';
  const jobs = [];
  try {
    // Start every create during the user's click/change gesture, before awaiting downloads.
    if (sourceLanguage === 'auto' && !languageDetector) jobs.push(Promise.resolve(detectorApi.create()).then(value => { if (disposed) value.destroy?.(); else languageDetector = value; }));
    const sources = sourceLanguage === 'auto' ? Core.translationLanguages : [sourceLanguage];
    for (const source of sources) {
      const key = translationKey(source, targetLanguage);
      if (source === targetLanguage || translators.has(key)) continue;
      jobs.push(Promise.resolve(api.create({ sourceLanguage: source, targetLanguage, monitor(monitor) {
        monitor.addEventListener('downloadprogress', e => {
          $('translationStatus').textContent = `${languageNames[source]} → ${languageNames[targetLanguage]} 语言包下载 ${Math.round(e.loaded * 100)}%`;
        });
      } })).then(value => { if (disposed) value.destroy?.(); else translators.set(key, value); }));
    }
    const outcomes = await Promise.allSettled(jobs);
    if (disposed) return;
    const failure = outcomes.find(item => item.status === 'rejected');
    if (failure) throw failure.reason;
    preparedTranslation = translationKey(sourceLanguage, targetLanguage);
    $('translationStatus').textContent = `本地翻译已准备好：${sourceLanguage === 'auto' ? '自动识别中英日韩' : languageNames[sourceLanguage]} → ${languageNames[targetLanguage]}。`;
  } catch (err) { $('translationStatus').textContent = `语言包准备失败：${err.message}`; }
  finally {
    // Wait for sibling downloads even if a synchronous API call failed.
    await Promise.allSettled(jobs);
    preparing = false; const idle = state === 'idle';
    $('prepareTranslation').disabled = !idle; $('start').disabled = !idle;
    $('language').disabled = !idle; $('output').disabled = !idle;
  }
}
$('prepareTranslation').onclick = prepareTranslation;
function outputChanged() {
  const cfg = config();
  updateOutputHint();
  $('translationSettings').hidden = !Core.outputLanguage(cfg.output) || cfg.language === Core.outputLanguage(cfg.output);
  if (!translationReady(cfg)) $('connectionSettings').open = true;
  void prepareTranslation();
}
$('language').onchange = outputChanged; $('output').onchange = outputChanged;

// Read the media before its local volume/mute stage. Unlike tab/system capture,
// HTMLMediaElement.captureStream() is independent of the element's volume/muted.
// Never route the captured audio back to this tab: that would risk feedback.
function captureLivePlayer() {
  const discard = stream => {
    // A media element may add fresh tracks to a previously captured stream when
    // its src changes. Also stop those future tracks after abandoning this stream.
    stream.addEventListener('addtrack', event => event.track.stop());
    stream.getTracks().forEach(track => track.stop());
  };
  const players = [...document.querySelectorAll('video')].filter(video => {
    const box = video.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && video.readyState >= 2 && !video.paused && !video.ended &&
      typeof video.captureStream === 'function';
  }).sort((a, b) => {
    const aa = a.getBoundingClientRect(), bb = b.getBoundingClientRect();
    return bb.width * bb.height - aa.width * aa.height;
  });
  const player = players[0];
  if (!player) return null;
  let stream;
  try {
    // Do not change crossOrigin/src on a running player to bypass CORS.
    if (player.currentSrc && new URL(player.currentSrc, location.href).origin !== location.origin && !player.crossOrigin) return null;
    stream = player.captureStream();
    const track = stream.getAudioTracks().find(track => track.readyState === 'live' && !track.muted);
    if (!track) { discard(stream); return null; }
    stream.getVideoTracks().forEach(track => track.stop());
    return { player, stream, track };
  } catch {
    if (stream) discard(stream);
    return null;
  }
}

let sharedAudioRequest = null;
function requestSharedAudio(cfg, signal) {
  return new Promise((resolve, reject) => {
    const request = { cfg, resolve, reject, signal, pending: false, abort: null };
    const abort = () => {
      if (sharedAudioRequest === request) { sharedAudioRequest = null; $('shareAudio').hidden = true; }
      reject(new Core.Cancelled());
    };
    request.abort = abort;
    if (signal.aborted) return abort();
    sharedAudioRequest = request; signal.addEventListener('abort', abort, { once: true });
    $('shareAudio').hidden = false; $('shareAudio').disabled = false;
    status(cfg.source === 'screen' ? '请点击「选择共享音频」，选择系统或屏幕音源。' : '播放器暂时无法直接采集；可先播放直播后重新开始，或点击「选择共享音频」。');
  });
}
$('shareAudio').onclick = () => {
  const request = sharedAudioRequest;
  if (!request || request.pending || request.signal.aborted) return;
  request.pending = true; $('shareAudio').disabled = true;
  // This call stays inside the button's own gesture, even after a long player wait.
  let pending;
  try {
    pending = navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: request.cfg.source === 'tab' ? 'browser' : 'monitor' },
      audio: { suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: request.cfg.source === 'tab', selfBrowserSurface: 'include', systemAudio: 'include', surfaceSwitching: 'exclude'
    });
  } catch (error) { pending = Promise.reject(error); }
  Promise.resolve(pending).then(stream => {
    if (sharedAudioRequest !== request || request.signal.aborted) { stream.getTracks().forEach(track => track.stop()); return; }
    sharedAudioRequest = null; request.signal.removeEventListener('abort', request.abort);
    $('shareAudio').hidden = true; request.resolve(stream);
  }, error => {
    if (sharedAudioRequest !== request) return;
    sharedAudioRequest = null; request.signal.removeEventListener('abort', request.abort);
    $('shareAudio').hidden = true; request.reject(error);
  });
};

function requestToken(apiKey, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Core.Cancelled()); return; }
    let request;
    const onAbort = () => { request?.abort(); reject(new Core.Cancelled()); };
    const done = callback => result => { signal.removeEventListener('abort', onAbort); callback(result); };
    signal.addEventListener('abort', onAbort, { once: true });
    request = GM_xmlhttpRequest({ method: 'POST', url: 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe',
      headers: { 'xi-api-key': apiKey }, timeout: 15000,
      onload: done(response => {
        if (response.status < 200 || response.status >= 300) {
          const error = new Error(`ElevenLabs 验证失败（HTTP ${response.status}），请检查 Key 的语音识别权限与额度`);
          error.retryable = response.status === 429 || response.status >= 500; reject(error); return;
        }
        try { const body = JSON.parse(response.responseText); if (typeof body.token !== 'string' || !body.token || body.token.length > 4096 || body.token === apiKey) throw new Error(); resolve(body.token); }
        catch { reject(new Error('ElevenLabs 没有返回有效的临时令牌')); }
      }),
      onerror: done(() => reject(Object.assign(new Error('无法连接 ElevenLabs，请检查网络'), { retryable: true }))),
      ontimeout: done(() => reject(Object.assign(new Error('ElevenLabs 验证超时'), { retryable: true }))),
      onabort: done(() => reject(new Core.Cancelled())) });
  });
}

const PCM_WORKLET = `
class LivePcm extends AudioWorkletProcessor {
  constructor(){super();this.buf=new Int16Array(3200);this.n=0;this.sum=0;this.inFlight=false;this.port.onmessage=e=>{if(e.data==='ack')this.inFlight=false;else if(e.data==='flush'){this.flush(true);this.port.postMessage({flushed:true});}};}
  flush(force=false){if(!this.n)return;if(!this.inFlight||force){const samples=this.buf.slice(0,this.n);this.inFlight=true;this.port.postMessage({samples,rms:Math.sqrt(this.sum/this.n),capturedAt:currentTime},[samples.buffer]);}this.n=0;this.sum=0;}
  process(inputs){const channels=inputs[0];if(!channels?.length)return true;for(let i=0;i<channels[0].length;i++){let v=0;for(const c of channels)v+=c[i]||0;v=Math.max(-1,Math.min(1,v/channels.length));this.buf[this.n++]=Math.round(v<0?v*32768:v*32767);this.sum+=v*v;if(this.n===this.buf.length)this.flush();}return true;}
}registerProcessor('eleven-live-pcm',LivePcm);`;
function toBase64(samples) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = ''; for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
class ElevenSession {
  constructor(cfg, callbacks) {
    this.cfg = cfg; this.cb = callbacks; this.controller = new AbortController();
    this.closed = false; this.stopping = false; this.ready = false; this.contextSent = false;
    this.recovering = false; this.recoveryPending = false; this.recoveryEpoch = 0;
    this.recognitionEpoch = 0; this.connecting = false; this.graphReady = false;
    this.commitGuard = new Core.RealtimeCommitGuard({ now: () => performance.now() });
    this.commitSerial = 0; this.uploadedSamples = 0; this.pendingCommitInfo = null;
    this.localMuteDesired = Boolean(cfg.localMute); this.timers = new Set(); this.releasedStreams = new WeakSet();
    this.userPaused = false; this.resumeAudioFrom = -Infinity;
  }
  async start(apiKey) {
    try {
      if (this.cb.beforeCapture && await this.cb.beforeCapture(this.controller.signal) === false) { this.close(); return; }
      if (this.closed) return;
      let direct = this.cfg.source === 'tab' ? captureLivePlayer() : null;
      if (!direct && this.cfg.source === 'tab') {
        this.cb.waitingForAudio?.();
        direct = await waitForPlayerInput({ capture: captureLivePlayer, signal: this.controller.signal });
      }
      if (!direct && this.cfg.localMute) throw new Error('当前播放器无法直接读取音频，暂不支持静音识别。请先播放直播；仍不可用时，取消静音勾选后使用共享音频。');
      const stream = direct?.stream || await this.cb.requestSharedAudio(this.controller.signal);
      if (this.closed) { this.stopCapturedStream(stream); return; }
      this.stream = stream;
      const audioTrack = direct?.track || stream.getAudioTracks()[0];
      if (!audioTrack) throw new Error('没有采集到音轨。请重新开始，选择标签页并勾选「共享音频」，或选择支持系统音频的整个屏幕。');
      this.directMode = Boolean(direct);
      if (direct) this.bindPlayer(direct, true);
      else for (const track of stream.getTracks()) track.addEventListener('ended', () => {
        if (!this.closed && !this.stopping) {
          if (this.cfg.watch) this.fail(new Error('共享音频授权已结束，已退出值守；请重新开始并授权。'));
          else void this.stop();
        }
      });
      const suppressed = audioTrack.getSettings().suppressLocalAudioPlayback === true;
      this.cb.audioSource({ mode: direct ? 'player' : 'shared', suppressed,
        muted: direct ? this.player.muted || this.player.volume === 0 : false });
      // A silent sink keeps processing independent of a monitor's HDMI/DP
      // speaker endpoint where supported. No microphone permission is needed.
      let context;
      try { context = new AudioContext({ sampleRate: 16000, sinkId: { type: 'none' } }); }
      catch { context = new AudioContext({ sampleRate: 16000 }); }
      this.context = context;
      if (context.sampleRate !== 16000) throw new Error('浏览器未建立 16kHz 音频采集，请使用桌面 Chrome 或 Edge 重试。');
      const source = this.source = context.createMediaStreamSource(new MediaStream([audioTrack]));
      const url = URL.createObjectURL(new Blob([PCM_WORKLET], { type: 'text/javascript' }));
      try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      if (this.closed) return;
      const node = this.node = new AudioWorkletNode(context, 'eleven-live-pcm');
      const gain = this.gain = context.createGain(); gain.gain.value = 0;
      node.port.onmessage = event => {
        if (event.data.flushed) { this.flushed?.(); return; }
        node.port.postMessage('ack');
        if (this.recovering || this.closed) return;
        // After a page freeze, MessagePort may deliver buffered old audio. Use
        // the native audio clock, rather than delivery time, to reject it.
        if (Number.isFinite(event.data.capturedAt) && context.currentTime - event.data.capturedAt > 1) return;
        if (Number.isFinite(event.data.capturedAt) && event.data.capturedAt <= this.resumeAudioFrom) return;
        const { samples, rms } = event.data;
        if (rms > .0001) this.lastAudibleAt = performance.now();
        this.cb.level(rms);
        if (this.ready && !this.closed && !this.userPaused) this.sendAudio(samples);
      };
      source.connect(node); node.connect(gain); gain.connect(context.destination);
      await context.resume();
      if (this.closed) return;
      this.graphReady = true;
      this.cb.audioReady?.();
      if (this.recoveryPending || (direct && (!this.player?.isConnected || audioTrack.readyState !== 'live'))) this.beginPlayerRecovery();
      if (this.closed) return;
      await this.connectRecognition(apiKey);
    } catch (err) { if (!this.closed) this.fail(err); }
  }
  pause() {
    if (this.closed || !this.graphReady) return false;
    this.userPaused = true; this.suspendRecognition(); return true;
  }
  resume() {
    if (this.closed || !this.userPaused) return false;
    this.resumeAudioFrom = this.context.currentTime; this.node?.port.postMessage('flush');
    this.lastAudibleAt = undefined; this.userPaused = false; return true;
  }
  hasRecentAudio() { return this.lastAudibleAt !== undefined && performance.now() - this.lastAudibleAt < 2000; }
  async connectRecognition(apiKey) {
    if (this.closed || this.stopping || this.userPaused || this.connecting || this.ready || !this.graphReady || this.recovering) return;
    if (this.cb.canConnect && !this.cb.canConnect()) return;
    this.connecting = true;
    const epoch = ++this.recognitionEpoch;
    const controller = this.recognitionController = new AbortController();
    const active = () => !this.closed && epoch === this.recognitionEpoch && !controller.signal.aborted;
    const abort = () => controller.abort(); this.controller.signal.addEventListener('abort', abort, { once: true });
    try {
      this.cb.connecting();
      const token = await requestToken(apiKey, controller.signal);
      if (!active()) return;
      if (this.cb.isCurrent && !this.cb.isCurrent()) { this.close(); return; }
      if (this.cb.canConnect && !this.cb.canConnect()) { this.connecting = false; return; }
      const wsUrl = new URL('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
      const options = { model_id: 'scribe_v2_realtime', audio_format: 'pcm_16000', commit_strategy: 'vad',
        vad_silence_threshold_secs: String(this.cfg.silence), vad_threshold: '.4', min_speech_duration_ms: '100',
        min_silence_duration_ms: '100', keepalive_interval_ms: '3000', token };
      if (this.cfg.language !== 'auto') options.language_code = this.cfg.language;
      for (const [key, value] of Object.entries(options)) wsUrl.searchParams.set(key, value);
      const ws = this.ws = new WebSocket(wsUrl);
      this.handshakeTimer = setTimeout(() => { if (active()) this.fail(Object.assign(new Error('ElevenLabs 连接超时'), { retryable: true })); }, 15000);
      ws.onmessage = event => {
        if (!active()) return;
        let data; try { data = JSON.parse(event.data); } catch { return; }
        if (data.message_type === 'session_started') {
          this.commitGuard.reset();
          this.commitSerial = 0; this.uploadedSamples = 0; this.pendingCommitInfo = null;
          clearTimeout(this.handshakeTimer); this.ready = true; this.connecting = false; this.cb.running();
          if (this.recovering) this.cb.recovering?.();
        } else if (data.message_type === 'partial_transcript') { this.commitGuard.notePartial(data.text || ''); this.cb.partial(data.text || ''); }
        else if (data.message_type === 'committed_transcript') {
          const confirmation = { connection: epoch, pendingRequest: this.pendingCommitInfo,
            uploadedAudioMs: Math.round(this.uploadedSamples / 16), receivedAt: Date.now() };
          this.pendingCommitInfo = null;
          this.commitGuard.noteCommitted();
          this.cb.committed(data.text || '', confirmation);
          if (this.stopping) this.settleStop?.();
        } else if (data.message_type === 'warning') log('ElevenLabs 返回了会话提示，请在账户中检查对应设置');
        else if (data.message_type === 'commit_throttled') { this.pendingCommitInfo = null; this.commitGuard.noteThrottled(); if (this.stopping) this.settleStop?.(); }
        else if (/error$|^error$|quota_exceeded|rate_limited|resource_exhausted|unaccepted_terms|session_time_limit_exceeded|queue_overflow/u.test(data.message_type || '')) {
          const knownType = ['error','auth_error','quota_exceeded','rate_limited','resource_exhausted','unaccepted_terms','session_time_limit_exceeded','queue_overflow'].includes(data.message_type) ? data.message_type : 'service_error';
          const error = new Error(`ElevenLabs：${knownType}。请检查权限、额度或网络；本次连接已停止。`);
          error.retryable = /session_time_limit_exceeded|queue_overflow|rate_limited/u.test(data.message_type);
          this.fail(error);
        }
      };
      ws.onerror = () => { if (active()) this.fail(Object.assign(new Error('ElevenLabs 实时连接失败，请检查网络或 API 权限'), { retryable: true })); };
      ws.onclose = () => {
        if (!active()) return;
        if (this.stopping) this.settleStop?.();
        else this.fail(Object.assign(new Error('实时连接已断开，正在等待恢复。'), { retryable: true }));
      };
    } catch (err) { if (active()) this.fail(err); }
    finally { this.controller.signal.removeEventListener('abort', abort); }
  }
  suspendRecognition() {
    this.commitGuard.reset();
    this.pendingCommitInfo = null;
    this.recognitionEpoch++; this.ready = false; this.connecting = false; this.recognitionController?.abort();
    clearTimeout(this.handshakeTimer);
    const ws = this.ws; this.ws = null;
    if (ws) { ws.onmessage = null; ws.onerror = null; ws.onclose = null; try { ws.close(); } catch {} }
  }
  bindPlayer(direct, initial = false) {
    const { player, stream, track } = direct;
    const requestedMute = this.localMuteDesired;
    this.player = player; this.stream = stream; this.audioTrack = track;
    this.playerSrc = player.currentSrc; this.playerSrcObject = player.srcObject;
    if (player.volume > 0) this.lastPlayerVolume = player.volume;
    this.lastPlayerVolume ||= .5;
    this.onPlayerVolume = () => {
      if (this.player !== player || this.closed || this.stopping) return;
      if (player.volume > 0) this.lastPlayerVolume = player.volume;
      if (!player.muted) this.restorePlayerMuted = undefined;
      this.localMuteDesired = player.muted || player.volume === 0;
      this.cb.playback(this.localMuteDesired);
    };
    this.onPlayerUnavailable = () => {
      if (this.player === player && this.audioTrack === track) this.beginPlayerRecovery();
    };
    player.addEventListener('volumechange', this.onPlayerVolume);
    player.addEventListener('emptied', this.onPlayerUnavailable);
    player.addEventListener('ended', this.onPlayerUnavailable);
    track.addEventListener('ended', this.onPlayerUnavailable);
    this.playerTimer = setInterval(() => {
      if (this.player !== player) return;
      if (!player.isConnected || track.readyState !== 'live' || player.currentSrc !== this.playerSrc || player.srcObject !== this.playerSrcObject) this.beginPlayerRecovery();
    }, 500);
    if (!initial || requestedMute) this.setLocalMute(requestedMute);
    else this.localMuteDesired = player.muted || player.volume === 0;
  }
  releasePlayer() {
    this.lastAudibleAt = undefined;
    clearInterval(this.playerTimer); this.playerTimer = null;
    if (this.player) {
      this.player.removeEventListener('volumechange', this.onPlayerVolume);
      this.player.removeEventListener('emptied', this.onPlayerUnavailable);
      this.player.removeEventListener('ended', this.onPlayerUnavailable);
      this.audioTrack?.removeEventListener('ended', this.onPlayerUnavailable);
      if (this.restorePlayerMuted !== undefined && this.player.muted) this.player.muted = this.restorePlayerMuted;
    }
    this.restorePlayerMuted = undefined; this.player = null; this.audioTrack = null;
    this.source?.disconnect(); this.source = null;
    if (this.stream) this.stopCapturedStream(this.stream); this.stream = null;
  }
  stopCapturedStream(stream) {
    if (!this.releasedStreams.has(stream)) {
      this.releasedStreams.add(stream);
      stream.addEventListener('addtrack', event => event.track.stop());
    }
    stream.getTracks().forEach(track => track.stop());
  }
  beginPlayerRecovery() {
    if (!this.directMode || this.closed || this.stopping || this.recovering) return;
    if (!this.node) { this.recoveryPending = true; return; }
    this.recoveryPending = false; this.recovering = true;
    const epoch = ++this.recoveryEpoch;
    const startedAt = performance.now();
    this.cb.recovering?.(); this.cb.level(0);
    this.releasePlayer();
    // Flush the worklet's partial old chunk while delivery is suppressed. Only
    // fresh samples from the replacement source will be sent on this connection.
    const attempt = () => {
      if (epoch !== this.recoveryEpoch || this.closed || this.stopping) return;
      if (performance.now() - startedAt >= 12000) {
        if (!this.cfg.watch) { this.fail(new Error('播放器音频未能恢复，已自动停止识别。直播恢复后可重新开始。')); return; }
        if (!this.recoveryWaiting) {
          this.recoveryWaiting = true; this.suspendRecognition(); this.cb.waitingForPlayer?.();
        }
      }
      const replacement = captureLivePlayer();
      if (!replacement) { this.recoveryTimer = setTimeout(attempt, this.recoveryWaiting ? 1000 : 300); return; }
      try {
        const source = this.context.createMediaStreamSource(new MediaStream([replacement.track]));
        this.bindPlayer(replacement);
        this.source = source; source.connect(this.node);
        this.recovering = false; this.recoveryWaiting = false; clearTimeout(this.recoveryTimer); this.recoveryTimer = null;
        this.cb.audioSource({ mode: 'player', suppressed: false, muted: this.localMuteDesired });
        this.cb.recovered?.();
      } catch (error) {
        this.stopCapturedStream(replacement.stream);
        this.releasePlayer(); this.fail(new Error(`播放器音频恢复失败：${error.message || '请重新开始同传'}`));
      }
    };
    const flushed = () => {
      clearTimeout(this.recoveryFlushTimer); this.recoveryFlushTimer = null;
      if (this.flushed === flushed) this.flushed = null;
      if (epoch !== this.recoveryEpoch || this.closed || this.stopping) return;
      this.recoveryTimer = setTimeout(attempt, 0);
    };
    this.flushed = flushed; this.node.port.postMessage('flush');
    // Wait for the ordered flush acknowledgement before binding the new source.
    // A stalled worklet must not cause an old partial chunk to leak into recovery.
    this.recoveryFlushTimer = setTimeout(() => {
      if (epoch === this.recoveryEpoch && !this.closed && !this.stopping) this.fail(new Error('音频处理未能恢复，已自动停止识别。请重新开始同传。'));
    }, 12000);
  }
  setLocalMute(muted) {
    if (this.closed || this.stopping || !this.directMode) return false;
    this.localMuteDesired = Boolean(muted);
    if (!this.player) {
      if (!this.recovering) return false;
      this.cb.playback(this.localMuteDesired); return true;
    }
    if (muted) {
      if (this.restorePlayerMuted === undefined) this.restorePlayerMuted = this.player.muted;
      this.player.muted = true;
    } else {
      // An explicit uncheck means "let me hear it", even if the player was
      // already muted before recognition. Preserve every positive volume.
      this.restorePlayerMuted = undefined;
      this.player.muted = false;
      if (this.player.volume === 0) this.player.volume = this.lastPlayerVolume || .5;
    }
    this.cb.playback(this.player.muted || this.player.volume === 0);
    return true;
  }
  sendAudio(samples, commit = false) {
    if (this.userPaused || this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > 256000) { this.fail(Object.assign(new Error('音频上传积压过多，已暂停识别并等待网络恢复。'), { retryable: true })); return; }
    if (!this.stopping && this.commitGuard.timedOut) { this.fail(Object.assign(new Error('ElevenLabs 文字确认超时，正在等待重新连接。'), { retryable: true })); return; }
    // Ask the service to finalize continuous speech using the next real PCM
    // chunk. Never promote an editable partial transcript to a sent caption.
    if (!commit && !this.stopping) commit = this.commitGuard.nextAudio(samples.length);
    if (commit) this.pendingCommitInfo = { id: ++this.commitSerial, requestedAt: Date.now() };
    this.ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: toBase64(samples), sample_rate: 16000,
      ...(!this.contextSent && this.cfg.contextText ? { previous_text: this.cfg.contextText } : {}), ...(commit ? { commit: true } : {}) }));
    this.contextSent = true;
    this.uploadedSamples += samples.length;
  }
  async stop() {
    if (this.closed || this.stopping) return;
    this.stopping = true; this.cb.stopping();
    if (this.node && this.ready) {
      await new Promise(resolve => { this.flushed = resolve; this.node.port.postMessage('flush'); setTimeout(resolve, 150); });
    }
    this.disconnectAudio();
    if (this.ws?.readyState === WebSocket.OPEN && this.ready) {
      await new Promise(resolve => {
        let quietTimer;
        const hardTimer = setTimeout(resolve, 4000);
        this.settleStop = () => { clearTimeout(quietTimer); quietTimer = setTimeout(() => { clearTimeout(hardTimer); resolve(); }, 300); };
        this.sendAudio(new Int16Array(3200), true);
      });
    }
    if (this.closed) return;
    this.close(); this.cb.finished();
  }
  disconnectAudio() {
    this.recoveryEpoch++; this.recovering = false; this.recoveryPending = false;
    clearTimeout(this.recoveryTimer); clearTimeout(this.recoveryFlushTimer);
    this.recoveryTimer = null; this.recoveryFlushTimer = null; this.flushed = null;
    this.releasePlayer(); this.node?.disconnect(); this.gain?.disconnect();
    if (this.node) this.node.port.onmessage = null;
    if (this.context?.state !== 'closed') this.context?.close().catch(() => {});
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.graphReady = false; this.suspendRecognition(); this.controller.abort(); clearTimeout(this.handshakeTimer);
    this.disconnectAudio();
    try { this.ws?.close(); } catch {}
  }
  fail(err) {
    if (this.closed) return;
    const retryable = Boolean(this.cfg.watch && this.graphReady && err.retryable);
    if (retryable) this.suspendRecognition(); else this.close();
    let message = err.message || String(err);
    if (err.name === 'NotAllowedError') message = '共享被取消或未获授权，可以再次点击「开始同传」。';
    this.cb.error(message, { retryable });
  }
}

const records = []; let nextId = 1; let finalizedCount = 0; let skippedCount = 0; let session = null; let assembler = null; let activeConfig = null; let roomMonitor = null;
const nativeSendRecords = earlyNativeCapture.records;
const nativeSendObserver = earlyNativeCapture;
$('diagnostics').onchange = () => {
  nativeSendObserver.setEnabled($('diagnostics').checked);
  log($('diagnostics').checked ? '诊断模式已开启，网页发送对照仅保留在本页。' : '诊断模式已关闭，网页发送对照已清空。');
};
const echoNodeIds = new WeakMap(); let echoNodeId = 0;
const echoTracker = createEchoTracker({
  ownUid: () => document.cookie.match(/(?:^|;\s*)DedeUserID=(\d+)(?:;|$)/u)?.[1] || '',
  readMessages: () => [...document.querySelectorAll('#chat-items .danmaku-item[data-uid]')].map(row => {
    if (!echoNodeIds.has(row)) echoNodeIds.set(row, ++echoNodeId);
    const text = row.getAttribute('data-danmaku') || row.querySelector('.danmaku-content')?.textContent || '';
    return { key: echoNodeIds.get(row), uid: row.getAttribute('data-uid') || '', text };
  })
});
let lastNativeCount = nativeSendRecords.length;
nativeSendObserver.subscribe(() => {
  updateRecordCounts();
  if (nativeSendRecords.length !== lastNativeCount) log('已记录一条B站网页发送对照，可用原有导出记录查看');
  lastNativeCount = nativeSendRecords.length;
});
let commitBatchId = 0;
let latestCommitAt = null, latestConfirmation = null, autoSendEpoch = 0;
let watchRetryAt = 0, watchFailures = 0, watchConnectedAt = 0;
let pageBinding = location.pathname; let state = 'idle'; let lastVoice = 0; let quietWarned = false;
const rowNodes = new Map();
let audioMode = null;
function updateAudioControl() {
  const shared = state !== 'idle' && audioMode === 'shared';
  const system = $('source').value === 'screen';
  $('localMute').disabled = system || shared || state === 'starting' || state === 'stopping';
  if (system || shared) $('localMute').checked = false;
  $('audioHint').textContent = shared || system
    ? '共享音频模式暂不支持此开关；播放器静音可能使采集也变为无声。'
    : audioMode === 'player' ? '已直接读取播放器；切换静音不中断识别。' : '默认保留原声；直接读取播放器时，可在识别中随时切换。';
  updateOutputHint();
}
function updateOutputHint() {
  const cfg = config();
  const sound = $('localMute').checked ? (audioMode === 'player' ? '直播已静音' : '识别时静音直播') : '保留直播原声';
  $('outputHint').textContent = `${sound} · ${Core.outputLanguage(cfg.output) ? outputDescription(cfg) : '输出识别原文'}`;
}
$('source').onchange = updateAudioControl;
$('localMute').onchange = () => {
  if (!session) { updateOutputHint(); return; }
  if (!session.setLocalMute($('localMute').checked)) { $('localMute').checked = false; log('当前音源不支持识别中切换静音', true); }
  updateOutputHint();
};
function historyRow(key) {
  let row = rowNodes.get(key);
  if (!row) {
    $('emptyHistory')?.remove();
    row = document.createElement('div'); row.className = 'entry'; row.dataset.historyKey = key;
    const text = document.createElement('div'); text.className = 'text';
    const source = document.createElement('div'); source.className = 'source';
    const meta = document.createElement('div'); meta.className = 'meta';
    const label = document.createElement('span'); label.className = 'label';
    meta.append(label); row.append(text, source, meta); $('history').prepend(row); rowNodes.set(key, row);
  }
  while ($('history').children.length > 100) { const last = $('history').lastElementChild; rowNodes.delete(last.dataset.historyKey); last.remove(); }
  return row;
}
function updatePacketRecord(event) {
  const row = historyRow('packet:' + event.id); row.dataset.packetId = event.id;
  const owners = event.recordIds.map(id => records.find(record => record.id === id)).filter(Boolean);
  row.querySelector('.text').textContent = event.text;
  row.querySelector('.source').textContent = owners.filter(record => record.text && record.text !== record.source)
    .map(record => `识别原文 #${record.id}：${record.source}`).join('\n');
  const labels = { queued: '待发送', preparing: '准备发送', sending: '发送中', submitted: '已提交，等待回显', echoed: '已回显', previewed: '仅预览', failed: '发送失败，已跳过', skipped: '已跳过', unconfirmed: '发送结果未确认', cancelled: '已取消' };
  row.querySelector('.label').textContent = `${event.automatic ? '弹幕' : '预览'} #${event.id} · ${labels[event.status] || event.status} · 来源 ${event.recordIds.map(id => '#' + id).join('、')}`;
  row.querySelector('.label').title = [event.reason || '', ...owners.map(record => `原句 #${record.id}：${record.text || record.source}`)].filter(Boolean).join('\n');
}
function updateRecord(record) {
  const events = record.previewEvents || [];
  if (events.length) {
    const key = 'source:' + record.id; rowNodes.get(key)?.remove(); rowNodes.delete(key);
    for (const event of events) updatePacketRecord(event);
  } else {
    const row = historyRow('source:' + record.id); row.dataset.recordId = record.id;
    row.querySelector('.text').textContent = record.text || record.source;
    row.querySelector('.source').textContent = record.text && record.text !== record.source ? `识别原文：${record.source}` : '';
    const labels = { recognizing: '待处理', translating: '翻译中', ready: '待合并', queued: '待合并', skipped: '已跳过', cancelled: '已取消', translation_failed: '翻译失败，已跳过' };
    row.querySelector('.label').textContent = `原句 #${record.id} · ${labels[record.status] || record.status}`;
    row.querySelector('.label').title = record.skipReason || record.sendDisabledReason || '';
  }
  updateRecordCounts();
}
function updateRecordCounts() { $('counts').textContent = `${nextId - 1} 句 · ${finalizedCount}条弹幕${nativeSendRecords.length ? ` · 原生对照${nativeSendRecords.length}条` : ''}`; }
function noteSkipped(record, reason) {
  record.status = 'skipped'; record.skipReason = reason;
  if (!record.skipCounted) { record.skipCounted = true; skippedCount++; log(`已跳过 #${record.id}：${reason}`); }
  updateRecord(record);
}
const sendQueue = createDanmakuSender(Core, {
  send: postDanmaku,
  onPacket: packet => { finalizedCount++; if (!packet.automatic) previewFinal(packet.text, packet); updatePacketRecord(packet); updateRecordCounts(); },
  onSending: packet => previewFinal(packet.text, packet),
  onUpdate: record => {
    if (record.status === 'skipped') noteSkipped(record, record.skipReason || '发送失败');
    else updateRecord(record);
    updatePreviewStatus(); updateSendTiming();
  },
  onNotice: message => { sendNotice = message; renderStatus(); updateSendTiming(); }
});
const translationQueue = new Core.OrderedQueue({ onError: (task, error) => {
  captionNotice = `字幕翻译已跳过：${String(error.message || '处理失败').slice(0, 90)}`; renderStatus(); return 'skip';
}, onChange(task) {
  if (task.status === 'failed') { task.record.status = 'translation_failed'; updateRecord(task.record); }
  if (task.status === 'skipped') noteSkipped(task.record, task.error || '翻译超时');
  if (task.status === 'cancelled') { task.record.status = task.status; updateRecord(task.record); }
} });
function trimLiveQueue(queue, incoming = false) {
  queue.dropWhere(task => Core.liveExpired(task.record.createdAt), '内容已超过20秒，保留最新字幕');
  if (!incoming) return;
  const automatic = queue.items;
  const removeCount = Math.max(0, automatic.length - Core.LIVE_PENDING_LIMIT + 1);
  const oldest = automatic.filter(task => task.status !== 'running').slice(0, removeCount);
  queue.dropWhere(task => oldest.includes(task), '内容积压，保留较新的句子');
}
let resolvedRoom = null;
async function readLiveStatus(path, signal) {
  const id = path.split('/').find(part => /^\d+$/u.test(part));
  if (!id || signal.aborted) return null;
  const controller = new AbortController(); const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 5000);
  try {
    const response = await fetch(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${id}`, { credentials: 'include', signal: controller.signal });
    if (!response.ok) return null;
    const body = await response.json();
    if (signal.aborted || location.pathname !== path || body.code !== 0) return null;
    if (Number.isInteger(body.data?.room_id) && body.data.room_id > 0) resolvedRoom = { path, id: body.data.room_id };
    const value = body.data?.live_status;
    return value === 0 || value === 1 || value === 2 ? value : null;
  } catch { return null; }
  finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
}
function stopRoomMonitor() {
  roomMonitor?.stop(); roomMonitor = null; roomNotice = '';
  watchRetryAt = 0; watchFailures = 0; watchConnectedAt = 0;
}
function stopForRoomChange() {
  stopRoomMonitor(); const previous = session; session = null; assembler = null; previous?.close();
  $('autoSend').checked = false; autoSendLease.release(); echoTracker.cancelAll(); sendQueue.clear(); translationQueue.clear();
  sendNotice = ''; captionNotice = ''; captionText = ''; previewDraft(''); previewFinal(''); setState('idle');
  status('直播间页面已切换，已停止识别和待发任务');
}
function stopOffline(current, liveStatus, initial) {
  if (session !== current) return;
  // Keep the explicitly authorized capture and room watch, but close the paid
  // recognition connection and invalidate every item from the previous show.
  current.suspendRecognition(); assembler = null; autoSendEpoch++;
  echoTracker.cancelAll(); sendQueue.clear(); translationQueue.clear(); watchRetryAt = 0; watchFailures = 0;
  sendNotice = ''; captionNotice = ''; captionText = ''; previewDraft(''); previewFinal(''); setState(current.userPaused ? 'paused' : 'waiting');
  const reason = liveStatus === 2 ? '直播间当前为轮播' : initial ? '直播间尚未开播' : '直播间已下播';
  status(current.userPaused ? `${reason} · 同传仍暂停，音轨与共享保留` : `${reason}，等待开播 · 未连接识别服务`);
  log(`${reason}；识别连接和待发任务已停止，保留值守与自动发送选择`);
}
async function jsonFetch(url, options = {}, rejectMessage = false, timeout = 12000) {
  const pending = earlyNativeCapture.runOwn(() => fetch(url, { ...options, credentials: 'include', signal: AbortSignal.timeout(timeout) }));
  const response = await pending;
  const retry = response.headers.get('Retry-After');
  const retryAfterMs = retry === null ? 0 : /^\s*\d+(?:\.\d+)?\s*$/u.test(retry)
    ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now());
  if (!response.ok) {
    const error = new Error(`B站请求失败（HTTP ${response.status}）`);
    error.httpStatus = response.status;
    error.rateLimited = response.status === 429; error.retryAfterMs = retryAfterMs; throw error;
  }
  const body = await response.json();
  if (body.code !== 0 || (rejectMessage && body.message)) {
    const message = body.message || body.msg || '';
    const error = new Error(/^[fk]$/u.test(message) ? `B站未接受弹幕（${message}，返回码 ${body.code}）` : message || `B站拒绝请求（${body.code}）`);
    error.httpStatus = response.status; error.responseCode = body.code; error.responseMessage = message;
    error.rateLimited = /频繁|频率|过快|太快|too (?:many|fast)|rate.?limit/iu.test(error.message);
    error.retryAfterMs = retryAfterMs; throw error;
  }
  return { ...body, httpStatus: response.status };
}
let wbiKeyCache = null, wbiKeyRead = null;
async function getWbiKeys() {
  if (wbiKeyCache && Date.now() - wbiKeyCache.at < 30 * 60000) return wbiKeyCache.keys;
  if (!wbiKeyRead) wbiKeyRead = (async () => {
    const body = await jsonFetch('https://api.bilibili.com/x/web-interface/nav', {}, false, 5000);
    const keys = Bilibili.keysFromNav(body); wbiKeyCache = { keys, at: Date.now() }; return keys;
  })().finally(() => { wbiKeyRead = null; });
  return wbiKeyRead;
}
async function roomFor(path) {
  if (resolvedRoom?.path === path) return resolvedRoom.id;
  const roomNumber = path.split('/').find(x => /^\d+$/u.test(x));
  if (!roomNumber) throw new Error('当前不是直播间页面，无法发送弹幕');
  const result = await jsonFetch(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomNumber}`);
  if (!result.data?.room_id) throw new Error('未取得直播间编号');
  resolvedRoom = { path, id: result.data.room_id }; return resolvedRoom.id;
}
async function postDanmaku(text, path, isCurrent, checkCurrent, attempted, accepted) {
  if (!text.startsWith('【') || !text.endsWith('】') || Core.danmakuLength(text) > 30) throw new Error('弹幕必须用【】包裹，且含括号、标点总长不能超过30字');
  if (location.pathname !== path) throw new Error('直播间页面已变化，已暂停发送');
  const csrf = document.cookie.split(';').map(x => x.trim()).find(x => x.startsWith('bili_jct='))?.slice(9);
  if (!csrf) throw new Error('请先登录B站');
  const roomId = await roomFor(path);
  if (!isCurrent() || location.pathname !== path) throw new Core.Cancelled();
  checkCurrent();
  const keys = await getWbiKeys();
  if (!isCurrent() || location.pathname !== path) throw new Core.Cancelled();
  checkCurrent();
  const webLocation = document.querySelector('meta[name="spm_prefix"]')?.getAttribute('content') || '444.8';
  const query = Bilibili.sign({ web_location: webLocation }, keys);
  const form = new FormData();
  for (const [key, value] of Object.entries({ msg: text, roomid: roomId, csrf, csrf_token: csrf, color: 16777215, fontsize: 25, mode: 1, bubble: 0, room_type: 0, jumpfrom: 0, reply_mid: 0, reply_attr: 0, replay_dmid: '', statistics: '{"appId":100,"platform":5}', rnd: Math.floor(Date.now() / 1000) })) form.append(key, String(value));
  const receipt = echoTracker.expect(text, () => isCurrent() && location.pathname === path);
  try {
    const ownUid = () => document.cookie.match(/(?:^|;\s*)DedeUserID=(\d+)(?:;|$)/)?.[1] || '';
    const senderUid = ownUid();
    const response = await sharedAutoSender.send({uid: senderUid, room: String(roomId), text,
      isCurrent: () => senderUid === ownUid() && isCurrent() && location.pathname === path}, () => {
      checkCurrent();
      attempted({ signed: true, webLocation, bodyFields: [...form.keys()].sort(),
      fields: Object.fromEntries([...form.entries()].filter(([name]) => ['roomid','room_type','jumpfrom','reply_mid','reply_attr','replay_dmid','color','mode','bubble','fontsize','rnd','dm_type','statistics'].includes(name))) });
      return jsonFetch('https://api.live.bilibili.com/msg/send?' + query, { method: 'POST', body: form }, true, 6000);
    });
    if (!isCurrent()) throw new Core.Cancelled();
    accepted(response);
    const confirmed = await receipt.promise;
    if (!isCurrent()) throw new Core.Cancelled();
    return { ...response, confirmed };
  }
  catch (err) {
    receipt.cancel();
    if (err.responseCode === -403 || err.httpStatus === 403) wbiKeyCache = null;
    if (err.name === 'TimeoutError' || err.name === 'TypeError') {
      const error = new Error('发送结果未确认，本条跳过且不自动重试'); error.unconfirmed = true; throw error;
    }
    throw err;
  }
}
function queueOutput(record) {
  if (!record.text) return;
  try { sendQueue.enqueue(record); } catch (err) { noteSkipped(record, err.message); }
}
function updateSendTiming() {
  const pending = sendQueue.pendingCount, wait = sendQueue.waitingMs;
  $('sendTiming').textContent = `每条最多30字（含【】） · 至少间隔5秒 · 短句最多合并1秒${wait > 0 ? ` · ${sendQueue.waitReason === 'rejected' ? '连续未获受理，暂缓' : sendQueue.waitReason === 'pace' ? '发送间隔等待' : '平台反馈等待'}约${Math.ceil(wait / 1000)}秒` : ''}${pending ? ` · 待${$('autoSend').checked ? '发' : '预览'}${pending}条` : ''}${skippedCount ? ` · 已跳过${skippedCount}句` : ''}`;
}
function newSentence(source) {
  const cfg = activeConfig || config();
  const record = { id: nextId++, source, text: '', status: 'recognizing', path: pageBinding, commitBatchId,
    confirmation: latestConfirmation,
    sourceLanguage: cfg.language === 'auto' ? '' : cfg.language, targetLanguage: Core.outputLanguage(cfg.output),
    time: new Date().toISOString(), createdAt: Date.now(), confirmedAt: latestCommitAt ?? Date.now(), automatic: $('autoSend').checked, autoSendEpoch };
  records.push(record); if (records.length > 2000) records.shift(); updateRecord(record);
  const ready = text => {
    record.readyAt = Date.now();
    if (record.automatic && record.autoSendEpoch !== autoSendEpoch) {
      record.automatic = false; record.sendDisabledReason = '自动发送状态已变化，此句只显示字幕';
    }
    record.text = Core.clean(text); record.status = 'ready'; updateRecord(record);
    if (Core.liveExpired(record.createdAt)) { noteSkipped(record, '处理完成时已超过20秒'); return; }
    captionNotice = ''; renderStatus();
    captionText = record.text; updateCaptions();
    queueOutput(record);
  };
  if (!record.targetLanguage || cfg.language === record.targetLanguage) { ready(source); return; }
  record.status = 'translating'; updateRecord(record);
  try {
    trimLiveQueue(translationQueue, true);
    const controller = new AbortController();
    translationQueue.enqueue({ id: record.id, record, automatic: record.automatic, cancel: () => controller.abort(), run: async isCurrent => {
      if (Core.liveExpired(record.createdAt)) throw new Core.Skipped('待译内容已超过20秒');
      if (!record.sourceLanguage) {
        if (!languageDetector) throw new Error('自动语言判断未准备好，请停止识别并准备语言包，或手动选择主播语言');
        const detected = await localDeadline(signal => languageDetector.detect(source, { signal }), controller.signal);
        if (!isCurrent()) throw new Core.Cancelled();
        record.sourceLanguage = Core.detectedLanguage(detected);
        if (!record.sourceLanguage) throw new Error('这句的语言判断不够确定，已跳过。可停止后固定识别语言再开始');
      }
      if (record.sourceLanguage === record.targetLanguage) { ready(source); return; }
      const translator = translators.get(translationKey(record.sourceLanguage, record.targetLanguage));
      if (!translator) throw new Error(`${languageNames[record.sourceLanguage] || record.sourceLanguage} → ${languageNames[record.targetLanguage]} 翻译未准备好，请停止后在设置中准备翻译再开始`);
      const text = await localDeadline(signal => translator.translate(source, { signal }), controller.signal);
      if (!isCurrent()) throw new Core.Cancelled();
      if (!Core.clean(text)) throw new Error('翻译结果为空，本句已跳过');
      ready(text);
    } });
  } catch (err) { noteSkipped(record, err.message); }
}
async function localDeadline(operation, outerSignal) {
  if (outerSignal?.aborted) throw new Core.Cancelled();
  const controller = new AbortController(); let timer, cancel;
  try {
    const interrupted = new Promise((resolve, reject) => {
      cancel = () => { controller.abort(); reject(new Core.Cancelled()); };
      outerSignal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(new Error('本句翻译或语言判断超过5秒')); }, 5000);
    });
    return await Promise.race([operation(controller.signal), interrupted]);
  } finally { clearTimeout(timer); if (cancel) outerSignal?.removeEventListener('abort', cancel); }
}
$('autoSend').onchange = () => {
  if ($('autoSend').checked && !autoSendLease.claim()) {
    $('autoSend').checked = false; sendNotice = '请先关闭评论盲盒防护的自动跟车，再开启同传自动发送。'; renderStatus(); log(sendNotice, true); return;
  }
  if (!$('autoSend').checked) autoSendLease.release();
  autoSendEpoch++;
  echoTracker.cancelAll();
  if (assembler) {
    const cfg = activeConfig || config();
    assembler = new Core.SentenceAssembler({ onSentence: newSentence, language: cfg.language, graceMs: cfg.grace });
  }
  previewDraft('');
  sendQueue.clear('自动发送状态已变化，已取消尚未定稿的内容');
  sendNotice = ''; renderStatus();
  if (!$('autoSend').checked) { log('自动发送已关闭，后续只预览；旧待发已取消，已在请求中的当前条可能完成'); }
  else {
    translationQueue.dropWhere(task => !task.automatic, '已开启实时发送，跳过之前的待译内容');
    sendQueue.prune(); trimLiveQueue(translationQueue);
    log('自动发送已开启，将从接下来确认的句子开始，失败和过期内容自动跳过');
  }
};
$('export').onclick = () => {
  const stamp = value => Number.isFinite(value) ? new Date(value).toISOString() : '—';
  const labels = { recognizing: '待处理', translating: '翻译中', ready: '待处理', queued: '合并等待中', running: '发送中', done: '处理完成', previewed: '仅预览，未发送', skipped: '已跳过', cancelled: '已取消' };
  const transcript = records.map(record => [
    `[#${record.id} · 成句 ${record.time}] ${record.text || record.source}`,
    ...(record.text && record.text !== record.source ? [`识别原文：${record.source}`] : []),
    `识别确认：${stamp(record.confirmedAt)}；文字就绪：${stamp(record.readyAt)}；进入待发：${stamp(record.queuedAt)}`,
    ...(record.confirmation ? [`确认来源：${record.confirmation.pendingRequest ? '收到时有主动请求等待' : '服务端确认'}；连接：${record.confirmation.connection}；主动请求：${record.confirmation.pendingRequest?.id ?? '—'}；请求时间：${stamp(record.confirmation.pendingRequest?.requestedAt)}；接收时已上传音频：${record.confirmation.uploadedAudioMs}毫秒`] : []),
    `状态：${labels[record.status] || record.status}${record.sendEvents?.length ? `；对应弹幕：${record.sendEvents.map(event => '#' + event.id).join('、')}` : ''}`,
    ...(record.previewEvents?.length ? [`对应最终内容：${record.previewEvents.map(event => '#' + event.id).join('、')}`] : []),
    ...(record.skipReason || record.sendDisabledReason ? [`原因：${record.skipReason || record.sendDisabledReason}`] : [])
  ].join('\n')).join('\n\n');
  const events = [...new Map(records.flatMap(record => (record.sendEvents || []).map(event => [event.id, event]))).values()].sort((a, b) => a.id - b.id);
  const results = { queued: '待发送', preparing: '准备发送', sending: '请求中', submitted: '已提交，等待回显', echoed: '已回显', failed: '发送失败', skipped: '已跳过', unconfirmed: '结果未确认', cancelled: '已取消' };
  const delivery = events.map(event => [
    `弹幕 #${event.id}：${event.text}`,
    `对应记录：${(event.recordIds || []).map(id => '#' + id).join('、')}`,
    `请求开始：${stamp(event.startedAt)}；请求完成：${stamp(event.finishedAt)}`,
    `请求签名：${event.requestInfo?.signed ? 'WBI已附带' : '未记录'}；返回HTTP：${event.httpStatus ?? '—'}；返回码：${event.responseCode ?? '—'}；返回消息：${event.responseMessage || '（空）'}`,
    `脚本方式：fetch / FormData / credentials=include；正文键名：${event.requestInfo?.bodyFields?.join('、') || '未记录'}`,
    `脚本公开参数：${JSON.stringify(event.requestInfo?.fields || {})}`,
    `结果：${results[event.status] || event.status}${event.reason ? `；${event.reason}` : ''}`
  ].join('\n')).join('\n\n') || '没有实际发送请求。';
  const previews = [...new Map(records.flatMap(record => (record.previewEvents || []).map(event => [event.id, event]))).values()].sort((a, b) => a.id - b.id);
  const formatted = previews.map(event => [
    `最终内容 #${event.id}：${event.text}`,
    `对应记录：${event.recordIds.map(id => '#' + id).join('、')}；定稿时间：${stamp(event.previewedAt)}`,
    `原文位置：${(event.sourceRanges || []).map(range => `#${range.recordId}[${range.start},${range.end})`).join('、')}；状态：${event.automatic ? results[event.status] || event.status : '仅预览'}`,
    `模式：${event.automatic ? '自动发送；实际请求及结果见发送记录' : '仅预览，未发送'}`
  ].join('\n')).join('\n\n') || '没有已定稿的弹幕预览。';
  const native = nativeSendRecords.map(record => [
    `原生 #${record.id}：${record.fields.msg || '（未读取到正文）'}`,
    `请求开始：${stamp(record.startedAt)}；请求完成：${stamp(record.finishedAt)}`,
    `请求地址：${record.endpoint}；方式：${record.transport}；凭据模式：${record.credentials}`,
    `正文编码：${record.bodyEncoding}；Content-Type：${record.contentType || '未显式设置'}；请求头键名：${record.headerFields.join('、')}`,
    `查询键名：${record.queryFields.join('、')}；web_location：${record.webLocation || '未附带'}；WBI：${record.signed ? '已附带' : '未附带'}`,
    `正文键名：${record.bodyFields.join('、')}；公开参数：${JSON.stringify(record.fields)}`,
    `已隐藏字段值：${record.withheldFields.join('、') || '无'}；返回HTTP：${record.httpStatus}；返回码：${record.responseCode ?? '—'}；返回消息：${record.responseMessage || '（空）'}`
  ].join('\n')).join('\n\n') || '没有捕获到原生手动发送请求；不能据此判断是否手动发送过。请核对下方网页确认状态。';
  const capture = nativeSendObserver.state;
  const captureStatus = `观察状态：${capture.mode}；网页确认：${capture.pageAcknowledged ? '是' : '否'}；安装阶段：${capture.readyState}；fetch挂接：${capture.fetch ? '是' : '否'}；XHR挂接：${capture.xhr ? '是' : '否'}${capture.error ? `；说明：${capture.error}` : ''}`;
  const text = `菜包直播同传 ${CAIBAO_BUILD_VERSION}\n构建：${CAIBAO_BUILD_REVISION}\n成句时间不代表发送时间；多句可共用同一条弹幕。\n\n识别记录\n\n${transcript}\n\n最终弹幕预览（每个编号只列一次）\n\n${formatted}\n\n实际弹幕发送记录（每个编号只列一次）\n\n${delivery}\n\n原生手动发送对照（最近20条，仅只读记录）\n\n${captureStatus}\n\n${native}`;
  const url = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `菜包直播同传-${new Date().toISOString().replace(/[:.]/gu, '-')}.txt`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
function setState(next) {
  state = next; $('start').disabled = next !== 'idle'; $('stop').disabled = next === 'idle' || next === 'stopping';
  $('pause').disabled = !session?.graphReady || next === 'idle' || next === 'stopping';
  $('pause').textContent = session?.userPaused ? '继续同传' : '暂停同传';
  updateLauncherStatus();
  for (const id of ['source', 'language', 'output', 'prepareTranslation']) $(id).disabled = next !== 'idle';
  if (next === 'idle') { audioMode = null; $('localMute').checked = false; $('level').style.width = '0'; shadow.querySelector('.meter').setAttribute('aria-valuenow', '0'); }
  updateAudioControl();
}
$('start').onclick = () => {
  const cfg = config(); const key = $('key').value.trim() || keyVault.get();
  if (preparing) { status('正在准备语言包，请稍候', true); return; }
  if (!key) { $('connectionSettings').open = true; status('请先填写 ElevenLabs API Key', true); $('key').focus(); return; }
  if (!navigator.mediaDevices?.getDisplayMedia && (cfg.source !== 'tab' || typeof HTMLMediaElement.prototype.captureStream !== 'function')) { status('当前浏览器不支持采集音频，请使用桌面 Chrome / Edge', true); return; }
  if (!translationReady(cfg)) {
    $('connectionSettings').open = true; $('translationSettings').hidden = false;
    status('请先准备所选输出语言的本地翻译，或把「输出为」设为「不翻译」', true); return;
  }
  stopRoomMonitor(); translationQueue.clear(); sendNotice = ''; captionNotice = '';
  try { keyVault.capture($('key'), $('remember').checked); updateKeyStatus(); }
  catch { log('Key 未能保存；当前页面仍可继续使用', true); }
  $('connectionSettings').open = false;
  activeConfig = cfg; pageBinding = location.pathname; quietWarned = false; lastVoice = Date.now(); latestCommitAt = null;
  const roomPath = pageBinding;
  assembler = new Core.SentenceAssembler({ onSentence: newSentence, language: cfg.language, graceMs: cfg.grace });
  const localMute = $('localMute').checked;
  captionText = ''; previewDraft(''); previewFinal(''); setState('starting'); status('正在确认直播间，优先直接读取播放器音频…');
  let firstGate = null, playbackBusy = false, watchStatus = null;
  const canConnect = () => session === current && !current.userPaused && location.pathname === roomPath && roomMonitor?.active && roomMonitor.lastStatus === 1 &&
    navigator.onLine !== false && Date.now() >= watchRetryAt && current.hasRecentAudio();
  const resumeIfReady = () => {
    if (!canConnect() || current.ready || current.connecting || current.recovering || !current.graphReady) return;
    void current.connectRecognition(key);
  };
  const prepareLivePlayback = async () => {
    if (session !== current || current.userPaused || sharedAudioRequest || roomMonitor?.lastStatus !== 1 || playbackBusy) return;
    playbackBusy = true;
    try {
      if (current.context?.state === 'suspended' || current.context?.state === 'interrupted') void current.context.resume().catch(() => {});
      const players = [...document.querySelectorAll('video')].filter(video => video.currentSrc || video.srcObject || video.getAttribute('src'));
      players.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height);
      const player = players[0];
      if (player?.paused || player?.ended) {
        try { await player.play(); }
        catch (error) {
          if (session === current && !current.ready && error.name === 'NotAllowedError') {
            setState('waiting'); status('已开播，浏览器阻止自动播放；请在直播页播放一次后继续值守', true);
          }
          return;
        }
      }
      if (session === current && !current.ready && !current.connecting && !current.recovering && Date.now() >= watchRetryAt) {
        setState('waiting'); status('已开播，等待播放器声音 · 尚未连接识别服务');
      }
      resumeIfReady();
    } finally { playbackBusy = false; }
  };
  const current = new ElevenSession({ ...cfg, localMute, watch: true }, {
    canConnect,
    requestSharedAudio: signal => requestSharedAudio(cfg, signal),
    audioReady: () => { if (session === current) { setState('waiting'); status('音轨已就绪，等待新的直播声音…'); } },
    waitingForAudio: () => { if (session === current) { setState('starting'); status('正在等待播放器音轨就绪，优先直接采集…'); } },
    isCurrent: () => {
      if (session !== current) return false;
      if (location.pathname !== roomPath) { stopForRoomChange(); return false; }
      return true;
    },
    beforeCapture: async signal => {
      if (signal.aborted || session !== current) return false;
      status('正在确认直播间是否开播…');
      const gate = new Promise(resolve => {
        const abort = () => { firstGate = null; resolve(false); };
        signal.addEventListener('abort', abort, { once: true });
        firstGate = value => { signal.removeEventListener('abort', abort); resolve(value); };
      });
      const monitor = createLiveRoomMonitor({
        continuous: true,
        readStatus: async monitorSignal => {
          const value = await readLiveStatus(roomPath, monitorSignal);
          if (session === current && !monitorSignal.aborted) {
            roomNotice = value === null ? '下播检测暂不可用，正在重试' : ''; renderStatus();
          }
          return value;
        },
        onUnknown: () => { if (session === current) log('暂时无法确认直播状态，将继续检查；网络错误不会被当作下播', true); },
        onStatus: value => {
          if (session !== current) return;
          if (location.pathname !== roomPath) { stopForRoomChange(); return; }
          if (value === 1 && watchStatus !== 1) current.lastAudibleAt = undefined;
          watchStatus = value;
          if (value === 1 && firstGate) { const resolve = firstGate; firstGate = null; resolve(true); }
          if (current.userPaused) return;
          if (value === 1) void prepareLivePlayback();
          else if (!current.ready && !current.connecting && !current.recovering) {
            setState('waiting'); status(value === null ? '等待开播 · 直播状态暂时无法确认，正在重试' : '等待开播 · 未连接识别服务');
          }
        },
        onLive: () => { if (session === current) log('检测到开播，将在采集到直播声音后自动开始同传'); },
        onOffline: (value, { initial }) => stopOffline(current, value, initial)
      });
      roomMonitor = monitor;
      await monitor.start();
      if (signal.aborted || session !== current) return false;
      if (location.pathname !== roomPath) { stopForRoomChange(); return false; }
      if (!monitor.active) return false;
      return gate;
    },
    connecting: () => {
      if (session !== current) return;
      if (!assembler) assembler = new Core.SentenceAssembler({ onSentence: newSentence, language: cfg.language, graceMs: cfg.grace });
      setState('starting'); status('正在连接 ElevenLabs…');
    },
    waitingForPlayer: () => {
      if (session !== current) return;
      assembler = null; autoSendEpoch++; sendQueue.clear(); translationQueue.clear(); previewDraft('');
      setState(current.userPaused ? 'paused' : 'waiting'); status(current.userPaused ? '同传仍暂停，等待播放器音轨恢复；不会自动启动识别。' : '播放器音频暂未恢复 · 识别已暂停，继续等待播放器');
    },
    recovering: () => {
      if (session !== current || current.userPaused) return;
      if (current.ready) setState('recovering');
      status('播放器正在切换，正在接续音频…'); log('正在尝试接续播放器音频');
      void roomMonitor?.checkNow();
    },
    recovered: () => {
      if (session !== current) return;
      if (current.userPaused) { setState('paused'); status('同传已暂停，音轨仍保留；未上传音频或发送弹幕。'); return; }
      quietWarned = false; lastVoice = Date.now();
      setState(current.ready ? 'running' : 'waiting');
      status(current.ready ? `正在识别 · ${outputDescription(cfg)}` : '音频已恢复，等待直播声音后自动开始');
      log('已接续直播音频，沿用本次识别连接');
    },
    audioSource: ({ mode, suppressed, muted }) => {
      if (session !== current) return;
      audioMode = mode; $('localMute').checked = muted; updateAudioControl();
      if (mode === 'player') log('已直接读取直播播放器，静音和音量变化不会中断音频采集');
      else if (suppressed) log('浏览器报告本地播放被关闭，请停止后重新共享并保留声音', true);
      else log('播放器无法直接读取，已使用共享音轨；请保留播放器声音');
    },
    playback: muted => { if (session === current) { $('localMute').checked = muted; updateOutputHint(); } },
    level: rms => {
      if (session !== current) return;
      const level = Math.min(100, Math.round(rms * 500));
      const shown = current.ready ? level : 0;
      $('level').style.width = `${shown}%`; shadow.querySelector('.meter').setAttribute('aria-valuenow', String(shown));
      if (rms > .0001) { lastVoice = Date.now(); if (quietWarned) { quietWarned = false; if (state === 'running') status(`正在识别 · ${outputDescription(cfg)}`); } }
      resumeIfReady();
    },
    running: () => { if (session !== current) return; watchConnectedAt = Date.now(); setState(current.recovering ? 'recovering' : 'running'); status(current.recovering ? '播放器正在切换，正在接续音频…' : `正在识别 · ${outputDescription(cfg)}`); log(`识别已启动；${Core.outputLanguage(cfg.output) ? 'ElevenLabs 识别后由浏览器本地翻译，发送目标语言' : '输出识别原文'}`); },
    partial: text => { if (session !== current || !current.ready || !assembler) return; assembler.notePartial(text); previewDraft(text ? `${Core.outputLanguage(cfg.output) ? '原文识别中' : '识别中'}：${text}` : ''); },
    committed: (text, confirmation) => {
      if (session !== current || !current.ready || !assembler || !Core.clean(text)) return;
      latestCommitAt = Date.now();
      latestConfirmation = confirmation || null;
      commitBatchId++;
      previewDraft('');
      assembler.push(text);
    },
    stopping: () => { if (session !== current) return; stopRoomMonitor(); setState('stopping'); status('正在接收最后一句…'); },
    finished: () => { if (session !== current) return; stopRoomMonitor(); assembler?.flush(); previewDraft(''); session = null; setState('idle'); status('已停止识别'); log('识别已停止；关闭自动发送可清空待发任务'); },
    error: (message, { retryable = false } = {}) => {
      if (session !== current) return;
      assembler = null; autoSendEpoch++; sendQueue.clear(); translationQueue.clear(); previewDraft('');
      if (retryable) {
        watchFailures++; const delay = Math.min(60000, 5000 * 2 ** Math.min(watchFailures - 1, 4));
        watchRetryAt = Date.now() + delay;
        setState('waiting'); status(`连接暂时中断，约${delay / 1000}秒后自动重试 · 未连接识别服务`);
        log(message + '；已保留值守，将在直播仍开播且有声音时重试', true);
      } else {
        stopRoomMonitor(); current.close(); session = null; $('autoSend').checked = false; autoSendLease.release(); echoTracker.cancelAll(); setState('idle'); status(message + '（已退出值守）', true); log(message, true);
      }
    }
  });
  session = current; void current.start(key);
};
$('stop').onclick = () => {
  if (!session) return;
  stopRoomMonitor(); const previous = session; session = null; assembler = null; previous.close();
  autoSendEpoch++; $('autoSend').checked = false; autoSendLease.release(); echoTracker.cancelAll(); sendQueue.clear(); translationQueue.clear();
  sendNotice = ''; captionNotice = ''; captionText = ''; previewDraft(''); previewFinal(''); setState('idle'); status('同传已结束，音轨与共享已释放'); log('已退出值守并释放音频；不会在下次开播时自动启动');
};
$('pause').onclick = () => {
  if (!session) return;
  if (session.userPaused) {
    if (!session.resume()) return;
    assembler = new Core.SentenceAssembler({ onSentence: newSentence, language: activeConfig.language, graceMs: activeConfig.grace });
    quietWarned = false; lastVoice = Date.now(); watchRetryAt = 0;
    setState('waiting'); status('已继续，复用当前音轨，等待新的直播声音…');
    void session.context?.resume().catch(() => {}); void roomMonitor?.checkNow();
  } else {
    if (!session.pause()) return;
    assembler = null; autoSendEpoch++; echoTracker.cancelAll(); sendQueue.clear(); translationQueue.clear();
    captionText = ''; previewDraft(''); previewFinal(''); setState('paused');
    status('同传已暂停，音轨与共享仍保留；未上传音频或发送弹幕。');
  }
};
const tick = setInterval(() => {
  if (!host.isConnected && document.body) document.body.append(host);
  assembler?.tick(); sendQueue.prune(); trimLiveQueue(translationQueue); updateCaptions(); updateSendTiming();
  if (session && location.pathname !== pageBinding) {
    stopForRoomChange();
  }
  if (state === 'running' && !quietWarned && Date.now() - lastVoice > 15000) {
    quietWarned = true; status('已连接，但最近没有检测到音量'); log(audioMode === 'player' ? '若主播正在说话，请确认直播仍在播放；未检测到音量不会单独被当作下播' : '若主播正在说话，请检查共享音频、播放器音量和是否仍在播放');
  }
  if (state === 'running' && session && Date.now() - lastVoice >= 60000) {
    session.suspendRecognition(); assembler = null; autoSendEpoch++;
    sendQueue.clear('长时间没有音频，已暂停识别'); translationQueue.clear();
    previewDraft(''); previewFinal(''); watchRetryAt = 0; watchFailures = 0;
    setState('waiting'); status('直播声音暂时中断，识别已暂停 · 有声音后自动接续');
    log('连续1分钟没有采到音频，已暂停识别；保留值守，不把静音直接当作下播');
  }
  if (state === 'running' && watchFailures && Date.now() - watchConnectedAt >= 60000) watchFailures = 0;
}, 250);
const recheckWatch = () => { if (session && roomMonitor?.active) { watchRetryAt = 0; void roomMonitor.checkNow(); } };
listen(window, 'online', recheckWatch); listen(window, 'focus', recheckWatch);
listen(document, 'visibilitychange', () => { if (document.visibilityState === 'visible') recheckWatch(); });
function dispose() {
  if (disposed) return; disposed = true;
  lifetime.abort(); autoSendEpoch++; $('autoSend').checked = false;
  autoSendLease.release(); echoTracker.cancelAll(); nativeSendObserver.stop(); nativeSendObserver.subscribe(null);
  clearInterval(tick); stopRoomMonitor(); floatingPanelObserver.disconnect();
  const previous = session; session = null; assembler = null; previous?.close();
  sendQueue.clear(); translationQueue.clear();
  for (const translator of translators.values()) translator.destroy?.();
  translators.clear(); languageDetector?.destroy?.(); languageDetector = null;
  host.remove(); captionHost.remove();
}
// Restore settings without triggering unsolicited model downloads on page load.
$('translationSettings').hidden = !Core.outputLanguage(settings.output) || settings.language === Core.outputLanguage(settings.output);
$('outputHint').textContent = Core.outputLanguage(settings.output)
  ? `保留直播原声 · ${outputDescription(settings)}`
  : '保留直播原声 · 输出识别原文';
updateCaptions();
updateSendTiming();
updateAudioControl();
setPanelOpen(false, false);
updateLauncherStatus();
host.dataset.caibaoReady = 'true';
return { dispose, show() {
  if (disposed) return;
  if (!host.isConnected && document.body) document.body.append(host);
  host.style.setProperty('display', 'block', 'important');
  setPanelOpen(true);
  updateCaptions();
} };

}
// All declarations, including app settings, live inside the userscript closure.
if (window.top !== window.self) return;
let caibaoApp = null;
// A BFCache return keeps this userscript closure but not its media sessions.
// Rebuild one idle UI; capture and automatic sending require a fresh user action.
window.addEventListener('pagehide', () => { caibaoApp?.dispose(); caibaoApp = null; });
window.addEventListener('pageshow', event => { if (event.persisted) launchCaibao(); });
function showExistingCaibaoPanel(expand) {
  const existing = document.getElementById('eleven-live-control');
  if (existing?.dataset.caibaoReady !== 'true') return false;
  if (expand) { existing.style.setProperty('display', 'block', 'important'); existing.dispatchEvent(new Event('caibao-show')); }
  return true;
}
function showCaibaoStartupError(error) {
  console.error('[菜包直播同传] 启动失败：', error);
  const button = document.createElement('button');
  button.id = 'caibao-startup-error';
  button.textContent = '菜包直播同传：启动失败，点击查看';
  button.style.cssText = 'position:fixed;right:20px;top:80px;z-index:2147483647;padding:10px;background:white;color:#b13f43;border:1px solid #b13f43;border-radius:8px;';
  button.onclick = () => alert(`菜包直播同传 ${CAIBAO_BUILD_VERSION} 启动失败\n${error.name}: ${error.message}\n请确认旧内容已完整替换，并刷新直播间。`);
  (document.body || document.documentElement).append(button);
}
function launchCaibao(expand = false) {
  if (caibaoApp) { if (expand) caibaoApp.show(); return; }
  if (showExistingCaibaoPanel(expand)) return;
  document.getElementById('caibao-startup-error')?.remove();
  try { caibaoApp = startCaibaoApp(); if (expand) caibaoApp.show(); }
  catch (error) { showCaibaoStartupError(error); }
}
try {
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('显示 / 恢复菜包直播同传', () => launchCaibao(true));
  }
} catch (error) { console.warn('[菜包直播同传] 无法注册恢复菜单：', error); }
if (document.body) launchCaibao();
else {
  const bodyObserver = new MutationObserver(() => {
    if (!document.body) return;
    bodyObserver.disconnect(); launchCaibao();
  });
  bodyObserver.observe(document.documentElement || document, { childList: true, subtree: true });
}

})();
