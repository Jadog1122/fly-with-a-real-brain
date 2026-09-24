// The whole screen is the game: the world fills it and the HUD floats on top.
// Every panel, bar, dock slot and button is a @rpgjs/ui-css primitive; theme.css
// retints that library's tokens to the meadow's palette without rewriting its CSS.
import { useEffect, useRef, useState } from 'react'
// Only the token groups this UI uses, not the whole of Open Props
import 'open-props/shadows'
import 'open-props/easings'
import 'open-props/borders'
import './ui.css'
import { PetEngine, type Snapshot } from './engine'
import type { StimKind } from './sensors'
import { BootOverlay, type BootState } from './BootOverlay'
import { missingFeatures } from '../support'
import { SettingsPanel } from './SettingsPanel'
import { DEFAULTS, type Settings } from './save'
import { Tracker, Notebook, DiscoveryToast } from './Notebook'
import type { Discovery } from './mind'

const BAR_TYPE: Record<string, string> = {
  escape: 'health', proboscis: 'experience', groom: 'stamina',
  forward: 'mana', backward: 'mana', turn_a: 'mana', turn_b: 'mana',
}
/**
 * What each readout means in words anyone can read.  The panel used to show the raw
 * cell name - "P9 oDN1", "MDN", "aDN1" - which is only meaningful if you already know
 * the fly literature.  The cell name is kept, but as the footnote rather than the
 * headline.
 */
const PLAIN: Record<string, { does: string; who: string }> = {
  forward:   { does: 'Walk forwards',      who: 'P9' },
  // Two separate steering pairs. Both really are "steer" - no functional split is
  // claimed here beyond their being different cells.
  turn_a:    { does: 'Steer, one pair',    who: 'DNa01' },
  turn_b:    { does: 'Steer, other pair',  who: 'DNa02' },
  backward:  { does: 'Walk backwards',     who: 'MDN, the "moonwalker" cells' },
  escape:    { does: 'Jump and fly away',  who: 'the giant fibre, its fastest nerve' },
  proboscis: { does: 'Put its tongue out', who: 'MN9' },
  groom:     { does: 'Clean its antennae', who: 'aDN1' },
}

const POP_TONE: Record<string, string> = {
  escape: 'danger', proboscis: 'gold', groom: 'leaf', backward: 'gold',
}

export default function App() {
  const engineRef = useRef<PetEngine | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const brainRef = useRef<HTMLDivElement>(null)
  const down = useRef<{ x: number; y: number; touch: boolean } | null>(null)
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [picked, setPicked] = useState('sugar')
  const [brainOpen, setBrainOpen] = useState(false)
  const [speed, setSpeed] = useState('1')
  const [sound, setSound] = useState(false)
  const [overview, setOverview] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [paused, setPaused] = useState(false)
  const [autoNote, setAutoNote] = useState<string | null>(null)
  const [showOrders, setShowOrders] = useState(false)
  const [settings, setSettings] = useState<Settings>({ ...DEFAULTS, picked: 'sugar' })
  // the mind layer: its view in the world, the notebook, and the last thing discovered
  const [mindOn, setMindOn] = useState(true)
  const [bookOpen, setBookOpen] = useState(false)
  const [bookFocus, setBookFocus] = useState<string | null>(null)
  const [found, setFound] = useState<Discovery | null>(null)
  const seen = useRef(0)
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
    setMindOn(e.mindViewOn)
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
    // Also in production behind ?perf=1, so scripts/perf.mjs can measure the real
    // shipped build - the frame rate was guesswork for far too long because nothing
    // outside a dev server could reach the renderer.
    if (import.meta.env.DEV || /(?:\?|&)perf=1(?:&|$)/.test(location.search))
      window.__pet = { engine: e }
    const key = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null
      if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return
      if (ev.key === 'v' || ev.key === 'V') setOverview(o => !o)
      if (ev.key === 'm' || ev.key === 'M') { const on = !e.mindViewOn; e.setMindView(on); setMindOn(on) }
      if (ev.key === 'n' || ev.key === 'N') { setBookFocus(null); setBookOpen(o => !o) }
      if (ev.key === 'Escape') { setShowSettings(false); setConfirmReset(false); setBookOpen(false) }
      if (ev.key === 'p' || ev.key === 'P' || ev.key === ' ') {
        ev.preventDefault()               // Space would otherwise re-click a focused button
        setPaused(e.togglePause())
      }
    }
    addEventListener('keydown', key)
    return () => {
      removeEventListener('keydown', key)
      e.dispose()
    }
  }, [])

  useEffect(() => { engineRef.current?.setOverview(overview) }, [overview])

  // A discovery arrives numbered, so one landing between two snapshots is not lost.
  useEffect(() => {
    const d = snap?.discovery
    if (!d || d.n <= seen.current) return
    seen.current = d.n
    setFound(d.d)
  }, [snap?.discovery])

  // The renderer drops a tier on its own if it cannot hold the frame rate. Say so
  // rather than silently changing what the user chose.
  useEffect(() => {
    const q = snap?.autoQuality
    if (!q) return
    setSettings(s => ({ ...s, quality: q }))
    setAutoNote(`Graphics turned down to ${q} to keep the frame rate up. You can change it in settings.`)
    const t = setTimeout(() => setAutoNote(null), 9000)
    return () => clearTimeout(t)
  }, [snap?.autoQuality])

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
        onPointerDown={ev => {
          down.current = { x: ev.clientX, y: ev.clientY, touch: ev.pointerType !== 'mouse' }
        }}
        onPointerUp={ev => {
          // OrbitControls owns dragging, so only a press that did not move places a
          // token. A finger wobbles far more than a mouse, so touch gets more slack.
          const d = down.current
          const slack = d?.touch ? 12 : 5
          if (d && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < slack) {
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
          {/* the cause, from mind.ts: what is driving the behaviour it shows */}
          {snap?.why && <span className="pet-why">because {snap.why}</span>}
          <i>{snap
            ? `${Math.round(snap.stepsPerSec).toLocaleString()} steps/s${
                snap.fps ? ` · ${Math.round(snap.fps)} fps` : ''}`
            : 'waking up'}</i>
        </div>
      </div>

      {/* title and settings, top right */}
      <div className="rpg-ui-glass-panel pet-title">
        <h1>A fly with a real brain</h1>
        <p>45,808 neurons simulated live in your browser</p>
        <button className="rpg-ui-btn pet-orders-btn"
                aria-expanded={showOrders}
                onClick={() => setShowOrders(v => !v)}>
          🧠 {firing.length ? `${firing.length} firing now` : "What the brain is doing"}
        </button>
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
          <button className={`rpg-ui-btn${paused ? ' on' : ''}`}
                  title={paused ? 'Resume (P)' : 'Pause (P)'}
                  aria-pressed={paused}
                  onClick={() => setPaused(engine!.togglePause())}>
            {paused ? '▶' : '❚❚'}
          </button>
          <button className={`rpg-ui-btn${mindOn ? ' on' : ''}`}
                  title="Show what it senses and where its brain is steering it (M)"
                  aria-pressed={mindOn}
                  onClick={() => { const on = !mindOn; engine?.setMindView(on); setMindOn(on) }}>
            Mind
          </button>
          <button className={`rpg-ui-btn${showSettings ? ' on' : ''}`} title="Settings"
                  aria-expanded={showSettings}
                  onClick={() => { setShowSettings(v => !v); setConfirmReset(false) }}>⚙</button>
          <a className="rpg-ui-btn" href="./index.html">Explorer</a>
          {/* the tutorial: what this thing is, told so a ten-year-old can follow it */}
          <a className="rpg-ui-btn" href="./how.html" title="What is actually deciding, and how">How?</a>
        </div>
      </div>

      {/* the brain's motor output, right */}
      <div className={`rpg-ui-glass-panel pet-neurons${showOrders ? ' open' : ''}`}>
        <div className="pet-neurons-head">
          <h2>What the brain is telling the body</h2>
          <button className="rpg-ui-btn pet-neurons-x" aria-label="Close"
                  onClick={() => setShowOrders(false)}>✕</button>
        </div>
        <p className="pet-sub">
          {firing.length
            ? <>Right now: <b>{firing.map(r => PLAIN[r.id]?.does ?? r.cell).join(', ').toLowerCase()}</b></>
            : 'Right now: nothing. Give it something to react to.'}
        </p>

        {readouts.map(r => {
          const plain = PLAIN[r.id]
          const on = r.hz >= 0.5
          return (
            <div className={`pet-neuron${on ? ' on' : ''}`} key={r.id}>
              <div className="pet-neuron-top">
                <b>{plain?.does ?? r.cell}</b>
                <span className="pet-neuron-rate">
                  {on ? <>{Math.round(r.hz)}<i>×/sec</i></> : <i>silent</i>}
                </span>
              </div>
              <div className="rpg-ui-bar" data-type={BAR_TYPE[r.id] ?? 'mana'}>
                <div className="rpg-ui-bar-fill"
                     style={{ width: `${Math.min(100, Math.sqrt(Math.max(r.hz, 0)) * 6.6)}%` }} />
              </div>
              <span className="pet-neuron-cell">{plain?.who ?? r.cell}</span>
            </div>
          )
        })}

        <p className="pet-note">
          Each bar is one small group of real nerve cells, and the number is how many
          times a second they are firing. They are the fly&rsquo;s only way to tell its
          body what to do &mdash; everything you see it do is read off these seven.
          One thing is ours: a wander drive on the steering cells, so it explores.
          Nothing else is scripted.
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
        <span><b>M</b> mind view &middot; <b>N</b> notebook</span>
      </div>

      {snap?.notebook && (
        <Tracker view={snap.notebook} onOpen={() => { setBookFocus(null); setBookOpen(true) }} />
      )}
      {snap?.notebook && (
        <Notebook open={bookOpen} view={snap.notebook} focus={bookFocus}
                  onClose={() => setBookOpen(false)}
                  onForget={() => { engine?.forgetNotebook(); seen.current = 0 }} />
      )}
      {/* The model's own failure, shown rather than hidden: a readout running on its
          own (mind.ts). A restart is the game's, and the notice says what it is doing. */}
      {snap?.stuck && (
        <div className="rpg-ui-glass-panel mind-stuck" role="status">
          <b>Its brain is stuck in a loop</b>
          <span>
            {snap.stuck.readout === 'proboscis'
              ? <>MN9, the tongue command, is firing at <em>{Math.round(snap.stuck.rate)} /s</em> with
                  nothing to taste. The last thing to drive it was {snap.stuck.cause}.</>
              : <>DNa01 is steering at <em>{Math.round(snap.stuck.rate)} /s</em> with nothing
                  there. The last thing to drive it was {snap.stuck.cause}.</>}
            {' '}Cells in this network are keeping each other firing, and nothing in the model
            tires, so it will not stop by itself.
          </span>
          <div className="mind-found-row">
            <button className="rpg-ui-btn" onClick={() => engine?.restartBrain()}
                    title="Every neuron back to rest. The body and the notebook stay.">
              Restart its brain
            </button>
            <button className="rpg-ui-btn" onClick={() => { setBookFocus('stuck'); setBookOpen(true) }}>
              Why?
            </button>
          </div>
        </div>
      )}
      {found && (
        <DiscoveryToast d={found}
                        onRead={() => { setBookFocus(found.id); setBookOpen(true); setFound(null) }}
                        onClose={() => setFound(null)} />
      )}

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

      {autoNote && (
        <div className="pet-toast rpg-ui-glass-panel" role="status">
          <span>{autoNote}</span>
          <button className="rpg-ui-btn" onClick={() => setAutoNote(null)}>OK</button>
        </div>
      )}

      {paused && (
        <div className="pet-paused" role="status">
          <div className="rpg-ui-glass-panel pet-paused-chip">
            <b>Paused</b>
            <span>the brain has stopped stepping</span>
          </div>
        </div>
      )}

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
