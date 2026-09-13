import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LiveBrain } from '../src/pet/sim'
import { petConfig, subnet } from './helpers'

/**
 * Regression lock on the LIF engine.
 *
 * What this does and does not prove: the engine's agreement with Brian2 was established
 * by bake/14_validate_engine.py, which bundles this same source, runs it against the
 * Brian2 reference and compares spike for spike. That check needs Brian2, a C++ compiler
 * and the 2.4 GB annotation cache, so it cannot run here or in CI.
 *
 * This test replays a fixed deterministic scenario and compares it to a golden recorded
 * from the validated engine. It catches drift - a refactor that changes a single spike -
 * without re-proving equivalence. If it fails, the question is not "is the golden stale"
 * but "what did I change"; regenerate only after re-running 14_validate_engine.py.
 *
 *   UPDATE_GOLDEN=1 npx vitest run test/sim.test.ts
 */
const GOLDEN = resolve(__dirname, 'golden/sim-kick.json')
const GOLDEN_DRIVEN = resolve(__dirname, 'golden/sim-driven.json')
const STEPS = 1000            // dt is 0.1 ms, so 100 ms of simulated time

interface Golden {
  note: string; steps: number; n: number; totalSpikes: number
  perStep: number[]; checksum: string; firstSpikes: number[]
}

/** Order-sensitive rolling hash over the whole (step, neuron) spike stream. */
function streamChecksum(pairs: Iterable<[number, number]>): string {
  let h = 0x811c9dc5 >>> 0
  for (const [t, i] of pairs) {
    h = Math.imul(h ^ (t & 0xff), 0x01000193) >>> 0
    h = Math.imul(h ^ ((t >>> 8) & 0xff), 0x01000193) >>> 0
    h = Math.imul(h ^ (i & 0xff), 0x01000193) >>> 0
    h = Math.imul(h ^ ((i >>> 8) & 0xff), 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

function runKick(steps = STEPS) {
  const cfg = petConfig()
  const brain = new LiveBrain(subnet(), cfg.model)
  const sugar = cfg.sensors.find(s => s.id === 'sugar')!
  brain.reset()
  brain.seed(12345)
  brain.kick(sugar.sides.left, 1.0)     // one suprathreshold poke, no Poisson anywhere
  const perStep: number[] = []
  const pairs: [number, number][] = []
  const firstSpikes: number[] = []
  let total = 0
  for (let t = 0; t < steps; t++) {
    const n = brain.step()
    perStep.push(n)
    total += n
    for (let k = 0; k < n; k++) {
      pairs.push([t, brain.lastSpikes[k]])
      if (firstSpikes.length < 64) firstSpikes.push(brain.lastSpikes[k])
    }
  }
  return { brain, perStep, total, checksum: streamChecksum(pairs), firstSpikes }
}

/** The Poisson path: a sustained sensory drive, which is what the pet actually runs. */
function runDriven(steps = 600) {
  const cfg = petConfig()
  const brain = new LiveBrain(subnet(), cfg.model)
  const sugar = cfg.sensors.find(s => s.id === 'sugar')!
  const touch = cfg.sensors.find(s => s.id === 'touch') ?? cfg.sensors[1]
  const rates = new Map<number, number>()
  for (const i of sugar.sides.left) rates.set(i, sugar.rate_hz)
  for (const i of touch.sides.right) rates.set(i, touch.rate_hz * 0.5)
  brain.reset()
  brain.seed(0xC0FFEE)
  brain.setDrive(rates)
  const perStep: number[] = []
  const pairs: [number, number][] = []
  let total = 0
  for (let t = 0; t < steps; t++) {
    const n = brain.step()
    perStep.push(n); total += n
    for (let k = 0; k < n; k++) pairs.push([t, brain.lastSpikes[k]])
  }
  return { perStep, total, checksum: streamChecksum(pairs) }
}

describe('LIF engine', () => {
  it('reproduces the recorded deterministic cascade spike for spike', () => {
    const r = runKick()
    if (process.env.UPDATE_GOLDEN) {
      const g: Golden = {
        note: 'Recorded from the engine validated against Brian2 by bake/14_validate_engine.py. '
            + 'Regenerate only after re-running that script.',
        steps: STEPS, n: subnet().n, totalSpikes: r.total,
        perStep: r.perStep, checksum: r.checksum, firstSpikes: r.firstSpikes,
      }
      writeFileSync(GOLDEN, JSON.stringify(g, null, 1) + '\n')
      console.warn(`golden rewritten: ${r.total} spikes, checksum ${r.checksum}`)
      return
    }
    expect(existsSync(GOLDEN), 'run with UPDATE_GOLDEN=1 to record it').toBe(true)
    const g: Golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
    expect(r.total).toBe(g.totalSpikes)
    expect(r.perStep).toEqual(g.perStep)          // when each spike happened
    expect(r.firstSpikes).toEqual(g.firstSpikes)  // and which neuron
    expect(r.checksum).toBe(g.checksum)           // and the whole stream, in order
  })

  it('reproduces the recorded Poisson-driven run spike for spike', () => {
    const r = runDriven()
    if (process.env.UPDATE_GOLDEN) {
      writeFileSync(GOLDEN_DRIVEN, JSON.stringify({
        note: 'Seeded Poisson drive. Same provenance caveat as sim-kick.json.',
        steps: 600, totalSpikes: r.total, perStep: r.perStep, checksum: r.checksum,
      }, null, 1) + '\n')
      console.warn(`driven golden rewritten: ${r.total} spikes, checksum ${r.checksum}`)
      return
    }
    expect(existsSync(GOLDEN_DRIVEN), 'run with UPDATE_GOLDEN=1 to record it').toBe(true)
    const g = JSON.parse(readFileSync(GOLDEN_DRIVEN, 'utf8'))
    expect(r.total).toBe(g.totalSpikes)
    expect(r.perStep).toEqual(g.perStep)
    expect(r.checksum).toBe(g.checksum)
  })

  it('the seeded Poisson drive is reproducible', () => {
    expect(runDriven(200).checksum).toBe(runDriven(200).checksum)
  })

  it('a different seed gives a different stream', () => {
    // if seeding did nothing, the golden above would be locking a constant
    const cfg = petConfig()
    const sugar = cfg.sensors.find(s => s.id === 'sugar')!
    const go = (seed: number) => {
      const b = new LiveBrain(subnet(), cfg.model)
      const rates = new Map<number, number>()
      for (const i of sugar.sides.left) rates.set(i, sugar.rate_hz)
      b.reset(); b.seed(seed); b.setDrive(rates)
      let n = 0
      for (let t = 0; t < 200; t++) n += b.step()
      return n
    }
    expect(go(1)).not.toBe(go(999))
  })

  it('is deterministic: the same kick twice gives the identical stream', () => {
    expect(runKick(300).checksum).toBe(runKick(300).checksum)
  })

  it('reset() clears membrane state so a second run matches the first', () => {
    const cfg = petConfig()
    const brain = new LiveBrain(subnet(), cfg.model)
    const sugar = cfg.sensors.find(s => s.id === 'sugar')!
    const go = () => {
      brain.reset(); brain.seed(1); brain.kick(sugar.sides.left, 1.0)
      let n = 0
      for (let t = 0; t < 200; t++) n += brain.step()
      return n
    }
    const a = go()
    expect(go()).toBe(a)
  })

  it('holds a neuron refractory for t_rfc after it fires', () => {
    const cfg = petConfig()
    const m = cfg.model
    const brain = new LiveBrain(subnet(), m)
    brain.reset()
    brain.kick([0], 1.0)
    expect(brain.step()).toBe(1)                    // fires on the first step
    const refrSteps = Math.round(m.t_rfc_ms / m.dt_ms)
    for (let t = 0; t < refrSteps - 1; t++) {
      brain.kick([0], 1.0)                          // keep shoving it over threshold
      const spikes = brain.step()
      expect(spikes, `neuron 0 fired again ${t + 1} steps into its refractory period`)
        .toBe(0)
    }
  })

  it('a kick under the decay margin does not fire at all', () => {
    // guards the default above: 1e-3 mV over threshold decays back under it
    const cfg = petConfig()
    const b = new LiveBrain(subnet(), cfg.model)
    b.reset(); b.kick([0], 1e-3)
    expect(b.step()).toBe(0)
    b.reset(); b.kick([0], 1.0)
    expect(b.step()).toBe(1)
  })

  it('a stronger kick recruits at least as many spikes', () => {
    const cfg = petConfig()
    const sugar = cfg.sensors.find(s => s.id === 'sugar')!
    const count = (idx: number[]) => {
      const b = new LiveBrain(subnet(), cfg.model)
      b.reset(); b.seed(7); b.kick(idx, 1.0)
      let n = 0
      for (let t = 0; t < 400; t++) n += b.step()
      return n
    }
    const few = count(sugar.sides.left.slice(0, 5))
    const many = count(sugar.sides.left)
    expect(many).toBeGreaterThan(few)
  })
})
