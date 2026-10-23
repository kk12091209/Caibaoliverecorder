import type { DownloadFile } from './media-downloader'

// Keep large movies out of a mobile tab's heap. Larger files still use the
// native downloader, from which iOS can share the file to Photos.
export const ALBUM_BATCH_BYTES = 128 * 1024 ** 2
export const ALBUM_BATCH_COUNT = 10
export function prefersPhotoLibrary(
  device: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> = navigator,
) {
  return (
    /iPhone|iPad/i.test(device.userAgent) ||
    (device.platform === 'MacIntel' && device.maxTouchPoints > 1)
  )
}
export function albumBatch(files: DownloadFile[], start: number) {
  const batch: DownloadFile[] = []
  let bytes = 0
  for (const file of files.slice(start)) {
    if (
      batch.length &&
      (batch.length >= ALBUM_BATCH_COUNT || bytes + file.bytes > ALBUM_BATCH_BYTES)
    )
      break
    batch.push(file)
    bytes += file.bytes
    if (bytes > ALBUM_BATCH_BYTES) break
  }
  return batch
}
export async function fetchAlbumFiles(
  files: DownloadFile[],
  signal: AbortSignal,
  onProgress: (bytes: number, total: number) => void,
) {
  const total = files.reduce((n, file) => n + file.bytes, 0),
    result: File[] = []
  let received = 0
  if (total > ALBUM_BATCH_BYTES)
    throw new Error('这个文件较大，请使用“下载文件”，再从系统文件中分享到相册。')
  for (const file of files) {
    const response = await fetch(file.url, { signal })
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== file.type)
      throw new Error('文件传输失败，请重新准备。')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('当前浏览器无法读取文件。')
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        received += value.byteLength
        if (size > file.bytes || received > ALBUM_BATCH_BYTES)
          throw new Error('文件大小发生变化，请重新准备。')
        chunks.push(value)
        onProgress(received, total)
      }
      if (size !== file.bytes) throw new Error('文件没有传输完整，请重新准备。')
      result.push(new File(chunks, file.name, { type: file.type }))
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  return result
}
