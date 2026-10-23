import { useState } from 'react'
import {
  DownloadIcon,
  PauseIcon,
  PlayIcon,
  StopIcon,
  VideoIcon,
  SpeakerLoudIcon,
} from '@radix-ui/react-icons'
import { formatTime } from '../model/teleprompter'
import type { RecordingMode } from '../model/recording'
import type { Capture } from '../hooks/useCapture'
import { useTutorialCamera } from './TutorialCamera'

export function RecordingControls({
  capture,
  start,
  pause,
  resume,
  stop,
  sync,
  setSync,
  canSync,
}: {
  capture: Capture
  start: (mode: RecordingMode) => void
  pause: () => void
  resume: () => void
  stop: () => void
  sync: boolean
  setSync: (sync: boolean) => void
  canSync: boolean
}) {
  const [mode, setMode] = useState<RecordingMode>('video')
  const tutorial = useTutorialCamera()
  const { status, active, elapsed, bytes, result, unsaved, error } = capture
  return (
    <section className="tp-recording" aria-label="本地录制">
      <div className="tp-record-heading">
        <h3>
          <VideoIcon /> 本地录制
        </h3>
        <span className={status === 'recording' ? 'tp-record-live' : ''} role="status">
          {status === 'requesting'
            ? '等待设备授权'
            : status === 'recording'
              ? '录制中'
              : status === 'paused'
                ? '录制已暂停'
                : status === 'stopping'
                  ? '正在整理录制'
                  : result
                    ? unsaved
                      ? '待保存'
                      : '已确认保存'
                    : '未开始'}
        </span>
      </div>
      <div className="tp-record-options">
        <label>
          录制内容{' '}
          <select
            aria-label="录制内容"
            disabled={active}
            value={mode}
            onChange={(event) => setMode(event.target.value as RecordingMode)}
          >
            <option value="video">视频和声音</option>
            <option value="audio">仅声音</option>
          </select>
        </label>
        <label className="tp-check">
          <input
            type="checkbox"
            disabled={active || !canSync}
            checked={sync}
            onChange={(event) => setSync(event.target.checked)}
          />{' '}
          同步提词
        </label>
      </div>
      <div className="tp-record-actions">
        {!active && (
          <button
            type="button"
            className="tp-record-start"
            disabled={capture.busy}
            onClick={() => start(mode)}
          >
            {mode === 'video' ? <VideoIcon /> : <SpeakerLoudIcon />}
            {mode === 'video' ? '开始录制' : '开始录音'}
          </button>
        )}
        {status === 'requesting' && (
          <button type="button" onClick={capture.cancelStart}>
            取消开启
          </button>
        )}
        {status === 'recording' && (
          <button type="button" onClick={pause}>
            <PauseIcon /> 暂停录制
          </button>
        )}
        {status === 'paused' && (
          <button type="button" onClick={resume}>
            <PlayIcon /> 继续录制
          </button>
        )}
        {(status === 'recording' || status === 'paused') && (
          <button type="button" className="tp-record-stop" onClick={stop}>
            <StopIcon /> 结束并保存
          </button>
        )}
        {result && !active && (
          <button type="button" onClick={() => capture.setShowSave(true)}>
            <DownloadIcon /> 查看并保存
          </button>
        )}
        <time>
          {formatTime(elapsed)} <small>· {(bytes / 1024 / 1024).toFixed(1)} MB</small>
        </time>
      </div>
      {error && (
        <p className="tp-error" role="alert">
          {error}
        </p>
      )}
      {!tutorial && (status === 'recording' || status === 'paused') && (
        <p className="tp-microphone-status" role="status">
          麦克风已连接{status === 'paused' ? ' · 录制已暂停' : ' · 正在录制声音'}
        </p>
      )}
      <p className="tp-record-note">
        {tutorial
          ? `${mode === 'video' ? '当前录制图片画面，提词文字不会写入视频。' : '当前为音频演示。'}${tutorial.microphone ? '使用麦克风录制声音。' : '声音为静音。'}`
          : mode === 'video'
            ? '录制摄像头画面与麦克风，不包含提词文字。'
            : '仅使用麦克风，无需摄像头。'}
        录制只留在本页，关闭前请保存。单次上限 256 MB。
      </p>
    </section>
  )
}
