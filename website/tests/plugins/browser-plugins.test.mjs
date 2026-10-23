import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { browserPlugins } from '../../src/shared/data/browser-plugins.ts'

test('each listed plugin copies its complete local source with matching name, version and original homepage', () => {
  assert.ok(browserPlugins.length > 0)
  assert.equal(new Set(browserPlugins.map(plugin => plugin.slug)).size, browserPlugins.length)
  for (const plugin of browserPlugins) {
    assert.match(plugin.source, /^\/plugins\/[a-z0-9-]+\.user\.js$/)
    const homepage = new URL(plugin.homepage)
    assert.equal(homepage.protocol, 'https:')
    assert.equal(homepage.username + homepage.password, '')
    const code = readFileSync(new URL('../../public' + plugin.source, import.meta.url), 'utf8')
    assert.ok(code.startsWith('// ==UserScript==\n'))
    const metadata = key => code.match(new RegExp('^// @' + key + '\\s+(.+)$', 'm'))?.[1].trim()
    assert.equal(metadata('name'), plugin.name)
    assert.equal(metadata('version'), plugin.version)
    assert.equal(metadata('homepageURL'), plugin.homepage)
    assert.ok(code.includes('// ==/UserScript=='))
    assert.ok(code.trimEnd().endsWith('})();'))
  }
})
