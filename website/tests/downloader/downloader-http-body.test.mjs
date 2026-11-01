import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { remoteBody } from '../../server/downloader/infrastructure/remote-body.mjs'

test('real HTTP bodies distinguish downstream pauses, genuine stalls and peer resets', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 512 * 1024 })
    res.flushHeaders()
    if (req.url === '/stall') {
      res.write(Buffer.alloc(8192))
      return
    }
    if (req.url === '/reset') {
      res.write(Buffer.alloc(8192))
      setTimeout(() => res.destroy(), 15)
      return
    }
    void (async () => {
      for (let i = 0; i < 64 && !res.destroyed; i++) {
        res.write(Buffer.alloc(8192, i))
        await delay(2)
      }
      res.end()
    })()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const read = async (path) => {
    const response = await new Promise((resolve, reject) =>
      http.get(`http://127.0.0.1:${server.address().port}${path}`, resolve).once('error', reject),
    )
    return remoteBody(response, { timeout: 60, url: 'https://a.bilivideo.com/media?signed=hidden' })
  }
  try {
    let bytes = 0
    await pipeline(
      await read('/slow'),
      new Writable({
        highWaterMark: 1,
        write(chunk, _encoding, done) {
          bytes += chunk.length
          setTimeout(done, 120)
        },
      }),
    )
    assert.equal(bytes, 512 * 1024)
    const consume = async (body) => {
      for await (const _chunk of body) {
        /* read to error */
      }
    }
    await assert.rejects(
      consume(await read('/stall')),
      (error) => error.code === 'UPSTREAM_BODY_TIMEOUT' && !error.message.includes('aborted'),
    )
    await assert.rejects(
      consume(await read('/reset')),
      (error) => error.code === 'ECONNRESET' && error.sourceHost === 'a.bilivideo.com',
    )
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
