import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { hasProgressiveMp4Layout, reusableMp4 } from '../../server/downloader/media/mp4-reuse.mjs'
import { runMedia } from '../../server/downloader/media/process.mjs'
import { mediaTool } from '../../server/downloader/media/tools.mjs'
import { DownloadJobs } from '../../server/downloader/jobs/manager.mjs'

test('a complete progressive H264/AAC MP4 keeps its exact bytes while late-index files retain remuxing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'caibao-mp4-reuse-'))
  const source = path.join(root, 'original.mp4'),
    late = path.join(root, 'late.mp4')
  let jobs
  try {
    await runMedia(await mediaTool('ffmpeg'), [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=320x240:r=30',
      '-f',
      'lavfi',
      '-i',
      'sine=f=440:r=48000',
      '-t',
      '1.2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      source,
    ])
    assert.equal(await hasProgressiveMp4Layout(source), true)
    const info = await reusableMp4(source)
    assert.equal(info.width, 320)
    assert.equal(info.height, 240)
    assert.equal(info.hasAudio, true)
    await runMedia(await mediaTool('ffmpeg'), ['-v', 'error', '-i', source, '-c', 'copy', late])
    assert.equal(await hasProgressiveMp4Layout(late), false)
    assert.equal(await reusableMp4(late), null)
    jobs = new DownloadJobs(
      {},
      {
        saveMedia: async (_urls, target, { onProgress }) => {
          const data = await readFile(source)
          await copyFile(source, target)
          onProgress(data.length, data.length)
        },
      },
    )
    const result = {
      platform: 'douyin',
      kind: 'video',
      title: 'sample',
      assets: [{ index: 1, type: 'video', urls: ['test'] }],
    }
    const created = jobs.create({ owner: 'owner', result }, [1]),
      job = jobs.jobs.get(created.id)
    await jobs.wait(job)
    assert.equal(job.status, 'done', job.error)
    assert.equal(job.originalMp4, 1)
    assert.deepEqual(await readFile(job.files[0].path), await readFile(source))
    assert.equal(job.timings.snapshot().stages.mux, undefined)
    const bytes = await readFile(source)
    await writeFile(path.join(root, 'truncated'), bytes.subarray(0, bytes.length - 9))
    assert.equal(await hasProgressiveMp4Layout(path.join(root, 'truncated')), false)
    await writeFile(path.join(root, 'fake'), Buffer.from('not an mp4'))
    assert.equal(await reusableMp4(path.join(root, 'fake')), null)
  } finally {
    await jobs?.close()
    await rm(root, { recursive: true, force: true })
  }
})
