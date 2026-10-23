import { readSignedManifest } from './update-trust.mjs'
import { versionOf } from './release-core.mjs'

export function verifyDesktopUpdate(envelope, plan, publicKey) {
  const manifest = readSignedManifest(envelope, publicKey)
  if (
    manifest.schema !== 1 ||
    manifest.version !== versionOf(plan.publicRelease.version) ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceRevision) ||
    manifest.sourceRevision !== plan.sourceRevision ||
    !Array.isArray(manifest.notes) ||
    manifest.notes.length > 12 ||
    manifest.notes.some((note) => typeof note !== 'string' || note.length > 500)
  )
    throw new Error('桌面更新版本、源码或说明无效')
  for (const [platform, id] of [
    ['win32-x64', 'win-setup'],
    ['darwin-arm64', 'mac-dmg'],
  ]) {
    const item = manifest.platforms?.[platform],
      file = plan.assets.find((asset) => asset.id === id)
    if (
      !file ||
      !item ||
      item.name !== file.name ||
      item.size !== file.size ||
      item.sha256 !== file.sha256
    )
      throw new Error('桌面更新与已验证安装包不一致')
  }
  return manifest
}
