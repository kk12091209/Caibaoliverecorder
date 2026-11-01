import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createDownloaderApi } from '../../server/downloader/api.mjs'
import { mediaTool } from '../../server/downloader/media/tools.mjs'

const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
let dir, samples, ffprobe
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'caibao-parts-test-'))
  ffprobe = await mediaTool('ffprobe')
  const ffmpeg = await mediaTool('ffmpeg')
  samples = await Promise.all(
    [1, 2].map(async (index) => {
      const file = path.join(dir, `${index}.mp4`)
      execFileSync(ffmpeg, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=${index === 1 ? 'red' : 'blue'}:size=160x90:rate=25`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${index * 440}`,
        '-t',
        '0.6',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-c:a',
        'aac',
        file,
      ])
      return readFile(file)
    }),
  )
})
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function fixture({ failSecond = false, dash = false, selected = [1, 2] } = {}) {
  const indices = Array.from({ length: Math.max(...selected) }, (_, i) => i + 1)
  const gates = indices.map(() => deferred())
  const tails = indices.map(() => deferred())
  let dashData,
    rangeFailures = 0
  if (dash) {
    const sample = path.join(dir, 'dash.mp4'),
      ffmpeg = await mediaTool('ffmpeg')
    execFileSync(ffmpeg, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=25',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440',
      '-t',
      '12',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-g',
      '25',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      sample,
    ])
    dashData = await readFile(sample)
  }
  const resolver = {
    resolve: async () => ({
      platform: 'bilibili',
      kind: 'video',
      id: 'BVparts',
      title: '分 P 视频',
      url: 'https://www.bilibili.com/video/BVparts/',
      assets: indices.map((index) => ({ index, title: `片段 ${index}`, type: 'video' })),
    }),
    bilibiliStreams: async (_result, asset) => {
      await gates[asset.index - 1].promise
      if (asset.index === selected[1] && failSecond) throw new Error('第二个分 P 不可用')
      if (dash)
        return {
          video: [`${asset.index}v`],
          audio: [`${asset.index}a`],
          quality: '原画',
          referer: 'https://www.bilibili.com/',
        }
      return {
        segments: [[String(asset.index)]],
        referer: 'https://www.bilibili.com/',
        quality: '原画',
      }
    },
  }
  let api
  const server = createServer(
    (req, res) =>
      void api.handler(req, res, () => {
        res.writeHead(404)
        res.end()
      }),
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  api = createDownloaderApi({
    resolver,
    publicOrigins: [base.replace('http:', 'https:')],
    jobOptions: {
      ...(dash
        ? {
            muxOptions: {
              sourceOptions: { firstBytes: 4096, chunkBytes: 8192, retryDelayMs: 1 },
              openSource: async (url, { headers, signal }) => {
                const range = /bytes=(\d+)-(\d+)/.exec(headers.Range || '')
                const common = {
                  'content-length': String(dashData.length),
                  'content-type': 'video/mp4',
                  'accept-ranges': 'bytes',
                  etag: '"dash"',
                }
                if (!range)
                  return { status: 200, headers: common, stream: Readable.from([dashData]) }
                const [start, end] = range.slice(1).map(Number)
                return {
                  status: 206,
                  headers: {
                    ...common,
                    'content-length': String(end - start + 1),
                    'content-range': `bytes ${start}-${end}/${dashData.length}`,
                  },
                  stream: Readable.from(
                    (async function* () {
                      if (start === 4096 && !rangeFailures++) {
                        yield dashData.subarray(start, start + 10)
                        throw Object.assign(new Error('reset'), { code: 'ECONNRESET' })
                      }
                      if (end === dashData.length - 1)
                        await Promise.race([
                          tails[Number.parseInt(url) - 1].promise,
                          new Promise((_, reject) =>
                            signal.addEventListener('abort', () => reject(signal.reason), {
                              once: true,
                            }),
                          ),
                        ])
                      yield dashData.subarray(start, end + 1)
                    })(),
                  ),
                }
              },
            },
          }
        : {}),
      saveMedia: async (urls, target, { onProgress }) => {
        const data = samples[(Number(urls[0]) - 1) % samples.length]
        await writeFile(target, data)
        onProgress(data.length, data.length)
      },
    },
  })
  const config = await fetch(base + '/api/downloader/config')
  const headers = {
    cookie: config.headers.get('set-cookie').split(';')[0],
    'x-downloader-token': (await config.json()).token,
  }
  const request = (url, options = {}) =>
    fetch(base + url, {
      ...options,
      headers: { ...headers, ...options.headers },
      signal: options.signal || AbortSignal.timeout(5000),
    })
  const post = async (route, body) => {
    const response = await request('/api/downloader/' + route, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`)
    return response.json()
  }
  const result = await post('resolve', { text: 'fixture' })
  const job = await post('jobs', {
    sessionId: result.sessionId,
    indices: [...selected].reverse().concat(selected[0]),
    delivery: 'parts',
  })
  return {
    gates,
    tails,
    dashData,
    job,
    request,
    post,
    state: async () => (await request(`/api/downloader/jobs/${job.id}`)).json(),
    close: async () => {
      for (const gate of gates) gate.resolve()
      for (const tail of tails) tail.resolve()
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
      await api.close()
    },
  }
}

test('selected Bilibili parts start independent MP4 attachments and P1 completes while P2 is still blocked', async () => {
  const app = await fixture()
  try {
    assert.equal(app.job.downloadUrl, '')
    assert.deepEqual(
      app.job.downloads.map((part) => part.index),
      [1, 2],
    )
    assert.ok(app.job.downloads.every((part) => part.name.endsWith('.mp4') && !part.ready))
    const responses = await Promise.all(app.job.downloads.map((part) => app.request(part.url)))
    for (const response of responses) {
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'video/mp4')
      assert.equal(response.headers.get('incremental'), '?1')
      assert.match(response.headers.get('content-disposition'), /^attachment;.*\.mp4/)
      assert.equal(response.headers.get('content-length'), null)
    }
    assert.notEqual(
      responses[0].headers.get('content-disposition'),
      responses[1].headers.get('content-disposition'),
    )
    const bodies = responses.map((response) =>
      response.arrayBuffer().then((value) => Buffer.from(value)),
    )
    app.gates[0].resolve()
    const first = await bodies[0]
    const state = await app.state()
    assert.equal(state.status, 'running')
    assert.equal(state.files.length, 1)
    assert.equal(state.archive, null)
    assert.deepEqual(
      state.downloads.map((part) => part.ready),
      [true, false],
    )
    assert.match(state.downloads[0].url, /\/files\//)
    assert.deepEqual(
      Buffer.from(await (await app.request(state.files[0].url)).arrayBuffer()),
      first,
    )
    const range = await app.request(app.job.downloads[0].url, { headers: { range: 'bytes=3-20' } })
    assert.equal(range.status, 206)
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), first.subarray(3, 21))
    app.gates[1].resolve()
    const second = await bodies[1]
    assert.notDeepEqual(first, second)
    for (const [index, bytes] of [first, second].entries()) {
      const file = path.join(dir, `export-${index}.mp4`)
      await writeFile(file, bytes)
      const info = JSON.parse(
        execFileSync(
          ffprobe,
          [
            '-v',
            'error',
            '-show_entries',
            'stream=codec_name,codec_type,width,height:format=duration',
            '-of',
            'json',
            file,
          ],
          { encoding: 'utf8' },
        ),
      )
      assert.deepEqual(
        info.streams.map((stream) => stream.codec_name),
        ['h264', 'aac'],
      )
      assert.equal(info.streams[0].width, 160)
      assert.ok(Number(info.format.duration) >= 0.6)
    }
    const done = await app.state()
    assert.equal(done.status, 'done')
    assert.equal(done.files.length, 2)
    assert.equal(done.archive, null)
    assert.equal(done.timings.stages.archive, undefined)
  } finally {
    await app.close()
  }
})

for (const selected of [
  [1, 2],
  [3, 4],
])
  test(`DASH P${selected.join('/P')} stream before EOF, recover a lost block, and preserve the completed part`, async () => {
    const app = await fixture({ dash: true, failSecond: true, selected })
    try {
      const first = await app.request(app.job.downloads[0].url)
      const reader = first.body.getReader(),
        chunks = []
      app.gates[selected[0] - 1].resolve()
      const beginning = await reader.read()
      assert.ok(beginning.value.length > 0)
      chunks.push(Buffer.from(beginning.value))
      const active = await app.state()
      assert.equal(active.status, 'running')
      assert.deepEqual(
        active.downloads.map((part) => part.index),
        selected,
      )
      assert.equal(active.files.length, 0, 'MP4 must reach browser before source EOF/probe')
      assert.equal(active.downloads[0].streaming, true)
      app.tails[selected[0] - 1].resolve()
      for (;;) {
        const value = await reader.read()
        if (value.done) break
        chunks.push(Buffer.from(value.value))
      }
      const body = Buffer.concat(chunks),
        output = path.join(dir, 'dash-output.mp4')
      await writeFile(output, body)
      const ffmpeg = await mediaTool('ffmpeg')
      execFileSync(ffmpeg, ['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'])
      const hash = (file) =>
        execFileSync(
          ffmpeg,
          [
            '-v',
            'error',
            '-i',
            file,
            '-map',
            '0:v:0',
            '-c',
            'copy',
            '-f',
            'hash',
            '-hash',
            'sha256',
            '-',
          ],
          { encoding: 'utf8' },
        )
      assert.equal(
        hash(output),
        hash(path.join(dir, 'dash.mp4')),
        'video packet payload must remain identical',
      )
      const ready = await app.state()
      assert.equal(ready.current, 1)
      assert.ok(ready.retries >= 1)
      app.gates[selected[1] - 1].resolve()
      let failed
      for (let i = 0; i < 100; i++) {
        failed = await app.state()
        if (failed.status === 'failed') break
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      assert.equal(failed.status, 'failed')
      const resumed = await app.request(failed.files[0].url, { headers: { Range: 'bytes=123-' } })
      assert.equal(resumed.status, 206)
      assert.deepEqual(Buffer.from(await resumed.arrayBuffer()), body.subarray(123))
    } finally {
      await app.close()
    }
  })

test('separate parts keep owner checks, validate the selected part, and retain P1 after P2 fails', async () => {
  const app = await fixture({ failSecond: true })
  try {
    assert.equal(
      (await app.request(app.job.downloads[0].url, { headers: { cookie: '' } })).status,
      401,
    )
    const stranger = await app.request('/api/downloader/config', { headers: { cookie: '' } })
    assert.equal(
      (
        await app.request(app.job.downloads[0].url, {
          headers: { cookie: stranger.headers.get('set-cookie').split(';')[0] },
        })
      ).status,
      404,
    )
    for (const part of ['', '0', '3', '-1', 'abc'])
      assert.equal(
        (await app.request(`/api/downloader/jobs/${app.job.id}/stream?part=${part}`)).status,
        404,
      )
    assert.equal((await app.request(`/api/downloader/jobs/${app.job.id}/download`)).status, 400)
    const firstResponse = await app.request(app.job.downloads[0].url)
    const firstBody = firstResponse.arrayBuffer()
    app.gates[0].resolve()
    const first = Buffer.from(await firstBody)
    const second = await app.request(app.job.downloads[1].url)
    const broken = assert.rejects(second.arrayBuffer())
    app.gates[1].resolve()
    await broken
    const failed = await app.state()
    assert.equal(failed.status, 'failed')
    assert.equal(failed.files.length, 1)
    assert.match(failed.error, /第二个/)
    assert.deepEqual(
      Buffer.from(await (await app.request(failed.files[0].url)).arrayBuffer()),
      first,
    )
    assert.equal((await app.request(app.job.downloads[1].url)).status, 409)
  } finally {
    await app.close()
  }
})

test('cancelling separately downloaded parts breaks their pending attachments', async () => {
  const app = await fixture()
  try {
    const response = await app.request(app.job.downloads[1].url)
    const broken = assert.rejects(response.arrayBuffer())
    await app.post(`jobs/${app.job.id}/cancel`, {})
    await broken
    assert.equal((await app.state()).status, 'cancelled')
  } finally {
    await app.close()
  }
})
