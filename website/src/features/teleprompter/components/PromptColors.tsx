import { useState, type Dispatch, type SetStateAction } from 'react'
import {
  PROMPT_THEMES,
  resolvePromptTheme,
  type PromptAppearance,
  type PromptColors as Colors,
} from '../model/prompt-style'
import { ColorPicker } from './ColorPicker'

const fields = [
  { key: 'unread', label: '未读文字' },
  { key: 'read', label: '已读文字' },
  { key: 'background', label: '提词背景' },
] as const

export function PromptColors({
  appearance,
  setAppearance,
}: {
  appearance: PromptAppearance
  setAppearance: Dispatch<SetStateAction<PromptAppearance>>
}) {
  const [browsingPresets, setBrowsingPresets] = useState(false)
  const view = appearance.theme === 'custom' && !browsingPresets ? 'custom' : 'presets'
  const [editing, setEditing] = useState<{
    key: keyof Colors
    label: string
    before: PromptAppearance
  } | null>(null)
  const theme = resolvePromptTheme(appearance)
  function cancel() {
    if (editing)
      setAppearance((value) => ({
        ...value,
        theme: editing.before.theme,
        customColors: editing.before.customColors,
      }))
    setEditing(null)
  }
  return (
    <fieldset className="tp-palette">
      <legend>提词配色</legend>
      <div className="tp-palette-tabs" role="group" aria-label="配色方式">
        <button
          type="button"
          aria-pressed={view === 'presets'}
          onClick={() => setBrowsingPresets(true)}
        >
          预设方案
        </button>
        <button
          type="button"
          aria-pressed={view === 'custom'}
          onClick={() => {
            setBrowsingPresets(false)
            setAppearance((value) => {
              const current = resolvePromptTheme(value)
              return {
                ...value,
                theme: 'custom',
                customColors: value.customColors ?? {
                  unread: current.unread,
                  read: current.read,
                  background: current.background,
                },
              }
            })
          }}
        >
          自定义
        </button>
      </div>
      {view === 'presets' ? (
        <div className="tp-preset-grid">
          {PROMPT_THEMES.map((preset) => (
            <button
              type="button"
              key={preset.id}
              aria-label={`${preset.name}配色`}
              aria-pressed={appearance.theme === preset.id}
              onClick={() =>
                setAppearance((value) => ({
                  ...value,
                  theme: preset.id,
                  backgroundOpacity:
                    preset.id === 'caibao' || preset.id.startsWith('ink-') ? 85 : 45,
                }))
              }
            >
              <span style={{ background: preset.background }}>
                <i style={{ color: preset.unread }}>口</i>
                <i style={{ color: preset.read }}>播</i>
              </span>
              {preset.name}
            </button>
          ))}
        </div>
      ) : (
        <div className="tp-custom-colors">
          {fields.map((field) => (
            <button
              type="button"
              key={field.key}
              aria-label={`调整${field.label}颜色`}
              onClick={() => setEditing({ ...field, before: appearance })}
            >
              <span className="tp-color-chip" style={{ background: theme[field.key] }} />
              <span>{field.label}</span>
              <small>{theme[field.key].toUpperCase()}</small>
            </button>
          ))}
        </div>
      )}
      {editing && (
        <ColorPicker
          title={`${editing.label}颜色`}
          initial={resolvePromptTheme(editing.before)[editing.key]}
          change={(color) =>
            setAppearance((value) => {
              const current = resolvePromptTheme(value)
              return {
                ...value,
                theme: 'custom',
                customColors: {
                  unread: current.unread,
                  read: current.read,
                  background: current.background,
                  [editing.key]: color,
                },
              }
            })
          }
          cancel={cancel}
          apply={() => setEditing(null)}
        />
      )}
    </fieldset>
  )
}
