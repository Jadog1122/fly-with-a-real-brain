// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { snapshot, validate, restore, read, write, forget } from '../src/pet/save'
import { World } from '../src/pet/world'
import { STIMULI } from '../src/pet/sensors'

const W = 760, H = 490
const v = (raw: unknown) => validate(raw, W, H, STIMULI)
const settings = { speed: 1, sound: false, picked: STIMULI[0].id }

beforeEach(() => { forget(); vi.restoreAllMocks() })

describe('snapshot and restore', () => {
  it('round-trips a world through validation unchanged', () => {
    const w = new World()
    w.fly.x = 123; w.fly.y = 456; w.fly.h = 1.2
    w.fly.hunger = 0.7; w.fly.startle = 0.3; w.fly.fed = 4
    w.add(STIMULI[0], 100, 200)
    w.add(STIMULI[1], 300, 400)

    const back = v(snapshot(w, settings))!
    expect(back).not.toBeNull()

    const w2 = new World()
    restore(back, w2, STIMULI)
    expect(w2.fly.x).toBeCloseTo(123)
    expect(w2.fly.y).toBeCloseTo(456)
    expect(w2.fly.hunger).toBeCloseTo(0.7)
    expect(w2.fly.fed).toBe(4)
    expect(w2.stims.map(s => s.kind.id)).toEqual([STIMULI[0].id, STIMULI[1].id])
    expect(w2.stims[0].x).toBeCloseTo(100)
  })

  it('clears transient body state so the fly does not resume mid-stride', () => {
    const w = new World()
    w.fly.speed = 90; w.fly.wing = 1; w.fly.eating = 0.8
    const w2 = new World()
    restore(v(snapshot(w, settings))!, w2, STIMULI)
    expect(w2.fly.speed).toBe(0)
    expect(w2.fly.wing).toBe(0)
    expect(w2.fly.eating).toBe(0)
  })

  it('replaces whatever was in the arena rather than adding to it', () => {
    const saved = v(snapshot(new World(), settings))!      // an empty arena
    const w = new World()
    w.add(STIMULI[0], 10, 10)
    w.add(STIMULI[0], 20, 20)
    restore(saved, w, STIMULI)
    expect(w.stims).toEqual([])
  })

  it('keeps stimulus ids distinct after a restore', () => {
    const w = new World()
    w.add(STIMULI[0], 10, 10); w.add(STIMULI[0], 20, 20)
    const w2 = new World()
    restore(v(snapshot(w, settings))!, w2, STIMULI)
    w2.add(STIMULI[0], 30, 30)
    expect(new Set(w2.stims.map(s => s.id)).size).toBe(3)
  })
})

describe('validation', () => {
  it('refuses anything that is not a saved state', () => {
    for (const junk of [null, undefined, 0, 'x', [], true, {}]) expect(v(junk)).toBeNull()
  })

  it('refuses a state written by a different version', () => {
    const w = new World()
    expect(v({ ...snapshot(w, settings), v: 99 })).toBeNull()
  })

  it('survives a state with every field the wrong type', () => {
    const out = v({ v: 1, at: 'x', fly: 'nope', stims: 'nope', settings: 7 })
    expect(out).not.toBeNull()
    expect(out!.stims).toEqual([])
    expect(out!.fly.hunger).toBe(0.35)
    expect(out!.settings.speed).toBe(1)
  })

  it('clamps a fly saved outside the arena back inside it', () => {
    const out = v({ v: 1, fly: { x: 99999, y: -500, hunger: 5, startle: -3, fed: -2 },
                    stims: [], settings: {} })!
    expect(out.fly.x).toBe(W)
    expect(out.fly.y).toBe(0)
    expect(out.fly.hunger).toBe(1)
    expect(out.fly.startle).toBe(0)
    expect(out.fly.fed).toBe(0)
  })

  it('rejects NaN and Infinity, which JSON can carry in as null or overflow', () => {
    const out = v({ v: 1, fly: { x: NaN, y: Infinity, h: -Infinity }, stims: [], settings: {} })!
    expect(Number.isFinite(out.fly.x)).toBe(true)
    expect(Number.isFinite(out.fly.y)).toBe(true)
    expect(Number.isFinite(out.fly.h)).toBe(true)
  })

  it('drops stimulus kinds this build no longer has', () => {
    const out = v({ v: 1, fly: {}, settings: {}, stims: [
      { kind: STIMULI[0].id, x: 10, y: 10, adapt: 1 },
      { kind: 'pheromone-from-an-old-build', x: 20, y: 20, adapt: 1 },
      null,
    ] })!
    expect(out.stims.map(s => s.kind)).toEqual([STIMULI[0].id])
  })

  it('caps how many stimuli a hand-edited entry can restore', () => {
    const many = Array.from({ length: 500 }, () => ({ kind: STIMULI[0].id, x: 1, y: 1, adapt: 1 }))
    expect(v({ v: 1, fly: {}, settings: {}, stims: many })!.stims.length).toBe(60)
  })

  it('falls back to a real stimulus when the selected one is gone', () => {
    const out = v({ v: 1, fly: {}, stims: [], settings: { picked: 'nonsense' } })!
    expect(STIMULI.some(k => k.id === out.settings.picked)).toBe(true)
  })

  it('clamps the speed setting and forces sound to a boolean', () => {
    const out = v({ v: 1, fly: {}, stims: [], settings: { speed: 9999, sound: 'yes' } })!
    expect(out.settings.speed).toBeLessThanOrEqual(4)
    expect(out.settings.sound).toBe(false)
  })
})

describe('storage', () => {
  it('writes then reads back', () => {
    const w = new World()
    w.fly.fed = 3
    expect(write(snapshot(w, settings))).toBe(true)
    expect(read(W, H, STIMULI)!.fly.fed).toBe(3)
  })

  it('returns null when nothing has been saved', () => {
    expect(read(W, H, STIMULI)).toBeNull()
  })

  it('returns null instead of throwing on corrupt JSON', () => {
    localStorage.setItem('fly-pet', '{not json')
    expect(read(W, H, STIMULI)).toBeNull()
  })

  it('survives a storage that throws, as in private mode', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied') })
    expect(read(W, H, STIMULI)).toBeNull()
    expect(write(snapshot(new World(), settings))).toBe(false)
    expect(() => forget()).not.toThrow()
  })

  it('forget() really removes it', () => {
    write(snapshot(new World(), settings))
    forget()
    expect(read(W, H, STIMULI)).toBeNull()
  })
})
