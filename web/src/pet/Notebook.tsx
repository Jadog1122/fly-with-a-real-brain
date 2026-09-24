// The field notebook: experiments to run on the fly, and what this fly showed you.
// The judging is in mind.ts; this only lays it out.
import { useEffect, useRef, useState } from 'react'
import { EXPERIMENTS, type Discovery, type NotebookView } from './mind'
import './mind.css'

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/** The experiment you are on, always in view - the quest tracker. */
export function Tracker({ view, onOpen }: { view: NotebookView; onOpen: () => void }) {
  const n = EXPERIMENTS.length
  const got = Object.keys(view.done).length
  // its own number in the notebook - they can be done in any order
  const at = EXPERIMENTS.findIndex(x => x.id === view.next)
  const e = EXPERIMENTS[at]
  return (
    <div className="rpg-ui-glass-panel mind-tracker" role="region" aria-label="Current experiment">
      <div className="mind-tracker-top">
        <span className="mind-kicker">{e ? `Experiment ${at + 1} of ${n}` : `All ${n} done`}</span>
        <button className="rpg-ui-btn mind-tracker-open" onClick={onOpen}
                title="Open the field notebook (N)">📓 {got}/{n}</button>
      </div>
      {e ? (
        <>
          <b className="mind-tracker-title">{e.title}</b>
          <p className="mind-tracker-ask">{e.ask}</p>
          {/* the hint waits, so the first try is the player's own */}
          {view.onNext > 75_000 && <p className="mind-tracker-hint">{e.hint}</p>}
        </>
      ) : (
        <p className="mind-tracker-ask">
          Every experiment in the notebook is done. The fly is still yours to poke at.
        </p>
      )}
    </div>
  )
}

function Card({ d, index }: { d: Discovery; index: number }) {
  const e = EXPERIMENTS.find(x => x.id === d.id)!
  return (
    <article className="mind-card done" id={`mind-${d.id}`}>
      <header>
        <span className="mind-num">{index + 1}</span>
        <h3>{e.title}</h3>
        <span className="mind-at" title="fly time">{clock(d.at)}</span>
      </header>
      <dl className="mind-readings">
        {d.readings.map(r => (
          <div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>
        ))}
      </dl>
      <ol className="mind-path" aria-label="the pathway">
        {e.path.map(step => <li key={step}>{step}</li>)}
      </ol>
      <p>{e.shows}</p>
      {d.note && <p className="mind-note">{d.note}</p>}
      {e.ours && <p className="mind-ours"><b>Ours, not the connectome&rsquo;s:</b> {e.ours}</p>}
      <p className="mind-measured">Checked before it went in: {e.measured}.</p>
    </article>
  )
}

export function Notebook({ open, view, focus, onClose, onForget }: {
  open: boolean; view: NotebookView; focus: string | null
  onClose: () => void; onForget: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open || !focus) return
    body.current?.querySelector(`#mind-${focus}`)?.scrollIntoView({ block: 'start' })
  }, [open, focus])
  useEffect(() => { if (!open) setConfirm(false) }, [open])
  const got = Object.keys(view.done).length
  return (
    <div className={`mind-book-scrim${open ? ' open' : ''}`} onClick={onClose} aria-hidden={!open}>
      <section className="rpg-ui-glass-panel mind-book" role="dialog" aria-label="Field notebook"
               onClick={ev => ev.stopPropagation()}>
        <div className="mind-book-head">
          <div>
            <h2>Field notebook</h2>
            <p>{got} of {EXPERIMENTS.length} discovered &middot; every number here is this fly&rsquo;s own,
              recorded the moment it happened</p>
          </div>
          <button className="rpg-ui-btn mind-x" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="mind-book-body" ref={body}>
          {EXPERIMENTS.map((e, i) => {
            const d = view.done[e.id]
            if (d) return <Card key={e.id} d={d} index={i} />
            const current = view.next === e.id
            return (
              <article key={e.id} className={`mind-card${current ? ' current' : ''}`} id={`mind-${e.id}`}>
                <header>
                  <span className="mind-num">{i + 1}</span>
                  <h3>{e.title}</h3>
                  {current && <span className="mind-at">now</span>}
                </header>
                <p>{e.ask}</p>
                {current && view.onNext > 75_000 && <p className="mind-note">{e.hint}</p>}
              </article>
            )
          })}
        </div>
        <div className="mind-book-foot">
          <button className={`rpg-ui-btn${confirm ? ' pet-danger' : ''}`}
                  onClick={() => {
                    if (!confirm) { setConfirm(true); return }
                    onForget(); setConfirm(false)
                  }}>
            {confirm ? 'Really start the notebook over?' : 'Start the notebook over'}
          </button>
        </div>
      </section>
    </div>
  )
}

/** The moment something is discovered. */
export function DiscoveryToast({ d, onRead, onClose }: {
  d: Discovery; onRead: () => void; onClose: () => void
}) {
  const e = EXPERIMENTS.find(x => x.id === d.id)
  // the parent re-renders on every snapshot, so hold the latest callback rather than
  // restarting the timer each time it arrives as a new function
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const t = setTimeout(() => close.current(), 11_000)
    return () => clearTimeout(t)
  }, [d])
  if (!e) return null
  return (
    <div className="rpg-ui-glass-panel mind-found" role="status">
      <span className="mind-kicker">Discovered</span>
      <b>{e.title}</b>
      <span className="mind-found-reading">
        {d.readings[0].label}: <em>{d.readings[0].value}</em>
      </span>
      <div className="mind-found-row">
        <button className="rpg-ui-btn" onClick={onRead}>Read it in the notebook</button>
        <button className="rpg-ui-btn" onClick={onClose} aria-label="Dismiss">✕</button>
      </div>
    </div>
  )
}
