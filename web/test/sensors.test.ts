import { describe, it, expect } from 'vitest'
import { bearing, computeDrive, foragingDrive, STIMULI,
         type SensorGroup, type StimKind, type Stim } from '../src/pet/sensors'

const group = (id: string, over: Partial<SensorGroup> = {}): SensorGroup => ({
  id, label: id, modality: 'test', rate_hz: 100, note: '', cell_types: [], n: 6,
  sides: { left: [0, 1], right: [2, 3], other: [4, 5] }, ...over,
})
const kind = (over: Partial<StimKind> = {}): StimKind => ({
  id: 'k', label: 'k', emoji: '*', colour: '#fff', range: 100, contact: false,
  edible: false, blurb: '', tag: '', channels: [{ group: 'g', rangeMul: 1 }], ...over,
})
const at = (k: StimKind, x: number, y: number, id = 1): Stim => ({ kind: k, x, y, id })
const one = () => new Map([['g', group('g')]])
const flat = () => 1

const sides = (r: Map<number, number>) => ({
  left: (r.get(0) ?? 0) + (r.get(1) ?? 0),
  right: (r.get(2) ?? 0) + (r.get(3) ?? 0),
  other: (r.get(4) ?? 0) + (r.get(5) ?? 0),
})

describe('bearing', () => {
  it('wraps into [-pi, pi]', () => {
    for (const h of [0, 1, 3, -3, 6, -6]) {
      for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1], [-1, -1]]) {
        const b = bearing(0, 0, h, x, y)
        expect(b).toBeGreaterThanOrEqual(-Math.PI)
        expect(b).toBeLessThanOrEqual(Math.PI)
      }
    }
  })
  it('is zero straight ahead', () => {
    expect(bearing(0, 0, 0, 10, 0)).toBeCloseTo(0)
    expect(bearing(0, 0, -Math.PI / 2, 0, -10)).toBeCloseTo(0)
  })
})

describe('laterality', () => {
  // This is the bug that was found and fixed: screen y grows downward, so something on
  // the fly's left sits at bearing -pi/2 and sin(b) is -1 there. Without the negation
  // the left stimulus drove the right antenna, and the turn sign cancelled it so
  // nothing looked wrong. Lock the direction.
  it('drives the left population when the stimulus is on the fly\'s left', () => {
    // heading -pi/2 points up the screen; the fly's left is then screen-left (-x)
    const r = computeDrive([at(kind(), -30, 0)], 0, 0, -Math.PI / 2, one(), flat)
    const s = sides(r.rates)
    expect(s.left).toBeGreaterThan(s.right)
  })
  it('drives the right population when the stimulus is on the fly\'s right', () => {
    const r = computeDrive([at(kind(), 30, 0)], 0, 0, -Math.PI / 2, one(), flat)
    const s = sides(r.rates)
    expect(s.right).toBeGreaterThan(s.left)
  })
  it('is balanced straight ahead', () => {
    const r = computeDrive([at(kind(), 0, -30)], 0, 0, -Math.PI / 2, one(), flat)
    const s = sides(r.rates)
    expect(s.left).toBeCloseTo(s.right, 6)
  })
  it('stays balanced for contact chemoreception, which has no direction', () => {
    const k = kind({ contact: true, range: 100 })
    const r = computeDrive([at(k, -30, 0)], 0, 0, -Math.PI / 2, one(), flat)
    const s = sides(r.rates)
    expect(s.left).toBeCloseTo(s.right, 6)
  })
})

describe('computeDrive', () => {
  it('falls off exponentially for distance senses and linearly on contact', () => {
    const far = (k: StimKind, d: number) =>
      sides(computeDrive([at(k, d, 0)], 0, 0, 0, one(), flat).rates).other
    const phasic = kind()
    expect(far(phasic, 0)).toBeGreaterThan(far(phasic, 50))
    expect(far(phasic, 50)).toBeGreaterThan(far(phasic, 150))
    expect(far(phasic, 150)).toBeGreaterThan(0)          // exponential never quite zero

    const contact = kind({ contact: true, range: 100 })
    expect(far(contact, 120)).toBe(0)                    // linear: hard cutoff at range
  })

  it('applies the per-stimulus gain', () => {
    const lo = computeDrive([at(kind(), 10, 0)], 0, 0, 0, one(), () => 1)
    const hi = computeDrive([at(kind(), 10, 0)], 0, 0, 0, one(), () => 2)
    expect(sides(hi.rates).other).toBeGreaterThan(sides(lo.rates).other)
  })

  it('adds several stimuli of the same kind onto the same neurons', () => {
    const k = kind()
    const single = computeDrive([at(k, 10, 0, 1)], 0, 0, 0, one(), flat)
    const double = computeDrive([at(k, 10, 0, 1), at(k, 10, 0, 2)], 0, 0, 0, one(), flat)
    expect(sides(double.rates).other).toBeGreaterThan(sides(single.rates).other)
  })

  it('clamps drive so one pile of stimuli cannot run away', () => {
    const k = kind()
    const many = Array.from({ length: 40 }, (_, i) => at(k, 1, 0, i))
    const r = computeDrive(many, 0, 0, 0, one(), () => 10)
    for (const hz of r.rates.values()) expect(hz).toBeLessThanOrEqual(400)
  })

  it('reports touching only for a contact stimulus the fly is really on', () => {
    const k = kind({ contact: true, range: 100, edible: true })
    expect(computeDrive([at(k, 90, 0)], 0, 0, 0, one(), flat).touching).toBeNull()
    expect(computeDrive([at(k, 10, 0)], 0, 0, 0, one(), flat).touching).not.toBeNull()
  })

  it('ignores a channel whose group is missing rather than throwing', () => {
    const k = kind({ channels: [{ group: 'nope', rangeMul: 1 }] })
    expect(() => computeDrive([at(k, 10, 0)], 0, 0, 0, one(), flat)).not.toThrow()
  })
})

describe('sensory adaptation', () => {
  it('fades a sustained stimulus toward its floor, and phasic fades further than taste', () => {
    const expose = (k: StimKind) => {
      const s = at(k, 2, 0)
      for (let t = 0; t < 60; t++) computeDrive([s], 0, 0, 0, one(), flat, 200)
      return s.adapt!
    }
    const phasic = expose(kind())
    const taste = expose(kind({ contact: true, range: 100 }))
    expect(phasic).toBeLessThan(taste)                 // 0.18 floor vs 0.72
    expect(phasic).toBeCloseTo(0.18, 1)
    expect(taste).toBeCloseTo(0.72, 1)
  })

  it('recovers once the stimulus is out of range', () => {
    const k = kind()
    const s = at(k, 2, 0)
    for (let t = 0; t < 60; t++) computeDrive([s], 0, 0, 0, one(), flat, 200)
    const faded = s.adapt!
    s.x = 100000                                        // walked away
    for (let t = 0; t < 60; t++) computeDrive([s], 0, 0, 0, one(), flat, 200)
    expect(s.adapt!).toBeGreaterThan(faded)
  })

  it('does not adapt when no time passes', () => {
    const s = at(kind(), 2, 0)
    computeDrive([s], 0, 0, 0, one(), flat, 0)
    expect(s.adapt).toBe(1)
  })
})

describe('foragingDrive', () => {
  it('drives forward harder when hungry', () => {
    const full = foragingDrive(0, 0, 1, 0, [0], [1], [2])
    const starving = foragingDrive(1, 0, 1, 0, [0], [1], [2])
    expect(starving.get(0)!).toBeGreaterThan(full.get(0)!)
  })
  it('goes quiet between bouts', () => {
    expect(foragingDrive(1, 0, 0, 0, [0], [1], [2]).get(0)).toBe(0)
  })
  it('steers with the saccade sign and never goes negative', () => {
    const left = foragingDrive(0.5, 0, 1, 1, [0], [1], [2])
    const right = foragingDrive(0.5, 0, 1, -1, [0], [1], [2])
    expect(left.get(1)!).toBeGreaterThan(left.get(2)!)
    expect(right.get(2)!).toBeGreaterThan(right.get(1)!)
    for (const v of [...left.values(), ...right.values()]) expect(v).toBeGreaterThanOrEqual(0)
  })
})

describe('the shipped stimulus table', () => {
  it('is internally consistent', () => {
    expect(STIMULI.length).toBeGreaterThan(0)
    const ids = new Set<string>()
    for (const k of STIMULI) {
      expect(ids.has(k.id), `duplicate stimulus id ${k.id}`).toBe(false)
      ids.add(k.id)
      expect(k.range).toBeGreaterThan(0)
      expect(k.channels.length).toBeGreaterThan(0)
      for (const c of k.channels) {
        expect(c.rangeMul).toBeGreaterThan(0)
        expect(c.rangeMul).toBeLessThanOrEqual(1)
      }
      expect(k.emoji).not.toBe('')
      expect(k.label).not.toBe('')
    }
  })
  it('only marks contact stimuli edible', () => {
    for (const k of STIMULI) if (k.edible) expect(k.contact).toBe(true)
  })
})
