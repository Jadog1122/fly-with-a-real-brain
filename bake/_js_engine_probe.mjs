// Drive the browser's LIF engine from Node with a known stimulus and dump the spikes,
// so 14_validate_engine.py can compare them against the Brian2 run of the same network.
// usage: node _js_engine_probe.mjs <subnet.bin> <pet.json> <sensorSpec> <ms> <out-prefix>
//   sensorSpec: "sugar:1.0,looming:0.5"  (id:rateScale, side suffix .left/.right allowed)
//               "kick:sugar"             deterministic: one suprathreshold kick, no Poisson
import fs from 'node:fs'
import { LiveBrain } from './_sim_engine.mjs'

const [, , subPath, petPath, spec, msArg, outPrefix] = process.argv
const MS = +msArg

function loadPacked(path, magic) {
  const b = fs.readFileSync(path)
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  const dv = new DataView(buf)
  const got = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
  if (got !== magic) throw new Error(`${path}: expected ${magic} got ${got}`)
  const hl = dv.getUint32(4, true)
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl)))
  const T = { f32: Float32Array, u8: Uint8Array, u16: Uint16Array, u32: Uint32Array, i16: Int16Array, i32: Int32Array }
  const out = { ...head }
  for (const a of head.arrays) out[a.name] = new T[a.type](buf, 8 + hl + a.offset, a.length)
  return out
}

const sub = loadPacked(subPath, 'FLYS')
const pet = JSON.parse(fs.readFileSync(petPath, 'utf8'))
const brain = new LiveBrain(sub, pet.model)

if (spec.startsWith('kick:')) {
  const s = pet.sensors.find(x => x.id === spec.slice(5))
  const seeds = [...s.sides.left, ...s.sides.right, ...s.sides.other].sort((a, b) => a - b)
  brain.kick(seeds, 1.0)                       // 1 mV over threshold, as in the Brian2 reference
  const si = [], st = []
  const steps = Math.round(MS / pet.model.dt_ms)
  for (let k = 0; k < steps; k++) {
    brain.step()
    for (const q of brain.lastSpikes) { si.push(q); st.push((k) * pet.model.dt_ms) }
  }
  fs.writeFileSync(outPrefix + '.i.bin', Buffer.from(new Uint16Array(si).buffer))
  fs.writeFileSync(outPrefix + '.t.bin', Buffer.from(new Float32Array(st).buffer))
  console.log(JSON.stringify({ spec, ms: MS, spikes: si.length, active: new Set(si).size }))
  process.exit(0)
}

const rates = new Map()
for (const part of spec.split(',')) {
  const [nameRaw, scaleRaw] = part.split(':')
  const [id, side] = nameRaw.split('.')
  const s = pet.sensors.find(x => x.id === id)
  if (!s) throw new Error(`no sensor ${id}`)
  const idx = side ? [...s.sides[side], ...s.sides.other] : [...s.sides.left, ...s.sides.right, ...s.sides.other]
  for (const i of idx) rates.set(i, s.rate_hz * (+scaleRaw))
}
brain.setDrive(rates)

const steps = Math.round(MS / pet.model.dt_ms)
const si = [], st = []
const t0 = Date.now()
for (let k = 0; k < steps; k++) {
  brain.step()
  const sp = brain.lastSpikes
  const tSec = (k + 1) * pet.model.dt_ms / 1000
  for (let q = 0; q < sp.length; q++) { si.push(sp[q]); st.push(tSec) }
}
const wall = (Date.now() - t0) / 1000
fs.writeFileSync(outPrefix + '.i.bin', Buffer.from(new Uint16Array(si).buffer))
fs.writeFileSync(outPrefix + '.t.bin', Buffer.from(new Float32Array(st).buffer))
console.log(JSON.stringify({
  spec, ms: MS, spikes: si.length, active: new Set(si).size,
  wall_s: +wall.toFixed(2), steps_per_s: Math.round(steps / wall),
  x_realtime: +(steps / wall / (1000 / pet.model.dt_ms)).toFixed(2),
}))
