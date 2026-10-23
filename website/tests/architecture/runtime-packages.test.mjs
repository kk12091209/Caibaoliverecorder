import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { runtimePackages } from '../../scripts/runtime-packages.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const json = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'))
const manifest = json('package.json')
const lock = json('package-lock.json')

for (const [service, expected] of Object.entries(runtimePackages)) {
  test(`${service} installs only its runtime dependencies with the main lock's versions`, () => {
    const base = `deploy/services/${service}/`
    const profile = json(base + 'package.json')
    const profileLock = json(base + 'package-lock.json')
    assert.deepEqual(profile.dependencies, Object.fromEntries(expected.map(name => [name, manifest.dependencies[name]])))
    assert.equal(profile.devDependencies, undefined)
    assert.deepEqual(profileLock.packages[''].dependencies, profile.dependencies)
    for (const [name, entry] of Object.entries(profileLock.packages)) {
      if (!name) continue
      assert.ok(lock.packages[name], `unknown runtime package: ${name}`)
      for (const field of ['version', 'resolved', 'integrity'])
        assert.equal(entry[field], lock.packages[name][field], `${name} ${field} differs; run npm run runtime:sync`)
      assert.ok(!entry.dev, `development-only package: ${name}`)
    }
    for (const browserPackage of ['react', 'react-dom', 'three', 'mediabunny', 'vite', 'typescript'])
      assert.equal(profileLock.packages[`node_modules/${browserPackage}`], undefined)

    const visited = new Set(), importedPackages = new Set()
    function visit(file) {
      if (visited.has(file)) return
      visited.add(file)
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      function node(item) {
        const specifier = (ts.isImportDeclaration(item) || ts.isExportDeclaration(item)) ? item.moduleSpecifier
          : ts.isCallExpression(item) && item.expression.kind === ts.SyntaxKind.ImportKeyword ? item.arguments[0] : null
        if (specifier && ts.isStringLiteral(specifier)) {
          const value = specifier.text
          if (value.startsWith('.')) visit(path.resolve(path.dirname(file), value))
          else if (!value.startsWith('node:')) importedPackages.add(value.startsWith('@') ? value.split('/').slice(0, 2).join('/') : value.split('/')[0])
        }
        ts.forEachChild(item, node)
      }
      node(source)
    }
    visit(path.join(root, `scripts/${service === 'sync' ? 'sync-releases' : 'serve-downloader'}.mjs`))
    assert.deepEqual([...importedPackages].sort(), [...expected].sort(), 'runtime imports and deployment profile must agree')
  })
}
