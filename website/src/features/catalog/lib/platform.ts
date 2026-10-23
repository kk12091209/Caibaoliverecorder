import type { PlatformId } from '../data/works'

export function detectPlatform(): PlatformId {
  if (typeof navigator === 'undefined') return 'windows'
  const ua = navigator.userAgent.toLowerCase()
  const platform = navigator.platform?.toLowerCase() ?? ''
  if (ua.includes('mac') || platform.includes('mac')) return 'macos'
  return 'windows'
}
