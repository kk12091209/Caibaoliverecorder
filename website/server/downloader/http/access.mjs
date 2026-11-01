import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'

const localHost = /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/
const UNUSED_TTL = 120000
const ACTIVE_TTL = 7200000
// A source is an admission budget, never an ownership check. Normalize aliases
// and group IPv6 /64 addresses so rotating an interface ID cannot buy more slots.
function sourceKey(address) {
  if (typeof address !== 'string' || address.length > 128) return 'unknown'
  if (isIP(address) === 4) return address
  if (isIP(address) !== 6) return 'unknown'
  try {
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1)
    const halves = normalized.split('::'),
      left = halves[0] ? halves[0].split(':') : []
    const right = halves[1] ? halves[1].split(':') : []
    const groups =
      halves.length === 2
        ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
        : left
    const words = groups.map((word) => parseInt(word, 16))
    if (words.slice(0, 5).every((n) => n === 0) && words[5] === 65535)
      return [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.')
    return (
      words
        .slice(0, 4)
        .map((n) => n.toString(16))
        .join(':') + '::/64'
    )
  } catch {
    return 'unknown'
  }
}
function denied(message, status = 403) {
  return Object.assign(new Error(message), { status })
}
export class DownloadAccess {
  constructor({
    publicOrigins = [],
    trustProxy = false,
    now = Date.now,
    cookieName = '__Host-caibao-download',
    retained = () => false,
  } = {}) {
    if (!/^__Host-[A-Za-z0-9_-]+$/.test(cookieName)) throw new Error('下载会话 Cookie 名称无效。')
    this.cookieName = cookieName
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
    this.retained = retained
    this.visitors = new Map()
    this.ips = new Map()
    this.local = { id: 'local', csrf: randomBytes(24).toString('hex'), rates: new Map() }
  }
  prune() {
    const now = this.now()
    for (const [id, value] of this.visitors)
      if (value.expires <= now && !this.pinned(value)) this.visitors.delete(id)
    for (const [ip, value] of this.ips) if (value.until < now) this.ips.delete(ip)
  }
  pinned(visitor) {
    return visitor.readers > 0 || this.retained(visitor.id)
  }
  cookie(visitor, res) {
    if (res && !res.headersSent && !res.writableEnded) {
      res.setHeader(
        'Set-Cookie',
        `${this.cookieName}=${visitor.id}; Path=/; Max-Age=7200; Secure; HttpOnly; SameSite=Strict`,
      )
      visitor.cookieExpires = this.now() + ACTIVE_TTL
    }
  }
  touch(visitor, res) {
    if (!this.publicMode) return
    if (
      this.visitors.get(visitor.id) !== visitor ||
      (visitor.expires <= this.now() && !this.pinned(visitor))
    )
      throw denied('页面会话已过期，请刷新页面后重试。', 401)
    const refresh = !visitor.used || visitor.cookieExpires - this.now() < 1800000
    visitor.used = true
    visitor.expires = this.now() + ACTIVE_TTL
    if (refresh) this.cookie(visitor, res)
  }
  retain(visitor) {
    if (!this.publicMode) return () => {}
    if (
      this.visitors.get(visitor.id) !== visitor ||
      (visitor.expires <= this.now() && !this.pinned(visitor))
    )
      throw denied('页面会话已过期，请刷新页面后重试。', 401)
    visitor.readers++
    let released = false
    return (completedActivity = false) => {
      if (released) return
      released = true
      if (completedActivity) this.touch(visitor)
      visitor.readers--
    }
  }
  admit(source) {
    this.prune()
    const fromSource = [...this.visitors.values()].filter((visitor) => visitor.source === source)
    const recycle = (candidates) => {
      const unused = candidates.find((visitor) => !visitor.used && !this.pinned(visitor))
      if (unused) this.visitors.delete(unused.id)
      return !!unused
    }
    if (fromSource.length >= 32 && !recycle(fromSource))
      throw denied('当前网络的下载会话较多，请稍后重试。', 429)
    if (this.visitors.size >= 256 && !recycle([...this.visitors.values()]))
      throw denied('当前访问较多，请稍后重试。', 429)
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
        .find((x) => x.startsWith(this.cookieName + '='))
        ?.slice(this.cookieName.length + 1)
      visitor = id && /^[a-f0-9]{48}$/.test(id) ? this.visitors.get(id) : null
      if (visitor && visitor.expires <= this.now() && !this.pinned(visitor)) visitor = null
      if (config) {
        const ip = sourceKey(
          this.trustProxy
            ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
                .split(',')
                .at(-1)
                .trim()
            : req.socket.remoteAddress || '',
        )
        let budget = this.ips.get(ip)
        if (!budget || budget.until < this.now()) {
          if (this.ips.size >= 4096) this.prune()
          if (this.ips.size >= 4096) throw denied('当前访问较多，请稍后重试。', 429)
          budget = { count: 0, until: this.now() + 600000 }
          this.ips.set(ip, budget)
        }
        if (++budget.count > 60) throw denied('请求较频繁，请稍后重试。', 429)
        if (!visitor) {
          this.admit(ip)
          visitor = {
            id: randomBytes(24).toString('hex'),
            csrf: randomBytes(24).toString('hex'),
            expires: this.now() + UNUSED_TTL,
            source: ip,
            used: false,
            readers: 0,
            rates: new Map(),
          }
          this.visitors.set(visitor.id, visitor)
          this.cookie(visitor, res)
        }
      }
      if (!visitor) throw denied('页面会话已过期，请刷新页面后重试。', 401)
      this.consume(visitor, 'all', 300, 60000)
    }
    if (req.method === 'POST' && req.headers['x-downloader-token'] !== visitor.csrf)
      throw Object.assign(denied('页面已过期，请刷新后重试。'), { code: 'SESSION_TOKEN_MISMATCH' })
    // Authentication alone is not activity: unknown routes and /config must
    // not keep unused identities alive. Valid business routes renew explicitly.
    return visitor
  }
}
