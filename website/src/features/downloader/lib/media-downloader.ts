export type MediaAsset = {
  index: number
  type: 'image' | 'video' | 'livePhoto'
  title: string
  duration?: number
  width: number
  height: number
  motionWidth?: number
  motionHeight?: number
  thumbnail: string
  preview?: string
  directThumbnail?: string
  directPreview?: string
  quality?: string
}
export type MediaResult = {
  platform: 'douyin' | 'bilibili'
  kind: 'images' | 'video'
  id: string
  sessionId: string
  title: string
  author: string
  url: string
  avatar: string
  directAvatar?: string
  cover: string
  directCover?: string
  notice: string
  current?: number
  assets: MediaAsset[]
}
export type DownloadFile = {
  id: string
  index: number
  name: string
  bytes: number
  type: string
  url: string
  previewUrl: string
  width?: number
  height?: number
  quality?: string
  hasAudio?: boolean
  duration?: number
}
export type DownloadJob = {
  id: string
  downloadUrl: string
  streaming?: boolean
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  phase: string
  current: number
  count: number
  bytes: number
  total: number
  error: string
  timings?: {
    firstReadyMs: number | null
    elapsedMs: number
    stages: Record<string, { count: number; waitMs: number; workMs: number; failures: number }>
  }
  files: DownloadFile[]
  archive: { name: string; bytes: number; url: string } | null
}
let token: Promise<string> | null = null
async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, options)
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new Error('下载服务暂时不可用，请稍后重试。')
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || '操作失败，请重试。')
  return value as T
}
export function prepareDownloaderSession(): Promise<string> {
  token ??= request<{ token: string }>('/api/downloader/config')
    .then((value) => value.token)
    .catch((error) => {
      token = null
      throw error
    })
  return token
}
export async function mediaPost<T>(path: string, value: unknown, signal?: AbortSignal): Promise<T> {
  const csrf = await prepareDownloaderSession()
  signal?.throwIfAborted()
  return request<T>('/api/downloader/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Downloader-Token': csrf },
    body: JSON.stringify(value),
    signal,
  })
}
export const getDownloadJob = (id: string, signal?: AbortSignal) =>
  request<DownloadJob>('/api/downloader/jobs/' + id, { signal })
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}
export function mediaDuration(seconds = 0) {
  const total = Math.floor(seconds)
  return total >= 3600
    ? `${Math.floor(total / 3600)}:${String(Math.floor(total / 60) % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
    : `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
export function saveFile(url: string, name: string) {
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
}
