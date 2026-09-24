import { describe, it, expect } from 'vitest'
import { Mind, sensesFor, explain, EXPERIMENTS } from '../src/pet/mind'
import { STIMULI, type Stim } from '../src/pet/sensors'
import type { Action } from '../src/pet/motor'
import type { Fly } from '../src/pet/world'

// The arena's y grows down the screen, so for a fly facing +x a stimulus at -y is on its
// LEFT (sensors.ts: bearing -pi/2 is left). Every "left" below means that.
const LEFT = (d: number) => ({ x: 380, y: 245 - d })
const RIGHT = (d: number) => ({ x: 380, y: 245 + d })

const kind = (id: string) => STIMULI.find(k => k.id === id)!
let nextId = 1
const stim = (id: string, at: { x: number; y: number }): Stim => ({ kind: kind(id), ...at, id: nextId++ })
const fly = (over: Partial<Fly> = {}): Fly => ({
  x: 380, y: 245, h: 0, speed: 0, legPhase: 0, wing: 0, hunger: 0.35, startle: 0, fed: 0,
  alt: 0, flying: 0, bank: 0, pitch: 0, beat: 0, turnRate: 0, ...over,
})
const act = (over: Partial<Action> = {}): Action => ({
  forward: 0, turn: 0, escape: false, escapeSpeed: 130, proboscis: 0, groom: 0,
  dominant: 'idle', ...over,
})
function memory() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
  }
}

/** Run the mind for `ms` of fly time with everything held fixed. */
function hold(mind: Mind, ms: number, o: {
  stims?: [Stim, number][]; rates?: Record<string, [number, number]>
  action?: Partial<Action>; fly?: Fly; touching?: Stim | null
}, clock = { t: 0 }) {
  const found: string[] = []
  const f = o.fly ?? fly()
  for (let t = 0; t < ms; t += 16.7) {
    clock.t += 16.7
    const d = mind.step({
      dtMs: 16.7, simMs: clock.t,
      side: id => o.rates?.[id] ?? [0, 0],
      action: act(o.action), fly: f,
      stims: (o.stims ?? []).map(([s]) => s),
      perStim: new Map((o.stims ?? []).map(([s, p]) => [s.id, p])),
      touching: o.touching ?? null, poked: false,
    })
    if (d) found.push(d.id)
  }
  return found
}

describe('senses', () => {
  it('sends a stimulus on its left to the left organ, as sensors.ts splits the drive', () => {
    const loom = stim('looming', LEFT(60))
    const s = sensesFor([loom], new Map([[loom.id, 0.8]]), fly())
    expect(s).toEqual([{ stim: loom.id, kind: 'looming', organ: 'eye', side: 'left', weight: 0.8 }])
  })

  it('tastes sugar with both front feet, and with the mouthparts only up close', () => {
    const sugar = stim('sugar', RIGHT(10))
    const far = sensesFor([sugar], new Map([[sugar.id, 0.3]]), fly())
    expect(far.map(x => `${x.organ}:${x.side}`)).toEqual(['foot:left', 'foot:right'])
    const near = sensesFor([sugar], new Map([[sugar.id, 0.9]]), fly())
    expect(near.map(x => x.organ)).toContain('labellum')
  })

  it('names the cause, and says when the drive is the game’s own', () => {
    const loom = stim('looming', LEFT(60))
    expect(explain('escape', [loom], new Map([[loom.id, 0.5]]), fly(), false))
      .toBe('a shadow looming on its left')
    expect(explain('walking', [], new Map(), fly(), false)).toBe('the wander drive we add')
  })
})

describe('the body', () => {
  it('gathers pollen near Dust and grooms it off again', () => {
    const mind = new Mind(memory())
    const dust = stim('bristle', LEFT(30))
    hold(mind, 1000, { stims: [[dust, 0.6]] })
    expect(mind.dust).toBeGreaterThan(0.5)
    hold(mind, 4000, { action: { groom: 1 } })
    expect(mind.dust).toBe(0)
  })

  it('drinks the nectar drop down while it feeds', () => {
    const mind = new Mind(memory())
    const sugar = stim('sugar', RIGHT(5))
    hold(mind, 500, { stims: [[sugar, 0.9]] })
    expect(mind.nectar.get(sugar.id)).toBe(1)
    hold(mind, 2000, { stims: [[sugar, 0.9]], fly: fly({ eating: 1 }), touching: sugar })
    const left = mind.nectar.get(sugar.id)!
    expect(left).toBeLessThan(0.6)
    expect(left).toBeGreaterThanOrEqual(0.2)
  })
})

describe('the notebook', () => {
  it('has ten experiments, each with the check it was measured against', () => {
    expect(EXPERIMENTS).toHaveLength(10)
    for (const e of EXPERIMENTS) expect(e.measured.length).toBeGreaterThan(10)
  })

  it('records the tongue coming out on sugar, with the fly’s own rate', () => {
    const mind = new Mind(memory())
    const sugar = stim('sugar', RIGHT(5))
    const found = hold(mind, 500, { stims: [[sugar, 0.8]], rates: { proboscis: [60, 62] } })
    expect(found).toContain('taste')
    expect(mind.view.done.taste.readings[0].value).toBe('122 /s')
  })

  it('judges bitter per visit to the sugar, against the fly\u2019s own answer to sugar alone', () => {
    const mind = new Mind(memory())
    const clock = { t: 0 }
    const sugar = stim('sugar', RIGHT(5)), bitter = stim('bitter', LEFT(6))
    const stepOff = () => hold(mind, 100, {}, clock)
    hold(mind, 600, { stims: [[sugar, 0.8]], rates: { proboscis: [70, 70] } }, clock)
    // bitter as strong as the sugar but the tongue still well out: not a veto
    hold(mind, 1000, { stims: [[sugar, 0.8], [bitter, 0.7]], rates: { proboscis: [40, 40] } }, clock)
    expect(stepOff()).not.toContain('bitter')
    // bitter too faint to count, however quiet the tongue
    hold(mind, 1000, { stims: [[sugar, 0.8], [bitter, 0.4]], rates: { proboscis: [1, 1] } }, clock)
    expect(stepOff()).not.toContain('bitter')
    // too brief a visit to judge
    hold(mind, 300, { stims: [[sugar, 0.8], [bitter, 0.7]], rates: { proboscis: [1, 1] } }, clock)
    expect(stepOff()).not.toContain('bitter')
    hold(mind, 1000, { stims: [[sugar, 0.8], [bitter, 0.7]], rates: { proboscis: [1, 1] } }, clock)
    expect(stepOff()).toContain('bitter')
    const r = mind.view.done.bitter.readings
    expect(r[0].value).toBe('140 /s')
    expect(r[1].value).toBe('2 /s')
  })

  it('needs the answering DNa01 to swap sides with the threat, and reports the crossing', () => {
    const mind = new Mind(memory())
    const clock = { t: 0 }
    const l = stim('looming', LEFT(60)), r = stim('looming', RIGHT(60))
    // the same cell answering both sides says nothing about side
    hold(mind, 700, { stims: [[l, 0.6]], rates: { turn_a: [0, 30] } }, clock)
    expect(hold(mind, 700, { stims: [[r, 0.6]], rates: { turn_a: [0, 28] } }, clock)).not.toContain('sides')
    // the model's own pattern, measured headless: crossed
    expect(hold(mind, 700, { stims: [[r, 0.6]], rates: { turn_a: [28, 0] } }, clock)).toContain('sides')
    expect(mind.view.done.sides.note).toMatch(/^Crossed/)
  })

  it('catches the smell artifact: the same turn whichever side the smell is on', () => {
    const mind = new Mind(memory())
    const clock = { t: 0 }
    hold(mind, 1600, { stims: [[stim('odor', LEFT(100)), 0.6]], rates: { turn_b: [79, 29] } }, clock)
    const found = hold(mind, 1600, { stims: [[stim('odor', RIGHT(100)), 0.6]], rates: { turn_b: [80, 33] } }, clock)
    expect(found).toContain('odor')
    expect(mind.view.done.odor.note).toMatch(/same side won both times/)
  })

  it('notices when one antenna does nothing', () => {
    const mind = new Mind(memory())
    const clock = { t: 0 }
    hold(mind, 2200, { stims: [[stim('touch', RIGHT(40)), 0.5]] }, clock)
    const found = hold(mind, 700, { stims: [[stim('touch', LEFT(40)), 0.5]], rates: { groom: [0, 35] },
                                    action: { dominant: 'grooming', groom: 1 } }, clock)
    expect(found).toContain('antenna')
    expect(mind.view.done.antenna.readings[1].value).toBe('its left')
    expect(mind.view.done.antenna.note).toMatch(/From its right it did nothing/)
  })

  it('reads hunger on the approach, where it shows, not standing in the sugar', () => {
    const mind = new Mind(memory())
    const clock = { t: 0 }
    const near = stim('sugar', RIGHT(5)), approaching = stim('sugar', RIGHT(30))
    // standing in it, the tongue saturates hungry or full: that must not count
    hold(mind, 500, { stims: [[near, 0.9]], rates: { proboscis: [65, 65] }, fly: fly({ hunger: 0.9 }) }, clock)
    hold(mind, 500, { stims: [[near, 0.9]], rates: { proboscis: [64, 64] }, fly: fly({ hunger: 0.1 }) }, clock)
    expect(mind.view.done.hunger).toBeUndefined()
    hold(mind, 400, { stims: [[approaching, 0.6]], rates: { proboscis: [50, 50] }, fly: fly({ hunger: 0.9 }) }, clock)
    const found = hold(mind, 400, { stims: [[approaching, 0.3]], rates: { proboscis: [5, 5] }, fly: fly({ hunger: 0.1 }) }, clock)
    expect(found).toContain('hunger')
    expect(mind.view.done.hunger.readings.map(r => r.value)).toEqual(['100 /s', '10 /s'])
  })

  it('spots the brain running on its own, and will not judge the tongue meanwhile', () => {
    const mind = new Mind(memory())
    const clock = { t: 0 }
    // MN9 hard on with nothing to taste, no bristle touched: the loop a poke leaves
    hold(mind, 2500, { rates: { proboscis: [110, 112] } }, clock)
    expect(mind.stuck).toBeNull()                       // not yet: three seconds of it
    const found = hold(mind, 1000, { rates: { proboscis: [110, 112] } }, clock)
    expect(mind.stuck?.readout).toBe('proboscis')
    expect(mind.why).toMatch(/loop in its brain/)
    expect(found).toContain('stuck')
    // sugar arriving now must not count as tasting it
    expect(hold(mind, 3500, { stims: [[stim('sugar', RIGHT(5)), 0.8]], rates: { proboscis: [110, 112] } }, clock))
      .not.toContain('taste')
    // a restart: everything back near nothing, and after a second it is over
    hold(mind, 1200, {}, clock)
    expect(mind.stuck).toBeNull()
  })

  it('does not call the ordinary wander drive a loop', () => {
    const mind = new Mind(memory())
    hold(mind, 6000, { rates: { forward: [25, 25], turn_b: [30, 30] } })
    expect(mind.stuck).toBeNull()
  })

  it('keeps what it found across visits, and forgets it on request', () => {
    const store = memory()
    const mind = new Mind(store)
    hold(mind, 500, { stims: [[stim('sugar', RIGHT(5)), 0.8]], rates: { proboscis: [60, 60] } })
    expect(Object.keys(new Mind(store).view.done)).toEqual(['taste'])
    mind.forget()
    expect(Object.keys(new Mind(store).view.done)).toEqual([])
  })

  it('treats a corrupt store as an empty notebook', () => {
    const store = memory()
    store.setItem('fly-notebook-v1', '{not json')
    expect(new Mind(store).view.next).toBe('taste')
  })
})
