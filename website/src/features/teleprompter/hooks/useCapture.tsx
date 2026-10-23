import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useBlocker } from 'react-router-dom'
import {
  RecordingSession,
  type RecordingMode,
  type RecordingResult,
  type RecordingStatus,
} from '../model/recording'
import { cameraConstraints, requireLiveTracks } from '../model/capture-media'

// Allows synthetic media in browser tests without accessing real camera/microphone devices.
export const CaptureDevicesContext = createContext<Pick<
  MediaDevices,
  'getUserMedia' | 'enumerateDevices'
> | null>(null)
const release = (stream: MediaStream | null) => stream?.getTracks().forEach((track) => track.stop())

export function useCapture(hasScript = false) {
  const injected = useContext(CaptureDevicesContext)
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [device, setDevice] = useState('')
  const [facing, setFacing] = useState<'user' | 'environment'>('user')
  const [error, setError] = useState('')
  const [status, setStatus] = useState<RecordingStatus>('idle')
  const [result, setResult] = useState<RecordingResult | null>(null)
  const [unsaved, setUnsaved] = useState(false)
  const [showSave, setShowSave] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [bytes, setBytes] = useState(0)
  const video = useRef<HTMLVideoElement>(null)
  const camera = useRef<MediaStream | null>(null)
  const microphone = useRef<MediaStream | null>(null)
  const session = useRef<RecordingSession | null>(null)
  const previewToken = useRef(0)
  const recordToken = useRef(0)
  const acquiring = useRef(false)
  const mounted = useRef(true)
  const autoOpened = useRef(false)
  const active = ['requesting', 'recording', 'paused', 'stopping'].includes(status)
  const blocker = useBlocker(active || unsaved || hasScript)
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    if (acquiring.current) cancelStart()
    if (session.current?.status === 'recording') pause()
  }, [blocker.state, status])
  const getDevices = () => {
    const value = injected ?? navigator.mediaDevices
    if (!value?.getUserMedia)
      throw new Error('当前页面无法使用摄像头或麦克风，请通过 HTTPS 或本机浏览器访问。')
    return value
  }
  const fail = (problem: unknown) => {
    const name = (problem as Error).name
    setError(
      name === 'NotAllowedError'
        ? '未获摄像头或麦克风授权。可在浏览器权限中开启，仍可继续提词。'
        : name === 'NotFoundError'
          ? '未找到需要的摄像头或麦克风。没有摄像头时可以选择仅录音。'
          : name === 'NotReadableError'
            ? '摄像头或麦克风可能被其他应用占用，请检查后重试。'
            : (problem as Error).message || '暂时无法开始录制，请检查设备后重试。',
    )
  }
  function closeCamera() {
    if (
      acquiring.current ||
      ['recording', 'paused', 'stopping'].includes(session.current?.status ?? '')
    )
      return
    previewToken.current++
    release(camera.current)
    camera.current = null
    if (video.current) video.current.srcObject = null
    setEnabled(false)
    setBusy(false)
  }
  async function openCamera(nextDevice = device, nextFacing = facing, switching = false) {
    if (
      acquiring.current ||
      ['recording', 'paused', 'stopping'].includes(session.current?.status ?? '')
    )
      return
    const token = ++previewToken.current
    release(camera.current)
    camera.current = null
    if (video.current) video.current.srcObject = null
    setEnabled(false)
    setBusy(true)
    setError('')
    let opened: MediaStream | null = null
    try {
      const stream = (opened = await getDevices().getUserMedia({
        audio: false,
        video: cameraConstraints(nextDevice, nextFacing, switching),
      }))
      if (!mounted.current || token !== previewToken.current) {
        release(stream)
        return
      }
      requireLiveTracks(stream, 'video')
      camera.current = stream
      if (video.current) {
        video.current.srcObject = stream
        await video.current.play()
      }
      if (token !== previewToken.current || !mounted.current) return
      setEnabled(true)
      const actual = stream.getVideoTracks()[0]?.getSettings().facingMode
      setFacing(actual === 'user' || actual === 'environment' ? actual : nextFacing)
      setDevice(nextDevice)
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (camera.current === stream) {
          camera.current = null
          setEnabled(false)
          setError('摄像头已断开，仍可继续提词。')
          void session.current?.stop('摄像头已断开，已结束录制并保留收到的内容。')
        }
      })
      // Failure to enumerate labels must not discard a successfully opened preview.
      const found = await getDevices()
        .enumerateDevices()
        .catch(() => [])
      if (mounted.current && token === previewToken.current)
        setDevices(found.filter((entry) => entry.kind === 'videoinput'))
    } catch (problem) {
      release(opened)
      if (mounted.current && token === previewToken.current) {
        camera.current = null
        if (video.current) video.current.srcObject = null
        if (
          switching &&
          ['OverconstrainedError', 'NotFoundError'].includes((problem as Error).name)
        )
          setError('没有找到可切换的摄像头，请重新开启当前摄像头。')
        else fail(problem)
      }
    } finally {
      if (mounted.current && token === previewToken.current) setBusy(false)
    }
  }
  function cancelStart() {
    recordToken.current++
    acquiring.current = false
    release(microphone.current)
    microphone.current = null
    if (autoOpened.current) {
      release(camera.current)
      camera.current = null
      setEnabled(false)
    }
    setStatus(result ? 'ready' : 'idle')
  }
  async function start(mode: RecordingMode) {
    if (
      acquiring.current ||
      busy ||
      ['recording', 'paused', 'stopping'].includes(session.current?.status ?? '')
    )
      return false
    if (unsaved && !window.confirm('上一份录制还没有保存。开始新录制会替换它，是否继续？'))
      return false
    if (!window.MediaRecorder) {
      setError('此浏览器不支持本地录制，请使用较新的 Safari、Chrome 或 Edge。')
      return false
    }
    const token = ++recordToken.current
    acquiring.current = true
    setStatus('requesting')
    setError('')
    let acquired: MediaStream | null = null
    if (
      camera.current &&
      !camera.current.getVideoTracks().some((track) => track.readyState === 'live')
    ) {
      release(camera.current)
      camera.current = null
      setEnabled(false)
    }
    const openedForRecording = mode === 'video' && !camera.current
    autoOpened.current = openedForRecording
    try {
      acquired = await getDevices().getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: openedForRecording ? cameraConstraints(device, facing) : false,
      })
      if (token !== recordToken.current || !mounted.current) {
        release(acquired)
        return false
      }
      requireLiveTracks(acquired, 'audio')
      microphone.current = new MediaStream(acquired.getAudioTracks())
      if (openedForRecording) {
        camera.current = new MediaStream(acquired.getVideoTracks())
        requireLiveTracks(camera.current, 'video')
        if (video.current) {
          video.current.srcObject = camera.current
          await video.current.play()
        }
        if (token !== recordToken.current || !mounted.current) {
          release(acquired)
          return false
        }
        setEnabled(true)
        const actual = camera.current.getVideoTracks()[0]?.getSettings().facingMode
        if (actual === 'user' || actual === 'environment') setFacing(actual)
      }
      const stream = new MediaStream([
        ...(mode === 'video' ? (camera.current?.getVideoTracks() ?? []) : []),
        ...acquired.getAudioTracks(),
      ])
      if (mode === 'video') requireLiveTracks(stream, 'video')
      session.current?.dispose()
      const current = new RecordingSession(stream, mode, {
        create: (media, options) => new MediaRecorder(media, options),
        supported: (mime) => MediaRecorder.isTypeSupported(mime),
        changed: () => {
          if (mounted.current && session.current === current) {
            setStatus(current.status)
            setElapsed(current.elapsed)
            setBytes(current.bytes)
          }
        },
        finished: (value, problem) => {
          release(microphone.current)
          microphone.current = null
          if (openedForRecording) {
            release(camera.current)
            camera.current = null
            if (video.current) video.current.srcObject = null
            if (mounted.current) setEnabled(false)
          }
          if (!mounted.current || token !== recordToken.current) return
          setResult(value)
          setUnsaved(Boolean(value))
          setStatus(value ? 'ready' : 'idle')
          setError(problem)
          setShowSave(Boolean(value))
        },
      })
      session.current = current
      stream.getTracks().forEach((track) => {
        track.addEventListener(
          'ended',
          () => {
            if (session.current === current)
              void current.stop('摄像头或麦克风已断开，已保留收到的内容。')
          },
          { once: true },
        )
        track.addEventListener('mute', () => {
          if (session.current === current && current.status === 'recording') {
            pause()
            setError('输入设备暂时中断，录制已暂停。请检查画面和声音后继续。')
          }
        })
      })
      current.start()
      setResult(null)
      setUnsaved(false)
      setElapsed(0)
      setBytes(0)
      return true
    } catch (problem) {
      release(acquired)
      if (token !== recordToken.current) return false
      release(microphone.current)
      microphone.current = null
      if (openedForRecording) {
        release(camera.current)
        camera.current = null
        if (video.current) video.current.srcObject = null
        if (mounted.current) setEnabled(false)
      }
      if (mounted.current && token === recordToken.current) {
        setStatus(result ? 'ready' : 'idle')
        fail(problem)
      }
      return false
    } finally {
      if (token === recordToken.current) acquiring.current = false
    }
  }
  const pause = () => {
    try {
      session.current?.pause()
    } catch (problem) {
      fail(problem)
      void session.current?.stop('录制暂停失败，已结束并保留已有内容。')
    }
  }
  const resume = () => {
    try {
      session.current?.resume()
      setError('')
      return session.current?.status === 'recording'
    } catch (problem) {
      fail(problem)
      return false
    }
  }
  const stop = () => session.current?.stop()
  useEffect(() => {
    mounted.current = true
    // A development hot refresh can retain hook state after its media resources were released.
    if (['requesting', 'recording', 'paused', 'stopping'].includes(status)) {
      session.current = null
      acquiring.current = false
      setStatus(result ? 'ready' : 'idle')
      setEnabled(false)
      setBusy(false)
      setElapsed(0)
      setBytes(0)
      setError('本地预览代码已刷新，录制已中断，请重新开始。')
    }
    return () => {
      mounted.current = false
      previewToken.current++
      recordToken.current++
      session.current?.dispose()
      release(camera.current)
      release(microphone.current)
      camera.current = null
      microphone.current = null
    }
  }, [])
  useEffect(() => {
    if (status !== 'recording') return
    const timer = setInterval(() => {
      if (session.current) {
        setElapsed(session.current.elapsed)
        setBytes(session.current.bytes)
      }
    }, 250)
    return () => clearInterval(timer)
  }, [status])
  useEffect(() => {
    const hide = () => {
      if (session.current?.status === 'recording') {
        pause()
        setError('页面离开前台，录制已暂停。返回后请点击继续。')
      }
    }
    const visibility = () => {
      if (document.hidden) hide()
    }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', hide)
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', hide)
    }
  }, [])
  useEffect(() => {
    const protectedTake = active || unsaved || hasScript
    if (!protectedTake) return
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', unload)
    return () => window.removeEventListener('beforeunload', unload)
  }, [active, unsaved, hasScript])
  return {
    blocker,
    video,
    enabled,
    busy,
    devices,
    device,
    facing,
    error,
    status,
    active,
    result,
    unsaved,
    showSave,
    setShowSave,
    elapsed,
    bytes,
    openCamera,
    closeCamera,
    flipCamera: () => openCamera('', facing === 'user' ? 'environment' : 'user', true),
    start,
    cancelStart,
    pause,
    resume,
    stop,
    markSaved: () => setUnsaved(false),
  }
}
export type Capture = ReturnType<typeof useCapture>
