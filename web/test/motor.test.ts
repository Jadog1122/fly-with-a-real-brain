import { describe, it, expect } from 'vitest'
import { MotorDecoder, type Rates, type Action } from '../src/pet/motor'

/** The decoder low-passes its input, so settle it before asserting. */
function settle(r: Rates, ms = 400, step = 16): Action {
  const d = new MotorDecoder()
  let a!: Action
  for (let t = 0; t < ms; t += step) a = d.update(r, step)
  return a
}
const quiet: Rates = {
  forward: [0, 0], backward: [0, 0], turn_a: [0, 0], turn_b: [0, 0],
  escape: [0, 0], proboscis: [0, 0], groom: [0, 0],
}

describe('motor decoder', () => {
  it('does nothing when the brain is quiet', () => {
    const a = settle(quiet)
    expect(a.dominant).toBe('idle')
    expect(a.forward).toBeCloseTo(0)
    expect(a.turn).toBeCloseTo(0)
    expect(a.escape).toBe(false)
  })

  it('walks only once forward clears its threshold', () => {
    expect(settle({ ...quiet, forward: [10, 10] }).dominant).toBe('idle')   // 20 < 24
    const on = settle({ ...quiet, forward: [30, 30] })
    expect(on.dominant).toBe('walking')
    expect(on.forward).toBeGreaterThan(0)
  })

  it('turns toward the side firing harder, positive meaning the fly\'s left', () => {
    const left = settle({ ...quiet, turn_a: [40, 0], turn_b: [40, 0] })
    const right = settle({ ...quiet, turn_a: [0, 40], turn_b: [0, 40] })
    expect(left.turn).toBeGreaterThan(0)
    expect(right.turn).toBeLessThan(0)
    expect(left.turn).toBeCloseTo(-right.turn, 6)
  })

  it('escapes above threshold and stops locomotion while fleeing', () => {
    const a = settle({ ...quiet, escape: [20, 20], forward: [60, 60] })
    expect(a.escape).toBe(true)
    expect(a.dominant).toBe('escape')
    expect(a.forward).toBe(0)
    expect(a.turn).toBe(0)
    expect(a.escapeSpeed).toBeGreaterThan(0)
  })

  it('latches escape for ~420 ms after the drive stops', () => {
    const d = new MotorDecoder()
    for (let t = 0; t < 400; t += 16) d.update({ ...quiet, escape: [30, 30] }, 16)
    expect(d.update(quiet, 16).escape).toBe(true)
    let a = d.update(quiet, 200)
    expect(a.escape).toBe(true)                 // still latched at 216 ms
    a = d.update(quiet, 250)
    expect(a.escape).toBe(false)                // released past 420 ms
  })

  it('grooming stops locomotion', () => {
    const a = settle({ ...quiet, groom: [10, 10], forward: [60, 60] })
    expect(a.dominant).toBe('grooming')
    expect(a.groom).toBeGreaterThan(0)
    expect(a.forward).toBe(0)
  })

  it('feeding does NOT stop locomotion', () => {
    // The regression this pins: the proboscis extends as soon as sugar is in receptor
    // range, which is further than the fly can reach. Treating that as "busy" froze it
    // just short of the food and no meal ever completed. The World decides when to
    // stop, on actual contact.
    const a = settle({ ...quiet, proboscis: [10, 10], forward: [60, 60] })
    expect(a.proboscis).toBeGreaterThan(0)
    expect(a.forward).toBeGreaterThan(0)
  })

  it('ranks escape over grooming over feeding over walking', () => {
    const loud = { escape: [30, 30], groom: [30, 30], proboscis: [30, 30],
                   forward: [60, 60] } as Partial<Rates>
    expect(settle({ ...quiet, ...loud }).dominant).toBe('escape')
    expect(settle({ ...quiet, groom: [30, 30], proboscis: [30, 30], forward: [60, 60] })
      .dominant).toBe('grooming')
    expect(settle({ ...quiet, proboscis: [30, 30], forward: [60, 60] })
      .dominant).toBe('feeding')
  })

  it('backs up when the backward readout dominates', () => {
    const a = settle({ ...quiet, backward: [40, 40], forward: [5, 5] })
    expect(a.dominant).toBe('backing up')
    expect(a.forward).toBeLessThan(0)
  })

  it('saturates proboscis extension at 1', () => {
    expect(settle({ ...quiet, proboscis: [500, 500] }).proboscis).toBe(1)
  })

  it('tolerates a readout it has never seen', () => {
    const d = new MotorDecoder()
    expect(() => d.update({ forward: [10, 10] }, 16)).not.toThrow()
  })
})
