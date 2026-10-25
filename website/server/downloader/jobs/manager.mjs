import {
  mkdtemp,
  chmod,
  mkdir,
  stat,
  statfs,
  rm,
  rename,
  writeFile,
  readdir,
} from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { runMedia } from '../media/process.mjs'
import { once } from 'node:events'
import { Zip, ZipPassThrough } from 'fflate'
import { newId } from '../platforms/resolver.mjs'
import { saveRemote } from '../infrastructure/network.mjs'
import { MediaImages } from '../media/images.mjs'
import { waitFor, WorkPool, StageTimings } from '../infrastructure/cache.mjs'
import { mediaTool as tool } from '../media/tools.mjs'
import { muxRemoteMp4 } from '../media/streaming.mjs'
import { reusableMp4 } from '../media/mp4-reuse.mjs'

export function fileStem(input) {
  return (
    String(input)
      .normalize('NFC')
      .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 90) || '作品'
  )
}
function videoName(result, asset) {
  return `${fileStem(result.title)}${asset.type === 'livePhoto' ? `_${String(asset.index).padStart(3, '0')}_实况` : result.assets.length > 1 ? `_P${asset.index}_${fileStem(asset.title)}` : ''}.mp4`
}
function archiveName(result, count) {
  return `${fileStem(result.title)}_已选${count}项.zip`
}
async function probe(file, signal) {
  try {
    const raw = await runMedia(
      await tool('ffprobe'),
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,width,height:format=duration',
        '-of',
        'json',
        file,
      ],
      signal,
      { idleMs: 15000 },
    )
    const data = JSON.parse(raw),
      v = data.streams?.find((x) => x.codec_type === 'video')
    return {
      width: v?.width || 0,
      height: v?.height || 0,
      duration: Number(data.format?.duration) || 0,
      hasAudio: data.streams?.some((x) => x.codec_type === 'audio') || false,
    }
  } catch (error) {
    if (signal.aborted) throw error
    return {}
  }
}
async function archive(files, target, signal) {
  const out = createWriteStream(target)
  let failure
  out.on('error', (error) => {
    failure = error
  })
  const zip = new Zip((error, data, final) => {
    if (error) {
      failure = error
      out.destroy(error)
      return
    }
    out.write(data)
    if (final) out.end()
  })
  try {
    for (const file of files) {
      signal.throwIfAborted()
      const entry = new ZipPassThrough(file.name)
      zip.add(entry)
      for await (const chunk of createReadStream(file.path)) {
        signal.throwIfAborted()
        if (failure) throw failure
        entry.push(chunk)
        if (out.writableNeedDrain) await once(out, 'drain')
      }
      entry.push(new Uint8Array(), true)
    }
    const finished = once(out, 'finish')
    zip.end()
    await finished
    if (failure) throw failure
  } catch (error) {
    zip.terminate()
    out.destroy()
    throw error
  }
}

export class DownloadJobs {
  constructor(
    resolver,
    {
      images,
      saveMedia = saveRemote,
      publicMode = false,
      fileServer = false,
      tempDir = tmpdir(),
      maxFileBytes = publicMode ? 1024 ** 3 : 8 * 1024 ** 3,
      maxJobBytes = publicMode ? 1024 ** 3 : Infinity,
      maxStorageBytes = publicMode ? 8 * 1024 ** 3 : Infinity,
      keepMs = publicMode ? 3600000 : 12 * 3600000,
    } = {},
  ) {
    this.resolver = resolver
    this.saveMedia = saveMedia
    this.images = images || new MediaImages()
    this.ownsImages = !images
    this.jobs = new Map()
    this.queue = []
    this.running = 0
    this.pending = new Set()
    this.network = new WorkPool(4)
    this.media = new WorkPool(1)
    // Streaming copy spends most of its lifetime waiting for the CDN. Keep it
    // separate from local remux/probe/ZIP work so a slow stream cannot block
    // already-downloaded files. Neither path transcodes the video.
    this.streams = new WorkPool(2)
    this.metadata = new WorkPool(2)
    this.imageTasks = new WorkPool(4)
    this.closed = false
    this.tempDir = path.resolve(tempDir)
    this.fileServer = fileServer
    this.root = mkdtemp(path.join(this.tempDir, 'caibao-downloader-')).then(async (root) => {
      if (fileServer) await chmod(root, 0o711)
      return root
    })
    this.publicMode = publicMode
    this.maxFileBytes = maxFileBytes
    this.maxJobBytes = maxJobBytes
    this.maxStorageBytes = maxStorageBytes
    this.keepMs = keepMs
  }
  storageUsage() {
    let bytes = 0
    for (const job of this.jobs.values())
      bytes += ['queued', 'running'].includes(job.status)
        ? Math.max(job.bytes * 3, (job.outputBytes || 0) * 2)
        : job.files.reduce((n, f) => n + f.bytes, 0) + (job.archive?.bytes || 0)
    return bytes
  }
  async ensureCapacity() {
    await this.prune()
    if (this.storageUsage() >= this.maxStorageBytes)
      throw new Error('临时下载空间正在使用中，请稍后重试。')
    if (this.publicMode) {
      const disk = await statfs(await this.root)
      if (disk.bavail * disk.bsize < 5 * 1024 ** 3)
        throw new Error('服务器临时空间不足，请稍后重试。')
    }
  }
  async prune() {
    const now = Date.now()
    for (const [id, job] of this.jobs)
      if (!['running', 'queued'].includes(job.status) && now - job.created > this.keepMs) {
        this.jobs.delete(id)
        await rm(path.join(await this.root, id), { recursive: true, force: true })
      }
  }
  create(session, indices, delivery = 'file') {
    if (this.closed || this.draining) throw new Error('下载服务正在停止，请稍后重试。')
    if (!['file', 'stream', 'album', 'preview'].includes(delivery))
      throw new Error('不支持的保存方式。')
    if (
      !Array.isArray(indices) ||
      !indices.length ||
      indices.length > 500 ||
      indices.some((i) => !Number.isInteger(i) || !session.result.assets.some((a) => a.index === i))
    )
      throw new Error('请选择要下载的图片或分 P。')
    const unique = [...new Set(indices)].sort((a, b) => a - b)
    const reuseKey = createHash('sha256')
      .update(JSON.stringify([session.owner, session.result, unique]))
      .digest('hex')
    const ready = [...this.jobs.values()].find(
      (job) =>
        ['queued', 'running', 'done'].includes(job.status) &&
        job.reuseKey === reuseKey &&
        (job.delivery === delivery ||
          (delivery === 'preview' && unique.length === 1 && !job.album) ||
          (delivery === 'stream' && job.delivery === 'preview') ||
          (!job.album && delivery !== 'album' && session.result.platform !== 'bilibili')) &&
        Date.now() - job.created < Math.min(this.keepMs, 600000),
    )
    if (ready) {
      // A preview already preparing a standard file can also serve a native
      // download. Attach to the same producer; do not fetch the source twice.
      if (delivery === 'stream' && !ready.attachment) {
        const asset = session.result.assets.find((a) => a.index === unique[0])
        ready.attachment =
          unique.length > 1
            ? { name: archiveName(session.result, unique.length), type: 'application/zip' }
            : asset.type !== 'image'
              ? { name: videoName(session.result, asset), type: 'video/mp4' }
              : null
      }
      return this.public(ready)
    }
    if (this.queue.length + this.running >= 10) throw new Error('下载任务较多，请等当前任务完成。')
    if (
      this.publicMode &&
      [...this.jobs.values()].filter(
        (j) => j.session.owner === session.owner && ['running', 'queued'].includes(j.status),
      ).length >= 2
    )
      throw new Error('已有两个下载任务正在处理，请稍后再添加。')
    const id = newId()
    const streamMode =
      delivery === 'stream' &&
      unique.length === 1 &&
      session.result.platform === 'bilibili' &&
      session.result.kind === 'video'
    const asset = session.result.assets.find((a) => a.index === unique[0])
    // Videos and archives have a known final format before preparation. A single
    // image must wait until conversion determines whether it is JPG or PNG.
    const attachment =
      delivery !== 'stream'
        ? null
        : unique.length > 1
          ? { name: archiveName(session.result, unique.length), type: 'application/zip' }
          : asset.type !== 'image'
            ? { name: videoName(session.result, asset), type: 'video/mp4' }
            : null
    const job = {
      id,
      created: Date.now(),
      reuseKey,
      delivery,
      timings: new StageTimings(),
      session,
      indices: unique,
      streamMode,
      attachment,
      album: delivery === 'album',
      status: 'queued',
      phase: '等待下载',
      current: 0,
      bytes: 0,
      total: 0,
      files: [],
      error: '',
      controller: new AbortController(),
    }
    job.finished = new Promise((resolve) => {
      job.finish = () => resolve(job)
    })
    job.streamReady = new Promise((resolve) => {
      job.publishStream = () => resolve()
    })
    this.jobs.set(id, job)
    this.queue.push(job)
    void this.drain()
    return this.public(job)
  }
  public(job) {
    const readyFiles = job.album
      ? job.indices.map((index) => job.files.find((file) => file.index === index))
      : job.files
    // A stable prefix prevents out-of-order image workers from moving a file
    // between album batches while the user has the system share sheet open.
    const missing = readyFiles.indexOf(undefined)
    const files =
      job.album && job.status === 'running' && missing >= 0
        ? readyFiles.slice(0, missing)
        : readyFiles.filter(Boolean)
    return {
      id: job.id,
      // Reused completed jobs must go straight to the immutable file. A fetch
      // followed through /stream's redirect is not a valid navigation response
      // for Chrome's download worker, and also adds an unnecessary round trip.
      downloadUrl: `/api/downloader/jobs/${job.id}/${job.attachment && job.status !== 'done' ? 'stream' : 'download'}`,
      streaming: !!job.stream?.bytes,
      status: job.status,
      phase: job.phase,
      current: job.current,
      count: job.indices.length,
      bytes: job.bytes,
      total: job.total,
      error: job.error,
      timings: job.timings.snapshot(),
      files: files.map(({ path: _path, ...file }) => ({
        ...file,
        url: `/api/downloader/jobs/${job.id}/files/${file.id}?download=1`,
        previewUrl: `/api/downloader/jobs/${job.id}/files/${file.id}`,
      })),
      archive: job.archive
        ? {
            name: job.archive.name,
            bytes: job.archive.bytes,
            url: `/api/downloader/jobs/${job.id}/files/${job.archive.id}?download=1`,
          }
        : null,
    }
  }
  wait(job, signal) {
    return waitFor(job.finished, signal)
  }
  waitStream(job, signal) {
    return waitFor(Promise.race([job.streamReady, job.finished]), signal)
  }
  cancel(id) {
    const job = this.jobs.get(id)
    if (!job) throw new Error('下载任务已过期。')
    if (['done', 'failed', 'cancelled'].includes(job.status)) return
    job.status = 'cancelled'
    job.phase = '已取消'
    job.controller.abort()
    job.finish()
  }
  async drain() {
    while (!this.closed && this.running < 10 && this.queue.length) {
      const job = this.queue.shift()
      if (job.status === 'cancelled') continue
      this.running++
      const pending = this.perform(job)
        .catch((error) => {
          job.status = job.controller.signal.aborted ? 'cancelled' : 'failed'
          job.error = job.controller.signal.aborted ? '' : error.message
          job.phase = job.controller.signal.aborted ? '已取消' : '下载失败'
        })
        .finally(() => {
          job.timings.finish()
          job.finish()
          this.pending.delete(pending)
          this.running--
          void this.drain()
        })
      this.pending.add(pending)
    }
  }
  async perform(job) {
    const { result } = job.session,
      operation = new AbortController(),
      signal = AbortSignal.any([job.controller.signal, operation.signal]),
      dir = path.join(await this.root, job.id)
    signal.throwIfAborted()
    await mkdir(dir)
    const stage = (name, pool, work) =>
      job.timings.run(name, pool, work, { signal, owner: job.session.owner })
    const run = (command, args) =>
      stage('mux', this.media, () => runMedia(command, args, signal, { progress: true }))
    const progress = new Map()
    job.outputBytes = 0
    const onProgress = (key) => (bytes, total) => {
      progress.set(key, { bytes, total })
      job.bytes = [...progress.values()].reduce((n, p) => n + p.bytes, 0)
      job.total =
        result.kind === 'images' ? 0 : [...progress.values()].reduce((n, p) => n + p.total, 0)
      if (job.bytes > this.maxJobBytes || job.outputBytes > this.maxJobBytes)
        throw new Error('当前在线测试版每次下载最多支持 1 GB，请减少本次选中内容。')
      if (this.storageUsage() > this.maxStorageBytes)
        throw new Error('临时下载空间已满，请稍后重试。')
    }
    const download = (urls, target, referer) =>
      stage('download', this.network, () =>
        this.saveMedia(urls, target, {
          referer,
          signal,
          maxBytes: this.maxFileBytes,
          onProgress: onProgress(target),
        }),
      )
    const processAsset = async (index) => {
      signal.throwIfAborted()
      const asset = result.assets.find((a) => a.index === index)
      let target,
        name,
        type,
        quality = asset.quality || '',
        metadata = null
      if (asset.type === 'image') {
        job.phase = '正在下载图片并保存为 JPG / PNG'
        const info = await stage('images', this.imageTasks, () =>
          this.images.download(asset.urls, {
            referer: result.url,
            signal,
            owner: job.session.owner,
            onProgress: onProgress(String(index)),
          }),
        )
        signal.throwIfAborted()
        name = `${fileStem(result.title)}_${String(index).padStart(3, '0')}.${info.extension}`
        target = path.join(dir, `${index}.${info.extension}`)
        type = info.type
        metadata = { width: info.width, height: info.height }
        if (info.data.length > this.maxFileBytes)
          throw new Error('转换后的图片超过单文件大小限制。')
        job.outputBytes += info.data.length
        onProgress(String(index))(
          progress.get(String(index)).bytes,
          progress.get(String(index)).total,
        )
        await writeFile(target, info.data, { signal })
      } else {
        name = videoName(result, asset)
        target = path.join(dir, `${index}.mp4`)
        type = 'video/mp4'
        if (result.platform === 'douyin') {
          job.phase = '正在下载无水印视频'
          const raw = path.join(dir, `${index}.source`)
          await download(asset.urls, raw, result.url)
          job.phase = '正在准备 MP4'
          metadata = await stage('validate', this.media, () => reusableMp4(raw, signal))
          if (metadata) {
            signal.throwIfAborted()
            await rename(raw, target)
            job.originalMp4 = (job.originalMp4 || 0) + 1
          } else {
            await run(
              await tool('ffmpeg'),
              [
                '-hide_banner',
                '-loglevel',
                'error',
                '-nostdin',
                '-y',
                '-i',
                raw,
                '-map',
                '0:v:0',
                '-map',
                '0:a:0?',
                '-c',
                'copy',
                '-movflags',
                '+faststart',
                target,
              ],
              signal,
            )
            await rm(raw)
          }
        } else {
          const sources = await stage('resolve', this.metadata, () =>
            this.resolver.bilibiliStreams(result, asset, signal),
          )
          quality = sources.quality
          if (sources.video && job.streamMode) {
            job.phase = `正在边合并边下载 · ${quality}`
            job.stream = { path: target, name, type, bytes: 0 }
            await stage('stream', this.streams, () =>
              stage('download', this.network, async () =>
                muxRemoteMp4(sources, target, {
                  command: await tool('ffmpeg'),
                  signal,
                  maxBytes: Math.min(this.maxFileBytes, this.maxJobBytes),
                  onProgress,
                  onOutput: (bytes) => {
                    job.stream.bytes = bytes
                    job.outputBytes = bytes
                    if (this.storageUsage() > this.maxStorageBytes)
                      throw new Error('临时下载空间已满，请稍后重试。')
                    job.timings.ready()
                    job.publishStream()
                  },
                }),
              ),
            )
          } else if (sources.video) {
            job.phase = `正在下载音画 · ${quality}`
            const video = path.join(dir, `${index}.video`),
              audio = path.join(dir, `${index}.audio`)
            const downloads = [
              download(sources.video, video, sources.referer),
              download(sources.audio, audio, sources.referer),
            ]
            try {
              await Promise.all(downloads)
            } catch (error) {
              operation.abort()
              await Promise.allSettled(downloads)
              throw error
            }
            job.phase = '正在合并音画'
            await run(
              await tool('ffmpeg'),
              [
                '-hide_banner',
                '-loglevel',
                'error',
                '-nostdin',
                '-y',
                '-i',
                video,
                '-i',
                audio,
                '-map',
                '0:v:0',
                '-map',
                '1:a:0',
                '-c',
                'copy',
                '-movflags',
                '+faststart',
                target,
              ],
              signal,
            )
            await Promise.all([rm(video), rm(audio)])
          } else {
            const segments = []
            for (const [n, urls] of sources.segments.entries()) {
              job.phase = `正在下载视频 · ${quality}`
              const segment = path.join(dir, `${index}-${n}.segment`)
              await download(urls, segment, sources.referer)
              segments.push(segment)
            }
            if (segments.length === 1) {
              await run(
                await tool('ffmpeg'),
                [
                  '-hide_banner',
                  '-loglevel',
                  'error',
                  '-nostdin',
                  '-y',
                  '-i',
                  segments[0],
                  '-c',
                  'copy',
                  '-movflags',
                  '+faststart',
                  target,
                ],
                signal,
              )
            } else {
              const list = path.join(dir, `${index}.concat`)
              await writeFile(
                list,
                segments.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'),
              )
              await run(
                await tool('ffmpeg'),
                [
                  '-hide_banner',
                  '-loglevel',
                  'error',
                  '-nostdin',
                  '-y',
                  '-f',
                  'concat',
                  '-safe',
                  '0',
                  '-i',
                  list,
                  '-c',
                  'copy',
                  '-movflags',
                  '+faststart',
                  target,
                ],
                signal,
              )
              await rm(list)
            }
            await Promise.all(segments.map((p) => rm(p)))
          }
        }
        metadata ||= await stage('probe', this.media, () => probe(target, signal))
        job.outputBytes = job.streamMode
          ? (await stat(target)).size
          : job.outputBytes + (await stat(target)).size
        if (job.outputBytes > this.maxJobBytes)
          throw new Error('当前在线测试版每次下载最多支持 1 GB，请减少本次选中内容。')
      }
      signal.throwIfAborted()
      const info = await stat(target)
      job.files.push({
        id: newId(),
        index,
        name,
        path: target,
        type,
        bytes: info.size,
        quality,
        ...metadata,
      })
      job.current++
      job.timings.ready()
    }
    try {
      job.status = 'running'
      job.phase = '正在获取最高可用画质'
      let next = 0
      const workers = Array.from(
        { length: result.kind === 'images' ? Math.min(4, job.indices.length) : 1 },
        async () => {
          while (next < job.indices.length) {
            signal.throwIfAborted()
            await processAsset(job.indices[next++])
          }
        },
      )
      try {
        await Promise.all(workers)
      } catch (error) {
        operation.abort()
        await Promise.allSettled(workers)
        throw error
      }
      job.files.sort((a, b) => a.index - b.index)
      if (job.files.length > 1 && !job.album) {
        job.phase = '正在打包所选文件'
        const target = path.join(dir, 'selected.zip')
        await stage('archive', this.media, () => archive(job.files, target, signal))
        job.archive = {
          id: newId(),
          name: archiveName(result, job.files.length),
          path: target,
          type: 'application/zip',
          bytes: (await stat(target)).size,
        }
      }
      job.status = 'done'
      job.phase = '下载准备完成'
      job.total = job.bytes
    } catch (error) {
      const cancelled = job.controller.signal.aborted
      job.status = cancelled ? 'cancelled' : 'failed'
      job.phase = cancelled ? '已取消' : '下载失败'
      job.error = cancelled ? '' : error.message
      if (job.album && !cancelled && job.files.length) {
        const complete = new Set(job.files.map((file) => path.basename(file.path)))
        await Promise.all(
          (await readdir(dir))
            .filter((file) => !complete.has(file))
            .map((file) => rm(path.join(dir, file), { force: true })),
        )
      } else {
        await rm(dir, { recursive: true, force: true })
        job.files = []
      }
      job.archive = null
    }
  }
  async close() {
    this.closed = true
    for (const job of this.jobs.values()) this.cancel(job.id)
    await Promise.allSettled(this.pending)
    await rm(await this.root, { recursive: true, force: true })
    if (this.ownsImages) await this.images.close()
  }
  beginDrain() {
    this.draining = true
  }
  async idle() {
    await Promise.allSettled([...this.pending])
  }
}
