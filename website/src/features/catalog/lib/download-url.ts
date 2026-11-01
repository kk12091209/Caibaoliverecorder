// Bind browser caches to the verified file while accepting older canonical catalogs.
export function downloadUrl(value: string, sha256?: string) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('下载地址无效')
  if (url.hostname !== 'download.caibao.media' || url.port) throw new Error('下载域名无效')
  const digest = typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256) ? sha256 : undefined
  if (url.search && (!digest || url.search !== `?sha256=${digest}`))
    throw new Error('下载校验标识无效')
  if (digest) url.search = `sha256=${digest}`
  return url.href
}
