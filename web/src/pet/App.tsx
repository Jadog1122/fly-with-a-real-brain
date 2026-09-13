// The whole screen is the game: the world fills it and the HUD floats on top.
// Every panel, bar, dock slot and button is a @rpgjs/ui-css primitive; theme.css
// retints that library's tokens to the meadow's palette without rewriting its CSS.
import { useEffect, useRef, useState } from 'react'
import '@rpgjs/ui-css/index.css'
import './theme.css'
import { PetEngine, type Snapshot } from './engine'
import type { StimKind } from './sensors'
import { BootOverlay, type BootState } from './BootOverlay'
import { missingFeatures } from '../support'
import { SettingsPanel } from './SettingsPanel'
import { DEFAULTS, type Settings } from './save'

const BAR_TYPE: Record<string, string> = {
  escape: 'health', proboscis: 'experience', groom: 'stamina',
  forward: 'mana', backward: 'mana', turn_a: 'mana', turn_b: 'mana',
}
const POP_TONE: Record<string, string> = {
  escape: 'danger', proboscis: 'gold', groom: 'leaf', backward: 'gold',
}

export default function App() {
  const engineRef = useRef<PetEngine | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const brainRef = useRef<HTMLDivElement>(null)
  const down = useRef<{ x: number; y: number } | null>(null)
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [picked, setPicked] = useState('sugar')
  const [brainOpen, setBrainOpen] = useState(false)
  const [speed, setSpeed] = useState('1')
  const [sound, setSound] = useState(false)
  const [overview, setOverview] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settings, setSettings] = useState<Settings>({ ...DEFAULTS, picked: 'sugar' })
  const [boot, setBoot] = useState<BootState>(() => {
    const missing = missingFeatures()
    return missing.length ? { kind: 'unsupported', missing } : { kind: 'loading' }
  })

  useEffect(() => {
    // nothing below will work without these, and failing here gives a readable reason
    // instead of a WebGL exception and a black page
    if (missingFeatures().length) return

    const e = new PetEngine()
    engineRef.current = e
    let timer = 0, pending: Snapshot | null = null
    const flush = () => {
      if (pending) { setSnap(pending); setBoot({ kind: 'ready' }) }
      pending = null; timer = 0
    }
    e.boot(hostRef.current!, s => {
      pending = s
      if (!timer) timer = window.setTimeout(flush, 50)
    }, err => setBoot({ kind: 'error', err }))
      .then(restored => {
        if (!restored) return
        setSpeed(String(restored.speed))
        setPicked(restored.picked)
        setSettings(restored)
        // Audio cannot start without a gesture, so a remembered "sound on" is armed
        // rather than applied, and takes effect the first time the page is touched.
        if (restored.sound) {
          const arm = async () => {
            await e.audio.enable()
            setSound(true)
          }
          addEventListener('pointerdown', arm, { once: true })
          addEventListener('keydown', arm, { once: true })
        }
      })
      .catch(err => setBoot({ kind: 'error', err: err instanceof Error ? err : new Error(String(err)) }))
    if (import.meta.env.DEV) window.__pet = { engine: e }
    const key = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null
      if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return
      if (ev.key === 'v' || ev.key === 'V') setOverview(o => !o)
      if (ev.key === 'Escape') { setShowSettings(false); setConfirmReset(false) }
    }
    addEventListener('keydown', key)
    return () => {
      removeEventListener('keydown', key)
      e.dispose()
    }
  }, [])

  useEffect(() => { engineRef.current?.setOverview(overview) }, [overview])

  const engine = engineRef.current
  const stimuli: StimKind[] = engine?.stimuli ?? []
  const readouts = snap?.readouts ?? []
  const fed = Math.round((1 - (snap?.hunger ?? 0)) * 100)
  const calm = Math.round((1 - (snap?.startle ?? 0)) * 100)
  const firing = readouts.filter(r => r.over)

  return (
    <div className="rpg-ui-app pet-root">
      <div
        ref={hostRef}
        className="pet-viewport"
        onPointerDown={ev => { down.current = { x: ev.clientX, y: ev.clientY } }}
        onPointerUp={ev => {
          // OrbitControls owns dragging, so only a click that did not move places
          const d = down.current
          if (d && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < 5) {
            engine?.tap(ev.clientX, ev.clientY)
          }
          down.current = null
        }}
      />

      {/* the fly's own status, top left */}
      <div className="rpg-ui-hud">
        <div className="rpg-ui-avatar">
          <span role="img" aria-label="fly">🪰</span>
          {!!snap?.fed && (
            <span className="rpg-ui-avatar-level" title="meals eaten">{snap.fed}</span>
          )}
        </div>
        <div className="rpg-ui-status-bars">
          <div className="rpg-ui-status-bar">
            <div className="rpg-ui-status-bar-fill" data-type="health" style={{ width: `${fed}%` }} />
            <span className="rpg-ui-status-bar-label">Fed {fed}</span>
          </div>
          <div className="rpg-ui-status-bar">
            <div className="rpg-ui-status-bar-fill" data-type="mana" style={{ width: `${calm}%` }} />
            <span className="rpg-ui-status-bar-label">Calm {calm}</span>
          </div>
        </div>
        <div className="pet-doing">
          <b>{snap?.doing ?? '…'}</b>
          <i>{snap ? `${Math.round(snap.stepsPerSec).toLocaleString()} steps/s` : 'waking up'}</i>
        </div>
      </div>

      {/* title and settings, top right */}
      <div className="rpg-ui-glass-panel pet-title">
        <h1>A fly with a real brain</h1>
        <p>45,808 neurons simulated live in your browser</p>
        <div className="pet-title-row">
          <select className="rpg-ui-btn" value={speed}
                  onChange={ev => { setSpeed(ev.target.value); engine?.setSpeed(Number(ev.target.value)) }}>
            <option value="1">real time</option>
            <option value="0.5">half speed</option>
            <option value="0.25">quarter</option>
          </select>
          <button className="rpg-ui-btn" title={sound ? 'Mute' : 'Sound on'}
                  onClick={async () => {
                    if (!sound) { await engine?.audio.enable(); setSound(true); engine?.setSound(true) }
                    else { engine?.audio.mute(true); setSound(false); engine?.setSound(false) }
                  }}>{sound ? '🔊' : '🔇'}</button>
          <button className="rpg-ui-btn" title="Remove everything you have put down"
                  onClick={() => { engine?.clear(); engine?.saveNow() }}>Clear</button>
          <button className={`rpg-ui-btn${showSettings ? ' on' : ''}`} title="Settings"
                  aria-expanded={showSettings}
                  onClick={() => { setShowSettings(v => !v); setConfirmReset(false) }}>⚙</button>
          <a className="rpg-ui-btn" href="/">Explorer</a>
        </div>
      </div>

      {/* the brain's motor output, right */}
      <div className="rpg-ui-glass-panel pet-neurons">
        <h2>Descending neurons</h2>
        <p className="pet-sub">{firing.length ? `firing: ${firing.map(r => r.cell).join(', ')}` : 'all quiet'}</p>
        {readouts.map(r => (
          <div className="pet-neuron" key={r.id}>
            <span className="pet-neuron-name">{r.cell}</span>
            <div className="rpg-ui-bar" data-type={BAR_TYPE[r.id] ?? 'mana'}>
              <div className="rpg-ui-bar-fill"
                   style={{ width: `${Math.min(100, Math.sqrt(Math.max(r.hz, 0)) * 6.6)}%` }} />
              <span className="rpg-ui-bar-label">{r.hz < 0.5 ? '—' : Math.round(r.hz)} Hz</span>
            </div>
          </div>
        ))}
        <p className="pet-note">
          These are the fly's real output neurons. The connectome stops at the neck, so what
          it <i>does</i> is decoded from these rates. One thing is ours: a foraging drive on
          P9 and DNa02 so it wanders. Nothing else is scripted.
        </p>
      </div>

      {/* what you can put in the world, bottom centre */}
      <div className="rpg-ui-dock">
        {stimuli.map(k => (
          <button
            key={k.id}
            className={`rpg-ui-dock-slot${picked === k.id ? ' active' : ''}${k.artifact ? ' pet-artifact' : ''}`}
            title={k.blurb}
            onClick={() => { setPicked(k.id); engine?.pick(k) }}
          >
            <span className="pet-slot-emoji">{k.emoji}</span>
            <span className="pet-slot-name">{k.label}</span>
            {k.artifact && <span className="rpg-ui-dock-slot-qty">!</span>}
          </button>
        ))}
      </div>

      {/* always-on controls */}
      <div className="rpg-ui-glass-panel pet-legend">
        <h2>Controls</h2>
        <span><b>click ground</b> place</span>
        <span><b>click token</b> remove</span>
        <span><b>click fly</b> poke it</span>
        <span><b>drag</b> look around</span>
        <span><b>V</b> {overview ? 'follow' : 'overview'}</span>
      </div>

      <button className="rpg-ui-fab pet-brainfab"
              title="Show every spike in the brain"
              onClick={() => {
                const next = !brainOpen
                setBrainOpen(next)
                if (next) engine?.showBrain(brainRef.current!)
                else engine?.resizeBrain()
              }}>🧠</button>

      <div className={`rpg-ui-glass-panel pet-brainpanel${brainOpen ? ' open' : ''}`}>
        <h2>Whole brain</h2>
        <p className="pet-sub">{snap?.brainNote || '138,639 neurons'}</p>
        <div ref={brainRef} className="pet-brainhost" />
      </div>

      <SettingsPanel
        open={showSettings}
        settings={settings}
        confirmReset={confirmReset}
        onChange={patch => { setSettings(engine!.applySettings(patch)) }}
        onClose={() => { setShowSettings(false); setConfirmReset(false) }}
        onReset={() => {
          if (!confirmReset) { setConfirmReset(true); return }
          engine?.resetPet(); engine?.saveNow(); setConfirmReset(false); setShowSettings(false)
        }}
      />

      <BootOverlay state={boot} onRetry={() => location.reload()} />

      {(snap?.pops ?? []).map(p => (
        <span key={p.key} className={`pet-pop tone-${POP_TONE[p.tone] ?? 'plain'}`}
              style={{ left: p.x, top: p.y }}>
          <b>{p.value}</b>
          <i>{p.cell}</i>
        </span>
      ))}
    </div>
  )
}
