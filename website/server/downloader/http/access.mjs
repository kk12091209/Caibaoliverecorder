import { randomBytes } from 'node:crypto'

const localHost = /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/
const cookieName = '__Host-caibao-download'
function denied(message, status = 403) {
  return Object.assign(new Error(message), { status })
}
export class DownloadAccess {
  constructor({ publicOrigins = [], trustProxy = false, now = Date.now } = {}) {
    this.origins = new Set(
      publicOrigins.map((value) => {
        const u = new URL(value)
        if (
          u.protocol !== 'https:' ||
          u.username ||
          u.password ||
          u.pathname !== '/' ||
          u.search ||
          u.hash
        )
          throw new Error('公网下载服务必须配置准确的 HTTPS 来源。')
        return u.origin
      }),
    )
    this.hosts = new Set([...this.origins].map((value) => new URL(value).host))
    this.publicMode = this.origins.size > 0
    this.trustProxy = trustProxy
    this.now = now
    this.visitors = new Map()
    this.ips = new Map()
    this.local = { id: 'local', csrf: randomBytes(24).toString('hex'), rates: new Map() }
  }
  prune() {
    const now = this.now()
    for (const [id, value] of this.visitors) if (value.expires < now) this.visitors.delete(id)
    for (const [ip, value] of this.ips) if (value.until < now) this.ips.delete(ip)
  }
  consume(visitor, key, limit, windowMs) {
    if (!this.publicMode) return
    const now = this.now(),
      previous = visitor.rates.get(key)
    if (!previous || previous.until < now) {
      visitor.rates.set(key, { count: 1, until: now + windowMs })
      return
    }
    if (previous.count >= limit) throw denied('请求较频繁，请稍后重试。', 429)
    previous.count++
  }
  authorize(req, res, { config = false, health = false } = {}) {
    const host = req.headers.host || ''
    if (
      this.publicMode
        ? !this.hosts.has(host) && !(health && localHost.test(host))
        : !localHost.test(host)
    )
      throw denied('请求域名不匹配。')
    if (
      req.headers.origin &&
      (this.publicMode
        ? !this.origins.has(req.headers.origin)
        : req.headers.origin !== `http://${host}`)
    )
      throw denied('请求来源不匹配。')
    if (health) return this.local
    let visitor = this.local
    if (this.publicMode) {
      const id = String(req.headers.cookie || '')
        .split(';')
        .map((x) => x.trim())
        .find((x) => x.startsWith(cookieName + '='))
        ?.slice(cookieName.length + 1)
      visitor = id && /^[a-f0-9]{48}$/.test(id) ? this.visitors.get(id) : null
      if (visitor?.expires < this.now()) visitor = null
      if (config) {
        const ip = this.trustProxy
          ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
              .split(',')
              .at(-1)
              .trim()
          : req.socket.remoteAddress || ''
        let budget = this.ips.get(ip)
        if (!budget || budget.until < this.now()) {
          if (this.ips.size >= 4096) this.prune()
          if (this.ips.size >= 4096) throw denied('当前访问较多，请稍后重试。', 429)
          budget = { count: 0, until: this.now() + 600000 }
          this.ips.set(ip, budget)
        }
        if (++budget.count > 60) throw denied('请求较频繁，请稍后重试。', 429)
        if (!visitor) {
          this.prune()
          if (this.visitors.size >= 256) throw denied('当前访问较多，请稍后重试。', 429)
          visitor = {
            id: randomBytes(24).toString('hex'),
            csrf: randomBytes(24).toString('hex'),
            expires: this.now() + 7200000,
            rates: new Map(),
          }
          this.visitors.set(visitor.id, visitor)
          res.setHeader(
            'Set-Cookie',
            `${cookieName}=${visitor.id}; Path=/; Max-Age=7200; Secure; HttpOnly; SameSite=Strict`,
          )
        }
      }
      if (!visitor) throw denied('页面会话已过期，请刷新页面后重试。', 401)
      this.consume(visitor, 'all', 300, 60000)
    }
    if (req.method === 'POST' && req.headers['x-downloader-token'] !== visitor.csrf)
      throw denied('页面已过期，请刷新后重试。')
    return visitor
  }
}
