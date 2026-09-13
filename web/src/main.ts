import './style.css'
import { missingFeatures } from './support'
import { Brain } from './brain'
import { Player } from './player'
import { Raster } from './raster'
import {
  loadNeurons, loadManifest, loadExperiment,
  REGION_COLORS, REGION_LABELS, GROUP_LABELS,
  type Experiment, type Manifest, type NeuronData,
} from './data'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let neurons: NeuronData
let manifest: Manifest
let brain: Brain
let player: Player
let raster: Raster
let current: Experiment | null = null
const seedToExp = new Map<number, string>()
const clickable = new Set<number>()
const expById = new Map<string, Manifest['experiments'][number]>()

// ---------------------------------------------------------------- bootstrap
async function boot() {
  const msg = $('loading-msg')
  msg.textContent = 'loading 138,639 neurons…'
  ;[neurons, manifest] = await Promise.all([
    loadNeurons('data/neurons.bin'),
    loadManifest('data/experiments.json'),
  ])
  // a neuron can seed several experiments (sugar GRNs seed both "Sugar GRNs" and
  // "Sugar + bitter GRNs"); route a click to the first, which is the simpler one
  manifest.seed_map.idx.forEach((i, k) => {
    if (!seedToExp.has(i)) seedToExp.set(i, manifest.seed_map.exp[k])
    clickable.add(i)
  })
  for (const e of manifest.experiments) expById.set(e.exp_id, e)

  msg.textContent = 'building the point cloud…'
  brain = new Brain($('canvas-host'), neurons)
  player = new Player(brain)
  raster = new Raster($<HTMLCanvasElement>('raster'))
  player.onChange = syncTransport

  buildLegend()
  buildList()
  wireInput()
  $('provenance').innerHTML =
    `Anatomical coordinates and cell types: FlyWire&nbsp;783 (Schlegel et&nbsp;al. 2024). ` +
    `Spiking model: Shiu et&nbsp;al., run in Brian2.`
  $('exp-count').textContent = `${manifest.experiments.length}`

  if (import.meta.env.DEV) {
    ;window.__fly = {
      brain, player, raster, neurons, manifest, selectNeuron, play,
      get current() { return current },
    }
  }
  requestAnimationFrame(loop)
  $('loading').classList.add('gone')
  const first = manifest.experiments.find(e => /sugar grn/i.test(e.label)) ?? manifest.experiments[0]
  if (first) await play(first.exp_id)
}

// ------------------------------------------------------------------ sidebar
function buildLegend() {
  const used = new Set<number>()
  for (let i = 0; i < neurons.n; i++) used.add(neurons.region[i])
  $('legend').innerHTML = [...used].sort((a, b) => a - b).map(r => {
    const key = neurons.regions[r]
    return `<div class="lg"><i style="background:${REGION_COLORS[key] ?? '#556'}"></i>${REGION_LABELS[key] ?? key}</div>`
  }).join('')
}

function buildList(filter = '') {
  const f = filter.trim().toLowerCase()
  const items = manifest.experiments.filter(e =>
    !f || e.label.toLowerCase().includes(f) || e.group.toLowerCase().includes(f))
  const groups = new Map<string, typeof items>()
  for (const e of items) {
    if (!groups.has(e.group)) groups.set(e.group, [])
    groups.get(e.group)!.push(e)
  }
  const host = $('exp-list')
  host.innerHTML = [...groups].map(([g, es]) => {
    const rows = es.map(e => {
      const col = REGION_COLORS[e.group] ?? '#60b2ff'
      return `<div class="exp${current?.exp_id === e.exp_id ? ' on' : ''}" data-id="${e.exp_id}" title="${esc(e.note)}">
        <i class="dot" style="background:${col}"></i>
        <span class="lbl">${esc(e.label)}</span>
        <span class="ct">${e.n_active.toLocaleString()}</span></div>`
    }).join('')
    return `<div class="grp">${GROUP_LABELS[g] ?? g}</div>${rows}`
  }).join('') || '<div class="grp">no match</div>'
  host.querySelectorAll<HTMLElement>('.exp').forEach(el =>
    el.onclick = () => play(el.dataset.id!))
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

function renderExpInfo() {
  if (!current) return
  $('exp-label').textContent = current.label
  $('exp-note').textContent = current.note
  const s = current.stats
  const rate = current.rate2_hz
    ? `${current.rate_hz} + ${current.rate2_hz} Hz` : `${current.rate_hz} Hz`
  $('exp-stats').innerHTML = [
    ['stimulated', (current.seed_idx.length + current.seed2_idx.length).toLocaleString()],
    ['drive', rate],
    ['recruited', s.n_active.toLocaleString()],
    ['spikes', s.n_spikes.toLocaleString()],
  ].map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join('')

  $('highlights').innerHTML = current.highlights.map(h =>
    `<div class="hl${h.named ? ' named' : ''}" data-i="${h.i}">
       <span class="nm">${esc(h.name)}</span>
       <span class="t">${h.first_ms.toFixed(0)}ms · ${h.spikes}</span></div>`).join('')
  $('highlights').querySelectorAll<HTMLElement>('.hl').forEach(el =>
    el.onclick = () => { const i = +el.dataset.i!; selectNeuron(i); brain.flyTo(i) })
}

function selectNeuron(i: number | null) {
  // keep the marker in sync with the sidebar
  brain.select(i)
  const host = $('sel-body')
  if (i == null) { host.className = 'sel-empty'; host.textContent = 'Click any point in the brain.'; return }
  host.className = ''
  const type = neurons.types[neurons.type[i]] || '(unannotated)'
  const region = REGION_LABELS[neurons.regions[neurons.region[i]]] ?? '?'
  const exp = seedToExp.get(i)
  host.innerHTML = `
    <div style="font-weight:640;font-size:12.5px">${esc(type)}</div>
    <div style="color:var(--dim);font-size:11px">${region} · out ${neurons.outDeg[i]} · in ${neurons.inDeg[i]}</div>
    <div class="mono" style="color:var(--dimmer);font-size:9.5px;margin-top:3px">${neurons.flyid[i].toString()}</div>
    ${exp
      ? `<button class="ghost" style="margin-top:6px;width:100%" data-go="${exp}">▶ Play ${esc(expById.get(exp)?.label ?? exp)}</button>`
      : `<div style="margin-top:5px;color:var(--dimmer);font-size:10.5px">No baked experiment for this neuron — only the ${clickable.size.toLocaleString()} highlighted cells have one.</div>`}`
  host.querySelector<HTMLElement>('[data-go]')?.addEventListener('click', e =>
    play((e.currentTarget as HTMLElement).dataset.go!))
}

// ------------------------------------------------------------------ playing
async function play(id: string) {
  const meta = expById.get(id)
  if (!meta) return
  $('exp-label').textContent = meta.label
  $('exp-note').textContent = 'loading…'
  current = await loadExperiment(`data/exp/${id}.bin`)
  player.load(current)
  const seeds = new Set([...current.seed_idx, ...current.seed2_idx])
  raster.load(current, seeds, new Set(current.highlights.filter(h => h.named).map(h => h.i)))
  renderExpInfo()
  buildList($<HTMLInputElement>('filter').value)
  story.reset(current)
  $('raster-end').textContent = `${(current.n_frames * current.frame_ms).toFixed(0)} ms`
  $('raster-mid').textContent = `${(current.n_frames * current.frame_ms / 2).toFixed(0)} ms`
}

function syncTransport() {
  $('play').textContent = player.playing ? '❚❚' : '▶'
  const t = player.frame / Math.max(player.nFrames, 1)
  $('scrub-fill').style.width = `${t * 100}%`
  $('scrub-head').style.left = `calc(${t * 100}% - 1.5px)`
  $('clock').textContent = `${player.timeMs.toFixed(1)} / ${player.durationMs.toFixed(0)} ms`
  raster.draw(player.frame)
  if (current) {
    const el = $('exp-stats').querySelectorAll('.stat b')[2]
    if (el) el.textContent = `${player.recruited().toLocaleString()} / ${current.stats.n_active.toLocaleString()}`
  }
  story.update(player.timeMs)
}

// ------------------------------------------------------- guided tour (sugar)
const story = {
  on: false, exp: null as Experiment | null, step: -1,
  beats: [] as { at: number; k: string; t: string }[],
  reset(exp: Experiment) {
    this.exp = exp; this.step = -1
    const mn9 = exp.highlights.filter(h => /MN9/.test(h.name))
    const t0 = mn9.length ? Math.min(...mn9.map(h => h.first_ms)) : 40
    this.beats = [
      { at: 0, k: 'Step 1 — stimulus', t: `${exp.seed_idx.length} labellar sugar receptor neurons start firing at ${exp.rate_hz} Hz, as if the fly just tasted sugar.` },
      { at: 6, k: 'Step 2 — into the brain', t: 'Spikes enter the subesophageal zone, the taste and feeding centre, and fan out along real connectome wiring.' },
      { at: Math.max(t0 - 6, 14), k: 'Step 3 — the cascade', t: 'Interneurons recruit each other. Watch the wave spread while the rest of the brain stays dark.' },
      { at: t0, k: 'Step 4 — motor output', t: `MN9, the proboscis extension motor neuron, fires at ${t0.toFixed(0)} ms. The fly sticks out its tongue.` },
      { at: t0 + 60, k: 'Step 5 — specificity', t: 'Escape, walking and turning descending neurons never fire. Sugar drives feeding, and only feeding.' },
    ]
    if (!this.on) { $('story').hidden = true; $('hud').style.opacity = '' }
  },
  start() {
    this.on = true
    $('guided').classList.add('on')
    player.setSpeed(25)
    $<HTMLSelectElement>('speed').value = '25'
    player.seek(0); player.playing = true
    brain.resetView()
  },
  stop() {
    this.on = false
    $('guided').classList.remove('on')
    $('story').hidden = true
    $('hud').style.opacity = ''
  },
  update(ms: number) {
    if (!this.on || !this.exp) return
    let s = -1
    for (let i = 0; i < this.beats.length; i++) if (ms >= this.beats[i].at) s = i
    if (s !== this.step && s >= 0) {
      this.step = s
      const b = this.beats[s]
      $('story').hidden = false
      $('hud').style.opacity = '0'          // the caption sits where the hints do
      $('story').innerHTML = `<div class="st-step">${b.k}</div><div class="st-text">${esc(b.t)}</div>`
    }
  },
}

// -------------------------------------------------------------------- input
function wireInput() {
  $('play').onclick = () => player.toggle()
  $('reset').onclick = () => { player.seek(0); player.playing = true; syncTransport() }
  $<HTMLSelectElement>('speed').onchange = e =>
    player.setSpeed(+(e.target as HTMLSelectElement).value)
  $<HTMLInputElement>('filter').oninput = e =>
    buildList((e.target as HTMLInputElement).value)

  $('guided').onclick = async () => {
    if (story.on) return story.stop()
    const sugar = manifest.experiments.find(e => /sugar grn/i.test(e.label))
    if (sugar && current?.exp_id !== sugar.exp_id) await play(sugar.exp_id)
    story.start()
  }

  // scrubber
  const scrub = $('scrub')
  let dragging = false
  const setFromEvent = (e: PointerEvent) => {
    const r = scrub.getBoundingClientRect()
    player.seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * player.nFrames)
  }
  scrub.addEventListener('pointerdown', e => {
    dragging = true; player.playing = false; scrub.setPointerCapture(e.pointerId); setFromEvent(e)
  })
  scrub.addEventListener('pointermove', e => { if (dragging) setFromEvent(e) })
  scrub.addEventListener('pointerup', () => { dragging = false })
  $('raster').addEventListener('pointerdown', e => {
    player.playing = false; player.seek(raster.frameAt((e as PointerEvent).clientX))
  })

  // 3D picking
  const host = $('canvas-host')
  let downAt = { x: 0, y: 0 }
  host.addEventListener('pointerdown', e => { downAt = { x: e.clientX, y: e.clientY } })
  host.addEventListener('pointerup', e => {
    if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return
    const i = brain.pick(e.clientX, e.clientY, clickable)
    if (i == null) return
    selectNeuron(i)
    const exp = seedToExp.get(i)
    if (exp) { story.stop(); play(exp) }
  })

  const tip = $('tooltip')
  let tipRaf = 0
  host.addEventListener('pointermove', e => {
    if (tipRaf) return
    tipRaf = requestAnimationFrame(() => {
      tipRaf = 0
      const i = brain.pick(e.clientX, e.clientY, clickable)
      if (i == null) { tip.hidden = true; return }
      const type = neurons.types[neurons.type[i]] || '(unannotated)'
      const region = REGION_LABELS[neurons.regions[neurons.region[i]]] ?? '?'
      const exp = seedToExp.get(i)
      tip.hidden = false
      tip.innerHTML = `<div class="tt-t">${esc(type)}</div>
        <div class="tt-r">${region} · out ${neurons.outDeg[i]} · in ${neurons.inDeg[i]}</div>
        <div class="tt-id">${neurons.flyid[i].toString()}</div>
        ${exp ? `<div class="tt-go">click to poke → ${esc(expById.get(exp)?.label ?? '')}</div>` : ''}`
      const r = host.getBoundingClientRect()
      tip.style.left = `${Math.min(e.clientX - r.left + 14, r.width - 275)}px`
      tip.style.top = `${Math.min(e.clientY - r.top + 14, r.height - 90)}px`
    })
  })
  host.addEventListener('pointerleave', () => { tip.hidden = true })

  addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return
    if (e.code === 'Space') { e.preventDefault(); player.toggle() }
    else if (e.key === 'r' || e.key === 'R') { brain.resetView(); player.seek(0); player.playing = true }
    else if (e.key === 'ArrowRight') { e.preventDefault(); player.step(1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); player.step(-1) }
  })

  $('hud').innerHTML =
    `<kbd>drag</kbd> rotate · <kbd>scroll</kbd> zoom · <kbd>click</kbd> poke a neuron<br>
     <kbd>space</kbd> play/pause · <kbd>R</kbd> reset · <kbd>← →</kbd> step a frame`
}

// --------------------------------------------------------------------- loop
let prev = performance.now()
function loop(now: number) {
  const dt = Math.min((now - prev) / 1000, 0.1)
  prev = now
  player.tick(dt)
  brain.render(dt)
  requestAnimationFrame(loop)
}

function stop(msg: string) {
  console.error('[explorer]', msg)
  $('loading').classList.add('failed')       // hides the spinner; it kept spinning
  $('loading-msg').textContent = msg
}

// Checked before boot so an unsupported browser gets a sentence rather than a
// three.js exception behind a spinner that never stops.
const missing = missingFeatures()
if (missing.length) {
  stop(`This browser is missing ${missing.map(m => m.name).join(' and ')}. `
     + 'A current Chrome, Edge, Firefox or Safari 16.4+ will work.')
} else {
  boot().catch(err => stop(err instanceof Error ? err.message : String(err)))
}
