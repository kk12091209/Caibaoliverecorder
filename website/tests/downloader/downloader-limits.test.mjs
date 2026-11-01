import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, copyFile, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DownloadJobs } from '../../server/downloader/jobs/manager.mjs'
import { mediaTool } from '../../server/downloader/media/tools.mjs'
import {
  PUBLIC_DOWNLOAD_BYTES,
  PUBLIC_STORAGE_BYTES,
  MIN_FREE_DISK_BYTES,
} from '../../server/downloader/infrastructure/limits.mjs'

const GiB = 1024 ** 3
const ampleDisk = async () => ({ bavail: 32 * GiB, bsize: 1 })
const session = {
  owner: 'limit-test',
  result: {
    platform: 'douyin',
    kind: 'video',
    id: '123',
    title: '限额测试',
    author: '作者',
    url: 'https://www.douyin.com/video/123',
    assets: [1, 2].map((index) => ({
      index,
      type: 'video',
      urls: ['fixture'],
      width: 160,
      height: 90,
    })),
  },
}
const completed = async (jobs, created) => {
  let timer
  try {
    return await Promise.race([
      jobs.jobs.get(created.id).finished,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('job did not settle')), 4000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('public limits allow 4 GiB and their conservative reservation fits the shared cache', async () => {
  const jobs = new DownloadJobs({}, { publicMode: true, diskSpace: ampleDisk })
  try {
    assert.equal(jobs.maxFileBytes, 4 * GiB)
    assert.equal(jobs.maxJobBytes, PUBLIC_DOWNLOAD_BYTES)
    assert.equal(jobs.maxStorageBytes, PUBLIC_STORAGE_BYTES)
    jobs.jobs.set('running', { status: 'running', bytes: 4 * GiB })
    assert.equal(jobs.storageUsage(), 12 * GiB)
    await assert.doesNotReject(jobs.ensureCapacity())
  } finally {
    jobs.jobs.clear()
    await jobs.close()
  }
})

test('space exhaustion has a clear retry message; local mode does not query server disk', async () => {
  const jobs = new DownloadJobs(
    {},
    { publicMode: true, diskSpace: async () => ({ bavail: MIN_FREE_DISK_BYTES - 1, bsize: 1 }) },
  )
  try {
    await assert.rejects(
      jobs.ensureCapacity(),
      (error) =>
        error.code === 'DOWNLOAD_SPACE_LOW' && /服务器.*空间不足.*稍后重试/.test(error.message),
    )
  } finally {
    await jobs.close()
  }
  const local = new DownloadJobs(
    {},
    { diskSpace: async () => assert.fail('local mode must not query server disk') },
  )
  try {
    await assert.doesNotReject(local.ensureCapacity())
    assert.equal(local.maxFileBytes, 8 * GiB)
  } finally {
    await local.close()
  }
})

test('4 GiB boundary and aggregate limits are enforced without allocating multi-gigabyte fixtures', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'downloader-limits-')),
    fixture = path.join(root, 'small.mp4')
  try {
    execFileSync(await mediaTool('ffmpeg'), [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=30',
      '-t',
      '0.2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-movflags',
      '+faststart',
      fixture,
    ])
    for (const [sizes, indices, expected] of [
      [[4 * GiB], [1], 'done'],
      [[4 * GiB + 1], [1], 'failed'],
      [[2.5 * GiB, 2 * GiB], [1, 2], 'failed'],
    ]) {
      let next = 0
      const jobs = new DownloadJobs(
        {},
        {
          publicMode: true,
          diskSpace: ampleDisk,
          saveMedia: async (_urls, target, { maxBytes, onProgress }) => {
            assert.equal(maxBytes, 4 * GiB)
            const bytes = sizes[next++]
            onProgress(bytes, bytes)
            await copyFile(fixture, target)
            return { bytes, type: 'video/mp4' }
          },
        },
      )
      try {
        const job = await completed(jobs, jobs.create(session, indices))
        assert.equal(job.status, expected)
        if (expected === 'failed') {
          assert.match(job.error, /大小限制（4 GB）/)
          assert.deepEqual(await readdir(await jobs.root), [])
        }
      } finally {
        await jobs.close()
      }
    }
    const fileBytes = (await stat(fixture)).size
    const archiveJobs = new DownloadJobs(
      {},
      {
        publicMode: true,
        diskSpace: ampleDisk,
        maxJobBytes: 2 * fileBytes,
        saveMedia: async (_urls, target, { onProgress }) => {
          onProgress(fileBytes, fileBytes)
          await copyFile(fixture, target)
          return { bytes: fileBytes, type: 'video/mp4' }
        },
      },
    )
    try {
      const job = await completed(archiveJobs, archiveJobs.create(session, [1, 2]))
      assert.equal(job.status, 'failed')
      assert.match(job.error, /打包文件.*大小限制/)
      assert.equal(job.archive, null)
    } finally {
      await archiveJobs.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('disk filling during a transfer aborts its producer and cleans the incomplete download', async () => {
  let checks = 0,
    producerStopped = false
  const jobs = new DownloadJobs(
    {},
    {
      publicMode: true,
      diskCheckMs: 5,
      diskSpace: async () => ({
        bavail: checks++ === 0 ? 32 * GiB : MIN_FREE_DISK_BYTES - 1,
        bsize: 1,
      }),
      saveMedia: async (_urls, _target, { signal, onProgress }) => {
        onProgress(1024, 10000)
        await new Promise((resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              producerStopped = true
              reject(signal.reason)
            },
            { once: true },
          ),
        )
      },
    },
  )
  try {
    const job = await completed(jobs, jobs.create(session, [1]))
    assert.equal(job.status, 'failed')
    assert.equal(producerStopped, true)
    assert.match(job.error, /服务器.*空间不足.*稍后重试/)
    assert.deepEqual(await readdir(await jobs.root), [])
  } finally {
    await jobs.close()
  }
})
