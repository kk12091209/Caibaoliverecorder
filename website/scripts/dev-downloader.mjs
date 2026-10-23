import { createServer } from 'vite'
import { createDownloaderApi } from '../server/downloader/api.mjs'

const api = createDownloaderApi()
const server = await createServer({
  server: {
    host: '127.0.0.1',
    port: Number(process.env.DOWNLOADER_PORT) || 17970,
    strictPort: true,
  },
  plugins: [
    {
      name: 'caibao-local-downloader',
      configureServer(vite) {
        vite.middlewares.use(api.handler)
      },
    },
  ],
})
await server.listen()
console.log(`菜包下载助手：http://127.0.0.1:${server.config.server.port}/tools/downloader`)
let closing = false
const close = async () => {
  if (closing) return
  closing = true
  await server.close()
  await api.close()
  process.exit(0)
}
process.on('SIGINT', close)
process.on('SIGTERM', close)
