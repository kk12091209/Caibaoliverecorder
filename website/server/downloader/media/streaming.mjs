import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { openRemote } from '../infrastructure/network.mjs'

// FFmpeg only sees pipes. All remote redirects and DNS still pass through the
// downloader's allowlist and pinned-address validation, never FFmpeg's network stack.
export async function muxRemoteMp4(
  sources,
  target,
  { command, signal, maxBytes, onProgress, onOutput, openSource = openRemote },
) {
  const abort = new AbortController(),
    combined = AbortSignal.any([signal, abort.signal])
  const responses = []
  let child, output
  const tasks = []
  try {
    for (const urls of [sources.video, sources.audio]) {
      let last
      for (const url of urls) {
        combined.throwIfAborted()
        try {
          const response = await openSource(url, {
            signal: combined,
            headers: { Referer: sources.referer },
            timeout: 60000,
          })
          const total = Number(response.headers['content-length']) || 0
          if (
            response.status !== 200 ||
            /text\/|application\/(?:json|xml)/i.test(response.headers['content-type'] || '')
          ) {
            response.stream.destroy()
            throw new Error('视频源暂时不可用。')
          }
          if (total > maxBytes) {
            response.stream.destroy()
            throw new Error('视频源超过本次下载大小限制。')
          }
          response.stream.on('error', () => {})
          responses.push({ ...response, total })
          last = null
          break
        } catch (error) {
          last = error
          if (combined.aborted) throw error
        }
      }
      if (last || responses.length === 0) throw last || new Error('没有可用的视频源。')
    }
    if (responses.length !== 2) throw new Error('没有完整的视频音画源。')
    child = spawn(
      command,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-protocol_whitelist',
        'pipe',
        '-i',
        'pipe:3',
        '-protocol_whitelist',
        'pipe',
        '-i',
        'pipe:4',
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c',
        'copy',
        '-movflags',
        '+empty_moov+default_base_moof+frag_keyframe',
        '-frag_duration',
        '2000000',
        '-flush_packets',
        '1',
        '-f',
        'mp4',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], signal: combined },
    )
    child.stderr.resume()
    tasks.push(
      new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) =>
          code === 0 ? resolve() : reject(new Error('视频传输中断，请重试下载。')),
        )
      }),
    )
    for (const [index, response] of responses.entries()) {
      let bytes = 0
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          try {
            bytes += chunk.length
            if (bytes > maxBytes || (response.total && bytes > response.total))
              throw new Error('视频源超过本次下载大小限制。')
            onProgress(String(index))(bytes, response.total)
            callback(null, chunk)
          } catch (error) {
            callback(error)
          }
        },
        flush(callback) {
          callback(
            response.total && bytes !== response.total ? new Error('视频源未传输完整。') : null,
          )
        },
      })
      tasks.push(pipeline(response.stream, meter, child.stdio[index + 3], { signal: combined }))
    }
    output = createWriteStream(target)
    let written = 0
    // Publish only bytes acknowledged by the file writer, so readers never see holes.
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        if (written + chunk.length > maxBytes)
          return callback(new Error('视频超过本次下载大小限制。'))
        output.write(chunk, (error) => {
          if (error) return callback(error)
          try {
            written += chunk.length
            onOutput(written)
            callback()
          } catch (reason) {
            callback(reason)
          }
        })
      },
      final(callback) {
        output.end(callback)
      },
    })
    output.on('error', (error) => sink.destroy(error))
    tasks.push(pipeline(child.stdout, sink, { signal: combined }))
    await Promise.all(tasks)
    if (!written) throw new Error('视频源没有返回有效内容。')
  } finally {
    abort.abort()
    for (const response of responses) response.stream.destroy()
    child?.kill()
    output?.destroy()
    await Promise.allSettled(tasks)
  }
}

// A bounded disk tail lets slow browsers apply backpressure without keeping an
// entire movie in Node memory. Failed/cancelled jobs terminate the response.
export async function* growingFile(job, signal) {
  const file = await open(job.stream.path, 'r')
  let position = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      if (['failed', 'cancelled'].includes(job.status)) throw new Error(job.error || '下载已取消。')
      const available = job.stream.bytes - position
      if (available > 0) {
        const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, available))
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position)
        if (!bytesRead) throw new Error('视频临时文件不完整。')
        position += bytesRead
        yield buffer.subarray(0, bytesRead)
      } else if (job.status === 'done') return
      else await delay(100, undefined, { signal })
    }
  } finally {
    await file.close()
  }
}
