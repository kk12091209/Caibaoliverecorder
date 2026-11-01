import test from 'node:test'
import assert from 'node:assert/strict'
import { observeDownload, downloadAddress } from '../../public/downloader-range-transfer.mjs'

test('attachment completion follows actual body EOF, not response headers or a timer', async () => {
  let feed, completed = 0
  const response = observeDownload(new Response(new ReadableStream({ start(c) { feed = c } }), { headers: { 'content-disposition': 'attachment; filename="a.mp4"' } }), () => completed++)
  const reader = response.body.getReader()
  assert.equal(completed, 0)
  const first = reader.read(); feed.enqueue(new Uint8Array([1, 2])); await first
  assert.equal(completed, 0)
  feed.close(); assert.equal((await reader.read()).done, true)
  assert.equal(completed, 1)
  assert.match(response.headers.get('content-disposition'), /attachment/)
})
test('cancellation and failed streams finish once and cancel the underlying body', async () => {
  let cancelled = 0, completed = 0
  const response = observeDownload(new Response(new ReadableStream({ cancel() { cancelled++ } })), () => completed++)
  await response.body.cancel(); assert.equal(cancelled, 1); assert.equal(completed, 1)
  const broken = observeDownload(new Response(new ReadableStream({ pull(c) { c.error(new Error('fixture failure')) } })), () => completed++)
  await assert.rejects(broken.arrayBuffer(), /fixture failure/); assert.equal(completed, 2)
})
test('worker transfer IDs never reach upstream download URLs', () => {
  const origin='https://caibao.media'
  const address=downloadAddress(`${origin}/api/downloader/jobs/${'a'.repeat(36)}/download?parallel=2&transfer=test`,origin)
  assert.equal(new URL(address.url).search,'')
})
