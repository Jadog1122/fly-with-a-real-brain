// The rules of a meadow, with a made-up brain: whatever rates the test hands in are
// what the decoder sees, so a meal, a scare or a stuck loop can be produced on demand.
import { describe, it, expect } from 'vitest'
import { Room, type ReadoutIdx } from '../server/game'
import { petConfig } from './helpers'
import { TOOLS, TOOL, ROUND, PALETTE, parseClientMsg, cleanName, ARENA } from '../src/play/protocol'
import type { SensorGroup } from '../src/pet/sensors'
import type { Rates } from '../src/pet/motor'

const pet = petConfig()
const groups = new Map<string, SensorGroup>(pet.sensors.map(s => [s.id, s as unknown as SensorGroup]))
const readouts = new Map<string, ReadoutIdx>(pet.readouts.map(r => [r.id, {
  id: r.id, left: r.sides.left, right: [...r.sides.right, ...r.sides.other],
  all: [...r.sides.left, ...r.sides.right, ...r.sides.other],
}]))

const KEY_A = 'aaaaaaaaaaaa', KEY_B = 'bbbbbbbbbbbb'
const quiet: Rates = {}
/** MN9 hard on, both sides, as sugar under the mouthparts drives it. */
const tongue: Rates = { proboscis: [120, 120] }
/** the giant fibre */
const jump: Rates = { escape: [200, 200] }

function room(opts = {}) {
  const r = new Room(groups, readouts, 0, opts)
  return r
}
/** Run `ms` of fly time in 16 ms ticks, with the same wall clock. */
function run(r: Room, from: number, ms: number, rates: Rates) {
  let now = from
  for (let t = 0; t < ms; t += 16) { now += 16; r.step(now, 16, rates) }
  return now
}

describe('joining a meadow', () => {
  it('gives each player a distinct colour and a printable name', () => {
    const r = room()
    const a = r.join(KEY_A, 'Ana', 0)
    const b = r.join(KEY_B, '  \u0000Bo\u200b  ', 0)
    expect(a.id).not.toBe(b.id)
    expect(a.colour).not.toBe(b.colour)
    expect(PALETTE).toContain(a.colour)
    expect(b.name).toBe('Bo')
    expect(r.playersView().map(p => p.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('falls back to a generated name rather than an empty one', () => {
    const r = room()
    const a = r.join(KEY_A, '', 0)
    expect(a.name.length).toBeGreaterThan(0)
    expect(cleanName('   ', 'x')).toBe('x')
    expect(cleanName('a'.repeat(40), 'x')).toHaveLength(16)
  })

  it('brings the same key back to the same seat, score and all', () => {
    const r = room()
    const a = r.join(KEY_A, 'Ana', 0)
    a.total = 3
    r.leave(a.id, 1000)
    expect(r.playersView()).toHaveLength(0)         // not shown while gone
    const again = r.join(KEY_A, 'Ana', 2000)
    expect(again.id).toBe(a.id)
    expect(again.total).toBe(3)
    expect(r.playersView()).toHaveLength(1)
  })

  it('forgets a player, and their tokens, after the grace period', () => {
    const r = room({ graceMs: 5000 })
    const a = r.join(KEY_A, 'Ana', 0)
    r.place(a.id, 'sugar', 100, 100, 0)
    r.leave(a.id, 100)
    run(r, 100, 3000, quiet)
    expect(r.players.has(a.id)).toBe(true)
    run(r, 3100, 3000, quiet)
    expect(r.players.has(a.id)).toBe(false)
    expect(r.tokensView(7000)).toHaveLength(0)
  })

  it('reuses colours only once the palette is exhausted', () => {
    const r = room()
    const seen = new Set<string>()
    for (let i = 0; i < PALETTE.length; i++) seen.add(r.join(`key${String(i).padStart(9, '0')}`, `p${i}`, 0).colour)
    expect(seen.size).toBe(PALETTE.length)
  })
})

describe('the pouch', () => {
  it('lets a player keep at most `max` of a tool out, picking up the oldest', () => {
    const r = room()
    const a = r.join(KEY_A, 'Ana', 0)
    const rule = TOOL.get('sugar')!
    let now = 0
    const ids: number[] = []
    for (let i = 0; i <= rule.max; i++) {
      now += rule.cooldownMs
      const res = r.place(a.id, 'sugar', 100 + i * 10, 100, now)
      expect(res.ok).toBe(true)
      if (res.ok) ids.push(res.token.id)
    }
    const out = r.tokensView(now).map(t => t.id)
    expect(out).toHaveLength(rule.max)
    expect(r.tokensView(now)[0]).toMatchObject({ name: 'Ana', colour: a.colour })
    expect(out).not.toContain(ids[0])            // the first one was picked up
    expect(r.pouchFor(a.id, now).sugar.out).toBe(rule.max)
  })

  it('enforces the cooldown on the server, whatever the client says', () => {
    const r = room()
    const a = r.join(KEY_A, 'Ana', 0)
    expect(r.place(a.id, 'looming', 100, 100, 1000).ok).toBe(true)
    const again = r.place(a.id, 'looming', 100, 100, 1000 + 500)
    expect(again.ok).toBe(false)
    const pouch = r.pouchFor(a.id, 1500)
    expect(pouch.looming.readyIn).toBe(TOOL.get('looming')!.cooldownMs - 500)
    expect(r.place(a.id, 'looming', 100, 100, 1000 + TOOL.get('looming')!.cooldownMs).ok).toBe(true)
  })

  it('a shadow passes, a bitter drop wears off, sugar stays', () => {
    const r = room()
    const a = r.join(KEY_A, 'Ana', 0)
    r.place(a.id, 'sugar', 100, 100, 0)
    r.place(a.id, 'looming', 300, 300, 0)
    r.place(a.id, 'bitter', 500, 300, 0)
    const loom = TOOL.get('looming')!.lifeMs!, bit = TOOL.get('bitter')!.lifeMs!
    let now = run(r, 0, loom + 32, quiet)
    expect(r.tokensView(now).map(t => t.kind).sort()).toEqual(['bitter', 'sugar'])
    now = run(r, now, bit, quiet)
    expect(r.tokensView(now).map(t => t.kind)).toEqual(['sugar'])
    expect(r.tokensView(now)[0].left).toBeNull()
  })

  it('only lets you pick up your own', () => {
    const r = room()
    const a = r.join(KEY_A, 'Ana', 0), b = r.join(KEY_B, 'Bo', 0)
    const res = r.place(a.id, 'sugar', 100, 100, 0)
    if (!res.ok) throw new Error(res.why)
    expect(r.remove(b.id, res.token.id)).toBe(false)
    expect(r.remove(a.id, res.token.id)).toBe(true)
    expect(r.tokensView(0)).toHaveLength(0)
  })

  it('marks sugar spoiled when bitter lands next to it, and says whose', () => {
    const r = room()
    const a = r.join(KEY_A, 'Ana', 0), b = r.join(KEY_B, 'Bo', 0)
    r.place(a.id, 'sugar', 200, 200, 0)
    r.drainEvents()
    r.place(b.id, 'bitter', 210, 205, 0)
    expect(r.tokensView(0).find(t => t.kind === 'sugar')!.spoiled).toBe(true)
    expect(r.drainEvents()).toContainEqual({ kind: 'spoiled', by: b.id, owner: a.id })
    // and unspoiled again once the bitter has gone
    run(r, 0, TOOL.get('bitter')!.lifeMs! + 32, quiet)
    expect(r.tokensView(30_000).find(t => t.kind === 'sugar')!.spoiled).toBe(false)
  })
})

describe('scoring', () => {
  it('a meal from your sugar is a point, and the fly is kept hungry', () => {
    const r = room()
    const a = r.join(KEY_A, 'Ana', 0)
    const f = r.world.fly
    f.hunger = 0.6
    // the drop right under it: its feet and mouthparts both taste it
    r.place(a.id, 'sugar', f.x, f.y, 0)
    r.drainEvents()
    // MN9 on -> proboscis > 0.4 -> the world counts it as on the meal; a few seconds does it
    const now = run(r, 0, 12_000, tongue)
    expect(r.players.get(a.id)!.score).toBe(1)
    expect(r.players.get(a.id)!.total).toBe(1)
    expect(r.tokensView(now)).toHaveLength(0)
    expect(r.drainEvents().some(e => e.kind === 'meal' && e.by === a.id)).toBe(true)
    expect(f.hunger).toBeGreaterThanOrEqual(0.55)
    expect(r.dirty.players).toBe(true)
  })

  it('reports the first taste of each drop once', () => {
    const r = room()
    const a = r.join(KEY_A, 'Ana', 0)
    const f = r.world.fly
    r.place(a.id, 'sugar', f.x, f.y, 0)
    r.drainEvents()
    run(r, 0, 400, tongue)
    const tastes = r.drainEvents().filter(e => e.kind === 'taste')
    expect(tastes).toHaveLength(1)
  })

  it('credits a scare to whoever owns the shadow the fly jumped from', () => {
    const r = room()
    const b = r.join(KEY_B, 'Bo', 0)
    const f = r.world.fly
    r.place(b.id, 'looming', f.x + 40, f.y, 0)
    r.drainEvents()
    run(r, 0, 200, jump)
    expect(r.drainEvents()).toContainEqual({ kind: 'scared', by: b.id })
    run(r, 200, 200, jump)
    expect(r.drainEvents().filter(e => e.kind === 'scared')).toHaveLength(0)   // once per shadow
  })
})

describe('rounds', () => {
  it('plays, pauses for the podium, then starts clean with a fresh brain', () => {
    const r = room({ playMs: 10_000, betweenMs: 2000 })
    const a = r.join(KEY_A, 'Ana', 0)
    const f = r.world.fly
    r.place(a.id, 'sugar', f.x, f.y, 0)
    run(r, 0, 6000, tongue)
    expect(r.players.get(a.id)!.score).toBe(1)
    r.drainEvents()

    let now = run(r, 6000, 4100, quiet)
    expect(r.roundView(now).phase).toBe('between')
    const end = r.drainEvents().find(e => e.kind === 'round-end')
    expect(end && end.kind === 'round-end' && end.podium[0].id).toBe(a.id)
    // nothing can be placed between rounds, and nothing is left on the field to eat
    expect(r.place(a.id, 'sugar', 100, 100, now).ok).toBe(false)
    expect(r.tokensView(now)).toHaveLength(0)

    const before = r.tick
    now += 2016
    const { restart } = r.step(now, 16, quiet)
    expect(restart).toMatch(/new round/)
    expect(r.tick).toBe(before + 1)
    const view = r.roundView(now)
    expect(view.phase).toBe('play')
    expect(view.n).toBe(2)
    expect(r.players.get(a.id)!.score).toBe(0)
    expect(r.players.get(a.id)!.total).toBe(1)
    expect(r.tokensView(now)).toHaveLength(0)
    expect(r.pouchFor(a.id, now).sugar.readyIn).toBe(0)
  })

  it('holds the clock while nobody is in the meadow', () => {
    const r = room({ playMs: 10_000 })
    run(r, 0, 5000, quiet)                          // empty: the clock should not move
    const a = r.join(KEY_A, 'Ana', 5000)
    expect(r.roundView(5016).left).toBeGreaterThan(9900)
    run(r, 5016, 3000, quiet)
    expect(r.roundView(8016).left).toBeLessThan(7100)
    r.leave(a.id, 8016)
    run(r, 8016, 5000, quiet)
    expect(r.roundView(13_016).phase).toBe('play')  // still not over
  })

  it('restarts a brain the model has got stuck', () => {
    const r = room()
    r.join(KEY_A, 'Ana', 0)
    // MN9 firing hard for seconds with nothing to taste is the signature mind.ts watches for
    let restarted: string | null = null
    let now = 0
    for (let t = 0; t < 20_000 && !restarted; t += 16) {
      now += 16
      restarted = r.step(now, 16, tongue).restart
    }
    expect(restarted).toMatch(/stuck/)
    expect(r.drainEvents().some(e => e.kind === 'restart')).toBe(true)
  })
})

describe('the wire', () => {
  it('rejects anything a client should not be able to say', () => {
    expect(parseClientMsg(null)).toBeNull()
    expect(parseClientMsg({ t: 'place', tool: 'odor', x: 1, y: 1 })).toBeNull()       // not a tool here
    expect(parseClientMsg({ t: 'place', tool: 'sugar', x: -5, y: 1 })).toBeNull()      // off the arena
    expect(parseClientMsg({ t: 'place', tool: 'sugar', x: ARENA.w + 1, y: 1 })).toBeNull()
    expect(parseClientMsg({ t: 'place', tool: 'sugar', x: NaN, y: 1 })).toBeNull()
    expect(parseClientMsg({ t: 'cursor', x: 'a', y: 1 })).toBeNull()
    expect(parseClientMsg({ t: 'join', name: 'x', key: 'short' })).toBeNull()
    expect(parseClientMsg({ t: 'remove', id: 1.5 })).toBeNull()
    expect(parseClientMsg({ t: 'drive', rates: [] })).toBeNull()                       // not for clients
  })

  it('accepts the real thing', () => {
    expect(parseClientMsg({ t: 'cursor', x: null, y: null })).toEqual({ t: 'cursor', x: null, y: null })
    expect(parseClientMsg({ t: 'place', tool: 'bitter', x: 10, y: 20 })).toEqual({ t: 'place', tool: 'bitter', x: 10, y: 20 })
    expect(parseClientMsg({ t: 'join', name: 'Ana', key: KEY_A })).toEqual({ t: 'join', name: 'Ana', key: KEY_A })
  })

  it('every tool is a stimulus the pet already has', () => {
    for (const t of TOOLS) expect(['sugar', 'looming', 'bitter']).toContain(t.id)
    expect(ROUND.playMs).toBeGreaterThan(ROUND.betweenMs)
  })

  it('a state message carries what the renderer needs and nothing it cannot read', () => {
    const r = room()
    const a = r.join(KEY_A, 'Ana', 0)
    r.cursor(a.id, 12, 34)
    r.step(16, 16, quiet)
    const s = r.stateMsg(16)
    expect(s.t).toBe('state')
    expect(Object.keys(s.rates).sort()).toEqual([...readouts.keys()].sort())
    expect(s.cursors).toEqual([[a.id, 12, 34]])
    expect(s.fly.x).toBeCloseTo(r.world.fly.x)
    expect(s.round).toEqual({ n: 1, phase: 'play', left: ROUND.playMs - 16 })
    expect(JSON.stringify(s).length).toBeLessThan(1200)
  })
})
