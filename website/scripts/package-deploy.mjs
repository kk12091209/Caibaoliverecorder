import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = join(root, 'artifacts')
await mkdir(out, { recursive: true })
const name = `caibao-web-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`
execFileSync(
  'tar',
  [
    '--no-xattrs',
    '--exclude=.DS_Store',
    '--exclude=.env',
    '--exclude=.env.*',
    '--exclude=*.pem',
    '--exclude=*.key',
    '--exclude=.parcel-private',
    '-czf',
    join(out, name),
    'dist',
    'server',
    'scripts',
    'deploy',
    'package.json',
    'package-lock.json',
    '.dockerignore',
    'DEPLOYMENT.md',
    'DOWNLOADER.md',
    'THIRD_PARTY_NOTICES.md',
    'LICENSE',
    'README.md',
    'docs',
  ],
  { cwd: root, stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } },
)
console.log(join(out, name))
