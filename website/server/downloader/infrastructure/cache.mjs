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
  run(work) {
    if (this.queue.length >= this.maxWaiting)
      return Promise.reject(new Error('正在处理其他图片，请稍后重试。'))
    return new Promise((resolve, reject) => {
      this.queue.push({ work, resolve, reject })
      this.drain()
    })
  }
  drain() {
    while (this.running < this.limit && this.queue.length) {
      const { work, resolve, reject } = this.queue.shift()
      this.running++
      Promise.resolve()
        .then(work)
        .then(resolve, reject)
        .finally(() => {
          this.running--
          this.drain()
        })
    }
  }
}
