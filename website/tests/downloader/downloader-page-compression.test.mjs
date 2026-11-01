import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib'
import { readRemoteText } from '../../server/downloader/infrastructure/remote-body.mjs'
import { xiaohongshuNote } from '../../server/downloader/platforms/xiaohongshu.mjs'

const id = '6abc8c7400000000020282ff'
const page =
  '<script>window.__INITIAL_STATE__=' +
  JSON.stringify({
    note: {
      noteDetailMap: {
        [id]: { note: { noteId: id, title: '完整笔记', imageList: [{ fileId: 'original' }] } },
      },
    },
  }) +
  '</script>'
const response = (data, encoding) => ({
  headers: encoding ? { 'content-encoding': encoding } : {},
  url: 'https://www.xiaohongshu.com/explore/' + id + '?xsec_token=never-log-this',
  stream: Readable.from([data.subarray(0, 3), data.subarray(3)]),
})

for (const [encoding, compress] of [
  ['identity', Buffer.from],
  ['gzip', gzipSync],
  ['deflate', deflateSync],
  ['br', brotliCompressSync],
])
  test(`compressed page ${encoding} preserves complete UTF-8 note data`, async () => {
    const upstream = response(compress(page), encoding)
    const decoded = await readRemoteText(upstream)
    assert.equal(decoded, page)
    assert.equal(xiaohongshuNote(decoded, id).title, '完整笔记')
    assert.equal(upstream.stream.destroyed, true)
  })
test('page limits apply to expanded compressed data and raw transferred bytes', async () => {
  const bomb = response(gzipSync('a'.repeat(1000000)), 'gzip')
  await assert.rejects(readRemoteText(bomb, { maxBytes: 4096 }), {
    code: 'UPSTREAM_TEXT_TOO_LARGE',
  })
  assert.equal(bomb.stream.destroyed, true)
  const raw = response(Buffer.alloc(5000))
  await assert.rejects(readRemoteText(raw, { maxBytes: 4096 }), { code: 'UPSTREAM_TEXT_TOO_LARGE' })
  assert.equal(raw.stream.destroyed, true)
  const padded = gzipSync('ok')
  const oversized = response(Buffer.concat([padded, Buffer.alloc(5000)]), 'gzip')
  await assert.rejects(readRemoteText(oversized, { maxBytes: 4096 }), {
    code: 'UPSTREAM_TEXT_TOO_LARGE',
  })
  assert.equal(oversized.stream.destroyed, true)
})
test('corrupt compression, unsupported formats and failed inputs close without exposing signed URLs', async () => {
  const corrupt = response(Buffer.from('invalid gzip'), 'gzip')
  await assert.rejects(readRemoteText(corrupt))
  assert.equal(corrupt.stream.destroyed, true)
  const unsupported = response(Buffer.from('data'), 'zstd')
  await assert.rejects(
    readRemoteText(unsupported),
    (e) => e.code === 'UPSTREAM_ENCODING' && !e.message.includes('never-log-this'),
  )
  assert.equal(unsupported.stream.destroyed, true)
  const upstream = response(Buffer.from(''))
  upstream.stream = Readable.from(
    (async function* () {
      yield Buffer.from('partial')
      throw new Error('disconnected')
    })(),
  )
  await assert.rejects(readRemoteText(upstream), /disconnected/)
  assert.equal(upstream.stream.destroyed, true)
})
