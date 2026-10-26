export const PUBLIC_DOWNLOAD_BYTES = 4 * 1024 ** 3
// Running jobs reserve three times their input size for download, remux and
// archives. Leave room for a full 4 GiB job as well as completed small files.
export const PUBLIC_STORAGE_BYTES = 16 * 1024 ** 3
export const MIN_FREE_DISK_BYTES = 5 * 1024 ** 3

export function sizeLimitError(bytes, subject = '本次所选内容') {
  const limit = bytes >= 1024 ** 3 ? `${bytes / 1024 ** 3} GB` : `${bytes} 字节`
  return Object.assign(
    new Error(`${subject}超过本次下载大小限制（${limit}），请减少所选内容或分批下载。`),
    { code: 'DOWNLOAD_TOO_LARGE' },
  )
}

export function diskSpaceError() {
  return Object.assign(new Error('服务器当前可用空间不足，暂时无法准备此下载，请稍后重试。'), {
    code: 'DOWNLOAD_SPACE_LOW',
  })
}
