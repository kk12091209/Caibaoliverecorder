import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeftIcon,
  CopyIcon,
  FileTextIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  ResetIcon,
  TrackNextIcon,
  TrackPreviousIcon,
  TrashIcon,
  Pencil1Icon,
  StopIcon,
} from '@radix-ui/react-icons'
import { Mark } from '../../shared/ui/Mark'
import { ContinuousReader } from './components/ContinuousReader'
import { ReorderHandle } from './components/ReorderHandle'
import { RecordingControls } from './components/RecordingControls'
import { SaveRecording } from './components/SaveRecording'
import { useCapture } from './hooks/useCapture'
import type { RecordingMode } from './model/recording'
import { Camera } from './components/Camera'
import { BoundedNumber, Modal, ScriptDialog, SegmentDialog } from './components/Dialogs'
import { usePlayback } from './hooks/usePlayback'
import {
  allocatedCharacterCount,
  appendSpeechText,
  buildCues,
  countCharacters,
  cueAt,
  formatTime,
  saveSpeechText,
  speechText,
  swapSegments,
  TEMPLATE,
  type Draft,
  type Segment,
} from './model/teleprompter'
import { PromptOverlay } from './components/PromptOverlay'
import { PromptColors } from './components/PromptColors'
import {
  TUTORIAL_CAMERA_ENABLED,
  TutorialCameraProvider,
  useTutorialCamera,
} from './components/TutorialCamera'
import {
  defaultAppearance,
  parseAppearance,
  promptTextMetrics,
  PROMPT_APPEARANCE_KEY,
  resolvePromptTheme,
} from './model/prompt-style'
import './teleprompter.css'

function emptyDraft(): Draft {
  return { schema: 1, title: '', source: '', rate: 220, segments: [] }
}

export function TeleprompterPage() {
  return TUTORIAL_CAMERA_ENABLED ? (
    <TutorialCameraProvider>
      <TeleprompterWorkspace />
    </TutorialCameraProvider>
  ) : (
    <TeleprompterWorkspace />
  )
}

function TeleprompterWorkspace() {
  const [draft, setDraft] = useState(emptyDraft)
  const [dialog, setDialog] = useState<'source' | 'speech' | 'pause' | 'edit' | 'template' | null>(
    null,
  )
  const [editing, setEditing] = useState<Segment | undefined>()
  const [appearance, setAppearance] = useState(() => {
    try {
      return parseAppearance(localStorage.getItem(PROMPT_APPEARANCE_KEY))
    } catch {
      return defaultAppearance()
    }
  })
  const [adjusting, setAdjusting] = useState(false)
  const tutorial = useTutorialCamera()
  const theme = useMemo(
    () => resolvePromptTheme(appearance),
    [appearance.theme, appearance.customColors],
  )
  const [withCountdown, setWithCountdown] = useState(true)
  const [message, setMessage] = useState('')
  const [swapId, setSwapId] = useState<string | null>(null)
  const [swapTarget, setSwapTarget] = useState<string | null>(null)
  const [orderUndo, setOrderUndo] = useState<{
    before: Segment[]
    after: Segment[]
    elapsed: number
  } | null>(null)
  const previewRef = useRef<HTMLElement>(null)
  const cues = useMemo(() => buildCues(draft.segments), [draft.segments])
  const total = cues.at(-1)?.end ?? 0
  const hasScript = Boolean(draft.source.trim() || draft.segments.length)
  const capture = useCapture(hasScript)
  const playback = usePlayback(cues, capture.status === 'recording')
  const [syncRecording, setSyncRecording] = useState(true)
  const editingLocked = playback.playing || capture.active
  const current = cueAt(cues, playback.elapsed)
  const activeSegment = current
  const [deleteTarget, setDeleteTarget] = useState<Segment | null>(null)

  useEffect(() => {
    document.title = '菜包口播助手 · 菜包宇宙'
  }, [])
  useEffect(() => {
    try {
      localStorage.setItem(PROMPT_APPEARANCE_KEY, JSON.stringify(appearance))
    } catch {
      /* Appearance remains usable when storage is unavailable. */
    }
  }, [appearance])
  useEffect(() => {
    if (editingLocked) setAdjusting(false)
  }, [editingLocked])
  useEffect(() => {
    if (
      capture.status === 'requesting' ||
      capture.status === 'paused' ||
      capture.status === 'stopping' ||
      capture.status === 'ready'
    )
      playback.pause()
  }, [capture.status, playback.pause])
  useEffect(() => {
    if (capture.status === 'recording' || playback.playing)
      previewRef.current?.scrollIntoView({
        block: 'start',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      })
  }, [capture.status, playback.playing])
  useEffect(() => {
    if (playback.notice && capture.status === 'recording') capture.pause()
  }, [playback.notice, capture.status])
  useEffect(() => {
    if (editingLocked) {
      setSwapId(null)
      setSwapTarget(null)
    }
  }, [editingLocked])
  async function startRecording(mode: RecordingMode) {
    playback.pause()
    if ((await capture.start(mode)) && syncRecording && total > 0) playback.play(withCountdown)
  }
  function pauseRecording() {
    capture.pause()
    if (syncRecording) playback.pause()
  }
  function resumeRecording() {
    if (capture.resume() && syncRecording && total > 0 && playback.elapsed < total)
      playback.play(false)
  }
  function stopRecording() {
    playback.pause()
    void capture.stop()
  }
  function togglePlayback() {
    if (syncRecording && capture.status === 'recording') {
      pauseRecording()
      return
    }
    if (syncRecording && capture.status === 'paused') {
      resumeRecording()
      return
    }
    if (playback.playing) playback.pause()
    else playback.play(withCountdown)
  }

  function choose(segment: Segment) {
    if (editingLocked) return
    if (swapId) {
      exchange(swapId, segment.id)
      return
    }
    playback.seek(segment.start)
  }
  function editPause(segment: Segment) {
    if (editingLocked) return
    if (swapId) {
      exchange(swapId, segment.id)
      return
    }
    playback.seek(segment.start)
    setEditing(segment)
    setDialog('edit')
  }
  function saveSegment(segment: Segment, text?: string, append = false) {
    const next =
      segment.kind === 'speech' && text !== undefined
        ? append
          ? appendSpeechText(draft, segment, text)
          : saveSpeechText(draft, segment, text)
        : {
            ...draft,
            segments: [...draft.segments.filter((s) => s.id !== segment.id), segment].sort(
              (a, b) => a.start - b.start,
            ),
          }
    setDraft(next)
    setDialog(null)
    playback.seek(segment.start, Math.max(total, segment.end))
  }
  function exchange(first: string, second: string | null) {
    if (editingLocked) return
    if (first === second) return
    setSwapId(null)
    setSwapTarget(null)
    if (!second) return
    try {
      const segments = swapSegments(draft.segments, first, second)
      setOrderUndo({ before: draft.segments, after: segments, elapsed: playback.elapsed })
      setDraft((value) => ({ ...value, segments }))
      playback.seek(segments.find((segment) => segment.id === first)?.start ?? 0)
    } catch (problem) {
      setMessage((problem as Error).message)
    }
  }
  function resetPosition() {
    playback.seek(0)
  }
  async function copyTemplate() {
    try {
      await navigator.clipboard.writeText(TEMPLATE)
      setMessage('模板已复制，可修改时间并填入台本后粘贴。')
    } catch {
      setDialog('template')
    }
  }
  return (
    <div className="tp-app">
      <header className="tp-nav">
        <Link className="brand" to="/">
          <Mark className="brand-mark" />
          <span>
            <strong>菜包宇宙</strong>
            <small>Caibao Universe</small>
          </span>
        </Link>
        <span className="tp-nav-product">
          菜包口播助手 <small>TELEPROMPTER</small>
        </span>
        <Link to="/works/teleprompter" className="tp-back">
          <ArrowLeftIcon /> 返回产品
        </Link>
      </header>
      <main className="tp-main">
        <div className="tp-heading">
          <div>
            <p className="tp-eyebrow">YOUR WORDS, YOUR PACE</p>
            <h1>菜包口播助手</h1>
          </div>
          <p className="tp-session-note">
            本次内容仅在当前页面保留
            <br />
            刷新或退出前，请保存录制
          </p>
        </div>
        {(message || playback.notice) && (
          <div className="tp-notice" role="status">
            {message || playback.notice}
            <button
              type="button"
              aria-label="关闭提示"
              onClick={() => {
                setMessage('')
                playback.dismissNotice()
              }}
            >
              ×
            </button>
          </div>
        )}
        <div className="tp-workspace">
          <aside className="tp-segments tp-panel">
            <div className="tp-panel-title">
              <h2>
                <FileTextIcon /> 台本分段
              </h2>
              <span>{cues.length} 段</span>
            </div>
            <div className="tp-source-actions">
              <button
                type="button"
                disabled={editingLocked}
                onClick={() => {
                  setSwapId(null)
                  setDialog('source')
                }}
              >
                粘贴台本
              </button>
              <button type="button" onClick={() => void copyTemplate()}>
                <CopyIcon /> 复制模板
              </button>
            </div>
            <div className="tp-sort-notice" role="status">
              {swapId ? (
                <>
                  <span>选择另一段交换，时长保持不变。</span>
                  <button
                    type="button"
                    onClick={() => {
                      setSwapId(null)
                      setSwapTarget(null)
                    }}
                  >
                    取消
                  </button>
                </>
              ) : orderUndo && draft.segments === orderUndo.after ? (
                <>
                  <span>已交换，起止时间已重新排列。</span>
                  <button
                    type="button"
                    disabled={editingLocked}
                    onClick={() => {
                      setDraft((value) => ({
                        ...value,
                        segments: orderUndo.before,
                      }))
                      playback.seek(orderUndo.elapsed)
                      setOrderUndo(null)
                    }}
                  >
                    撤销
                  </button>
                </>
              ) : (
                <span>长按手柄交换，时长随分段移动。</span>
              )}
            </div>
            <div className="tp-segment-list">
              {cues.map((cue, index) => (
                <div
                  data-sort-id={cue.automatic ? undefined : cue.id}
                  className={`tp-segment ${cue.id === current?.id ? 'is-selected' : ''} ${cue.kind === 'pause' ? 'is-pause' : ''} ${playback.playing && current?.id === cue.id ? 'is-playing' : ''} ${swapId === cue.id ? 'is-swapping' : ''} ${swapTarget === cue.id && swapId !== cue.id ? 'is-swap-target' : ''}`}
                  key={cue.id}
                >
                  <button
                    type="button"
                    className="tp-segment-main"
                    disabled={editingLocked || Boolean(swapId && cue.automatic)}
                    onClick={() => (cue.kind === 'pause' ? editPause(cue) : choose(cue))}
                  >
                    <div>
                      <span>
                        {cue.kind === 'pause' ? <PauseIcon /> : String(index + 1).padStart(2, '0')}
                      </span>
                      <strong>
                        {cue.kind === 'pause'
                          ? `停顿 ${cue.end - cue.start} 秒`
                          : `第 ${index + 1} 段`}
                      </strong>
                      {cue.automatic && <small>自动</small>}
                    </div>
                    <time>
                      {formatTime(cue.start)} — {formatTime(cue.end)}
                    </time>
                    {cue.kind === 'speech' ? (
                      <p>{speechText(draft.source, cue)}</p>
                    ) : cue.note ? (
                      <p className="tp-segment-note">
                        <span>动作提示</span>
                        {cue.note}
                      </p>
                    ) : (
                      <p className="tp-segment-note tp-segment-note-empty">添加动作提示</p>
                    )}
                  </button>
                  <div className="tp-segment-actions">
                    {!cue.automatic && (
                      <ReorderHandle
                        label={`长按交换第 ${index + 1} 段顺序`}
                        active={swapId === cue.id}
                        disabled={editingLocked || Boolean(dialog)}
                        lift={() => {
                          setSwapId(cue.id)
                          setSwapTarget(null)
                        }}
                        hover={setSwapTarget}
                        drop={(target) => exchange(cue.id, target)}
                      />
                    )}
                    <button
                      type="button"
                      aria-label={
                        cue.kind === 'pause'
                          ? `编辑 ${formatTime(cue.start)} 停顿提示`
                          : `编辑 ${formatTime(cue.start)} 分段`
                      }
                      disabled={editingLocked}
                      onClick={() => {
                        setSwapId(null)
                        setEditing(cue)
                        setDialog('edit')
                      }}
                    >
                      <Pencil1Icon />
                    </button>
                    {!cue.automatic && (
                      <button
                        type="button"
                        aria-label={`删除 ${formatTime(cue.start)} 分段`}
                        disabled={editingLocked}
                        onClick={() => {
                          setSwapId(null)
                          setDeleteTarget(cue)
                        }}
                      >
                        <TrashIcon />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {cues.length === 0 && <p className="tp-empty">暂无分段</p>}
            <div className="tp-add-actions">
              <button
                type="button"
                className="tp-add"
                disabled={editingLocked}
                onClick={() => {
                  setSwapId(null)
                  setEditing(undefined)
                  setDialog('speech')
                }}
              >
                <PlusIcon /> 添加一段
              </button>
              <button
                type="button"
                disabled={editingLocked}
                onClick={() => {
                  setSwapId(null)
                  setEditing(undefined)
                  setDialog('pause')
                }}
              >
                添加停顿
              </button>
            </div>
            <div className="tp-library-foot">
              <p>
                全文 {countCharacters(draft.source)} 字 · 已分配 {allocatedCharacterCount(draft)} 字
              </p>
            </div>
          </aside>
          <section className="tp-preview-column" aria-label="口播预览" ref={previewRef}>
            <div className="tp-preview-label">
              <h2>口播预览</h2>
              <div className="tp-preview-tools">
                <button
                  type="button"
                  disabled={editingLocked}
                  aria-pressed={adjusting}
                  onClick={() => setAdjusting(!adjusting)}
                >
                  {adjusting ? '锁定位置' : '调整位置'}
                </button>
                <button
                  type="button"
                  disabled={editingLocked}
                  aria-pressed={appearance.narrow}
                  onClick={() =>
                    setAppearance((value) => ({
                      ...value,
                      narrow: !value.narrow,
                    }))
                  }
                >
                  窄条
                </button>
                <button
                  type="button"
                  disabled={editingLocked}
                  onClick={() => {
                    setAppearance(defaultAppearance())
                    setAdjusting(false)
                  }}
                >
                  复位
                </button>
              </div>
              <span>
                {!cues.length
                  ? '未开始'
                  : playback.playing
                    ? playback.countdown
                      ? '准备开始'
                      : '正在口播'
                    : playback.elapsed >= total && total > 0
                      ? '已完成'
                      : '已暂停'}
              </span>
            </div>
            <div
              className={`tp-stage${capture.enabled ? ' has-camera' : ''}`}
              style={{
                minHeight: promptTextMetrics(appearance.font).normalMinHeight,
              }}
            >
              <Camera capture={capture} />
              <PromptOverlay
                rect={
                  appearance.narrow ? { ...appearance.rect, y: appearance.stripY } : appearance.rect
                }
                font={appearance.font}
                narrow={appearance.narrow}
                editing={adjusting}
                change={(rect) =>
                  setAppearance((value) =>
                    value.narrow ? { ...value, stripY: rect.y } : { ...value, rect },
                  )
                }
              >
                <ContinuousReader
                  cues={cues}
                  source={draft.source}
                  elapsed={playback.elapsed}
                  playing={playback.playing && !playback.countdown}
                  seekRevision={playback.seekRevision}
                  narrow={appearance.narrow}
                  font={appearance.font}
                  opacity={appearance.backgroundOpacity}
                  textOpacity={appearance.textOpacity}
                  theme={theme}
                />
              </PromptOverlay>
              {playback.countdown && (
                <div className="tp-countdown" aria-live="assertive">
                  {playback.countdown}
                </div>
              )}
              {capture.status === 'recording' || capture.status === 'paused' ? (
                <div className="tp-stage-record">
                  <span>
                    {capture.status === 'recording' ? '录制中' : '已暂停'} ·{' '}
                    {formatTime(capture.elapsed)}
                  </span>
                  <button
                    type="button"
                    aria-label={capture.status === 'recording' ? '暂停本次录制' : '继续本次录制'}
                    onClick={capture.status === 'recording' ? pauseRecording : resumeRecording}
                  >
                    {capture.status === 'recording' ? <PauseIcon /> : <PlayIcon />}
                  </button>
                  <button type="button" aria-label="结束本次录制" onClick={stopRecording}>
                    <StopIcon />
                    结束
                  </button>
                </div>
              ) : (
                <span className="tp-local-label">本地取景与录制 · 不上传</span>
              )}
            </div>
            <div className="tp-transport">
              <span className="tp-clock">
                {formatTime(playback.elapsed)} <small>/ {formatTime(total)}</small>
              </span>
              <div className="tp-play-actions">
                <button
                  type="button"
                  className="tp-icon"
                  aria-label="上一段"
                  disabled={editingLocked || total === 0}
                  onClick={() =>
                    playback.seek(
                      [...cues].reverse().find((s) => s.start < playback.elapsed - 0.1)?.start ?? 0,
                    )
                  }
                >
                  <TrackPreviousIcon />
                </button>
                <button
                  type="button"
                  className="tp-play"
                  aria-label={playback.playing ? '暂停口播' : '开始口播'}
                  disabled={
                    total === 0 ||
                    Boolean(dialog) ||
                    capture.status === 'requesting' ||
                    capture.status === 'stopping'
                  }
                  onClick={togglePlayback}
                >
                  {playback.playing ? <PauseIcon /> : <PlayIcon />}
                </button>
                <button
                  type="button"
                  className="tp-icon"
                  aria-label="下一段"
                  disabled={editingLocked || total === 0}
                  onClick={() =>
                    playback.seek(
                      cues.find((s) => s.start > playback.elapsed + 0.1)?.start ?? total,
                    )
                  }
                >
                  <TrackNextIcon />
                </button>
              </div>
              <button
                type="button"
                className="tp-reset"
                disabled={editingLocked || total === 0}
                onClick={resetPosition}
              >
                <ResetIcon /> 从头开始
              </button>
            </div>
            <div className="tp-reading-controls">
              <div className="tp-live-font">
                <span>字号</span>
                <button
                  type="button"
                  aria-label="缩小提词字号"
                  disabled={appearance.font <= 16}
                  onClick={() =>
                    setAppearance((value) => ({
                      ...value,
                      font: Math.max(16, value.font - 2),
                    }))
                  }
                >
                  −
                </button>
                <input
                  aria-label="提词字号"
                  type="range"
                  min="16"
                  max="72"
                  value={appearance.font}
                  onChange={(event) =>
                    setAppearance((value) => ({
                      ...value,
                      font: Number(event.target.value),
                    }))
                  }
                />
                <output>{appearance.font}</output>
                <button
                  type="button"
                  aria-label="放大提词字号"
                  disabled={appearance.font >= 72}
                  onClick={() =>
                    setAppearance((value) => ({
                      ...value,
                      font: Math.min(72, value.font + 2),
                    }))
                  }
                >
                  +
                </button>
              </div>
              <div className="tp-live-pace">
                <span>朗读速度</span>
                <button
                  type="button"
                  aria-label="降低朗读速度"
                  disabled={playback.rate <= 0.5}
                  onClick={() => playback.setRate(playback.rate - 0.1)}
                >
                  −
                </button>
                <input
                  type="range"
                  aria-label="实时朗读速度"
                  min="0.5"
                  max="2"
                  step="0.1"
                  value={playback.rate}
                  onChange={(event) => playback.setRate(Number(event.target.value))}
                />
                <output>{playback.rate.toFixed(1)}×</output>
                <button
                  type="button"
                  aria-label="提高朗读速度"
                  disabled={playback.rate >= 2}
                  onClick={() => playback.setRate(playback.rate + 0.1)}
                >
                  +
                </button>
              </div>
            </div>
            <div className="tp-timeline" aria-label="分段时间轴">
              {cues.map((cue) => (
                <button
                  key={cue.id}
                  type="button"
                  disabled={editingLocked}
                  title={`${cue.kind === 'pause' ? '停顿' : '朗读'} ${formatTime(cue.start)} — ${formatTime(cue.end)}`}
                  aria-label={`跳转到 ${formatTime(cue.start)}`}
                  className={`${cue.kind === 'pause' ? 'is-pause' : ''} ${cue.id === current?.id ? 'is-current' : ''}`}
                  style={{ flexGrow: cue.end - cue.start }}
                  onClick={() => playback.seek(cue.start)}
                />
              ))}
            </div>
            <label className="tp-seek">
              <span className="tp-sr-only">播放进度（秒）</span>
              <input
                type="range"
                min="0"
                max={total || 1}
                step="0.1"
                value={playback.elapsed}
                disabled={editingLocked || !total}
                onChange={(event) => playback.seek(Number(event.target.value))}
              />
            </label>
            <div className="tp-preview-foot">
              <span>台本进度 · 按时间估算 · 总时长 {formatTime(total)}</span>
              <span>{playback.wake}</span>
            </div>
            <RecordingControls
              capture={capture}
              start={(mode) => void startRecording(mode)}
              pause={pauseRecording}
              resume={resumeRecording}
              stop={stopRecording}
              sync={syncRecording}
              setSync={setSyncRecording}
              canSync={total > 0}
            />
          </section>
          <aside className="tp-inspector tp-panel">
            <div className="tp-panel-title">
              <h2>朗读设置</h2>
            </div>
            <label className="tp-setting">
              口播语速参考
              <span>
                <BoundedNumber
                  label="默认口播语速"
                  min={60}
                  max={500}
                  value={draft.rate}
                  disabled={editingLocked}
                  onChange={(rate) => setDraft((value) => ({ ...value, rate }))}
                />{' '}
                字/分钟
              </span>
            </label>
            <p className="tp-setting-note">
              初始参考 220 字/分钟，可按自己的语速调整。实际滚动以分段时间为准。
            </p>
            <label className="tp-setting">
              文字不透明度 <b>{appearance.textOpacity}%</b>
              <input
                aria-label="文字不透明度"
                type="range"
                min="0"
                max="100"
                step="5"
                value={appearance.textOpacity}
                onChange={(event) =>
                  setAppearance((value) => ({
                    ...value,
                    textOpacity: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label className="tp-setting">
              提词背景 <b>{appearance.backgroundOpacity}%</b>
              <input
                aria-label="提词背景不透明度"
                type="range"
                min="0"
                max="100"
                step="5"
                value={appearance.backgroundOpacity}
                onChange={(event) =>
                  setAppearance((value) => ({
                    ...value,
                    backgroundOpacity: Number(event.target.value),
                  }))
                }
              />
            </label>
            <PromptColors appearance={appearance} setAppearance={setAppearance} />
            {tutorial && (
              <div className="tp-tutorial-setting">
                <strong>图片演示</strong>
                <p>使用图片代替摄像头画面。</p>
                <label className="tp-check">
                  <input
                    type="checkbox"
                    aria-label="演示录制使用麦克风"
                    checked={tutorial.microphone}
                    disabled={capture.active}
                    onChange={(event) => tutorial.setMicrophone(event.target.checked)}
                  />
                  录制时使用麦克风
                </label>
                <small>
                  {tutorial.microphone
                    ? '开始录制时会请求麦克风授权。'
                    : '演示录制为静音，摄像头不会启用。'}
                </small>
              </div>
            )}
            <label className="tp-check">
              <input
                type="checkbox"
                checked={withCountdown}
                disabled={editingLocked}
                onChange={(event) => setWithCountdown(event.target.checked)}
              />
              开始前倒数 3 秒
            </label>
            {activeSegment && (
              <div className="tp-selected-info">
                <span className="tp-eyebrow">当前选段</span>
                <strong>
                  {formatTime(activeSegment.start)} — {formatTime(activeSegment.end)}
                </strong>
                <p>
                  时长 {activeSegment.end - activeSegment.start} 秒
                  {activeSegment.kind === 'speech'
                    ? ` · ${countCharacters(speechText(draft.source, activeSegment))} 字`
                    : ''}
                </p>
                <button
                  type="button"
                  disabled={editingLocked}
                  onClick={() => {
                    setSwapId(null)
                    setEditing(activeSegment)
                    setDialog('edit')
                  }}
                >
                  {activeSegment.kind === 'pause' ? '编辑停顿提示' : '编辑分段'} <Pencil1Icon />
                </button>
              </div>
            )}
            <p className="tp-privacy">
              台本和未保存的录制仅供本次使用。刷新、关闭或退出页面后不会恢复，请及时保存视频或音频。
            </p>
          </aside>
        </div>
      </main>
      {capture.showSave && capture.result && (
        <SaveRecording
          result={capture.result}
          close={() => capture.setShowSave(false)}
          saved={() => {
            capture.markSaved()
            capture.setShowSave(false)
          }}
        />
      )}
      {capture.blocker.state === 'blocked' && (
        <Modal
          title={capture.active || capture.unsaved ? '先保存本次录制？' : '离开并清空本次台本？'}
          close={() => capture.blocker.reset?.()}
        >
          <div className="tp-modal-content">
            <p>
              {capture.active || capture.unsaved
                ? '本次录制尚未保存。请留在此页保存，或放弃后离开。'
                : '离开后，本次台本和分段不会恢复。'}
            </p>
          </div>
          <footer className="tp-modal-footer">
            <button type="button" onClick={() => capture.blocker.proceed?.()}>
              放弃并离开
            </button>
            <button type="button" className="tp-primary" onClick={() => capture.blocker.reset?.()}>
              留在此页
            </button>
          </footer>
        </Modal>
      )}
      {dialog === 'source' && (
        <ScriptDialog
          draft={draft}
          close={() => setDialog(null)}
          save={(source, segments) => {
            setDraft((value) => ({ ...value, source, segments }))
            playback.seek(0)
            setDialog(null)
          }}
        />
      )}
      {(dialog === 'speech' || dialog === 'pause' || dialog === 'edit') && (
        <SegmentDialog
          draft={draft}
          edit={dialog === 'edit' ? editing : undefined}
          kind={dialog === 'edit' ? (editing?.kind ?? 'speech') : dialog}
          close={() => setDialog(null)}
          save={saveSegment}
          setRate={(rate) => setDraft((value) => ({ ...value, rate }))}
        />
      )}
      {dialog === 'template' && (
        <Modal title="复制模板" close={() => setDialog(null)}>
          <div className="tp-modal-content">
            <p>复制以下内容，替换成你的台本后粘贴。</p>
            <textarea
              className="tp-script-input"
              readOnly
              value={TEMPLATE}
              onFocus={(event) => event.target.select()}
              aria-label="时间模板"
            />
          </div>
          <footer className="tp-modal-footer">
            <button type="button" onClick={() => setDialog(null)}>
              完成
            </button>
          </footer>
        </Modal>
      )}
      {deleteTarget && (
        <Modal title="删除这一段？" close={() => setDeleteTarget(null)}>
          <div className="tp-modal-content">
            <p>
              {deleteTarget.kind === 'pause'
                ? '移除这段停顿及动作提示，口播分段和已选文字会保留。'
                : '这段文字将恢复为未分配。其他分段的位置与时间会保留。'}
            </p>
          </div>
          <footer className="tp-modal-footer">
            <button type="button" onClick={() => setDeleteTarget(null)}>
              取消
            </button>
            <button
              type="button"
              className="tp-primary"
              onClick={() => {
                setDraft((value) => ({
                  ...value,
                  segments: value.segments.filter((s) => s.id !== deleteTarget.id),
                }))
                setDeleteTarget(null)
                playback.seek(0)
              }}
            >
              删除分段
            </button>
          </footer>
        </Modal>
      )}
    </div>
  )
}
