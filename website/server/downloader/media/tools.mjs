import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// Resolve relative to this module, never to a developer's checkout name or cwd.
// A standalone server can use FFMPEG_PATH / FFPROBE_PATH or its system PATH.
export async function mediaTool(name) {
  const executable = process.platform === 'win32' ? `${name}.exe` : name
  const bundled = fileURLToPath(
    new URL(`../../../../.tools/runtime/ffmpeg/${executable}`, import.meta.url),
  )
  for (const candidate of [process.env[`${name.toUpperCase()}_PATH`], bundled].filter(Boolean)) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Continue to the bundled runtime, then the system installation.
    }
  }
  return executable
}
