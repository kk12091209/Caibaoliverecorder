import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Input, BlobSource, ALL_FORMATS, EncodedPacketSink } from 'mediabunny'
import { unzipSync } from 'fflate'
import { extractRecordingTrack, zipRecordings } from '../../src/features/teleprompter/model/recording-export.ts'

async function inspect(blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const report = []
    for (const track of await input.getTracks()) {
      const hashes = []
      for await (const packet of new EncodedPacketSink(track).packets()) hashes.push(createHash('sha256').update(packet.data).digest('hex'))
      report.push({ kind: track.type, codec: await track.getCodec(), hashes })
    }
    return report
  } finally { input.dispose() }
}
for (const format of ['mp4', 'webm']) test(`${format}: independent video/audio retain every encoded packet, ZIP contains the exact files`, async () => {
  const original = new Blob([await readFile(new URL(`../fixtures/recording-test.${format}`, import.meta.url))], { type: `video/${format}` })
  const before = await inspect(original)
  const video = await extractRecordingTrack(original, 'video')
  const audio = await extractRecordingTrack(original, 'audio')
  const separatedVideo = await inspect(video.blob)
  const separatedAudio = await inspect(audio.blob)
  assert.equal(separatedVideo.length, 1)
  assert.equal(separatedAudio.length, 1)
  assert.deepEqual(separatedVideo, before.filter((track) => track.kind === 'video'))
  assert.deepEqual(separatedAudio, before.filter((track) => track.kind === 'audio'))
  assert.equal(video.extension, format)
  assert.equal(audio.extension, format === 'mp4' ? 'm4a' : 'webm')
  const zip = await zipRecordings([{ name: `视频.${video.extension}`, blob: video.blob }, { name: `音频.${audio.extension}`, blob: audio.blob }])
  const files = unzipSync(new Uint8Array(await zip.arrayBuffer()))
  assert.deepEqual(new Uint8Array(await video.blob.arrayBuffer()), files[`视频.${video.extension}`])
  assert.deepEqual(new Uint8Array(await audio.blob.arrayBuffer()), files[`音频.${audio.extension}`])
  await assert.rejects(extractRecordingTrack(video.blob, 'audio'), /没有音频/)
})
test('cancelled exports and malformed input never produce a misleading empty download', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(extractRecordingTrack(new Blob(['broken']), 'video', controller.signal), { name: 'AbortError' })
  await assert.rejects(zipRecordings([{ name: 'a', blob: new Blob(['a']) }], controller.signal), { name: 'AbortError' })
  await assert.rejects(extractRecordingTrack(new Blob(['not media']), 'audio'))
})
