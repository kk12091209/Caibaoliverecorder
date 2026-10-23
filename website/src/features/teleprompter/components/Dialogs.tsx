import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Cross2Icon } from '@radix-ui/react-icons'
import {
  countCharacters,
  importScript,
  MAX_PAUSE_NOTE,
  MAX_SCRIPT_LENGTH,
  MAX_TIME,
  readingSeconds,
  recommendedCount,
  sourceRuns,
  speechSourceMap,
  speechText,
  validateSegment,
  validateSpeechSelection,
  type Draft,
  type Segment,
} from '../model/teleprompter'
import {
  mappedSourceRanges,
  reconcileSourceMap,
  sourceMapForRange,
  type TextEditSelection,
} from '../model/text-allocation'
import { SourceText } from './SourceText'
import { sourceDomRange, sourceIndex, type SourceRange } from '../model/source-selection'

export function Modal({
  title,
  children,
  close,
  wide = false,
}: {
  title: string
  children: ReactNode
  close: () => void
  wide?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const label = useId()
  const backdropPress = useRef<{
    pointerId: number
    x: number
    y: number
    released: boolean
  } | null>(null)
  const outside = (x: number, y: number) => {
    const rect = ref.current!.getBoundingClientRect()
    return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom
  }
  useEffect(() => {
    const element = ref.current!
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    element.showModal()
    return () => {
      element.close()
      document.body.style.overflow = previous
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className={`tp-modal ${wide ? 'tp-modal-wide' : ''}`}
      aria-labelledby={label}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      onPointerDownCapture={(event) => {
        backdropPress.current =
          event.button === 0 &&
          event.target === ref.current &&
          outside(event.clientX, event.clientY)
            ? {
                pointerId: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                released: false,
              }
            : null
      }}
      onPointerUpCapture={(event) => {
        const press = backdropPress.current
        if (press)
          press.released =
            press.pointerId === event.pointerId &&
            event.target === ref.current &&
            outside(event.clientX, event.clientY) &&
            Math.hypot(event.clientX - press.x, event.clientY - press.y) < 8
      }}
      onPointerCancelCapture={() => {
        backdropPress.current = null
      }}
      onClick={(event) => {
        const press = backdropPress.current
        backdropPress.current = null
        if (
          press?.released &&
          event.target === ref.current &&
          outside(event.clientX, event.clientY)
        )
          close()
      }}
    >
      <header className="tp-modal-head">
        <div>
          <small>菜包口播助手</small>
          <h2 id={label}>{title}</h2>
        </div>
        <button type="button" className="tp-icon" aria-label="关闭弹窗" onClick={close}>
          <Cross2Icon />
        </button>
      </header>
      {children}
    </dialog>
  )
}

export function BoundedNumber({
  label,
  min,
  max,
  value,
  onChange,
  disabled,
}: {
  label: string
  min: number
  max: number
  value: number
  onChange: (value: number) => void
  disabled?: boolean
}) {
  const [text, setText] = useState(String(value))
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setText(String(value))
  }, [value, focused])
  return (
    <input
      aria-label={label}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      value={text}
      disabled={disabled}
      onFocus={() => setFocused(true)}
      onChange={(event) => {
        const raw = event.target.value
        setText(raw)
        const number = Number(raw)
        if (raw !== '' && Number.isSafeInteger(number) && number >= min && number <= max)
          onChange(number)
      }}
      onBlur={() => {
        const number =
          text.trim() === ''
            ? value
            : Math.max(min, Math.min(max, Math.round(Number(text) || value)))
        onChange(number)
        setText(String(number))
        setFocused(false)
      }}
    />
  )
}

export function TimeField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <fieldset className="tp-time-field">
      <legend>{label}</legend>
      <label>
        <BoundedNumber
          label={`${label}分钟`}
          min={0}
          max={1440}
          value={Math.floor(value / 60)}
          onChange={(minutes) => onChange(Math.min(MAX_TIME, minutes * 60 + (value % 60)))}
        />
        <span>分</span>
      </label>
      <label>
        <BoundedNumber
          label={`${label}秒`}
          min={0}
          max={59}
          value={value % 60}
          onChange={(seconds) =>
            onChange(Math.min(MAX_TIME, Math.floor(value / 60) * 60 + seconds))
          }
        />
        <span>秒</span>
      </label>
    </fieldset>
  )
}

export function SegmentDialog({
  draft,
  edit,
  kind,
  close,
  save,
  setRate,
}: {
  draft: Draft
  edit?: Segment
  kind: 'speech' | 'pause'
  close: () => void
  save: (segment: Segment, text?: string, append?: boolean) => void
  setRate: (rate: number) => void
}) {
  const [sourceOpen, setSourceOpen] = useState(false)
  const [start, setStart] = useState(
    edit?.start ?? Math.max(0, ...draft.segments.map((s) => s.end)),
  )
  const [end, setEnd] = useState(
    edit?.end ?? Math.max(0, ...draft.segments.map((s) => s.end)) + (kind === 'pause' ? 20 : 30),
  )
  const [selection, setSelection] = useState<{ from: number; to: number } | null>(
    edit?.kind === 'speech' && !edit.sourceMap ? { from: edit.from, to: edit.to } : null,
  )
  const [content, setContent] = useState(() =>
    edit?.kind === 'speech'
      ? { text: speechText(draft.source, edit), sourceMap: speechSourceMap(edit) }
      : { text: '', sourceMap: [] },
  )
  const selectedText = content.text
  const beforeInput = useRef<TextEditSelection | null>(null)
  const lastNativeSelection = useRef<SourceRange | null>(null)
  const [note, setNote] = useState(edit?.kind === 'pause' ? (edit.note ?? '') : '')
  const [error, setError] = useState('')
  const [selectionIssue, setSelectionIssue] = useState('')
  const sourceRef = useRef<HTMLDivElement>(null)
  const id = useRef(edit?.id ?? crypto.randomUUID())
  const duration = end - start
  const selectedCount = countCharacters(selectedText)
  const recommended = recommendedCount(duration, draft.rate)
  const append = kind === 'speech' && !edit && !selection
  const resultingLength = append
    ? draft.source.length + (draft.source ? 2 : 0) + selectedText.length
    : draft.source.length
  const spokenLength = draft.segments.reduce(
    (total, segment) =>
      total +
      (segment.kind === 'speech' && segment.id !== edit?.id
        ? speechText(draft.source, segment).length
        : 0),
    selectedText.length,
  )
  const textUnchanged = edit?.kind === 'speech' && selectedText === speechText(draft.source, edit)
  const textTooLong = Math.max(resultingLength, spokenLength) > MAX_SCRIPT_LENGTH && !textUnchanged
  const freeCharacters = useMemo(
    () =>
      sourceRuns(
        draft.source,
        draft.segments.filter((segment) => segment.id !== edit?.id),
      )
        .filter((run) => !run.segment)
        .reduce((total, run) => total + countCharacters(run.text), 0),
    [draft.source, draft.segments, edit?.id],
  )
  const makeSegment = (): Segment =>
    kind === 'pause'
      ? { id: id.current, kind, start, end, ...(note.trim() ? { note: note.trim() } : {}) }
      : {
          id: id.current,
          kind,
          start,
          end,
          from:
            selection?.from ??
            (edit?.kind === 'speech' ? edit.from : draft.source.length + (draft.source ? 2 : 0)),
          to: selection?.to ?? (edit?.kind === 'speech' ? edit.to : resultingLength),
          text: selectedText,
          sourceMap: content.sourceMap,
        }
  const chooseRange = useCallback(
    ({ from, to }: SourceRange) => {
      const problem = validateSpeechSelection(
        { id: id.current, from, to },
        draft.source,
        draft.segments,
      )
      if (problem) {
        setSelectionIssue(problem)
        return
      }
      setContent({
        text: draft.source.slice(from, to),
        sourceMap: sourceMapForRange(from, to),
      })
      beforeInput.current = null
      setSelection({ from, to })
      setSelectionIssue('')
      setError('')
    },
    [draft.source, draft.segments],
  )

  useEffect(() => {
    if (!('Highlight' in window) || !CSS.highlights) return
    if (sourceOpen && sourceRef.current) {
      const ranges = mappedSourceRanges(content.sourceMap)
        .map((range) => sourceDomRange(sourceRef.current!, range))
        .filter((range): range is Range => range !== null)
      if (ranges.length) CSS.highlights.set('tp-selected-text', new Highlight(...ranges))
    }
    return () => {
      CSS.highlights.delete('tp-selected-text')
    }
  }, [sourceOpen, content.sourceMap])

  useEffect(() => {
    if (!sourceOpen) return
    lastNativeSelection.current = null
    const onSelection = () => {
      if (
        document.activeElement instanceof HTMLTextAreaElement ||
        document.activeElement instanceof HTMLInputElement
      )
        return
      const native = window.getSelection()
      const root = sourceRef.current
      if (!native || !root || native.rangeCount === 0 || native.isCollapsed) return
      const range = native.getRangeAt(0)
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return
      const from = sourceIndex(root, range.startContainer, range.startOffset)
      const to = sourceIndex(root, range.endContainer, range.endOffset)
      if (from === null || to === null) {
        setSelectionIssue('请选择未分配的连续文字。')
        return
      }
      if (lastNativeSelection.current?.from === from && lastNativeSelection.current.to === to)
        return
      lastNativeSelection.current = { from, to }
      chooseRange({ from, to })
    }
    document.addEventListener('selectionchange', onSelection)
    return () => document.removeEventListener('selectionchange', onSelection)
  }, [sourceOpen, chooseRange])

  function rememberEdit(element: HTMLTextAreaElement, inputType?: string) {
    beforeInput.current = {
      start: element.selectionStart,
      end: element.selectionEnd,
      inputType,
    }
  }
  function changeText(text: string) {
    const hint = beforeInput.current
    beforeInput.current = null
    setContent((previous) => ({
      text,
      sourceMap: reconcileSourceMap(previous.text, text, previous.sourceMap, hint),
    }))
    setError('')
    setSelectionIssue('')
  }

  function commit() {
    const segment = makeSegment()
    const problem = validateSegment(
      append ? { id: id.current, kind: 'pause', start, end } : segment,
      draft.source,
      draft.segments,
    )
    if (problem) {
      setError(problem)
      return
    }
    if (kind === 'speech' && (!selectedCount || textTooLong || selectionIssue)) return
    try {
      save(segment, kind === 'speech' ? selectedText : undefined, append)
    } catch (problem) {
      setError((problem as Error).message)
    }
  }
  return (
    <Modal
      title={kind === 'pause' ? (edit ? '编辑停顿' : '添加停顿') : edit ? '编辑分段' : '添加一段'}
      wide={sourceOpen}
      close={close}
    >
      <div className={`tp-composer-body${sourceOpen ? ' with-source' : ''}`}>
        <section className="tp-composer-fields">
          <div className="tp-time-grid">
            <TimeField
              label="开始时间"
              value={start}
              onChange={(value) => {
                setStart(value)
                setError('')
              }}
            />
            <TimeField
              label="结束时间"
              value={end}
              onChange={(value) => {
                setEnd(value)
                setError('')
              }}
            />
          </div>
          <div className="tp-duration">
            <span>
              本段时长 <b>{Math.max(0, duration)} 秒</b>
            </span>
            <div>
              <button
                type="button"
                onClick={() => {
                  setEnd(Math.max(start + 1, end - 5))
                  setError('')
                }}
              >
                − 5 秒
              </button>
              <button
                type="button"
                onClick={() => {
                  setEnd(Math.min(MAX_TIME, end + 5))
                  setError('')
                }}
              >
                + 5 秒
              </button>
            </div>
          </div>
          {kind === 'speech' ? (
            <>
              <div className="tp-reference tp-reference-summary" aria-live="polite">
                <span>
                  建议约 <b>{recommended}</b> 字
                </span>
                <span>
                  当前 <b>{selectedCount}</b> 字
                </span>
              </div>
              <label className="tp-spoken-editor">
                本段口播文字
                <textarea
                  aria-label="本段口播文字"
                  value={selectedText}
                  placeholder="直接填写这一段，或从原文选取……"
                  onBeforeInput={(event) =>
                    rememberEdit(
                      event.currentTarget,
                      (event.nativeEvent as InputEvent).inputType ?? beforeInput.current?.inputType,
                    )
                  }
                  onKeyDown={(event) =>
                    rememberEdit(
                      event.currentTarget,
                      event.key === 'Delete'
                        ? 'deleteContentForward'
                        : event.key === 'Backspace'
                          ? 'deleteContentBackward'
                          : undefined,
                    )
                  }
                  onPaste={(event) => rememberEdit(event.currentTarget)}
                  onCut={(event) => rememberEdit(event.currentTarget)}
                  onChange={(event) => changeText(event.target.value)}
                />
                {textTooLong && (
                  <small role="alert" className="tp-error">
                    台本合计超过 1 万字符，请删减后保存。
                  </small>
                )}
              </label>
              <div className="tp-composer-source-actions">
                {draft.source && (
                  <button
                    type="button"
                    aria-expanded={sourceOpen}
                    onClick={() => {
                      setSourceOpen(!sourceOpen)
                      setSelectionIssue('')
                    }}
                  >
                    {sourceOpen ? '收起原文' : '从原文选取'}
                  </button>
                )}
                {!edit && selection && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelection(null)
                      setContent((previous) => ({
                        ...previous,
                        sourceMap: Array<null>(previous.text.length).fill(null),
                      }))
                      setSelectionIssue('')
                      setError('')
                    }}
                  >
                    改为新增文字
                  </button>
                )}
                <span>
                  {content.sourceMap.some((index) => index !== null) ? '原文选段' : '新增文字'}
                </span>
              </div>
              <label className="tp-rate">
                口播语速{' '}
                <span>
                  <BoundedNumber
                    label="口播语速"
                    min={60}
                    max={500}
                    value={draft.rate}
                    onChange={setRate}
                  />{' '}
                  字/分钟
                </span>
                <small>预计朗读约 {readingSeconds(selectedText, draft.rate)} 秒</small>
              </label>
            </>
          ) : (
            <label className="tp-pause-editor">
              动作提示 <span>选填，不作为朗读正文</span>
              <textarea
                aria-label="停顿动作提示"
                value={note}
                maxLength={MAX_PAUSE_NOTE}
                rows={3}
                placeholder="例如：拿起产品，展示侧面；微笑看向镜头。"
                onChange={(event) => setNote(event.target.value)}
              />
              <small>
                {note.length} / {MAX_PAUSE_NOTE}
              </small>
            </label>
          )}
          {error && (
            <p role="alert" className="tp-error">
              {error}
            </p>
          )}
          {selectionIssue && (
            <p role="alert" className="tp-error">
              {selectionIssue}
            </p>
          )}
        </section>
        {sourceOpen && (
          <section
            className="tp-source-pane tp-composer-source"
            onPointerDownCapture={() => {
              lastNativeSelection.current = null
            }}
          >
            <div className="tp-source-label">
              <strong>{'菜包口播助手'}</strong>
              <small>
                {edit
                  ? '本段可重新选取，其他分段已锁定'
                  : freeCharacters
                    ? '选取未分配的连续文字'
                    : '原文已全部分配，可以直接填写新段内容。'}
              </small>
            </div>
            <SourceText
              draft={draft}
              sourceRef={sourceRef}
              editingId={edit?.id}
              select={chooseRange}
            />
          </section>
        )}
      </div>
      <footer className="tp-modal-footer">
        <button type="button" onClick={close}>
          取消
        </button>
        <button
          type="button"
          className="tp-primary"
          disabled={kind === 'speech' && (!selectedCount || textTooLong || !!selectionIssue)}
          onClick={commit}
        >
          {kind === 'pause' ? (edit ? '保存停顿' : '添加停顿') : edit ? '保存分段' : '添加分段'}
        </button>
      </footer>
    </Modal>
  )
}

export function ScriptDialog({
  draft,
  close,
  save,
}: {
  draft: Draft
  close: () => void
  save: (source: string, segments: Segment[]) => void
}) {
  const [text, setText] = useState(draft.source)
  const [error, setError] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  return (
    <Modal title="粘贴台本" close={close}>
      <div className="tp-modal-content">
        <p className="tp-muted">直接粘贴全文，或使用带时间标记的模板。单次最多 1 万字符。</p>
        <textarea
          aria-label="台本原文"
          className="tp-script-input"
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setError('')
          }}
          placeholder="在这里粘贴你的台本……"
        />
        <div className={`tp-script-count${text.length > MAX_SCRIPT_LENGTH ? ' tp-error' : ''}`}>
          {text.length} / {MAX_SCRIPT_LENGTH} 字符
        </div>
        {text.length > MAX_SCRIPT_LENGTH && (
          <p role="alert" className="tp-error">
            台本超过 1 万字符，请删减后保存；粘贴内容未被截断。
          </p>
        )}
        {draft.segments.length > 0 && (
          <label className="tp-check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            替换原文并重新分段（清除当前分段）
          </label>
        )}
        {error && (
          <p role="alert" className="tp-error">
            {error}
          </p>
        )}
      </div>
      <footer className="tp-modal-footer">
        <button type="button" onClick={close}>
          取消
        </button>
        <button
          type="button"
          className="tp-primary"
          disabled={
            text.length > MAX_SCRIPT_LENGTH ||
            !text.trim() ||
            (draft.segments.length > 0 && !confirmed)
          }
          onClick={() => {
            try {
              const result = importScript(text)
              save(result.source, result.segments)
            } catch (problem) {
              setError((problem as Error).message)
            }
          }}
        >
          使用这份台本
        </button>
      </footer>
    </Modal>
  )
}
