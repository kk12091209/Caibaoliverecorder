import { useRef, useState } from 'react'
import { CameraIcon, Cross2Icon, ReloadIcon, UploadIcon } from '@radix-ui/react-icons'
import type { Capture } from '../hooks/useCapture'
import { useTutorialCamera } from './TutorialCamera'
import { isMobileCameraDevice } from '../model/capture-media'

export function Camera({ capture }: { capture: Capture }) {
  const {
    enabled,
    busy,
    active,
    devices,
    device,
    facing,
    video,
    openCamera,
    closeCamera,
    flipCamera,
  } = capture
  const [mobile] = useState(() => isMobileCameraDevice(navigator))
  const tutorial = useTutorialCamera()
  const fileInput = useRef<HTMLInputElement>(null)
  return (
    <>
      <video
        className={`tp-camera-video ${enabled ? 'is-on' : ''} ${!tutorial && facing === 'user' ? 'is-mirrored' : ''}`}
        ref={video}
        muted
        playsInline
        aria-hidden={!enabled}
        aria-label={tutorial ? '图片演示预览' : '本地摄像头预览'}
      />
      <div className="tp-camera-controls">
        {tutorial && <span className="tp-tutorial-badge">图片演示</span>}
        {!enabled && !busy && (
          <button
            type="button"
            disabled={active || tutorial?.loading}
            onClick={() => void openCamera()}
          >
            <CameraIcon /> 开启摄像头
          </button>
        )}
        {busy && (
          <button type="button" onClick={closeCamera}>
            取消开启
          </button>
        )}
        {enabled && (
          <>
            {tutorial ? (
              <>
                <button
                  type="button"
                  disabled={active || tutorial.loading}
                  onClick={() => fileInput.current?.click()}
                >
                  <UploadIcon />
                  {tutorial.loading ? '读取中…' : '上传图片'}
                </button>
                <button
                  type="button"
                  disabled={active || tutorial.loading}
                  onClick={tutorial.black}
                >
                  黑屏
                </button>
                <button
                  type="button"
                  disabled={active || tutorial.loading}
                  aria-label="恢复演示图片"
                  onClick={tutorial.restore}
                >
                  <ReloadIcon />
                </button>
              </>
            ) : mobile ? (
              <button
                type="button"
                disabled={active || busy}
                aria-label={facing === 'user' ? '切换到后置摄像头' : '切换到前置摄像头'}
                onClick={() => void flipCamera()}
              >
                <ReloadIcon />
                翻转摄像头
              </button>
            ) : (
              <label className="tp-camera-select">
                <span className="tp-sr-only">选择摄像头</span>
                <select
                  disabled={active || busy}
                  value={device}
                  onChange={(event) => void openCamera(event.target.value)}
                >
                  <option value="">默认摄像头</option>
                  {devices.map((entry, index) => (
                    <option value={entry.deviceId} key={entry.deviceId}>
                      {entry.label || `摄像头 ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button type="button" disabled={active} aria-label="关闭摄像头" onClick={closeCamera}>
              <Cross2Icon />
            </button>
          </>
        )}
      </div>
      {tutorial && (
        <>
          <input
            className="tp-sr-only"
            aria-label="选择演示图片"
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
            disabled={active}
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void tutorial.upload(file)
            }}
          />
          {tutorial.error && (
            <p className="tp-camera-error" role="alert">
              {tutorial.error}
            </p>
          )}
        </>
      )}
    </>
  )
}
