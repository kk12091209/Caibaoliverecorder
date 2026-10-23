import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { CaptureDevicesContext } from '../hooks/useCapture'
import defaultImage from '../../../assets/teleprompter-demo.jpeg'

export const TUTORIAL_CAMERA_ENABLED =
  import.meta.env.MODE === 'tutorial' ||
  (import.meta.env.DEV && import.meta.env.VITE_TELEPROMPTER_DEMO === 'true')
type Tutorial = {
  microphone: boolean
  setMicrophone: (value: boolean) => void
  upload: (file: File) => Promise<void>
  black: () => void
  restore: () => void
  error: string
  loading: boolean
}
const TutorialContext = createContext<Tutorial | null>(null)
export const useTutorialCamera = () => useContext(TutorialContext)
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片无法读取，请换一张 JPG、PNG 或 WebP 图片。'))
    image.src = url
  })
}

/** A tutorial source. It never asks for a physical video device. */
export function TutorialCameraProvider({ children }: { children: ReactNode }) {
  const [initialImage] = useState(() => loadImage(defaultImage))
  const image = useRef<Promise<HTMLImageElement | null>>(initialImage)
  const objectUrl = useRef<string | null>(null)
  const version = useRef(0)
  const resources = useRef(new Set<() => void>())
  const microphoneRef = useRef(false)
  const [microphone, setMic] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const source = useMemo(
    () => ({
      enumerateDevices: async () => [] as MediaDeviceInfo[],
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        const tracks: MediaStreamTrack[] = []
        const owned: (() => void)[] = []
        function own(track: MediaStreamTrack, cleanup: () => void) {
          const originalStop = track.stop.bind(track)
          let closed = false
          const dispose = () => {
            if (closed) return
            closed = true
            originalStop()
            cleanup()
            resources.current.delete(dispose)
          }
          track.stop = dispose
          resources.current.add(dispose)
          owned.push(dispose)
          tracks.push(track)
        }
        try {
          if (constraints.video) {
            if (!HTMLCanvasElement.prototype.captureStream)
              throw new Error('当前浏览器不支持图片演示录制，请使用较新的浏览器。')
            let picture = await image.current
            const canvas = document.createElement('canvas')
            canvas.width = 720
            canvas.height = 720
            const context = canvas.getContext('2d')!
            const draw = () => {
              context.fillStyle = '#000000'
              context.fillRect(0, 0, 720, 720)
              if (picture) {
                const ratio = Math.min(720 / picture.naturalWidth, 720 / picture.naturalHeight)
                const width = picture.naturalWidth * ratio,
                  height = picture.naturalHeight * ratio
                context.drawImage(picture, (720 - width) / 2, (720 - height) / 2, width, height)
              }
            }
            draw()
            const stream = canvas.captureStream(30)
            const timer = window.setInterval(() => {
              void image.current
                .then((value) => {
                  picture = value
                  draw()
                })
                .catch(() => {})
            }, 1000 / 30)
            own(stream.getVideoTracks()[0], () => clearInterval(timer))
          }
          if (constraints.audio) {
            if (microphoneRef.current) {
              const stream = await navigator.mediaDevices.getUserMedia({
                audio: constraints.audio,
                video: false,
              })
              stream.getAudioTracks().forEach((track) => own(track, () => {}))
            } else {
              const audio = new AudioContext()
              const destination = audio.createMediaStreamDestination()
              const oscillator = audio.createOscillator()
              const gain = audio.createGain()
              gain.gain.value = 0
              oscillator.connect(gain).connect(destination)
              oscillator.start()
              own(destination.stream.getAudioTracks()[0], () => {
                oscillator.stop()
                void audio.close()
              })
              await audio.resume()
            }
          }
          return new MediaStream(tracks)
        } catch (problem) {
          owned.forEach((dispose) => dispose())
          throw problem
        }
      },
    }),
    [],
  )
  function releaseUrl() {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    objectUrl.current = null
  }
  async function upload(file: File) {
    const token = ++version.current
    setError('')
    setLoading(true)
    let url = ''
    try {
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'].includes(file.type))
        throw new Error('请选择 JPG、PNG、WebP、AVIF 或 GIF 图片。')
      if (file.size > 10 * 1024 * 1024) throw new Error('图片请控制在 10 MB 以内。')
      url = URL.createObjectURL(file)
      const decoded = await loadImage(url)
      if (decoded.naturalWidth * decoded.naturalHeight > 24000000)
        throw new Error('图片尺寸过大，请缩小后再使用。')
      if (token !== version.current) {
        URL.revokeObjectURL(url)
        return
      }
      image.current = Promise.resolve(decoded)
      releaseUrl()
      objectUrl.current = url
    } catch (problem) {
      if (url) URL.revokeObjectURL(url)
      if (token === version.current) setError((problem as Error).message)
    } finally {
      if (token === version.current) setLoading(false)
    }
  }
  useEffect(
    () => () => {
      version.current++
      releaseUrl()
      ;[...resources.current].forEach((dispose) => dispose())
    },
    [],
  )
  const value: Tutorial = {
    microphone,
    setMicrophone: (value) => {
      microphoneRef.current = value
      setMic(value)
    },
    upload,
    error,
    loading,
    black: () => {
      version.current++
      image.current = Promise.resolve(null)
      releaseUrl()
      setError('')
      setLoading(false)
    },
    restore: () => {
      version.current++
      image.current = loadImage(defaultImage)
      releaseUrl()
      setError('')
      setLoading(false)
    },
  }
  return (
    <TutorialContext.Provider value={value}>
      <CaptureDevicesContext.Provider value={source}>{children}</CaptureDevicesContext.Provider>
    </TutorialContext.Provider>
  )
}
