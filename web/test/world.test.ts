import { describe, it, expect } from 'vitest'
import { World } from '../src/pet/world'
import { STIMULI, type Stim } from '../src/pet/sensors'
import type { Action } from '../src/pet/motor'

const still: Action = {
  forward: 0, turn: 0, escape: false, escapeSpeed: 130,
  proboscis: 0, groom: 0, dominant: 'idle',
}
const act = (o: Partial<Action> = {}): Action => ({ ...still, ...o })
const sugar = STIMULI.find(k => k.id === 'sugar')!
const noop = () => {}

/** Run the world forward without any stimulus. */
function run(w: World, a: Action, ms: number, stepMs = 16, touching: Stim | null = null,
             ate: (s: Stim) => void = noop) {
  for (let t = 0; t < ms; t += stepMs) w.step(a, stepMs, ate, touching)
}

describe('world physics', () => {
  it('keeps the fly inside the arena on every wall', () => {
    for (const h of [0, Math.PI, Math.PI / 2, -Math.PI / 2, 0.7, -2.3]) {
      const w = new World()
      w.fly.h = h
      run(w, act({ forward: 200 }), 20_000)
      expect(w.fly.x, `x escaped heading ${h}`).toBeGreaterThanOrEqual(0)
      expect(w.fly.x).toBeLessThanOrEqual(w.w)
      expect(w.fly.y, `y escaped heading ${h}`).toBeGreaterThanOrEqual(0)
      expect(w.fly.y).toBeLessThanOrEqual(w.h)
      expect(Number.isFinite(w.fly.x)).toBe(true)
      expect(Number.isFinite(w.fly.y)).toBe(true)
    }
  })

  it('reflects off a wall rather than sticking to it', () => {
    const w = new World()
    w.fly.x = 30; w.fly.y = w.h / 2; w.fly.h = Math.PI     // driving into the left wall
    run(w, act({ forward: 120 }), 3000)
    expect(w.fly.x).toBeGreaterThan(30)                    // it turned around and left
  })

  it('accumulates hunger at roughly the documented rate', () => {
    const w = new World()
    w.fly.hunger = 0
    run(w, still, 60_000)                                  // one minute
    expect(w.fly.hunger).toBeCloseTo(0.0035 * 60, 2)       // ~5 min from full to starving
  })

  it('never lets hunger leave [0, 1]', () => {
    const w = new World()
    w.fly.hunger = 0.99
    run(w, still, 600_000)
    expect(w.fly.hunger).toBeLessThanOrEqual(1)
    expect(w.fly.hunger).toBeGreaterThanOrEqual(0)
  })
})

describe('feeding', () => {
  const meal = (): Stim => ({ kind: sugar, x: 0, y: 0, id: 1 })

  it('only counts as a meal when actually touching edible food with the proboscis out', () => {
    const w = new World()
    w.fly.hunger = 0.5
    const before = w.fly.hunger
    run(w, act({ proboscis: 1 }), 1000, 16, null)          // proboscis out, nothing there
    expect(w.fly.hunger).toBeGreaterThan(before)           // still getting hungrier

    const w2 = new World()
    w2.fly.hunger = 0.5
    run(w2, act({ proboscis: 0.2 }), 1000, 16, meal())     // touching, proboscis too low
    expect(w2.fly.hunger).toBeGreaterThan(0.5)
  })

  it('stops the fly while it is on a meal', () => {
    const w = new World()
    w.fly.hunger = 0.5
    run(w, act({ forward: 120, turn: 1, proboscis: 1 }), 2000, 16, meal())
    expect(Math.abs(w.fly.speed)).toBeLessThan(1)
  })

  it('feeds, counts the meal and removes the food', () => {
    // The deadlock this pins: the decoder used to own the stop decision and the fly
    // froze short of the food, feeding forever with zero meals eaten.
    const w = new World()
    w.fly.hunger = 0.95
    const eaten: Stim[] = []
    const food = meal()
    for (let t = 0; t < 60_000 && eaten.length === 0; t += 16) {
      w.step(act({ proboscis: 1 }), 16, s => eaten.push(s), food)
    }
    expect(eaten.length).toBe(1)
    expect(eaten[0].id).toBe(food.id)
    expect(w.fly.fed).toBe(1)
    expect(w.fly.hunger).toBeLessThan(0.1)
  })
})

describe('stimulus bookkeeping', () => {
  it('adds and removes by id', () => {
    const w = new World()
    w.add(sugar, 10, 20)
    w.add(sugar, 30, 40)
    expect(w.stims.length).toBe(2)
    const id = w.stims[0].id
    w.remove(id)
    expect(w.stims.length).toBe(1)
    expect(w.stims.find(s => s.id === id)).toBeUndefined()
  })
  it('gives every stimulus a distinct id', () => {
    const w = new World()
    for (let i = 0; i < 50; i++) w.add(sugar, i, i)
    expect(new Set(w.stims.map(s => s.id)).size).toBe(50)
  })
  it('clear() empties the arena', () => {
    const w = new World()
    w.add(sugar, 10, 10)
    w.clear()
    expect(w.stims.length).toBe(0)
  })
})

describe('wing state', () => {
  it('is full while escaping and folds away once it has actually landed', () => {
    // Wings track flight, not the escape command: the Giant Fibre fires for a moment
    // and the flight lasts seconds, so they stay out through the whole descent.
    const w = new World()
    run(w, act({ escape: true }), 500)
    expect(w.fly.wing).toBe(1)
    run(w, still, 1000)
    expect(w.fly.wing, 'still descending, wings still out').toBeGreaterThan(0)
    run(w, still, 4000)
    expect(w.fly.wing, 'landed, wings folded').toBe(0)
    expect(w.fly.flying).toBe(0)
    expect(w.fly.alt).toBe(0)
  })
  it('stays within [0, 1] throughout', () => {
    const w = new World()
    for (let t = 0; t < 4000; t += 16) {
      w.step(act({ escape: (t / 16) % 7 < 3 }), 16, noop, null)
      expect(w.fly.wing).toBeGreaterThanOrEqual(0)
      expect(w.fly.wing).toBeLessThanOrEqual(1)
    }
  })
})
