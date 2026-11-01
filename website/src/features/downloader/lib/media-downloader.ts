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
  platform: 'douyin' | 'bilibili' | 'xiaohongshu'
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
  recovering?: boolean
  retries?: number
  outputBytes?: number
  monitoringError?: string
  downloads?: { index: number; name: string; url: string; ready: boolean; streaming?: boolean }[]
  timings?: {
    firstReadyMs: number | null
    elapsedMs: number
    stages: Record<string, { count: number; waitMs: number; workMs: number; failures: number }>
  }
  files: DownloadFile[]
  archive: { name: string; bytes: number; url: string } | null
}
const mainApi = '/api/downloader'
const xhsApi = '/api/downloader-xhs-v2'
const tokens = new Map<string, Promise<string>>()
const sessionRoutes = new Map<string, string>()
const jobRoutes = new Map<string, string>()
function remember(routes: Map<string, string>, id: string, base: string) {
  routes.set(id, base)
  if (routes.size > 256) routes.delete(routes.keys().next().value!)
}
function shareApi(text: string) {
  const links = text.replace(/\\\//g, '/').match(/https?:\/\/[^\s<>]+/g) || []
  for (const link of links) {
    try {
      const host = new URL(link).hostname
      if (
        [
          'xiaohongshu.com',
          'www.xiaohongshu.com',
          'xhslink.com',
          'www.xhslink.com',
          'xhslink.cn',
          'www.xhslink.cn',
        ].includes(host)
      )
        return xhsApi
    } catch {
      /* The server provides the full input validation message. */
    }
  }
  return mainApi
}
async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, options)
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new Error('下载服务暂时不可用，请稍后重试。')
  const value = await response.json()
  if (!response.ok)
    throw Object.assign(new Error(value.error || '操作失败，请重试。'), {
      status: response.status,
      code: value.code,
    })
  return value as T
}
export function prepareDownloaderSession(base = mainApi): Promise<string> {
  let token = tokens.get(base)
  if (token) return token
  token = request<{ token: string }>(base + '/config')
    .then((value) => value.token)
    .catch((error) => {
      tokens.delete(base)
      throw error
    })
  tokens.set(base, token)
  return token
}
export async function mediaPost<T>(path: string, value: unknown, signal?: AbortSignal): Promise<T> {
  const payload = value as { text?: string; sessionId?: string }
  const base =
    path === 'resolve'
      ? shareApi(payload.text || '')
      : sessionRoutes.get(payload.sessionId || '') || jobRoutes.get(path.split('/')[1]) || mainApi
  let csrf = await prepareDownloaderSession(base)
  signal?.throwIfAborted()
  const send = () =>
    request<T>(base + '/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Downloader-Token': csrf },
      body: JSON.stringify(value),
      signal,
    })
  let result: T
  try {
    result = await send()
  } catch (error) {
    // A fresh page can sit unused longer than its admission session. Only
    // retry resolution rejected before authorization, never job mutations or
    // a network-ambiguous operation that might already have been accepted.
    const failure = error as { status?: number; code?: string }
    if (
      path !== 'resolve' ||
      !(
        failure.status === 401 ||
        (failure.status === 403 && failure.code === 'SESSION_TOKEN_MISMATCH')
      )
    )
      throw error
    const cached = tokens.get(base)
    if (cached && (await cached) === csrf && tokens.get(base) === cached) tokens.delete(base)
    csrf = await prepareDownloaderSession(base)
    signal?.throwIfAborted()
    result = await send()
  }
  if (path === 'resolve') remember(sessionRoutes, (result as MediaResult).sessionId, base)
  if (path === 'jobs') remember(jobRoutes, (result as DownloadJob).id, base)
  return result
}
export const getDownloadJob = (id: string, signal?: AbortSignal) =>
  request<DownloadJob>((jobRoutes.get(id) || mainApi) + '/jobs/' + id, { signal })
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
