// Offline behaviour harness: the pet's real brain, sensors, decoder and world, run
// headless so the constants in motor.ts / sensors.ts can be tuned against numbers
// instead of against a feeling.  usage: node 15_pet_tune.mjs [scenario...]
import fs from 'node:fs'
import { LiveBrain, computeDrive, foragingDrive, Saccades, STIMULI, MotorDecoder, World }
  from './_pet_headless.mjs'

const WEB = new URL('../web/public/data/', import.meta.url).pathname
function packed(file, magic) {
  const b = fs.readFileSync(WEB + file)
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  const dv = new DataView(buf)
  const got = String.fromCharCode(...[0,1,2,3].map(i => dv.getUint8(i)))
  if (got !== magic) throw new Error(`${file}: ${got}`)
  const hl = dv.getUint32(4, true)
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl)))
  const T = { f32: Float32Array, u8: Uint8Array, u16: Uint16Array, u32: Uint32Array,
              i16: Int16Array, i32: Int32Array }
  const out = { ...head }
  for (const a of head.arrays) out[a.name] = new T[a.type](buf, 8 + hl + a.offset, a.length)
  return out
}
const sub = packed('subnet.bin', 'FLYS')
const pet = JSON.parse(fs.readFileSync(WEB + 'pet.json', 'utf8'))
const groups = new Map(pet.sensors.map(s => [s.id, s]))
const RO = new Map(pet.readouts.map(r => [r.id, {
  left: new Set(r.sides.left), right: new Set([...r.sides.right, ...r.sides.other]),
  all: new Set([...r.sides.left, ...r.sides.right, ...r.sides.other]),
  nl: Math.max(r.sides.left.length, 1),
  nr: Math.max(r.sides.right.length + r.sides.other.length, 1),
  ema: [0, 0],
}]))
const readoutIdx = new Map(pet.readouts.map(r => [r.id, {
  left: r.sides.left, right: [...r.sides.right, ...r.sides.other],
  all: [...r.sides.left, ...r.sides.right, ...r.sides.other],
}]))
const RATE_TAU_MS = 80
const DT = pet.model.dt_ms

/** Run one scenario for `seconds` of fly time; returns behaviour metrics. */
function run(seconds, place, opts = {}) {
  const brain = new LiveBrain(sub, pet.model)
  brain.seed(opts.seed ?? 20260912)
  const world = new World()
  const motor = new MotorDecoder()
  for (const r of RO.values()) r.ema = [0, 0]
  world.fly.hunger = opts.hunger ?? 0.35
  if (place) place(world)

  const FRAME = 16.7                       // the main loop's cadence, in sim ms
  const stepsPerFrame = Math.round(FRAME / DT)
  const frames = Math.round(seconds * 1000 / FRAME)
  let wander = 0, wanderV = 0, boutPhase = Math.random() * 6.283
  const saccades = new Saccades()
  const m = { dist: 0, turned: 0, bounces: 0, meals: 0, escapes: 0, minDist: Infinity,
              doing: {}, firstContactMs: null, firstEscapeMs: null, maxSpeed: 0,
              peak: {}, peakDrive: 0 }
  let prev = { x: world.fly.x, y: world.fly.y }

  for (let f = 0; f < frames; f++) {
    const gain = id => id === 'sugar' ? 0.55 + world.fly.hunger * 0.9 : 1
    const { rates, perStim, touching } =
      computeDrive(world.stims, world.fly.x, world.fly.y, world.fly.h, groups, gain, FRAME)
    void perStim
    wanderV += (Math.random() - 0.5) * FRAME * 0.006
    wanderV *= 0.97
    wander = Math.max(-1, Math.min(1, wander + wanderV))
    const fw = readoutIdx.get('forward'), st = readoutIdx.get('turn_b')
    boutPhase += FRAME / 9000 * 6.283
    const bout = Math.max(0, 0.55 + 0.75 * Math.sin(boutPhase) + 0.25 * world.fly.hunger)
    const sac = saccades.step(FRAME)
    for (const [i, hz] of
         foragingDrive(world.fly.hunger, wander, bout, sac, fw.all, st.left, st.right))
      rates.set(i, (rates.get(i) ?? 0) + hz)
    brain.setDrive(rates)

    const counts = new Map([...RO.keys()].map(k => [k, [0, 0]]))
    for (let s = 0; s < stepsPerFrame; s++) {
      brain.step()
      for (const i of brain.lastSpikes)
        for (const [id, r] of RO)
          if (r.all.has(i)) counts.get(id)[r.left.has(i) ? 0 : 1]++
    }
    const win = stepsPerFrame * DT
    const alpha = 1 - Math.exp(-win / RATE_TAU_MS)
    const rrates = {}
    for (const [id, r] of RO) {
      const c = counts.get(id)
      r.ema[0] += ((c[0] / r.nl) * (1000 / win) - r.ema[0]) * alpha
      r.ema[1] += ((c[1] / r.nr) * (1000 / win) - r.ema[1]) * alpha
      rrates[id] = [r.ema[0], r.ema[1]]
    }

    for (const k in rrates) m.peak[k] = Math.max(m.peak[k] ?? 0, rrates[k][0] + rrates[k][1])
    for (const v of rates.values()) m.peakDrive = Math.max(m.peakDrive, v)
    const a = motor.update(rrates, FRAME)
    const h0 = world.fly.h
    const nStim = world.stims.length
    world.step(a, FRAME, s => world.remove(s.id), touching)
    if (world.stims.length < nStim) m.meals++
    if (touching && m.firstContactMs === null) m.firstContactMs = f * FRAME
    for (const st2 of world.stims)
      m.minDist = Math.min(m.minDist, Math.hypot(st2.x - world.fly.x, st2.y - world.fly.y))
    if (a.escape && m.firstEscapeMs === null) m.firstEscapeMs = f * FRAME
    if (a.escape) m.escapes++
    m.dist += Math.hypot(world.fly.x - prev.x, world.fly.y - prev.y)
    m.turned += Math.abs(world.fly.h - h0)
    m.maxSpeed = Math.max(m.maxSpeed, Math.abs(world.fly.speed))
    if (world.fly.x <= 27 || world.fly.x >= world.w - 27 ||
        world.fly.y <= 27 || world.fly.y >= world.h - 27) m.bounces++
    m.doing[a.dominant] = (m.doing[a.dominant] ?? 0) + 1
    prev = { x: world.fly.x, y: world.fly.y }
  }
  const pct = Object.fromEntries(Object.entries(m.doing)
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(100 * v / frames).toFixed(0)]))
  return {
    seconds, speed_avg: +(m.dist / seconds).toFixed(0), speed_max: +m.maxSpeed.toFixed(0),
    arena_crossings: +(m.dist / world.w).toFixed(2),
    turn_deg_per_s: +(m.turned * 180 / Math.PI / seconds).toFixed(0),
    wall_frames_pct: +(100 * m.bounces / frames).toFixed(0),
    meals: m.meals, hunger_end: +world.fly.hunger.toFixed(2),
    first_contact_s: m.firstContactMs === null ? null : +(m.firstContactMs / 1000).toFixed(1),
    first_escape_ms: m.firstEscapeMs,
    min_dist: m.minDist === Infinity ? null : +m.minDist.toFixed(0),
    peak_drive_hz: +m.peakDrive.toFixed(0),
    peak_readout_hz: Object.fromEntries(Object.entries(m.peak)
      .map(([k, v]) => [k, +v.toFixed(1)]).filter(([, v]) => v > 0.3)
      .sort((a, b) => b[1] - a[1])),
    doing_pct: pct,
  }
}

const kind = id => STIMULI.find(k => k.id === id)
const near = (id, dist, ang = 0) => w => {
  const a = w.fly.h + ang
  w.add(kind(id), w.fly.x + Math.cos(a) * dist, w.fly.y + Math.sin(a) * dist)
}
const SCENARIOS = {
  idle:     () => run(60, null),
  forage:   (seed) => run(120, near('sugar', 200, 1.1), { seed: 20260912 + (seed ?? 0) * 7919 }),
  hungry:   () => run(60, null, { hunger: 0.95 }),
  full:     () => run(60, null, { hunger: 0.05 }),
  sugar:    () => run(40, near('sugar', 70)),
  sugar_on: () => run(25, near('sugar', 8)),
  looming:  () => run(15, near('looming', 60, Math.PI / 2)),
  vibrate:  () => run(25, near('touch', 45, Math.PI / 2)),
  dust:     () => run(25, near('bristle', 40, Math.PI / 2)),
  bitter:   () => run(25, near('bitter', 8)),
}
// `forage xN` repeats a scenario across seeds: finding food without a sense of smell
// is luck, so the number that matters is the hit rate, not one run
const repeat = (name, n) => {
  const rows = []
  for (let k = 0; k < n; k++) {
    const saved = SCENARIOS[name]
    rows.push(saved.length ? saved(k) : (() => {
      const f = SCENARIOS[name]; return f(k)
    })())
  }
  const hit = rows.filter(r => r.meals > 0).length
  const contacted = rows.filter(r => r.first_contact_s !== null).length
  console.log(`${name} x${n}: reached food ${contacted}/${n}, ate ${hit}/${n}, ` +
    `min distance ${rows.map(r => r.min_dist).join(', ')}`)
}

const want = process.argv.slice(2)
if (want[0] === 'repeat') { repeat(want[1], +want[2] || 5); process.exit(0) }
for (const [name, fn] of Object.entries(SCENARIOS)) {
  if (want.length && !want.includes(name)) continue
  const t0 = Date.now()
  const r = fn()
  console.log(`${name.padEnd(9)} ${JSON.stringify(r)}  [${((Date.now()-t0)/1000).toFixed(1)}s]`)
}
