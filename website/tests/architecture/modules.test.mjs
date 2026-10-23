import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../', import.meta.url))
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(directory, entry.name)
  return entry.isDirectory() ? walk(file) : /\.(tsx?|mjs)$/.test(file) ? [file] : []
})
const relative = file => path.relative(root, file).split(path.sep).join('/')

test('browser features stay independent and never import backend or release operations', () => {
  const problems = []
  for (const file of walk(path.join(root, 'src'))) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const owner = relative(file).match(/^src\/features\/([^/]+)\//)?.[1]
    function visit(node) {
      const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0] : null
      if (specifier && ts.isStringLiteral(specifier)) {
        const value = specifier.text
        if (value.startsWith('node:')) problems.push(`${relative(file)} imports ${value}`)
        if (value.startsWith('.')) {
          const target = relative(path.resolve(path.dirname(file), value))
          const feature = target.match(/^src\/features\/([^/]+)\//)?.[1]
          if (!target.startsWith('src/') || (owner && feature && owner !== feature)
              || (relative(file).startsWith('src/shared/') && feature)) {
            problems.push(`${relative(file)} -> ${target}`)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('only the recorder is registered for binary release synchronization', () => {
  const config = JSON.parse(readFileSync(path.join(root, 'deploy/products.json'), 'utf8'))
  assert.deepEqual(config.products.map(product => product.slug), ['caibo-recorder'])
  assert.equal(config.products[0].repository, 'kk12091209/Caibaoliverecorder')
})
