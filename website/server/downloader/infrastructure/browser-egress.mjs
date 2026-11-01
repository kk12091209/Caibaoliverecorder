import http from 'node:http'
import net from 'node:net'
import { lookup } from 'node:dns/promises'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { approvedUrl, permittedAddress } from './network.mjs'

export async function browserDestination(authority, resolve = lookup) {
  if (typeof authority !== 'string' || !/^[a-zA-Z0-9.-]+:443$/.test(authority))
    throw new Error('Browser destination rejected')
  const url = approvedUrl('https://' + authority)
  const addresses = await resolve(url.hostname, { all: true, verbatim: true })
  if (
    !addresses.length ||
    addresses.some(
      ({ address, family }) => net.isIP(address) !== family || !permittedAddress(address, family),
    )
  )
    throw new Error('Browser destination rejected')
  return { host: addresses[0].address, family: addresses[0].family, port: 443 }
}

// HTTPS remains end-to-end. CONNECT sockets are dialed to a checked literal
// address, so Chromium cannot repeat DNS lookup after validation or bypass it
// with a subresource, worker, WebSocket, or redirect.
export async function createBrowserEgress({ resolve = lookup, connect = net.connect } = {}) {
  const username = 'caibao',
    password = randomBytes(32).toString('hex')
  const expected = Buffer.from('Basic ' + Buffer.from(username + ':' + password).toString('base64'))
  const sockets = new Set()
  let pending = 0,
    closed = false
  const deny = (socket, status = 403) => {
    socket.end(
      `HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n${status === 407 ? 'Proxy-Authenticate: Basic realm="Caibao"\r\n' : ''}\r\n`,
    )
  }
  const server = http.createServer(
    { maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 10000 },
    (req, res) => {
      res.writeHead(403, { Connection: 'close' })
      res.end()
    },
  )
  server.maxConnections = 64
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    socket.setTimeout(30000, () => socket.destroy())
  })
  server.on('connect', async (req, client, head) => {
    const credential = Buffer.from(req.headers['proxy-authorization'] || '')
    if (credential.length !== expected.length || !timingSafeEqual(credential, expected))
      return deny(client, 407)
    if (closed || pending >= 32) return deny(client, 503)
    pending++
    let upstream, deadline
    try {
      const destination = await Promise.race([
        browserDestination(req.url, resolve),
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(Error('DNS deadline')), 8000)
        }),
      ])
      clearTimeout(deadline)
      if (closed || client.destroyed) return
      upstream = connect(destination)
      sockets.add(upstream)
      upstream.on('error', () => client.destroy())
      upstream.once('close', () => {
        sockets.delete(upstream)
        client.destroy()
      })
      client.once('close', () => upstream.destroy())
      upstream.setTimeout(30000, () => upstream.destroy())
      upstream.once('connect', () => {
        if (closed || client.destroyed) return upstream.destroy()
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream).pipe(client)
      })
    } catch {
      if (!client.destroyed) deny(client)
    } finally {
      clearTimeout(deadline)
      pending--
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    proxy: { server: 'http://127.0.0.1:' + server.address().port, username, password },
    async close() {
      closed = true
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
