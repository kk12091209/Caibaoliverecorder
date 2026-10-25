import http from 'node:http'
import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { createDownloaderApi } from '../server/downloader/api.mjs'

const publicOrigin = process.env.DOWNLOADER_PUBLIC_ORIGIN
if (!publicOrigin) throw new Error('DOWNLOADER_PUBLIC_ORIGIN is required for the public server.')
const tempDir = process.env.DOWNLOADER_TEMP_DIR
if (tempDir) {
  await mkdir(tempDir, { recursive: true, mode: 0o700 })
  // The production volume belongs exclusively to this single service. A crash
  // loses its in-memory sessions, so old process caches can no longer be served.
  for (const entry of await readdir(tempDir, { withFileTypes: true }))
    if (entry.isDirectory() && /^caibao-downloader-[\w-]+$/.test(entry.name))
      await rm(path.join(tempDir, entry.name), { recursive: true, force: true })
}
const api = createDownloaderApi({
  publicOrigins: [publicOrigin],
  galleryMode: 'images',
  trustProxy: process.env.DOWNLOADER_TRUST_PROXY === 'true',
  jobOptions: {
    ...(tempDir ? { tempDir } : {}),
    fileServer: process.env.DOWNLOADER_FILE_SERVER === 'true',
  },
})
const server = http.createServer((req, res) => {
  void api.handler(req, res, () => {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"error":"not found"}')
  })
})
server.requestTimeout = 120000
server.headersTimeout = 15000
server.keepAliveTimeout = 5000
server.maxRequestsPerSocket = 500
const host = process.env.DOWNLOADER_HOST || '127.0.0.1',
  port = Number(process.env.DOWNLOADER_PORT) || 8790
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, host, resolve)
})
console.log(`Download service ready on ${host}:${port}`)
let closing = false
const close = async () => {
  if (closing) return
  closing = true
  api.beginDrain()
  const disconnected = new Promise((resolve) => server.close(resolve))
  server.closeIdleConnections()
  let timer
  try {
    await Promise.race([
      Promise.all([disconnected, api.idle()]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 15000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  server.closeAllConnections()
  await api.close()
  process.exit(0)
}
process.on('SIGINT', close)
process.on('SIGTERM', close)
