// The play page's HUD: the round, the people, the pouch, and what the fly's brain is
// doing. React only draws the snapshot view.ts emits; the world underneath is the
// pet's Scene3D fed from the server.
import { useEffect, useRef, useState } from 'react'
import 'open-props/easings'
import '../pet/ui.css'
import './play.css'
import { PlayView, type PlaySnapshot } from './view'
import { rememberedName } from './net'
import { NAME_MAX, ROUND, TOOLS, TOOL, type ToolId } from './protocol'
import { webgl2 } from '../support'
import { QUALITIES, type Quality } from '../pet/save'
import { ToolIcon, SoundIcon, MuteIcon, PulseIcon, SlidersIcon, CloseIcon } from '../icons'

const WORDS: Record<string, { does: string; who: string }> = {
  forward:   { does: 'Walk forwards',      who: 'P9' },
  turn_a:    { does: 'Steer, one pair',    who: 'DNa01' },
  turn_b:    { does: 'Steer, other pair',  who: 'DNa02' },
  backward:  { does: 'Walk backwards',     who: 'MDN, the moonwalker cells' },
  escape:    { does: 'Jump and fly away',  who: 'the giant fibre' },
  proboscis: { does: 'Put its tongue out', who: 'MN9' },
  groom:     { does: 'Clean its antennae', who: 'aDN1' },
}
const POP_TONE: Record<string, string> = { critical: 'danger', heal: 'gold', magic: 'leaf', guard: 'gold' }
/** each tool in the colour of the stimulus it is, softened to sit on ink */
const TOOL_COLOUR: Record<ToolId, string> = {
  sugar: 'oklch(85% 0.12 84)', looming: 'oklch(76% 0.13 15)', bitter: 'oklch(78% 0.10 300)',
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function Tool({ id, active, slot, onPick }: {
  id: ToolId; active: boolean; onPick: () => void
  slot: { out: number; max: number; readyIn: number } | undefined
}) {
  const t = TOOL.get(id)!
  const wait = slot ? slot.readyIn : 0
  const frac = wait > 0 ? Math.min(1, wait / t.cooldownMs) : 0
  return (
    <button className={`play-tool${active ? ' active' : ''}${wait ? ' wait' : ''}`}
            style={{ '--tool': TOOL_COLOUR[id] } as React.CSSProperties}
            title={`${t.does}. ${t.how}.`} aria-pressed={active} onClick={onPick}>
      <span className="play-tool-icon">
        <ToolIcon id={id} />
        {wait > 0 && (
          <svg className="play-tool-ring" viewBox="0 0 38 38" aria-hidden="true">
            <circle cx="19" cy="19" r="17" pathLength={100} strokeDasharray={100} strokeDashoffset={100 - frac * 100} />
          </svg>
        )}
      </span>
      <span className="play-tool-text"><b>{t.label}</b><small>{t.does}</small></span>
      {wait > 0
        ? <span className="play-tool-wait">{Math.ceil(wait / 1000)} s</span>
        : slot && (
          <span className="play-tool-dots" aria-label={`${slot.max - slot.out} of ${slot.max} to place`}>
            {Array.from({ length: slot.max }, (_, i) => <i key={i} className={i < slot.max - slot.out ? '' : 'used'} />)}
          </span>
        )}
    </button>
  )
}

export default function App() {
  const viewRef = useRef<PlayView | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLDivElement>(null)
  const down = useRef<{ x: number; y: number; touch: boolean } | null>(null)
  const [snap, setSnap] = useState<PlaySnapshot | null>(null)
  const [supported] = useState(() => webgl2())
  const [name, setName] = useState(rememberedName)
  const [picked, setPicked] = useState<ToolId>('sugar')
  const [overview, setOverview] = useState(true)
  const [sound, setSound] = useState(false)
  const [showBrain, setShowBrain] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [quality, setQuality] = useState<Quality>('high')
  const [here, setHere] = useState<number | null>(null)
  const [autoNote, setAutoNote] = useState<string | null>(null)

  useEffect(() => {
    if (!supported) return
    const v = new PlayView()
    viewRef.current = v
    let pending: PlaySnapshot | null = null, timer = 0
    v.boot(hostRef.current!, labelRef.current!, s => {
      pending = s
      if (!timer) timer = window.setTimeout(() => { if (pending) setSnap(pending); pending = null; timer = 0 }, 40)
    })
    setQuality(v.quality ?? 'high')
    if (import.meta.env.DEV || /(?:\?|&)perf=1(?:&|$)/.test(location.search)) window.__pet = { view: v }
    // who is there already, for the door
    const health = v.serverUrl.replace(/^ws/, 'http').replace(/\/ws$/, '/healthz')
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 4000)
    fetch(health, { signal: ctl.signal }).then(r => r.json()).then((j: { rooms?: { players: number }[] }) => {
      setHere((j.rooms ?? []).reduce((n, r) => n + r.players, 0))
    }).catch(() => { /* the door says nothing, then */ }).finally(() => clearTimeout(t))
    const key = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null
      if (el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return
      if (ev.key === 'v' || ev.key === 'V') setOverview(o => !o)
      if (ev.key === '1') setPicked('sugar')
      if (ev.key === '2') setPicked('looming')
      if (ev.key === '3') setPicked('bitter')
      if (ev.key === 'b' || ev.key === 'B') setShowBrain(o => !o)
      if (ev.key === 'Escape') { setShowBrain(false); setShowSettings(false) }
    }
    addEventListener('keydown', key)
    return () => { removeEventListener('keydown', key); ctl.abort(); v.dispose() }
  }, [supported])

  useEffect(() => { viewRef.current?.setOverview(overview) }, [overview])
  useEffect(() => { viewRef.current?.pick(picked) }, [picked])
  useEffect(() => {
    const q = snap?.autoQuality
    if (!q) return
    setQuality(q)
    setAutoNote(`Graphics turned down to ${q} to keep the frame rate up.`)
    const t = setTimeout(() => setAutoNote(null), 8000)
    return () => clearTimeout(t)
  }, [snap?.autoQuality])

  const view = viewRef.current
  const join = async () => {
    if (!view) return
    const n = name.trim().slice(0, NAME_MAX) || rememberedName()
    setName(n)
    view.connect(n)
    // the click is the gesture audio needs; a remembered "sound on" takes effect here
    if (view.wantsSound) { await view.setSound(true); setSound(true) }
  }

  const me = snap?.me ?? null
  const players = snap?.players ?? []
  const round = snap?.round
  const firing = (snap?.readouts ?? []).filter(r => r.over)
  const myRank = me ? players.findIndex(p => p.id === me.id) + 1 : 0
  const top = players.slice(0, 5)
  const failed = snap?.status === 'failed'
  // the door: until seated for the first time. A socket that drops later is a
  // reconnect (the chip), not a new door.
  const door = !snap?.joined && (failed || !snap?.everJoined)
  const joining = snap?.status === 'connecting'
  const late = round?.phase === 'play' && round.left < 10_000

  return (
    <div className="play-root">
      <div
        ref={hostRef}
        className="play-viewport"
        onPointerDown={ev => { down.current = { x: ev.clientX, y: ev.clientY, touch: ev.pointerType !== 'mouse' } }}
        onPointerMove={ev => view?.hover(ev.clientX, ev.clientY)}
        onPointerLeave={() => view?.hover(null, null)}
        onPointerUp={ev => {
          const d = down.current
          const slack = d?.touch ? 12 : 5
          if (d && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < slack) view?.tap(ev.clientX, ev.clientY)
          down.current = null
        }}
      />
      <div ref={labelRef} className="play-labels" aria-hidden="true" />

      {/* the round and the fly, top left */}
      <div className="play-top">
        <div className={`play-glass play-round${late ? ' late' : ''}${round?.phase === 'between' ? ' between' : ''}`}>
          <span className="play-eyebrow">{round?.phase === 'between' ? 'Next round in' : `Round ${round?.n ?? '…'}`}</span>
          <b className="play-clock">{round ? clock(round.left) : '–:––'}</b>
        </div>
        <div className="play-glass play-state">
          <b>{snap?.doing ?? '…'}</b>
          {snap?.why && <span>because {snap.why}</span>}
          <i>{snap?.joined
            ? `${Math.round(snap.sps).toLocaleString()} steps/s on the server${snap.fps ? ` · ${Math.round(snap.fps)} fps` : ''}`
            : 'the fly is on the server'}</i>
        </div>
      </div>

      {/* the people, top right */}
      <div className="play-side">
        <div className="play-glass play-people">
          <div className="play-people-head">
            <h2>{players.length} in the meadow</h2>
            <button className={`play-btn${showBrain ? ' on' : ''}`} aria-expanded={showBrain}
                    title="What its brain is telling its body (B)" onClick={() => setShowBrain(v => !v)}>
              <PulseIcon /> {firing.length ? `${firing.length} firing` : 'Brain'}
            </button>
          </div>
          <ol className="play-scores">
            {top.map((p, i) => (
              <li key={p.id} className={p.id === me?.id ? 'me' : ''}>
                <em>{i + 1}</em>
                <i style={{ background: p.colour }} />
                <span>{p.name}</span>
                <b>{p.score}</b>
              </li>
            ))}
            {me && myRank > 5 && (
              <li className="me">
                <em>{myRank}</em><i style={{ background: me.colour }} /><span>{me.name}</span><b>{me.score}</b>
              </li>
            )}
          </ol>
        </div>
        <div className="play-actions">
          <button className="play-btn" title="Overview or follow the fly (V)" onClick={() => setOverview(o => !o)}>
            {overview ? 'Follow' : 'Overview'}
          </button>
          <button className="play-btn play-btn-icon" title={sound ? 'Mute' : 'Sound on'} aria-label={sound ? 'Mute' : 'Sound on'}
                  onClick={async () => { const on = !sound; await view?.setSound(on); setSound(on) }}>
            {sound ? <SoundIcon /> : <MuteIcon />}
          </button>
          <button className={`play-btn play-btn-icon${showSettings ? ' on' : ''}`} title="Graphics" aria-label="Graphics"
                  aria-expanded={showSettings} onClick={() => setShowSettings(v => !v)}><SlidersIcon /></button>
          <a className="play-btn" href="./pet.html" title="One fly of your own, with its brain in your browser">Lab</a>
          <a className="play-btn" href="./how.html" title="What is actually deciding, and how">How?</a>
        </div>
      </div>

      {/* the brain's motor output */}
      <aside className={`play-glass play-brain${showBrain ? ' open' : ''}`} aria-label="What its brain is telling its body">
        <div className="play-brain-head">
          <h2>What its brain is telling its body</h2>
          <button className="play-btn play-btn-icon play-brain-x" aria-label="Close" onClick={() => setShowBrain(false)}><CloseIcon /></button>
        </div>
        <p className="play-brain-now">
          {firing.length
            ? <>Right now: <b>{firing.map(r => WORDS[r.id]?.does ?? r.id).join(', ').toLowerCase()}</b></>
            : 'Right now: nothing. Give it something to react to.'}
        </p>
        <div className="play-brain-rows">
          {(snap?.readouts ?? []).map(r => {
            const on = r.hz >= 0.5
            return (
              <div className={`play-readout${on ? ' on' : ''}`} key={r.id}>
                <div className="play-readout-top">
                  <b>{WORDS[r.id]?.does ?? r.id}</b>
                  <span>{on ? <>{Math.round(r.hz)}<i>/s</i></> : 'silent'}</span>
                </div>
                <div className="play-readout-bar"><i style={{ width: `${Math.min(100, Math.sqrt(Math.max(r.hz, 0)) * 6.6)}%` }} /></div>
                <small>{WORDS[r.id]?.who ?? r.id}</small>
              </div>
            )
          })}
        </div>
        <p className="play-brain-note">
          Seven small groups of real nerve cells, with 45,808 neurons of the fly connectome
          behind them, stepped on the server. Everything the fly does is read off these.
          Two things are ours: a wander drive so it explores, and it is kept hungry so the
          game keeps going.
        </p>
      </aside>

      {/* what happened, bottom left */}
      <ol className="play-feed" aria-live="polite">
        {(snap?.feed ?? []).map(f => (
          <li key={f.key} className={f.mine ? 'mine' : ''}>
            <i style={f.colour ? { background: f.colour } : undefined} />{f.text}
          </li>
        ))}
      </ol>

      {/* the pouch, bottom centre */}
      <nav className="play-glass play-dock" aria-label="Tools">
        {TOOLS.map(t => (
          <Tool key={t.id} id={t.id} active={picked === t.id} slot={snap?.pouch[t.id]} onPick={() => setPicked(t.id)} />
        ))}
      </nav>
      <p className="play-hint">
        <b>Click the ground</b> to place · <b>click yours</b> to pick it up · <b>drag</b> to look around
      </p>

      {/* between rounds */}
      {snap?.joined && round?.phase === 'between' && (
        <div className="play-podium-scrim" role="status">
          <div className="play-glass play-podium">
            <span className="play-eyebrow">Round {round.n} over</span>
            <h2>{snap.podium?.length
              ? `${snap.podium[0].id === me?.id ? 'You' : snap.podium[0].name} lured it ${snap.podium[0].score === 1 ? 'once' : `${snap.podium[0].score} times`}`
              : 'It ate nobody’s sugar'}</h2>
            {snap.podium && snap.podium.length > 0 ? (
              <ol>
                {snap.podium.map((p, i) => (
                  <li key={p.id} className={p.id === me?.id ? 'me' : ''}>
                    <em>{i + 1}</em>
                    <i style={{ background: p.colour }} />
                    <span>{p.name}</span>
                    <b>{p.score}</b>
                  </li>
                ))}
              </ol>
            ) : <p>Put it where it walks.</p>}
            <p>Next round in <b>{clock(round.left)}</b></p>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="play-glass play-settings" role="dialog" aria-label="Graphics">
          <div className="play-settings-head">
            <h2>Graphics</h2>
            <button className="play-btn play-btn-icon play-brain-x" aria-label="Close" onClick={() => setShowSettings(false)}><CloseIcon /></button>
          </div>
          <div className="play-seg" role="radiogroup" aria-label="Graphics quality">
            {QUALITIES.map(q => (
              <button key={q} role="radio" aria-checked={quality === q}
                      className={`play-btn${quality === q ? ' on' : ''}`}
                      onClick={() => { setQuality(q); view?.setQuality(q) }}>{q}</button>
            ))}
          </div>
          <p>Low turns shadows off. The fly and the people are the same at every tier.</p>
        </div>
      )}

      {autoNote && (
        <div className="play-glass play-toast" role="status">
          <span>{autoNote}</span>
          <button className="play-btn" onClick={() => setAutoNote(null)}>OK</button>
        </div>
      )}

      {snap && !snap.joined && snap.everJoined && !failed && (
        <div className="play-glass play-reconnect" role="status">Reconnecting…</div>
      )}

      {/* the door */}
      {(door || !supported) && (
        <div className="play-door">
          <div className="play-glass play-card">
            {!supported ? (
              <>
                <h2>This browser can&rsquo;t run it</h2>
                <p>The meadow is drawn with <b>WebGL 2</b>, which this browser doesn&rsquo;t have.
                   A current Chrome, Edge, Firefox or Safari will work.</p>
              </>
            ) : failed ? (
              <>
                <h2>Couldn&rsquo;t reach the meadow</h2>
                <p>{snap?.detail}</p>
                <p>The game needs its server running. If this is your own copy of the site, start it
                   with <code>npm run play</code> and build the pages with <code>VITE_PLAY_SERVER</code> set
                   to where it lives.</p>
                <button className="play-btn play-btn-primary" onClick={join}>Try again</button>
              </>
            ) : (
              <>
                <span className="play-eyebrow">Everyone shares one fly</span>
                <h1 className="play-title">Lure the fly</h1>
                <ul className="play-rules">
                  {TOOLS.map(t => (
                    <li key={t.id}>
                      <span className="play-tool-icon" style={{ '--tool': TOOL_COLOUR[t.id] } as React.CSSProperties}><ToolIcon id={t.id} size={17} /></span>
                      <span><b>{t.label}.</b> {t.id === 'sugar' ? 'Drop it where the fly will walk. If it eats yours, you score.' : t.does + '.'}</span>
                    </li>
                  ))}
                </ul>
                <p className="play-rules-note">
                  Its brain is real: 45,808 neurons of a fly, stepped live on the server. Nobody
                  steers it. Rounds are {ROUND.playMs / 1000} seconds.
                </p>
                <form className="play-join" onSubmit={ev => { ev.preventDefault(); if (!joining) void join() }}>
                  <label>
                    <span>Your name</span>
                    <input value={name} maxLength={NAME_MAX} autoComplete="nickname"
                           onChange={ev => setName(ev.target.value)} />
                  </label>
                  <button className="play-btn play-btn-primary play-go" type="submit" disabled={joining}>
                    {joining ? 'Joining…' : 'Join'}
                  </button>
                </form>
                <p className="play-here">
                  {here === null ? '' : here === 0 ? 'Nobody is in the meadow right now. The fly is waiting.'
                    : `${here} ${here === 1 ? 'person is' : 'people are'} in the meadow right now.`}
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {(snap?.pops ?? []).map(p => (
        <span key={p.key} className={`play-pop tone-${POP_TONE[p.tone] ?? 'plain'}`} style={{ left: p.x, top: p.y }}>
          <b>{p.value}</b>
          <i>{p.cell}</i>
        </span>
      ))}
    </div>
  )
}
