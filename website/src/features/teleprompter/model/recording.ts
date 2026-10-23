export type RecordingMode = 'video' | 'audio'
export type RecordingStatus = 'idle' | 'requesting' | 'recording' | 'paused' | 'stopping' | 'ready'
export type RecordingResult = {
  blob: Blob
  mode: RecordingMode
  duration: number
  createdAt: string
  warning: string
}
export const MAX_RECORDING_BYTES = 256 * 1024 * 1024

export function recordingMime(mode: RecordingMode, supported: (mime: string) => boolean) {
  const candidates =
    mode === 'video'
      ? [
          'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
          'video/mp4',
          'video/webm;codecs=vp8,opus',
          'video/webm',
        ]
      : [
          'audio/mp4;codecs=mp4a.40.2',
          'audio/mp4',
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/ogg;codecs=opus',
        ]
  return candidates.find(supported) ?? ''
}
export function recordingExtension(mime: string, mode: RecordingMode) {
  if (mime.includes('mp4')) return mode === 'audio' ? 'm4a' : 'mp4'
  if (mime.includes('ogg')) return 'ogg'
  return 'webm'
}
export function recordingFilename(title: string, createdAt: string) {
  const name =
    title
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .slice(0, 70) || '口播录制'
  return `${name}-${createdAt.replace(/[^0-9]/g, '').slice(0, 14)}`
}

export function recordingNameIssue(name: string) {
  const value = name.trim()
  if (!value) return '请先填写要保存的文件名。'
  if (!value.replace(/\.(mp4|webm|m4a|ogg|wav|mp3|zip)$/i, '')) return '请填写扩展名前的文件名。'
  if (
    value.length > 100 ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(value) ||
    /[.]$/.test(value) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  )
    return '文件名不可使用特殊符号或系统保留名称，请换一个名称。'
  return ''
}
export function recordingSaveName(name: string, extension: string, suffix = '') {
  const issue = recordingNameIssue(name)
  if (issue) throw new Error(issue)
  const base = name.trim().replace(/\.(mp4|webm|m4a|ogg|wav|mp3|zip)$/i, '')
  if (!base) throw new Error('请填写扩展名前的文件名。')
  return `${base}${suffix}.${extension}`
}

type RecorderOptions = {
  create: (stream: MediaStream, options: MediaRecorderOptions) => MediaRecorder
  supported: (mime: string) => boolean
  now?: () => number
  limit?: number
  changed?: () => void
  finished?: (result: RecordingResult | null, error: string) => void
}

/** One encoder per take. Keep the final dataavailable chunk before resolving stop. */
export class RecordingSession {
  status: RecordingStatus = 'idle'
  bytes = 0
  warning = ''
  private recorder: MediaRecorder
  private chunks: Blob[] = []
  private accumulated = 0
  private anchor = 0
  private now: () => number
  private completion: Promise<RecordingResult | null>
  private resolve!: (result: RecordingResult | null) => void
  private disposed = false
  private createdAt = new Date().toISOString()
  readonly mode: RecordingMode
  private options: RecorderOptions

  constructor(stream: MediaStream, mode: RecordingMode, options: RecorderOptions) {
    this.mode = mode
    this.options = options
    this.now = options.now ?? (() => performance.now())
    const mimeType = recordingMime(mode, options.supported)
    this.recorder = options.create(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 128000,
      ...(mode === 'video' ? { videoBitsPerSecond: 2500000 } : {}),
    })
    this.completion = new Promise((resolve) => {
      this.resolve = resolve
    })
    this.recorder.ondataavailable = (event) => {
      if (this.disposed || event.data.size === 0) return
      this.chunks.push(event.data)
      this.bytes += event.data.size
      if (this.bytes >= (options.limit ?? MAX_RECORDING_BYTES) && this.status !== 'stopping')
        void this.stop('已达到单次 256 MB 缓冲上限，请先保存本次录制。')
      options.changed?.()
    }
    this.recorder.onerror = () => {
      if (this.disposed) return
      const warning = '录制遇到中断，已保留收到的内容，请检查后保存。'
      if (this.recorder.state !== 'inactive') void this.stop(warning)
      else {
        if (this.status === 'recording') this.accumulated = this.elapsed
        this.warning = warning
        this.status = 'stopping'
        options.changed?.()
      }
    }
    this.recorder.onstop = () => this.finish()
  }
  get elapsed() {
    return this.accumulated + (this.status === 'recording' ? (this.now() - this.anchor) / 1000 : 0)
  }
  start() {
    if (this.status !== 'idle' || this.disposed) throw new Error('录制状态无效')
    this.recorder.start(1000)
    this.anchor = this.now()
    this.status = 'recording'
    this.options.changed?.()
  }
  pause() {
    if (this.status !== 'recording') return
    this.recorder.pause()
    this.accumulated = this.elapsed
    this.status = 'paused'
    this.options.changed?.()
  }
  resume() {
    if (this.status !== 'paused') return
    this.recorder.resume()
    this.anchor = this.now()
    this.status = 'recording'
    this.options.changed?.()
  }
  stop(warning = '') {
    if (this.disposed || this.status === 'ready' || this.status === 'stopping')
      return this.completion
    if (this.status === 'recording') this.accumulated = this.elapsed
    this.warning = warning
    this.status = 'stopping'
    this.options.changed?.()
    try {
      if (this.recorder.state !== 'inactive') this.recorder.stop()
    } catch {
      this.finish()
    }
    return this.completion
  }
  private finish() {
    if (this.disposed || this.status === 'ready') return
    if (this.status === 'recording') this.accumulated = this.elapsed
    const blob = new Blob(this.chunks, {
      type:
        this.recorder.mimeType ||
        this.chunks[0]?.type ||
        (this.mode === 'video' ? 'video/webm' : 'audio/webm'),
    })
    const result = blob.size
      ? {
          blob,
          mode: this.mode,
          duration: this.accumulated,
          createdAt: this.createdAt,
          warning: this.warning,
        }
      : null
    this.chunks = []
    this.status = 'ready'
    this.resolve(result)
    this.options.finished?.(
      result,
      result ? '' : '没有收到有效录制数据，请检查摄像头与麦克风后重试。',
    )
    this.options.changed?.()
  }
  dispose() {
    this.disposed = true
    this.recorder.ondataavailable = null
    this.recorder.onstop = null
    this.recorder.onerror = null
    if (this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop()
      } catch {
        /* Already stopped by the browser. */
      }
    }
    this.chunks = []
    this.resolve(null)
  }
}
