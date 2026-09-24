/**
 * Every experiment in the field notebook, run against the real model with no browser:
 * the engine's tick step for step - stimulus drive, the wander drive we add, pollen on
 * the bristles, the 45,808-neuron brain, the 80 ms rate smoothing, the decoder, the
 * world and the notebook's own judges from src/pet/mind.ts. It is what "every experiment
 * was run headless first" means, and it is how to tell whether a judge asks for more
 * than the model gives.
 *
 *   node scripts/notebook-headless.mjs [seeds]      (about three minutes a seed)
 *
 * Each experiment gets up to three goes a seed, as a player would give it. Exits non-zero
 * if any experiment is never found in any seed.
 */
import { build } from 'esbuild'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { TextDecoder } from 'node:util'

// The current source, bundled in memory - not bake/_pet_headless.mjs, which is a build
// artefact from before flight existed.
async function load(entry) {
  const out = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const { LiveBrain, computeDrive, foragingDrive, Saccades, STIMULI, MotorDecoder, World } =
  await load('src/pet/_headless.ts')
const { Mind, EXPERIMENTS } = await load('src/pet/mind.ts')

function packed(file) {
  const b = readFileSync(`public/data/${file}`)
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  const hl = new DataView(buf).getUint32(4, true)
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl)))
  const T = { f32: Float32Array, u8: Uint8Array, u16: Uint16Array, u32: Uint32Array, i16: Int16Array, i32: Int32Array }
  const out = { ...head }
  for (const a of head.arrays) out[a.name] = new T[a.type](buf, 8 + hl + a.offset, a.length)
  return out
}
const sub = packed('subnet.bin')
const pet = JSON.parse(readFileSync('public/data/pet.json', 'utf8'))
const groups = new Map(pet.sensors.map(s => [s.id, s]))
const readouts = new Map(pet.readouts.map(r => [r.id, {
  left: new Set(r.sides.left), all: new Set([...r.sides.left, ...r.sides.right, ...r.sides.other]),
  nl: Math.max(r.sides.left.length, 1), nr: Math.max(r.sides.right.length + r.sides.other.length, 1),
  byside: { left: r.sides.left, right: [...r.sides.right, ...r.sides.other],
            all: [...r.sides.left, ...r.sides.right, ...r.sides.other] },
}]))
const DT = pet.model.dt_ms, FRAME = 16.7, SPF = Math.round(FRAME / DT)
const kind = id => STIMULI.find(k => k.id === id)
const memory = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) } }

/** A fresh fly and the engine's tick (engine.ts), with nothing drawn. */
function game(seed) {
  const brain = new LiveBrain(sub, pet.model)
  brain.seed(4242 + seed * 97)
  const world = new World(), mind = new Mind(memory()), saccades = new Saccades()
  let motor = new MotorDecoder()
  const ema = new Map([...readouts.keys()].map(k => [k, [0, 0]]))
  let wander = 0, wanderV = 0, bout = seed, sim = 0, rates = {}, pokeMs = 0
  const tick = () => {
    const f = world.fly
    const gain = id => id === 'sugar' ? 0.55 + f.hunger * 0.9 : 1
    const { rates: drive, perStim, touching } = computeDrive(world.stims, f.x, f.y, f.h, groups, gain, FRAME, f.alt)
    wanderV += (Math.random() - 0.5) * FRAME * 0.006
    wanderV *= 0.97
    wander = Math.max(-1, Math.min(1, wander + wanderV))
    bout += FRAME / 9000 * 6.283
    const b = Math.max(0, 0.55 + 0.75 * Math.sin(bout) + 0.25 * f.hunger)
    const fw = readouts.get('forward').byside, st = readouts.get('turn_b').byside
    for (const [i, hz] of foragingDrive(f.hunger, wander, b, saccades.step(FRAME), fw.all, st.left, st.right))
      drive.set(i, (drive.get(i) ?? 0) + hz)
    // a poke, as engine.tap drives it: every bristle neuron at its full rate
    const poked = pokeMs > 0
    if (poked) {
      pokeMs -= FRAME
      const bb = groups.get('bristle')
      for (const side of [bb.sides.left, bb.sides.right, bb.sides.other])
        for (const i of side) drive.set(i, (drive.get(i) ?? 0) + bb.rate_hz)
    }
    const bristle = mind.dust > 0.02 ? groups.get('bristle') : null
    if (bristle) {
      for (const side of [bristle.sides.left, bristle.sides.right, bristle.sides.other])
        for (const i of side) drive.set(i, Math.min(400, (drive.get(i) ?? 0) + bristle.rate_hz * 0.8 * mind.dust))
    }
    brain.setDrive(drive)
    const counts = new Map([...readouts.keys()].map(k => [k, [0, 0]]))
    for (let s = 0; s < SPF; s++) {
      brain.step()
      for (const i of brain.lastSpikes)
        for (const [k, r] of readouts) if (r.all.has(i)) counts.get(k)[r.left.has(i) ? 0 : 1]++
    }
    const alpha = 1 - Math.exp(-(SPF * DT) / 80), next = {}
    for (const [k, r] of readouts) {
      const c = counts.get(k), e = ema.get(k)
      e[0] += ((c[0] / r.nl) * (1000 / (SPF * DT)) - e[0]) * alpha
      e[1] += ((c[1] / r.nr) * (1000 / (SPF * DT)) - e[1]) * alpha
      next[k] = [e[0], e[1]]
    }
    // the engine decodes the rates the worker last posted, one tick behind
    const action = motor.update(rates, FRAME)
    rates = next
    world.step(action, FRAME, s => world.remove(s.id), touching)
    sim += FRAME
    mind.step({ dtMs: FRAME, simMs: sim, side: id => motor.side(id), action, fly: world.fly,
                stims: world.stims, perStim, touching, poked })
  }
  const run = ms => { for (let t = 0; t < ms; t += FRAME) tick() }
  const until = (id, ms) => { for (let t = 0; t < ms && !mind.view.done[id]; t += FRAME) tick() }
  // side: 0 ahead, -1 its left, +1 its right (y grows down the screen: heading - 90 is left)
  const put = (k, d, side = 0, dx = 0) => {
    const f = world.fly, a = f.h + side * Math.PI / 2
    world.add(kind(k), f.x + d * Math.cos(a) + dx, f.y + d * Math.sin(a))
  }
  const settle = ms => { world.clear(); run(ms) }
  // what "Restart its brain" does (engine.restartBrain): every neuron back to rest
  const restart = () => {
    brain.reset(); motor = new MotorDecoder(); rates = {}
    for (const e of ema.values()) { e[0] = 0; e[1] = 0 }
  }
  return { world, mind, run, until, put, settle, restart, poke: ms => { pokeMs = ms } }
}

/** The same sequence as scripts/notebook.mjs plays in the browser. */
function play(g) {
  const tries = {}
  let restarts = 0
  // as a player would when the "stuck" notice comes up: restart the brain, then carry on
  const unstick = () => { if (g.mind.stuck) { g.restart(); g.run(1500); restarts++ } }
  const go = (id, fn) => {
    for (let k = 0; k < 3 && !g.mind.view.done[id]; k++) { unstick(); tries[id] = k + 1; fn() }
  }
  g.run(1500)
  go('taste', () => { g.put('sugar', 25); g.until('taste', 15_000); g.settle(1000) })
  go('meal', () => { g.put('sugar', 20); g.until('meal', 20_000); g.settle(1500) })
  go('escape', () => { g.put('looming', 80, 1); g.until('escape', 8000); g.settle(6000) })
  go('dust', () => { g.put('bristle', 40, -1); g.until('dust', 25_000); g.settle(4000) })
  go('sides', () => {
    g.put('looming', 90, -1); g.run(1500); g.settle(6000)
    g.put('looming', 90, 1); g.until('sides', 4000); g.settle(6000)
  })
  go('bitter', () => {
    g.world.fly.hunger = 0.6
    g.put('sugar', 30); g.put('bitter', 30, 0, 3); g.until('bitter', 15_000); g.settle(3000)
  })
  go('antenna', () => {
    g.put('touch', 35, 1); g.run(2600); g.settle(1000)
    g.put('touch', 35, -1); g.until('antenna', 8000); g.settle(3000)
  })
  go('odor', () => {
    g.put('odor', 100, -1); g.run(2500); g.settle(3000)
    g.put('odor', 100, 1); g.until('odor', 5000); g.settle(3000)
  })
  go('hunger', () => {
    g.world.fly.hunger = 0.95; g.put('sugar', 34); g.run(1500); g.settle(2500)
    g.world.fly.hunger = 0.1; g.put('sugar', 34); g.until('hunger', 6000); g.settle(2000)
  })
  go('stuck', () => { g.poke(700); g.until('stuck', 10_000) })
  tries.restarts = restarts
  return tries
}

const seeds = Number(process.argv[2] ?? 2)
const found = Object.fromEntries(EXPERIMENTS.map(e => [e.id, 0]))
for (let s = 0; s < seeds; s++) {
  const t0 = Date.now()
  const g = game(s)
  const tries = play(g)
  console.log(`seed ${s} (${Math.round((Date.now() - t0) / 1000)} s, ${tries.restarts} brain restarts)`)
  for (const e of EXPERIMENTS) {
    const d = g.mind.view.done[e.id]
    if (d) found[e.id]++
    console.log(`  ${e.id.padEnd(8)} ${(d ? (tries[e.id] ? `go ${tries[e.id]}` : 'by itself') : 'NOT FOUND').padEnd(10)}`,
      d ? d.readings.map(r => `${r.label}: ${r.value}`).join(' | ') : '')
  }
}
console.log(Object.entries(found).map(([id, n]) => `${id} ${n}/${seeds}`).join(', '))
process.exitCode = Object.values(found).some(n => n === 0) ? 1 : 0
