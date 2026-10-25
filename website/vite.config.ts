import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  server: {
    port: 5173,
    host: '127.0.0.1',
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.parcel-private/**'] },
  },
})
