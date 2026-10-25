import type { ExportedRecording } from './recording-export'
import type { RecordingMode } from './recording'

type Request =
  | { operation: 'track'; blob: Blob; kind: RecordingMode }
  | { operation: 'zip'; files: { name: string; blob: Blob }[] }

async function execute<T>(request: Request, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  // No WebCodecs decode or re-encode: the worker only copies encoded packets.
  // A worker per operation releases its temporary buffers on finish/cancel.
  if (typeof Worker === 'undefined') {
    const local = await import('./recording-export')
    return (
      request.operation === 'track'
        ? local.extractRecordingTrack(request.blob, request.kind, signal)
        : local.zipRecordings(request.files, signal)
    ) as Promise<T>
  }
  const worker = new Worker(new URL('./recording-export.worker.ts', import.meta.url), {
    type: 'module',
  })
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      signal?.removeEventListener('abort', abort)
      worker.terminate()
    }
    const abort = () => {
      cleanup()
      reject(signal?.reason || new DOMException('已取消', 'AbortError'))
    }
    worker.onmessage = ({ data }) => {
      cleanup()
      if (data.error) reject(new Error(data.error))
      else resolve(data.value)
    }
    worker.onerror = () => {
      cleanup()
      reject(new Error('文件处理未能完成，请保存原始录制或重新生成。'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    else {
      try {
        worker.postMessage(request)
      } catch (error) {
        cleanup()
        reject(error)
      }
    }
  })
}
export const extractRecordingTrack = (blob: Blob, kind: RecordingMode, signal?: AbortSignal) =>
  execute<ExportedRecording>({ operation: 'track', blob, kind }, signal)
export const zipRecordings = (files: { name: string; blob: Blob }[], signal?: AbortSignal) =>
  execute<Blob>({ operation: 'zip', files }, signal)
