import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { DownloadJobs } from '../../server/downloader/jobs/manager.mjs'
import { DownloadAccess } from '../../server/downloader/http/access.mjs'

test('completed files expire after idle time, with active reads protected and renewed after release', async () => {
  let now = 1000
  const jobs = new DownloadJobs(
    {},
    {
      now: () => now,
      keepMs: 100,
      images: {
        download: async (_urls, { onProgress }) => {
          onProgress(3, 3)
          return { data: Buffer.from('jpg'), extension: 'jpg', type: 'image/jpeg' }
        },
      },
    },
  )
  const session = {
    owner: 'owner',
    result: {
      kind: 'images',
      title: 'image',
      assets: [{ index: 1, type: 'image', urls: ['image'] }],
    },
  }
  try {
    const created = jobs.create(session, [1], 'album'),
      job = jobs.jobs.get(created.id)
    await jobs.wait(job)
    assert.equal(job.status, 'done', job.error)
    const release = jobs.retain(job)
    now += 1000
    await jobs.prune()
    assert.equal((await readFile(job.files[0].path)).toString(), 'jpg')
    release()
    release()
    assert.equal(job.readers, 0)
    now += 90
    await jobs.prune()
    assert.ok(jobs.jobs.has(job.id))
    jobs.touch(job)
    now += 90
    await jobs.prune()
    assert.ok(jobs.jobs.has(job.id))
    now += 11
    await jobs.prune()
    assert.equal(jobs.jobs.has(job.id), false)
    await assert.rejects(readFile(job.files[0].path), { code: 'ENOENT' })
  } finally {
    await jobs.close()
  }
})

test('active visits renew their original identity and idle visits still expire', () => {
  let now = 1000
  const access = new DownloadAccess({ publicOrigins: ['https://caibao.media'], now: () => now })
  const request = {
    method: 'GET',
    headers: { host: 'caibao.media' },
    socket: { remoteAddress: '203.0.113.1' },
  }
  const headers = {},
    response = {
      setHeader: (key, value) => {
        headers[key] = value
      },
    }
  const visitor = access.authorize(request, response, { config: true })
  request.headers.cookie = headers['Set-Cookie'].split(';')[0]
  const id = visitor.id,
    csrf = visitor.csrf
  access.touch(visitor, response)
  for (let i = 0; i < 4; i++) {
    now += 100 * 60000
    const renewed = access.authorize(request, response)
    access.touch(renewed, response)
    assert.equal(renewed.id, id)
    assert.equal(renewed.csrf, csrf)
    assert.ok(renewed.expires > now)
  }
  request.method = 'POST'
  request.headers['x-downloader-token'] = 'wrong'
  const expires = visitor.expires
  assert.throws(
    () => access.authorize(request, response),
    (error) => error.status === 403,
  )
  assert.equal(visitor.expires, expires)
  now += 7200001
  access.prune()
  assert.throws(
    () => access.authorize(request, response),
    (error) => error.status === 401,
  )
})
