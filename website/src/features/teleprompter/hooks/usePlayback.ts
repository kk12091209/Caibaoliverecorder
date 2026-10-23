import { useCallback, useEffect, useRef, useState } from 'react'
import type { Cue } from '../model/teleprompter'
import { advanceTimeline } from '../model/reading-progress'

export function usePlayback(cues: Cue[], recording = false) {
  const total = cues.at(-1)?.end ?? 0
  const [elapsed, setElapsed] = useState(0)
  const [seekRevision, setSeekRevision] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const [wake, setWake] = useState('播放时尝试保持屏幕常亮')
  const [rate, setRateValue] = useState(1)
  const position = useRef(0)
  const previous = useRef(0)
  const speed = useRef(1)
  const active = useRef(false)
  const deadline = useRef<number | null>(null)
  const update = useCallback(
    (now: number) => {
      if (active.current && deadline.current === null && now - previous.current <= 3000)
        position.current = advanceTimeline(
          cues,
          position.current,
          (now - previous.current) / 1000,
          speed.current,
        )
      previous.current = now
      setElapsed(position.current)
    },
    [cues],
  )
  const pause = useCallback(() => {
    update(performance.now())
    active.current = false
    deadline.current = null
    setPlaying(false)
    setCountdown(null)
  }, [update])
  const seek = useCallback(
    (seconds: number, limit = total) => {
      if (active.current) return
      position.current = Math.max(0, Math.min(limit, seconds))
      setElapsed(position.current)
      setSeekRevision((value) => value + 1)
    },
    [total],
  )
  const play = useCallback(
    (withCountdown: boolean) => {
      if (total <= 0 || active.current) return
      if (position.current >= total) {
        position.current = 0
        setElapsed(0)
        setSeekRevision((value) => value + 1)
      }
      const now = performance.now()
      previous.current = now
      deadline.current = withCountdown ? now + 3000 : null
      active.current = true
      setCountdown(withCountdown ? 3 : null)
      setNotice('')
      setPlaying(true)
    },
    [total],
  )
  const setRate = useCallback(
    (value: number) => {
      update(performance.now())
      speed.current = Math.round(Math.max(0.5, Math.min(2, value)) * 10) / 10
      setRateValue(speed.current)
    },
    [update],
  )
  useEffect(() => {
    let frame = 0
    const tick = (now: number) => {
      if (!active.current) return
      if (now - previous.current > 3000) {
        previous.current = now
        pause()
        setNotice('检测到运行中断，已暂停在当前位置。')
        return
      }
      if (deadline.current !== null) {
        const remaining = Math.ceil((deadline.current - now) / 1000)
        if (remaining > 0) {
          setCountdown(remaining)
          previous.current = now
        } else {
          previous.current = deadline.current
          deadline.current = null
          setCountdown(null)
          update(now)
        }
      } else update(now)
      if (position.current >= total) {
        active.current = false
        setPlaying(false)
        return
      }
      frame = requestAnimationFrame(tick)
    }
    if (playing) frame = requestAnimationFrame(tick)
    const hide = () => {
      if (active.current) {
        pause()
        setNotice('页面离开前台，口播已暂停。回到页面后可继续。')
      }
    }
    const visibility = () => {
      if (document.hidden) hide()
    }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', hide)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', hide)
    }
  }, [playing, total, pause, update])
  useEffect(() => {
    if (!playing && !recording) return
    let disposed = false
    let lock: WakeLockSentinel | undefined
    if (!navigator.wakeLock) {
      setWake('此浏览器不支持保持屏幕常亮')
      return
    }
    void navigator.wakeLock
      .request('screen')
      .then((result) => {
        if (disposed) {
          void result.release()
          return
        }
        lock = result
        setWake('屏幕常亮已生效')
        result.addEventListener('release', () => {
          if (!disposed) setWake('屏幕常亮已被系统释放')
        })
      })
      .catch(() => {
        if (!disposed) setWake('未能保持常亮，请留意屏幕状态')
      })
    return () => {
      disposed = true
      void lock?.release()
      setWake('播放时尝试保持屏幕常亮')
    }
  }, [playing, recording])
  return {
    elapsed,
    seekRevision,
    playing,
    countdown,
    notice,
    wake,
    rate,
    setRate,
    play,
    pause,
    seek,
    dismissNotice: () => setNotice(''),
  }
}
