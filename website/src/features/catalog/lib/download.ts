import type { DownloadFile } from '../data/works'

// The file and the visible version come from the same published catalog snapshot.
export function startBrowserDownload(file: DownloadFile) {
  if (!file.href || !file.name) throw new Error('安装包尚未发布')
  const anchor = document.createElement('a')
  anchor.href = file.href
  anchor.download = file.name
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}
