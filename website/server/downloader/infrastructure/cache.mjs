export class ExpiringCache {
  constructor({ maxEntries = 80, maxBytes = Infinity, ttl = 300000, now = Date.now } = {}) {
    this.values = new Map()
    this.bytes = 0
    Object.assign(this, { maxEntries, maxBytes, ttl, now })
  }
  get(key) {
    const entry = this.values.get(key)
    if (!entry) return undefined
    if (entry.until <= this.now()) {
      this.delete(key)
      return undefined
    }
    this.values.delete(key)
    this.values.set(key, entry)
    return entry.value
  }
  delete(key) {
    const entry = this.values.get(key)
    if (entry) this.bytes -= entry.bytes
    this.values.delete(key)
  }
  set(key, value, bytes = 1) {
    this.delete(key)
    if (bytes > this.maxBytes) return value
    this.values.set(key, { value, bytes, until: this.now() + this.ttl })
    this.bytes += bytes
    while (this.values.size > this.maxEntries || this.bytes > this.maxBytes)
      this.delete(this.values.keys().next().value)
    return value
  }
  clear() {
    this.values.clear()
    this.bytes = 0
  }
}

export function waitFor(promise, signal) {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
        cleanup()
        reject(signal.reason)
      },
      cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

export class WorkPool {
  constructor(limit = 4, maxWaiting = 80) {
    this.limit = limit
    this.maxWaiting = maxWaiting
    this.running = 0
    this.queue = []
  }
  run(work, { signal, owner = '', onStart } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.queue.length >= this.maxWaiting)
      return Promise.reject(new Error('正在处理其他图片，请稍后重试。'))
    return new Promise((resolve, reject) => {
      const entry = { work, resolve, reject, signal, owner, onStart }
      entry.abort = () => {
        const index = this.queue.indexOf(entry)
        if (index < 0) return
        this.queue.splice(index, 1)
        reject(signal.reason)
      }
      signal?.addEventListener('abort', entry.abort, { once: true })
      this.queue.push(entry)
      this.drain()
    })
  }
  drain() {
    while (this.running < this.limit && this.queue.length) {
      // Rotate visitors at stage boundaries. A large album must not own every
      // subsequent slot while another visitor is waiting for one small file.
      const other = this.queue.findIndex((entry) => entry.owner !== this.lastOwner)
      const { work, resolve, reject, signal, abort, owner, onStart } = this.queue.splice(
        other < 0 ? 0 : other,
        1,
      )[0]
      signal?.removeEventListener('abort', abort)
      this.lastOwner = owner
      this.running++
      Promise.resolve()
        .then(() => {
          signal?.throwIfAborted()
          onStart?.()
          return work()
        })
        .then(resolve, reject)
        .finally(() => {
          this.running--
          this.drain()
        })
    }
  }
}

// Cancellation belongs to subscribers, not to the first requester. Abort the
// shared producer only after its last subscriber leaves; never cache failures.
export class SharedWork {
  constructor() {
    this.pending = new Map()
    this.active = new Set()
  }
  run(key, work, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason)
    let entry = this.pending.get(key)
    if (!entry) {
      const controller = new AbortController()
      entry = { controller, users: 0, settled: false }
      entry.promise = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted()
          return work(controller.signal)
        })
        .finally(() => {
          entry.settled = true
          this.active.delete(entry)
          if (this.pending.get(key) === entry) this.pending.delete(key)
        })
      this.pending.set(key, entry)
      this.active.add(entry)
    }
    entry.users++
    return waitFor(entry.promise, signal).finally(() => {
      if (--entry.users === 0 && !entry.settled) {
        if (this.pending.get(key) === entry) this.pending.delete(key)
        entry.controller.abort()
      }
    })
  }
  async close() {
    const entries = [...this.active]
    for (const entry of entries) entry.controller.abort()
    await Promise.allSettled(entries.map((entry) => entry.promise))
  }
}

export class StageTimings {
  constructor() {
    this.started = performance.now()
    this.stages = {}
    this.firstReadyMs = null
    this.elapsedMs = null
  }
  finish() {
    this.elapsedMs ??= Math.round(performance.now() - this.started)
  }
  ready() {
    this.firstReadyMs ??= Math.round(performance.now() - this.started)
  }
  async run(name, pool, work, options = {}) {
    const queued = performance.now()
    let began
    const stage = (this.stages[name] ??= { count: 0, waitMs: 0, workMs: 0, failures: 0 })
    try {
      return await pool.run(work, {
        ...options,
        onStart: () => {
          began = performance.now()
          stage.count++
          stage.waitMs += began - queued
        },
      })
    } catch (error) {
      stage.failures++
      throw error
    } finally {
      if (began !== undefined) stage.workMs += performance.now() - began
    }
  }
  snapshot() {
    return {
      firstReadyMs: this.firstReadyMs,
      elapsedMs: this.elapsedMs ?? Math.round(performance.now() - this.started),
      stages: Object.fromEntries(
        Object.entries(this.stages).map(([key, value]) => [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, amount]) => [name, Math.round(amount)]),
          ),
        ]),
      ),
    }
  }
}
