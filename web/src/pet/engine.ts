// Everything imperative about the pet: the arena, the worker, the drive loop and the
// canvas.  The HUD is React (see App.tsx) and only ever reads a snapshot from here, so
// the 60 fps simulation loop never goes through React.

import { STIMULI, computeDrive, foragingDrive, Saccades,
         type SensorGroup, type StimKind } from './sensors'
import { MotorDecoder, type Action, type Rates } from './motor'
import { World } from './world'
import { Scene3D } from './scene3d'
import { PetAudio } from './audio'
import { snapshot, restore, read, write, forget, DEFAULTS, type Settings } from './save'
import * as THREE from 'three'
import { loadNeurons, type NeuronData } from '../data'
import { Brain } from '../brain'

export interface ReadoutView {
  id: string; label: string; cell: string; hz: number; peak: number
  over: boolean; n: number
}
export interface PopView {
  key: number; cell: string; label: string; tone: string; value: number; x: number; y: number
}
export interface Snapshot {
  ready: boolean
  hunger: number; startle: number; fed: number; doing: string; eating: boolean
  simMs: number; stepsPerSec: number; realtime: number
  readouts: ReadoutView[]
  pops: PopView[]
  brainNote: string
}

const TH: Record<string, number> = {
  escape: 12, proboscis: 4, groom: 4, forward: 24, backward: 24, turn_a: 14, turn_b: 14,
}
// crystal-menu-ui DamageNumber tones, chosen per behaviour
const TONE: Record<string, string> = {
  escape: 'critical', proboscis: 'heal', groom: 'magic', backward: 'guard',
}
const PRIORITY = ['escape', 'proboscis', 'groom', 'backward', 'forward', 'turn_a', 'turn_b']

/** The protocol worker.ts posts back, as a discriminated union on `type`. */
type WorkerMessage =
  | { type: 'ready'; n: number; members: Uint32Array }
  | { type: 'tick'; simMs: number; steps: number; rates: Rates
      spikes: Uint16Array; wallMs: number; driven: number }

export class PetEngine {
  readonly world = new World()
  readonly stimuli = STIMULI
  private motor = new MotorDecoder()
  private groups = new Map<string, SensorGroup>()
  private meta: { id: string; label: string; note: string; cell: string; n: number }[] = []
  private idx = new Map<string, { left: number[]; right: number[]; all: number[] }>()
  private worker: Worker
  private host!: HTMLElement
  private scene!: Scene3D
  readonly audio = new PetAudio()
  private emit!: (s: Snapshot) => void
  private ray = new THREE.Raycaster()
  private pokeUntil = 0

  private neurons: NeuronData | null = null
  private brain: Brain | null = null
  private members: Uint32Array | null = null

  private lastRates: Rates = {}
  private simMs = 0
  private simPending = 0
  private stepsPerSec = 0
  private wander = 0
  private wanderV = 0
  private boutPhase = Math.random() * 6.283
  private saccades = new Saccades()
  private wasOver: Record<string, boolean> = {}
  private peak: Record<string, number> = {}
  private popCooldown = 0
  private pops: PopView[] = []
  private popKey = 0
  private ready = false
  private brainNote = ''
  picked: StimKind = STIMULI[0]

  /** Set by boot(); anything that kills the simulation after start-up lands here. */
  private onError: (e: Error) => void = e => console.error('[pet]', e)

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent) => this.onWorker(e.data)
    // a worker that throws used to fail silently, leaving a world that never moves
    this.worker.onerror = e => this.onError(new Error(e.message || 'the simulation worker stopped'))
    this.worker.onmessageerror = () => this.onError(new Error('the simulation sent a message that could not be read'))
  }

  async boot(host: HTMLElement, emit: (s: Snapshot) => void, onError?: (e: Error) => void) {
    this.host = host
    this.emit = emit
    if (onError) this.onError = onError
    this.scene = new Scene3D(host, this.world)
    // A missing config used to surface as "Unexpected token '<'". Status alone is not
    // enough to catch it: a dev server answers unknown paths with index.html at 200,
    // so the HTML only fails later, at the parse.
    const petRes = await fetch('data/pet.json')
    if (!petRes.ok) throw new Error(`data/pet.json: HTTP ${petRes.status} ${petRes.statusText}`)
    const petText = await petRes.text()
    let pet
    try {
      pet = JSON.parse(petText)
    } catch {
      throw new Error('data/pet.json is missing or is not JSON - has the bake been run?')
    }
    for (const s of pet.sensors) this.groups.set(s.id, s as SensorGroup)
    for (const r of pet.readouts) {
      const first = (Object.values(r.names as Record<string, string>)[0] ?? r.label) as string
      this.meta.push({ id: r.id, label: r.label, note: r.note, n: r.n as number,
                       cell: first.replace(/_(left|right|\d+)$/, '').replace(/_/g, ' ') })
      this.idx.set(r.id, { left: r.sides.left, right: [...r.sides.right, ...r.sides.other],
                           all: [...r.sides.left, ...r.sides.right, ...r.sides.other] })
    }
    // absolute: a relative URL inside the worker resolves against the worker's own path
    this.worker.postMessage({
      type: 'init',
      subnetUrl: new URL('data/subnet.bin', location.href).href,
      petUrl: new URL('data/pet.json', location.href).href,
    })
    // Bring back the fly you left. The brain is deliberately not restored - see save.ts.
    const saved = read(this.world.w, this.world.h, this.stimuli)
    let settings: Settings = { ...DEFAULTS, picked: this.stimuli[0].id }
    if (saved) {
      settings = restore(saved, this.world, this.stimuli)
      this.picked = this.stimuli.find(k => k.id === settings.picked) ?? this.stimuli[0]
    }
    this.worker.postMessage({ type: 'speed', factor: settings.speed })
    this.settings = settings
    this.audio.setVolume(settings.volume)
    this.scene.setQuality(settings.quality)
    document.documentElement.dataset.cb = settings.colourblind ? 'on' : ''
    document.documentElement.dataset.reduceMotion = settings.reducedMotion ? 'on' : ''
    // Scene3D watches its own host for resize
    // The fly's life runs on a timer, not on requestAnimationFrame: rAF stops entirely
    // when the page is not being painted, which would freeze the simulation and the
    // HUD along with it.  Only drawing is tied to the paint schedule.
    this.timer = window.setInterval(this.tick, 16)
    requestAnimationFrame(this.paint)

    // A tab is often closed rather than navigated away from, and 'unload' is not
    // reliable on mobile; pagehide and a hidden visibilitychange are.
    addEventListener('pagehide', this.saveNow)
    addEventListener('visibilitychange', this.onVisibility)
    return settings
  }

  private settings: Settings = { ...DEFAULTS, picked: '' }
  private lastSave = 0

  private onVisibility = () => { if (document.visibilityState === 'hidden') this.saveNow() }

  /** Write the current world out now. Cheap: a few hundred bytes of JSON. */
  saveNow = () => {
    if (!this.ready) return
    this.lastSave = performance.now()
    write(snapshot(this.world, this.settings))
  }

  setSound(on: boolean) { this.settings = { ...this.settings, sound: on }; this.saveNow() }

  /** The single path the settings panel uses; applies the change and persists it. */
  applySettings(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch }
    const s = this.settings
    if (patch.volume !== undefined) this.audio.setVolume(s.volume)
    if (patch.quality !== undefined) this.scene?.setQuality(s.quality)
    if (patch.speed !== undefined) this.worker.postMessage({ type: 'speed', factor: s.speed })
    if (patch.colourblind !== undefined) {
      document.documentElement.dataset.cb = s.colourblind ? 'on' : ''
    }
    if (patch.reducedMotion !== undefined) {
      document.documentElement.dataset.reduceMotion = s.reducedMotion ? 'on' : ''
    }
    this.saveNow()
    return s
  }

  get currentSettings(): Settings { return this.settings }

  /** Forget this fly and start a new one. */
  resetPet() {
    forget()
    const f = this.world.fly
    Object.assign(f, { x: this.world.w / 2, y: this.world.h / 2, h: -Math.PI / 2,
                       speed: 0, legPhase: 0, wing: 0, hunger: 0.35, startle: 0,
                       fed: 0, eating: 0 })
    this.world.clear()
    this.world.trail.length = 0
  }

  dispose() {
    this.saveNow()
    removeEventListener('pagehide', this.saveNow)
    removeEventListener('visibilitychange', this.onVisibility)
    if (this.timer) clearInterval(this.timer)
    this.worker.terminate()
  }

  private onWorker(m: WorkerMessage) {
    if (m.type === 'ready') {
      this.members = m.members
      this.ready = true
    } else if (m.type === 'tick') {
      this.lastRates = m.rates
      this.simPending = Math.min(this.simPending + (m.simMs - this.simMs), 400)
      this.simMs = m.simMs
      const wall = Math.max(m.wallMs, 1) / 1000
      this.stepsPerSec = this.stepsPerSec * 0.88 + (m.steps / wall) * 0.12
      if (this.brain && this.members) {
        const sp = m.spikes
        if (sp.length) {
          const full = new Uint32Array(sp.length)
          for (let k = 0; k < sp.length; k++) full[k] = this.members[sp[k]]
          this.brain.fireFrame(full, this.simMs / 1000)
        }
        this.brain.setNow(this.simMs / 1000)
      }
    }
  }

  setSpeed(f: number) {
    this.worker.postMessage({ type: 'speed', factor: f })
    this.settings = { ...this.settings, speed: f }
    this.saveNow()
  }
  setOverview(on: boolean) { this.scene?.setOverview(on) }
  pick(kind: StimKind) {
    this.picked = kind
    this.settings = { ...this.settings, picked: kind.id }
    this.saveNow()
  }
  clear() { this.world.clear() }

  /**
   * Pointer into the world.  Clicking the fly pokes it, which is not a shortcut: the
   * poke drives the body bristles, the same 1,417 mechanoreceptors the Dust stimulus
   * uses, so the grooming that follows comes out of the connectome.
   */
  tap(clientX: number, clientY: number) {
    const p = this.groundPoint(clientX, clientY)
    if (!p) return
    const f = this.world.fly
    if (Math.hypot(p.x - f.x, p.y - f.y) < 42) {
      this.pokeUntil = performance.now() + 700
      this.scene.kick(0.35)
      this.audio.blip('groom', 0.7)
      return
    }
    const hit = this.world.stims.find(s => Math.hypot(s.x - p.x, s.y - p.y) < 34)
    if (hit) this.world.remove(hit.id)
    else this.world.add(this.picked, p.x, p.y)
  }

  /** Where a screen point lands on the arena floor. */
  private groundPoint(clientX: number, clientY: number) {
    const b = this.host.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((clientX - b.left) / b.width) * 2 - 1,
      -((clientY - b.top) / b.height) * 2 + 1)
    this.ray.setFromCamera(ndc, this.scene.camera)
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const out = new THREE.Vector3()
    if (!this.ray.ray.intersectPlane(plane, out)) return null
    return { x: out.x, y: out.z }
  }

  async showBrain(host: HTMLElement) {
    if (this.brain) return
    this.neurons = await loadNeurons('data/neurons.bin')
    this.brain = new Brain(host, this.neurons)
    this.brain.setPointSize(0.85)
    this.brain.setTau(0.5, 1)
    requestAnimationFrame(() => this.brain?.resize())
    setTimeout(() => this.brain?.resize(), 260)
    this.brainNote =
      `${this.neurons.n.toLocaleString()} neurons drawn · ${this.members?.length.toLocaleString() ?? '—'} simulated`
  }
  resizeBrain() { setTimeout(() => this.brain?.resize(), 260) }

  /** Project the fly to screen space so the damage numbers land over it. */
  private flyXY() {
    const b = this.host.getBoundingClientRect()
    const v = new THREE.Vector3(this.world.fly.x, 40, this.world.fly.y)
    v.project(this.scene.camera)
    return { x: (v.x * .5 + .5) * b.width, y: (-v.y * .5 + .5) * b.height - 26 }
  }

  private timer = 0

  private tick = () => {
    const dtMs = Math.min(this.simPending, 120)
    this.simPending -= dtMs

    // Autosave. pagehide and visibilitychange cover an orderly exit, but not a crash
    // or a tab the OS kills, so keep a floor on how much can be lost.
    if (performance.now() - this.lastSave > 5000) this.saveNow()

    // a starved fly has more sensitive sugar receptors, which is real in Drosophila
    const gain = (id: string) => id === 'sugar' ? 0.55 + this.world.fly.hunger * 0.9 : 1
    const { rates, perStim, touching } = computeDrive(
      this.world.stims, this.world.fly.x, this.world.fly.y, this.world.fly.h,
      this.groups, gain, dtMs)

    this.wanderV += (Math.random() - 0.5) * dtMs * 0.006
    this.wanderV *= 0.97
    this.wander = Math.max(-1, Math.min(1, this.wander + this.wanderV))
    this.boutPhase += dtMs / 9000 * 6.283
    const bout = Math.max(0, 0.55 + 0.75 * Math.sin(this.boutPhase) + 0.25 * this.world.fly.hunger)
    const fwd = this.idx.get('forward'), st = this.idx.get('turn_b')
    if (fwd && st) {
      const sac = this.saccades.step(dtMs)
      for (const [i, hz] of foragingDrive(this.world.fly.hunger, this.wander, bout, sac,
                                          fwd.all, st.left, st.right)) {
        rates.set(i, (rates.get(i) ?? 0) + hz)
      }
    }
    // a poke is a real bristle stimulus, at full strength, briefly
    if (performance.now() < this.pokeUntil) {
      const bristle = this.groups.get('bristle')
      if (bristle) {
        for (const side of [bristle.sides.left, bristle.sides.right, bristle.sides.other]) {
          for (const i of side) rates.set(i, (rates.get(i) ?? 0) + bristle.rate_hz)
        }
      }
    }
    this.worker.postMessage({ type: 'drive', rates: [...rates] })

    const action = this.motor.update(this.lastRates, dtMs)
    this.world.step(action, dtMs, s => this.world.remove(s.id), touching)
    this.lastDraw = { action, perStim }
    this.audio.update({
      speed: this.world.fly.speed, escape: action.escape,
      eating: (this.world.fly.eating ?? 0) > 0, legPhase: this.world.fly.legPhase,
      groom: action.groom,
    })

    // threshold crossings become damage numbers
    this.popCooldown = Math.max(0, this.popCooldown - dtMs)
    const crossed: typeof this.meta = []
    const readouts: ReadoutView[] = this.meta.map(r => {
      const hz = this.motor.rate(r.id)
      const over = hz > (TH[r.id] ?? 12)
      if (over && !this.wasOver[r.id]) crossed.push(r)
      this.wasOver[r.id] = over
      this.peak[r.id] = Math.max(this.peak[r.id] ?? 0, hz)
      return { id: r.id, label: r.label, cell: r.cell, hz, peak: this.peak[r.id], over, n: r.n }
    })
    if (crossed.length && this.popCooldown <= 0) {
      crossed.sort((a, b) => PRIORITY.indexOf(a.id) - PRIORITY.indexOf(b.id))
      const r = crossed[0]
      const { x, y } = this.flyXY()
      this.pops = [...this.pops.slice(-4), {
        key: ++this.popKey, cell: r.cell, label: r.label,
        tone: TONE[r.id] ?? 'normal', value: Math.round(this.motor.rate(r.id)),
        x: x + (Math.random() - 0.5) * 46, y: y - 30,
      }]
      this.popCooldown = 300
      this.audio.blip(r.id, Math.min(1, this.motor.rate(r.id) / 160))
      if (r.id === 'escape') this.scene.kick(1)
      if (r.id === 'proboscis') {
        this.scene.spawnCrumbs(this.world.fly.x, this.world.fly.y, 0xffc24d)
      }
      setTimeout(() => { this.pops = this.pops.filter(p => p.key !== this.popKey) }, 1400)
    }

    this.emit({
      ready: this.ready,
      hunger: this.world.fly.hunger, startle: this.world.fly.startle,
      fed: this.world.fly.fed, doing: action.dominant,
      eating: (this.world.fly.eating ?? 0) > 0,
      simMs: this.simMs, stepsPerSec: this.stepsPerSec,
      realtime: this.stepsPerSec / 10000,
      readouts, pops: this.pops, brainNote: this.brainNote,
    })

  }

  private lastDraw: { action: Action; perStim: Map<number, number> } | null = null
  private prevPaint = performance.now()

  private paint = () => {
    const now = performance.now()
    const dt = Math.min(now - this.prevPaint, 100) / 1000
    this.prevPaint = now
    if (this.lastDraw) this.scene.render(dt, this.lastDraw.action, this.world.stims)
    if (this.brain) this.brain.render(dt)
    requestAnimationFrame(this.paint)
  }

}
