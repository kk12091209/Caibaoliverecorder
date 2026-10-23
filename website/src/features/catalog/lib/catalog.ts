import { useSyncExternalStore } from 'react'
import { works as definitions, type Work } from '../data/works'

type ReleaseFile = {
  id: string
  platform: string
  arch: string
  name: string
  size: number
  sha256: string
  url: string
}
type Release = {
  version: string
  publishedAt: string
  notes: string
  releaseUrl?: string
  files: ReleaseFile[]
  sources?: { name: string; url: string }[]
}
type Catalog = { schemaVersion: number; products: Record<string, Release> }
type Snapshot = { works: Work[]; loading: boolean; error: boolean }

let snapshot: Snapshot = { works: definitions, loading: true, error: false }
let pending: Promise<void> | undefined
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const getSnapshot = () => snapshot

function safeUrl(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('下载地址无效')
  if (url.hostname !== 'download.caibao.media') throw new Error('下载域名无效')
  return url.href
}

function mergeCatalog(data: Catalog): Work[] {
  if (data.schemaVersion !== 1 || !data.products || typeof data.products !== 'object')
    throw new Error('版本清单格式无效')
  return definitions.map((work) => {
    const release = data.products[work.slug]
    if (!release) return work
    if (
      !/^v?\d+\.\d+\.\d+$/.test(release.version) ||
      !Number.isFinite(Date.parse(release.publishedAt)) ||
      !Array.isArray(release.files)
    )
      throw new Error('版本信息无效')
    const downloads = work.downloads.map((file) => {
      const matches = release.files.filter((entry) => entry.id === file.id)
      const match = matches[0]
      if (
        matches.length !== 1 ||
        match.platform !== file.platform ||
        !['x64', 'arm64'].includes(match.arch) ||
        !Number.isSafeInteger(match.size) ||
        match.size <= 0 ||
        !/^[a-f0-9]{64}$/.test(match.sha256) ||
        !/^[A-Za-z0-9_.-]+$/.test(match.name)
      )
        throw new Error('安装包信息无效')
      return {
        ...file,
        href: safeUrl(match.url),
        name: match.name,
        sha256: match.sha256,
        size: `${(match.size / 1024 / 1024).toFixed(1)} MB`,
      }
    })
    return {
      ...work,
      version: release.version,
      releasedAt: new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .format(new Date(release.publishedAt))
        .replaceAll('/', '.'),
      downloads,
      updates: typeof release.notes === 'string' ? release.notes.split('\n').filter(Boolean) : [],
      sources: (release.sources || []).map((source) => ({
        name: source.name,
        url: safeUrl(source.url),
      })),
      releaseUrl: release.releaseUrl,
    }
  })
}

export function loadCatalog(): Promise<void> {
  if (pending) return pending
  snapshot = { ...snapshot, loading: true, error: false }
  listeners.forEach((listener) => listener())
  pending = (async () => {
    try {
      const response = await fetch('/releases/catalog.json', {
        cache: 'no-cache',
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) throw new Error('无法读取版本清单')
      const works = mergeCatalog((await response.json()) as Catalog)
      snapshot = { works, loading: false, error: false }
    } catch {
      snapshot = { ...snapshot, loading: false, error: true }
    } finally {
      pending = undefined
      listeners.forEach((listener) => listener())
    }
  })()
  return pending
}

export function useCatalog() {
  return useSyncExternalStore(subscribe, getSnapshot)
}
export function useWorks() {
  return useCatalog().works
}
