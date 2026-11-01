import { readFile, writeFile } from 'node:fs/promises'
import { createSharedAutoSender } from './lib/auto-sender.mjs'

export const senderBlock = `// BEGIN SHARED AUTO SENDER\n${createSharedAutoSender.toString()}\n// END SHARED AUTO SENDER`
const paths = ['bili-comment-blindbox.user.js', 'caibao-live-translator.user.js']
for (const file of paths) {
  const url = new URL('../public/plugins/' + file, import.meta.url)
  const source = await readFile(url, 'utf8')
  const block = /\/\/ BEGIN SHARED AUTO SENDER[\s\S]*?\/\/ END SHARED AUTO SENDER/
  const next = block.test(source)
    ? source.replace(block, () => senderBlock)
    : source.replace(/["']use strict["'];/, (match) => match + '\n' + senderBlock)
  if (!next.includes(senderBlock)) throw new Error('Userscript insertion boundary changed: ' + file)
  if (process.argv.includes('--check')) {
    if (next !== source) throw new Error('Shared sender copy is stale: ' + file)
  } else if (next !== source) await writeFile(url, next)
}
