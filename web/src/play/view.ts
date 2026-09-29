// Everything imperative about the play page: the world, the socket, the paint loop and
// the pointer. React (App.tsx) only draws the snapshot this emits, twenty times a second.
//
// There is no brain here. The fly's body arrives over the socket (net.ts interpolates
// it), and this feeds the same Scene3D the single-player page uses, so the meadow, the
// fly's rig, its shadow, the dust it kicks up and the falling shadow token are all the
// pet's own. What is added is the other people: presence3d.ts.

import * as THREE from 'three'
import { World } from '../pet/world'
import { Scene3D } from '../pet/scene3d'
import { PetAudio } from '../pet/audio'
import { STIMULI, type Stim } from '../pet/sensors'
import type { Action } from '../pet/motor'
import type { Quality } from '../pet/save'
import { Presence3D } from './presence3d'
import { Interpolator, PlayClient, serverUrl, rememberName, type Status } from './net'
import { ARENA, TOOLS, type ToolId, type PlayerView, type TokenView, type Pouch,
         type RoundView, type StateMsg, type ServerMsg, type GameEvent } from './protocol'

export interface FeedItem { key: number; text: string; colour: string | null; at: number; mine: boolean }
export interface ReadoutView { id: string; hz: number; over: boolean }
export interface PopView { key: number; cell: string; tone: string; value: number; x: number; y: number }

export interface PlaySnapshot {
  status: Status
  detail: string
  joined: boolean
  /** seated at least once this visit: a dropped socket is a reconnect, not a new door */
  everJoined: boolean
  me: PlayerView | null
  room: string
  players: PlayerView[]
  tokens: TokenView[]
  pouch: Pouch
  round: RoundView
  doing: string
  why: string
  readouts: ReadoutView[]
  pops: PopView[]
  feed: FeedItem[]
  podium: PlayerView[] | null
  sps: number
  fps: number
  /** set when the renderer dropped a tier on its own, so the UI can say so */
  autoQuality: Quality | null
}

const TH: Record<string, number> = {
  escape: 12, proboscis: 4, groom: 4, forward: 24, backward: 24, turn_a: 14, turn_b: 14,
}
const TONE: Record<string, string> = { escape: 'critical', proboscis: 'heal', groom: 'magic', backward: 'guard' }
const CELL: Record<string, string> = {
  escape: 'giant fibre', proboscis: 'MN9', groom: 'aDN1', forward: 'P9',
  backward: 'MDN', turn_a: 'DNa01', turn_b: 'DNa02',
}
const PRIORITY = ['escape', 'proboscis', 'groom', 'backward', 'forward', 'turn_a', 'turn_b']
const KIND = new Map(STIMULI.map(k => [k.id, k]))
const QUALITY_KEY = 'fly-play-quality'
const SOUND_KEY = 'fly-play-sound'

const IDLE: Action = {
  forward: 0, turn: 0, escape: false, escapeSpeed: 130, proboscis: 0, groom: 0, dominant: 'idle',
}

export class PlayView {
  readonly world = new World()
  readonly audio = new PetAudio()
  readonly tools = TOOLS
  picked: ToolId = 'sugar'
  private scene!: Scene3D
  private presence!: Presence3D
  private host!: HTMLElement
  private emit!: (s: PlaySnapshot) => void
  private client: PlayClient | null = null
  private interp = new Interpolator()
  private ray = new THREE.Raycaster()
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

  private status: Status = 'closed'
  private detail = ''
  private joined = false
  private everJoined = false
  private me: PlayerView | null = null
  private room = ''
  private players: PlayerView[] = []
  private names = new Map<string, PlayerView>()
  private tokens: TokenView[] = []
  private pouch: Pouch = { sugar: { out: 0, max: 2, readyIn: 0 }, looming: { out: 0, max: 1, readyIn: 0 }, bitter: { out: 0, max: 1, readyIn: 0 } }
  private pouchAt = 0
  private round: RoundView = { n: 0, phase: 'play', left: 0 }
  private roundAt = 0
  private latest: StateMsg | null = null
  private action: Action = IDLE
  private feed: FeedItem[] = []
  private feedKey = 0
  private podium: PlayerView[] | null = null
  private pops: PopView[] = []
  private popKey = 0
  private popCooldown = 0
  private wasOver: Record<string, boolean> = {}
  private lastLatest: StateMsg | null = null
  private autoQuality: Quality | null = null
  private sound = false
  private paint = 0
  private snapTimer = 0
  private prevPaint = performance.now()

  boot(host: HTMLElement, labels: HTMLElement, emit: (s: PlaySnapshot) => void) {
    this.host = host
    this.emit = emit
    this.scene = new Scene3D(host, this.world)
    this.presence = new Presence3D(this.scene.overlay, this.scene.camera, labels)
    // the whole arena in view: this is a game of where the fly will go next
    this.scene.setOverview(true)
    let q: Quality = 'high'
    try { q = (localStorage.getItem(QUALITY_KEY) as Quality) || 'high' } catch { /* fine */ }
    if (!['low', 'medium', 'high'].includes(q)) q = 'high'
    this.scene.setQuality(q)
    this.scene.onDegrade = next => { this.scene.setQuality(next); this.autoQuality = next; this.storeQuality(next) }
    this.scene.beforeDraw = dt => {
      const f = this.world.fly
      this.presence.setFly(f.x, f.y, f.alt)
      this.presence.update(dt, performance.now(), this.host)
    }
    try { this.sound = localStorage.getItem(SOUND_KEY) === '1' } catch { /* fine */ }
    this.paint = requestAnimationFrame(this.frame)
    this.snapTimer = window.setInterval(this.snapshot, 50)
  }

  private storeQuality(q: Quality) { try { localStorage.setItem(QUALITY_KEY, q) } catch { /* fine */ } }

  get quality(): Quality | null { return this.scene ? (this.scene as unknown as { quality: Quality }).quality : null }
  setQuality(q: Quality) { this.scene.setQuality(q); this.storeQuality(q) }
  get soundOn() { return this.sound }
  /** remembered as a wish: audio itself only starts on a gesture */
  get wantsSound() { return this.sound }
  async setSound(on: boolean) {
    this.sound = on
    try { localStorage.setItem(SOUND_KEY, on ? '1' : '0') } catch { /* fine */ }
    if (on) await this.audio.enable()
    this.audio.mute(!on)
  }

  /** Open the socket and take a seat. The join card calls this once the name is settled. */
  connect(name: string) {
    rememberName(name)
    this.client?.close()
    this.client = new PlayClient(serverUrl(), name, m => this.onMsg(m), (s, d) => {
      this.status = s
      this.detail = d ?? ''
      if (s !== 'open') this.joined = false
    })
  }

  get serverUrl() { return this.client?.url ?? serverUrl() }
  pick(tool: ToolId) { this.picked = tool }
  setOverview(on: boolean) { this.scene.setOverview(on) }
  get overview() { return this.scene?.overview ?? true }

  // --- the wire ------------------------------------------------------------------------

  private who(id: string) { return this.names.get(id) ?? { id, name: 'someone', colour: null as unknown as string, score: 0, total: 0 } }

  private say(text: string, colour: string | null, mine = false) {
    this.feed = [...this.feed.slice(-3), { key: ++this.feedKey, text, colour, at: performance.now(), mine }]
  }

  private onMsg(m: ServerMsg) {
    const now = performance.now()
    switch (m.t) {
      case 'welcome':
        this.joined = true
        this.everJoined = true
        this.me = m.you
        this.room = m.room
        this.setPlayers(m.players)
        this.setTokens(m.tokens)
        this.pouch = m.pouch; this.pouchAt = now
        this.round = m.round; this.roundAt = now
        this.podium = null
        this.say(`You are ${m.you.name}. Drop sugar where it will walk.`, m.you.colour, true)
        break
      case 'players': this.setPlayers(m.players); break
      case 'tokens': this.setTokens(m.tokens); break
      case 'pouch': this.pouch = m.pouch; this.pouchAt = now; break
      case 'state':
        this.interp.push(m, now)
        this.latest = m
        this.round = m.round; this.roundAt = now
        break
      case 'event': this.onEvent(m.e); break
      case 'error': this.say(m.msg, null); break
    }
  }

  private setPlayers(list: PlayerView[]) {
    this.players = list
    for (const p of list) this.names.set(p.id, p)
    if (this.me) this.me = this.names.get(this.me.id) ?? this.me
    this.presence.setPlayers(list, this.me?.id ?? null)
  }

  private setTokens(list: TokenView[]) {
    this.tokens = list
    // the scene's tokens are the pet's stimuli, by id
    const stims: Stim[] = []
    for (const t of list) {
      const kind = KIND.get(t.kind)
      if (kind) stims.push({ kind, x: t.x, y: t.y, id: t.id })
    }
    this.world.stims = stims
    this.presence.setTokens(list)
  }

  private onEvent(e: GameEvent) {
    const meId = this.me?.id
    switch (e.kind) {
      case 'meal': {
        const p = this.who(e.by)
        this.presence.burst(e.x, e.y, p.colour ?? '#ffffff')
        this.scene.spawnCrumbs(e.x, e.y, 0xffc24d)
        this.audio.blip('proboscis', 1)
        this.say(`🍬 It ate ${e.by === meId ? 'your' : `${p.name}'s`} sugar${e.by === meId ? ' — +1' : ''}`, p.colour, e.by === meId)
        if (e.by === meId) this.pop('+1', 'heal', 'your sugar')
        break
      }
      case 'taste': {
        const p = this.who(e.by)
        this.say(`👅 Its tongue is out for ${e.by === meId ? 'your' : `${p.name}'s`} sugar`, p.colour, e.by === meId)
        break
      }
      case 'spoiled': {
        const by = this.who(e.by), owner = this.who(e.owner)
        this.say(`☠️ ${e.by === meId ? 'You' : by.name} spoiled ${e.owner === meId ? 'your' : `${owner.name}'s`} sugar`, by.colour, e.by === meId || e.owner === meId)
        break
      }
      case 'scared': {
        const p = this.who(e.by)
        this.say(`🛸 ${e.by === meId ? 'Your' : `${p.name}'s`} shadow made it jump`, p.colour, e.by === meId)
        break
      }
      case 'round-start':
        this.podium = null
        this.say(`Round ${e.n}. Go.`, null)
        break
      case 'round-end':
        this.podium = e.podium
        break
      case 'restart':
        this.say(`Its brain got stuck in a loop, so every neuron was put back to rest.`, null)
        break
      case 'joined': {
        const p = this.who(e.who)
        if (e.who !== meId) this.say(`${p.name} is here`, p.colour)
        break
      }
      case 'left': {
        const p = this.who(e.who)
        this.say(`${p.name} left`, p.colour)
        break
      }
    }
  }

  // --- the pointer ---------------------------------------------------------------------

  /** Where a screen point lands on the arena floor, or null off the arena. */
  private groundPoint(clientX: number, clientY: number) {
    const b = this.host.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - b.left) / b.width) * 2 - 1, -((clientY - b.top) / b.height) * 2 + 1)
    this.ray.setFromCamera(ndc, this.scene.camera)
    const out = new THREE.Vector3()
    if (!this.ray.ray.intersectPlane(this.plane, out)) return null
    if (out.x < 0 || out.x > ARENA.w || out.z < 0 || out.z > ARENA.h) return null
    return { x: out.x, y: out.z }
  }

  hover(clientX: number | null, clientY: number | null) {
    if (!this.client) return
    const p = clientX === null || clientY === null ? null : this.groundPoint(clientX, clientY)
    this.client.cursor(p?.x ?? null, p?.y ?? null)
  }

  /** A press that did not drag: pick up one of yours, or put the chosen tool down. */
  tap(clientX: number, clientY: number) {
    if (!this.client || !this.joined) return
    const p = this.groundPoint(clientX, clientY)
    if (!p) return
    const mine = this.tokens.find(t => t.owner === this.me?.id && Math.hypot(t.x - p.x, t.y - p.y) < 30)
    if (mine) { this.client.remove(mine.id); return }
    const f = this.world.fly
    // not on the fly itself: everyone's, and a poke locks its brain (mind.ts)
    if (Math.hypot(p.x - f.x, p.y - f.y) < 30 && f.alt < 10) { this.say('It is everyone’s fly. Put things near it, not on it.', null); return }
    this.client.place(this.picked, p.x, p.y)
    this.audio.blip('groom', 0.35)
  }

  // --- frames and snapshots ------------------------------------------------------------

  private frame = () => {
    const now = performance.now()
    const dt = Math.min(now - this.prevPaint, 100) / 1000
    this.prevPaint = now
    const f = this.world.fly
    const s = this.interp.sample(now, f)
    if (s) {
      const a = s.action
      this.action = { forward: a.forward, turn: a.turn, escape: a.escape, escapeSpeed: 130,
                      proboscis: a.proboscis, groom: a.groom, dominant: a.dominant }
      // what the body derives for itself, exactly as world.ts does
      f.legPhase += Math.min(Math.abs(f.speed), 200) * dt * 0.09 * (1 - f.flying)
      f.beat += dt * (f.flying > 0.02 ? 34 : 0)
      f.wing = Math.max(0, Math.min(1, Math.max(a.escape ? 1 : 0, f.flying)))
      f.turnRate = a.turn
      if (s.cursors !== this.lastLatest?.cursors) this.presence.setCursors(s.cursors, now)
      this.lastLatest = s
    }
    this.scene.render(dt, this.action, this.world.stims)
    this.audio.update({
      speed: f.speed, escape: this.action.escape, eating: (f.eating ?? 0) > 0,
      legPhase: f.legPhase, groom: this.action.groom, flying: f.flying,
    })
    this.paint = requestAnimationFrame(this.frame)
  }

  private flyXY() {
    const b = this.host.getBoundingClientRect()
    const v = new THREE.Vector3(this.world.fly.x, 40, this.world.fly.y)
    v.project(this.scene.camera)
    return { x: (v.x * .5 + .5) * b.width, y: (-v.y * .5 + .5) * b.height - 26 }
  }

  private pop(value: string | number, tone: string, cell: string) {
    const { x, y } = this.flyXY()
    const key = ++this.popKey
    this.pops = [...this.pops.slice(-4), {
      key, cell, tone, value: typeof value === 'number' ? value : (value as unknown as number),
      x: x + (Math.random() - 0.5) * 46, y: y - 30,
    }]
    setTimeout(() => { this.pops = this.pops.filter(p => p.key !== key) }, 1400)
  }

  private snapshot = () => {
    const now = performance.now()
    // what happened stays up long enough to read, then makes room
    if (this.feed.length && now - this.feed[0].at > 14_000) this.feed = this.feed.filter(f => now - f.at <= 14_000)
    const rates = this.latest?.rates ?? {}
    this.popCooldown = Math.max(0, this.popCooldown - 50)
    const crossed: string[] = []
    const readouts: ReadoutView[] = PRIORITY.map(id => {
      const hz = rates[id] ?? 0
      const over = hz > (TH[id] ?? 12)
      if (over && !this.wasOver[id]) crossed.push(id)
      this.wasOver[id] = over
      return { id, hz, over }
    })
    if (crossed.length && this.popCooldown <= 0 && this.joined) {
      const id = crossed[0]
      this.pop(Math.round(rates[id] ?? 0), TONE[id] ?? 'normal', CELL[id] ?? id)
      this.popCooldown = 300
      this.audio.blip(id, Math.min(1, (rates[id] ?? 0) / 160))
      if (id === 'escape') this.scene.kick(1)
    }
    const pouch = {} as Pouch
    for (const t of TOOLS) {
      const p = this.pouch[t.id]
      pouch[t.id] = { out: p.out, max: p.max, readyIn: Math.max(0, p.readyIn - (now - this.pouchAt)) }
    }
    this.emit({
      status: this.status, detail: this.detail, joined: this.joined, everJoined: this.everJoined,
      me: this.me, room: this.room,
      players: this.players, tokens: this.tokens, pouch,
      round: { ...this.round, left: Math.max(0, this.round.left - (now - this.roundAt)) },
      doing: this.latest?.action.dominant ?? '…', why: this.latest?.why ?? '',
      readouts, pops: this.pops, feed: this.feed, podium: this.podium,
      sps: this.latest?.sps ?? 0, fps: this.scene?.fps ?? 0, autoQuality: this.autoQuality,
    })
    this.autoQuality = null
  }

  dispose() {
    cancelAnimationFrame(this.paint)
    clearInterval(this.snapTimer)
    this.client?.close()
    this.presence?.dispose()
    // a remount (hot reload in development) must not leave a second canvas behind
    this.scene?.renderer.dispose()
    this.scene?.renderer.domElement.remove()
  }
}
