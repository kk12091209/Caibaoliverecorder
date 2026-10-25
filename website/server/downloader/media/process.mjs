import { spawn } from 'node:child_process'

// Settle only after the process exits, including cancellation. Otherwise a
// failed request can free its CPU slot and remove files while FFmpeg still writes.
export function runMedia(
  command,
  args,
  signal,
  { idleMs = 120000, killMs = 2000, progress = false, rejectStderr = false } = {},
) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(command, progress ? ['-progress', 'pipe:3', '-nostats', ...args] : args, {
      stdio: ['ignore', 'pipe', 'pipe', ...(progress ? ['pipe'] : [])],
      windowsHide: true,
    })
    let output = '',
      error = '',
      failure,
      timer,
      killTimer,
      lastProgress = ''
    const stop = (reason) => {
      failure ??= reason
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), killMs)
      killTimer.unref?.()
    }
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(
        () => stop(new Error('媒体处理长时间没有进展，已停止本次处理，请重试。')),
        idleMs,
      )
      timer.unref?.()
    }
    const abort = () => stop(signal.reason)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (data) => {
      if (output.length < 100000) output += data
    })
    child.stderr.on('data', (data) => {
      error = (error + data).slice(-12000)
    })
    if (progress) {
      let pending = ''
      child.stdio[3].on('data', (data) => {
        pending += data
        const lines = pending.split('\n')
        pending = lines.pop().slice(-1000)
        for (const line of lines)
          if (/^(?:out_time_us|total_size)=\d+$/.test(line) && line !== lastProgress) {
            // Different progress keys must not make an unchanged timestamp look active.
            const [key, value] = line.split('=')
            if (values[key] !== value) {
              values[key] = value
              lastProgress = line
              arm()
            }
          }
      })
    }
    const values = {}
    child.once('error', (reason) => {
      failure ??= reason
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code === 0 && !(rejectStderr && error.trim())) resolve(output)
      else
        reject(
          new Error(
            `媒体合并失败（${code}），请重试。${/ENOENT/.test(error) ? '需要安装 FFmpeg。' : ''}`,
          ),
        )
    })
    arm()
    if (signal?.aborted) abort()
  })
}
