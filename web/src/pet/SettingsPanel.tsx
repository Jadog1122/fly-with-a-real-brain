import { QUALITIES, type Settings, type Quality } from './save'

const QUALITY_NOTE: Record<Quality, string> = {
  low: 'No shadows, native resolution, few crumbs',
  medium: 'Softer shadows, 1.5x resolution',
  high: 'Full shadows and resolution',
}

export function SettingsPanel({ open, settings, onChange, onReset, onClose, confirmReset }: {
  open: boolean
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onReset: () => void
  onClose: () => void
  confirmReset: boolean
}) {
  if (!open) return null

  return (
    <div className="rpg-ui-glass-panel pet-settings" role="dialog" aria-label="Settings">
      <div className="pet-settings-head">
        <h2>Settings</h2>
        <button className="rpg-ui-btn pet-settings-x" aria-label="Close settings"
                onClick={onClose}>✕</button>
      </div>

      <section>
        <h3>Sound</h3>
        <label className="pet-row">
          <span>Volume</span>
          <input
            type="range" min={0} max={100} step={1}
            value={Math.round(settings.volume * 100)}
            aria-label="Volume"
            onChange={e => onChange({ volume: Number(e.target.value) / 100 })}
          />
          <b>{Math.round(settings.volume * 100)}</b>
        </label>
      </section>

      <section>
        <h3>Graphics</h3>
        <div className="pet-seg" role="radiogroup" aria-label="Graphics quality">
          {QUALITIES.map(q => (
            <button
              key={q}
              role="radio"
              aria-checked={settings.quality === q}
              className={`rpg-ui-btn${settings.quality === q ? ' on' : ''}`}
              onClick={() => onChange({ quality: q })}
            >
              {q}
            </button>
          ))}
        </div>
        <p className="pet-hint">{QUALITY_NOTE[settings.quality]}</p>
      </section>

      <section>
        <h3>Accessibility</h3>
        <label className="pet-row pet-check">
          <input
            type="checkbox" checked={settings.colourblind}
            onChange={e => onChange({ colourblind: e.target.checked })}
          />
          <span>Colour-blind safe bars</span>
        </label>
        <p className="pet-hint">
          The Fed and Calm bars sit next to each other in red and green. This swaps every
          bar to an Okabe&ndash;Ito palette that stays distinct for all common types.
        </p>
        <label className="pet-row pet-check">
          <input
            type="checkbox" checked={settings.reducedMotion}
            onChange={e => onChange({ reducedMotion: e.target.checked })}
          />
          <span>Reduce motion</span>
        </label>
        <p className="pet-hint">Calms the floating numbers and spinners. The fly still moves.</p>
      </section>

      <section>
        <h3>Pet</h3>
        <button className={`rpg-ui-btn${confirmReset ? ' pet-danger' : ''}`} onClick={onReset}>
          {confirmReset ? 'Sure? This erases it' : 'New fly'}
        </button>
        <p className="pet-hint">Forgets this fly&rsquo;s meals, hunger and everything you put down.</p>
      </section>
    </div>
  )
}
