import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const catalog = await readFile(
  new URL('../src/shared/data/browser-plugins.ts', import.meta.url),
  'utf8',
)
for (const match of catalog.matchAll(
  /slug: '([^']+)'[\s\S]*?version: '([^']+)'[\s\S]*?source: '(\/plugins\/[^']+)'/g,
)) {
  const script = await readFile(new URL('../public' + match[3], import.meta.url), 'utf8')
  assert.equal(
    script.match(/^\/\/ @version\s+(\S+)/m)?.[1],
    match[2],
    `${match[1]} catalog and userscript versions differ`,
  )
}
const main = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
const service = JSON.parse(
  await readFile(new URL('../deploy/services/downloader/package.json', import.meta.url)),
)
for (const [name, version] of Object.entries(service.dependencies))
  assert.equal(
    main.dependencies[name],
    version,
    `${name} public and service runtime versions differ`,
  )
console.log('Product catalog, userscripts and downloader runtime versions agree')
