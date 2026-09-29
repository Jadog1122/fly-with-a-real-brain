// One room of the game: the fly, the players in it, their tokens, and the round.
//
// Nothing here touches a socket, a timer or the brain thread. The server (main.ts)
// hands in the brain's readout rates and a clock, and takes out the drive to send
// back, the messages to broadcast and the events that happened. That is what makes the
// rules testable with a made-up brain (test/play-game.test.ts) - and it is the same
// split engine.ts makes in the single-player page, where the world is stepped by
// however much simulated time the brain got through.
//
// What is the model's and what is ours, as in the single-player page:
//   - what the fly does is decoded from the connectome's descending neurons (motor.ts)
//   - the stimuli are Poisson drive on its real sensory neurons (sensors.ts)
//   - the wander drive is ours, and so is one game rule: the fly is kept hungry after a
//     meal, or a full fly would stop foraging and the round would go quiet

import { World } from '../src/pet/world'
import { MotorDecoder, type Action, type Rates } from '../src/pet/motor'
import { STIMULI, computeDrive, foragingDrive, Saccades,
         type SensorGroup, type Stim, type StimKind } from '../src/pet/sensors'
import { Mind } from '../src/pet/mind'
import { TOOLS, TOOL, ROUND, PALETTE, SPOIL_RANGE, cleanName, randomName,
         type ToolId, type PlayerView, type TokenView, type Pouch, type GameEvent,
         type StateMsg, type RoundView, type FlyView, type ActionView } from '../src/play/protocol'

export interface ReadoutIdx { id: string; left: number[]; right: number[]; all: number[] }

export interface Player {
  id: string
  /** the client's own secret, so a reload comes back as the same player */
  key: string
  name: string
  colour: string
  score: number
  total: number
  cursor: { x: number; y: number } | null
  readyAt: Record<ToolId, number>
  /** when the socket went away; null while connected */
  gone: number | null
}

interface Token {
  stim: Stim
  tool: ToolId
  owner: string
  diesAt: number | null
  spoiled: boolean
  tasted: boolean
  scared: boolean
}

export interface RoomOptions {
  playMs?: number
  betweenMs?: number
  /** how long a disconnected player keeps their place, tokens and score */
  graceMs?: number
  /** the fly is never let get fuller than this after a meal */
  keepHungry?: number
}

/** What one step of the room asks the server to do. */
export interface StepResult {
  /** subnet index -> Hz, for the brain */
  drive: Map<number, number>
  /** every neuron back to rest, please: a new round, or a loop the model cannot leave */
  restart: string | null
}

const KIND = new Map<ToolId, StimKind>(
  TOOLS.map(t => [t.id, STIMULI.find(k => k.id === t.id)!]))
const NO_RATES: Rates = {}

export class Room {
  readonly world = new World()
  readonly mind = new Mind(null)
  private motor = new MotorDecoder()
  readonly players = new Map<string, Player>()
  private tokens = new Map<number, Token>()
  round: { n: number; phase: 'play' | 'between'; endsAt: number }
  /** what happened since the server last drained them */
  events: GameEvent[] = []
  /** what changed since the server last sent it */
  dirty = { players: false, tokens: false, pouch: new Set<string>() }
  tick = 0
  /** brain steps per second, set by the server from the brain thread */
  sps = 0

  private lastAction: Action = {
    forward: 0, turn: 0, escape: false, escapeSpeed: 0, proboscis: 0, groom: 0, dominant: 'idle',
  }
  private wander = 0
  private wanderV = 0
  private boutPhase = Math.random() * 6.283
  private saccades = new Saccades()
  private flyMs = 0
  private lastNow: number | null = null
  private lastRestart = -Infinity
  private nextPlayer = 1
  private readonly playMs: number
  private readonly betweenMs: number
  private readonly graceMs: number
  private readonly keepHungry: number

  constructor(private groups: Map<string, SensorGroup>,
              private readouts: Map<string, ReadoutIdx>,
              now: number, opts: RoomOptions = {}) {
    this.playMs = opts.playMs ?? ROUND.playMs
    this.betweenMs = opts.betweenMs ?? ROUND.betweenMs
    this.graceMs = opts.graceMs ?? 60_000
    this.keepHungry = opts.keepHungry ?? 0.55
    this.round = { n: 1, phase: 'play', endsAt: now + this.playMs }
    // a hungry fly forages; the arena starts with one that wants to
    this.world.fly.hunger = 0.6
  }

  // --- players ------------------------------------------------------------------------

  /** Everyone with a live socket. */
  connected(): Player[] {
    return [...this.players.values()].filter(p => p.gone === null)
  }

  /** Join, or come back after a dropped connection. */
  join(key: string, rawName: string, now: number): Player {
    for (const p of this.players.values()) {
      if (p.key === key) {
        const wasGone = p.gone !== null
        p.gone = null
        p.name = cleanName(rawName, p.name)
        this.dirty.players = true
        if (wasGone) this.events.push({ kind: 'joined', who: p.id })
        return p
      }
    }
    const id = `p${this.nextPlayer++}`
    const p: Player = {
      id, key, name: cleanName(rawName, randomName()), colour: this.pickColour(),
      score: 0, total: 0, cursor: null,
      readyAt: { sugar: 0, looming: 0, bitter: 0 }, gone: null,
    }
    this.players.set(id, p)
    this.dirty.players = true
    this.events.push({ kind: 'joined', who: id })
    void now
    return p
  }

  /** The socket went away. The player stays for a while in case they come back. */
  leave(id: string, now: number) {
    const p = this.players.get(id)
    if (!p || p.gone !== null) return
    p.gone = now
    p.cursor = null
    this.dirty.players = true
    this.events.push({ kind: 'left', who: id })
  }

  /** The colour fewest people are already wearing. */
  private pickColour(): string {
    const used = new Map(PALETTE.map(c => [c, 0]))
    for (const p of this.players.values()) used.set(p.colour, (used.get(p.colour) ?? 0) + 1)
    let best = PALETTE[0], n = Infinity
    for (const c of PALETTE) {
      const k = used.get(c) ?? 0
      if (k < n) { best = c; n = k }
    }
    return best
  }

  cursor(id: string, x: number | null, y: number | null) {
    const p = this.players.get(id)
    if (!p) return
    p.cursor = x === null || y === null ? null : { x, y }
  }

  // --- tokens -------------------------------------------------------------------------

  place(id: string, tool: ToolId, x: number, y: number, now: number):
      { ok: true; token: TokenView } | { ok: false; why: string } {
    const p = this.players.get(id)
    if (!p) return { ok: false, why: 'not in the room' }
    if (this.round.phase !== 'play') return { ok: false, why: 'the next round has not started' }
    const rule = TOOL.get(tool)!
    if (now < p.readyAt[tool]) {
      return { ok: false, why: `${rule.label} is ready in ${Math.ceil((p.readyAt[tool] - now) / 1000)} s` }
    }
    // at the limit, the oldest of theirs is picked up to make room
    const mine = [...this.tokens.values()].filter(t => t.owner === id && t.tool === tool)
    if (mine.length >= rule.max) this.drop(mine[0].stim.id)
    const stim = this.world.add(KIND.get(tool)!, x, y)
    const t: Token = { stim, tool, owner: id, spoiled: false, tasted: false, scared: false,
                       diesAt: rule.lifeMs === null ? null : now + rule.lifeMs }
    this.tokens.set(stim.id, t)
    p.readyAt[tool] = now + rule.cooldownMs
    this.respoil()
    this.dirty.tokens = true
    this.dirty.pouch.add(id)
    return { ok: true, token: this.tokenView(t, now) }
  }

  /** Pick up one of your own. */
  remove(id: string, tokenId: number) {
    const t = this.tokens.get(tokenId)
    if (!t || t.owner !== id) return false
    this.drop(tokenId)
    this.respoil()
    return true
  }

  private drop(tokenId: number) {
    const t = this.tokens.get(tokenId)
    if (!t) return
    this.tokens.delete(tokenId)
    this.world.remove(tokenId)
    this.dirty.tokens = true
    this.dirty.pouch.add(t.owner)
  }

  /** A sugar drop with bitter next to it is spoiled: the bitter neurons suppress MN9. */
  private respoil() {
    const bitter = [...this.tokens.values()].filter(t => t.tool === 'bitter')
    for (const t of this.tokens.values()) {
      if (t.tool !== 'sugar') continue
      const was = t.spoiled
      t.spoiled = bitter.some(b => Math.hypot(b.stim.x - t.stim.x, b.stim.y - t.stim.y) < SPOIL_RANGE)
      if (t.spoiled && !was) {
        const by = bitter.find(b => Math.hypot(b.stim.x - t.stim.x, b.stim.y - t.stim.y) < SPOIL_RANGE)!
        if (by.owner !== t.owner) this.events.push({ kind: 'spoiled', by: by.owner, owner: t.owner })
        this.dirty.tokens = true
      }
    }
  }

  private clearTokens() {
    this.tokens.clear()
    this.world.clear()
    this.dirty.tokens = true
    for (const p of this.players.values()) {
      p.readyAt = { sugar: 0, looming: 0, bitter: 0 }
      this.dirty.pouch.add(p.id)
    }
  }

  // --- the round ----------------------------------------------------------------------

  private advanceRound(now: number): string | null {
    if (now < this.round.endsAt) return null
    if (this.round.phase === 'play') {
      this.round = { n: this.round.n, phase: 'between', endsAt: now + this.betweenMs }
      this.events.push({ kind: 'round-end', n: this.round.n, podium: this.podium() })
      // the field is cleared with the whistle: a meal in the break would count for nobody
      this.clearTokens()
      return null
    }
    this.round = { n: this.round.n + 1, phase: 'play', endsAt: now + this.playMs }
    this.clearTokens()
    for (const p of this.players.values()) p.score = 0
    this.dirty.players = true
    this.world.fly.hunger = Math.max(this.world.fly.hunger, this.keepHungry)
    this.events.push({ kind: 'round-start', n: this.round.n })
    // a fresh brain each round, so a loop from last round cannot decide this one
    return 'a new round'
  }

  private podium(): PlayerView[] {
    return this.connected()
      .filter(p => p.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, 3)
      .map(p => this.playerView(p))
  }

  // --- one step -----------------------------------------------------------------------

  /**
   * Advance by `dtMs` of simulated time with the brain's latest rates, at wall time
   * `now`. An empty room holds the round clock where it is: nobody is missing anything.
   */
  step(now: number, dtMs: number, rates: Rates): StepResult {
    if (this.lastNow !== null && this.connected().length === 0) {
      this.round.endsAt += now - this.lastNow
    }
    this.lastNow = now
    let restart = this.advanceRound(now)

    // forgotten players, and tokens that have run out
    for (const [id, p] of this.players) {
      if (p.gone !== null && now - p.gone > this.graceMs) {
        for (const t of [...this.tokens.values()]) if (t.owner === id) this.drop(t.stim.id)
        this.players.delete(id)
        this.dirty.players = true
      }
    }
    let expired = false
    for (const t of [...this.tokens.values()]) {
      if (t.diesAt !== null && now >= t.diesAt) { this.drop(t.stim.id); expired = true }
    }
    if (expired) this.respoil()

    const f = this.world.fly
    // a starved fly has more sensitive sugar receptors, which is real in Drosophila
    const gain = (id: string) => id === 'sugar' ? 0.55 + f.hunger * 0.9 : 1
    const { rates: drive, perStim, touching } =
      computeDrive(this.world.stims, f.x, f.y, f.h, this.groups, gain, dtMs, f.alt)

    // the wander drive we add, exactly as engine.ts adds it
    this.wanderV += (Math.random() - 0.5) * dtMs * 0.006
    this.wanderV *= 0.97
    this.wander = Math.max(-1, Math.min(1, this.wander + this.wanderV))
    this.boutPhase += dtMs / 9000 * 6.283
    const bout = Math.max(0, 0.55 + 0.75 * Math.sin(this.boutPhase) + 0.25 * f.hunger)
    const fwd = this.readouts.get('forward'), st = this.readouts.get('turn_b')
    if (fwd && st) {
      const sac = this.saccades.step(dtMs)
      for (const [i, hz] of foragingDrive(f.hunger, this.wander, bout, sac, fwd.all, st.left, st.right)) {
        drive.set(i, (drive.get(i) ?? 0) + hz)
      }
    }

    const action = this.motor.update(rates ?? NO_RATES, dtMs)
    const wasEscaping = this.lastAction.escape
    this.lastAction = action
    this.world.step(action, dtMs, s => this.ate(s, now), touching)

    // the tongue came out for someone's sugar
    if (touching && action.proboscis > 0.4) {
      const t = this.tokens.get(touching.id)
      if (t && t.tool === 'sugar' && !t.tasted) {
        t.tasted = true
        this.events.push({ kind: 'taste', by: t.owner })
      }
    }
    // the giant fibre fired with someone's shadow over it
    if (action.escape && !wasEscaping) {
      let best: Token | null = null, bp = 0.15
      for (const t of this.tokens.values()) {
        const p = perStim.get(t.stim.id) ?? 0
        if (t.tool === 'looming' && !t.scared && p > bp) { best = t; bp = p }
      }
      if (best) { best.scared = true; this.events.push({ kind: 'scared', by: best.owner }) }
    }

    this.flyMs += dtMs
    this.mind.step({
      dtMs, simMs: this.flyMs, side: id => this.motor.side(id), action,
      fly: f, stims: this.world.stims, perStim, touching, poked: false,
    })
    // A loop the model cannot leave (mind.ts): restart the brain rather than let the
    // round run on with a fly whose tongue is stuck out. Say so.
    if (this.mind.stuck && !restart && now - this.lastRestart > 20_000) {
      restart = `its brain got stuck in a loop - ${this.mind.why}`
      this.events.push({ kind: 'restart', why: restart })
    }
    if (restart) {
      this.lastRestart = now
      this.motor = new MotorDecoder()
    }
    this.tick++
    return { drive, restart }
  }

  private ate(s: Stim, now: number) {
    const t = this.tokens.get(s.id)
    void now
    if (t) {
      const p = this.players.get(t.owner)
      if (p) { p.score++; p.total++; this.dirty.players = true }
      this.events.push({ kind: 'meal', by: t.owner, x: s.x, y: s.y })
      this.drop(s.id)
      this.respoil()
    } else {
      this.world.remove(s.id)
    }
    // ours: a full fly stops foraging, and the round would go quiet
    this.world.fly.hunger = Math.max(this.world.fly.hunger, this.keepHungry)
  }

  // --- views --------------------------------------------------------------------------

  playerView(p: Player): PlayerView {
    return { id: p.id, name: p.name, colour: p.colour, score: p.score, total: p.total }
  }

  playersView(): PlayerView[] {
    return this.connected()
      .sort((a, b) => b.score - a.score || b.total - a.total || a.id.localeCompare(b.id))
      .map(p => this.playerView(p))
  }

  private tokenView(t: Token, now: number): TokenView {
    const p = this.players.get(t.owner)
    return {
      id: t.stim.id, kind: t.tool, x: t.stim.x, y: t.stim.y, owner: t.owner,
      name: p?.name ?? 'someone', colour: p?.colour ?? '#ffffff',
      left: t.diesAt === null ? null : Math.max(0, t.diesAt - now), spoiled: t.spoiled,
    }
  }

  tokensView(now: number): TokenView[] {
    return [...this.tokens.values()].map(t => this.tokenView(t, now))
  }

  pouchFor(id: string, now: number): Pouch {
    const p = this.players.get(id)
    const out = {} as Pouch
    for (const rule of TOOLS) {
      const mine = [...this.tokens.values()].filter(t => t.owner === id && t.tool === rule.id).length
      out[rule.id] = {
        out: mine, max: rule.max,
        readyIn: p ? Math.max(0, p.readyAt[rule.id] - now) : 0,
      }
    }
    return out
  }

  roundView(now: number): RoundView {
    return { n: this.round.n, phase: this.round.phase, left: Math.max(0, this.round.endsAt - now) }
  }

  flyView(): FlyView {
    const f = this.world.fly
    return {
      x: f.x, y: f.y, h: f.h, speed: f.speed,
      alt: f.alt, flying: f.flying, bank: f.bank, pitch: f.pitch,
      hunger: f.hunger, startle: f.startle, eating: f.eating ?? 0,
    }
  }

  actionView(): ActionView {
    const a = this.lastAction
    return { dominant: a.dominant, escape: a.escape, proboscis: a.proboscis,
             groom: a.groom, forward: a.forward, turn: a.turn }
  }

  stateMsg(now: number): StateMsg {
    const rates: Record<string, number> = {}
    for (const id of this.readouts.keys()) rates[id] = this.motor.rate(id)
    const cursors: [string, number, number][] = []
    for (const p of this.connected()) if (p.cursor) cursors.push([p.id, p.cursor.x, p.cursor.y])
    return {
      t: 'state', tick: this.tick, at: now, fly: this.flyView(), action: this.actionView(), rates,
      cursors, round: this.roundView(now), sps: this.sps, why: this.mind.why,
    }
  }

  /** Take the events since last time; the list is emptied. */
  drainEvents(): GameEvent[] {
    const e = this.events
    this.events = []
    return e
  }
}
