// The brain, on its own thread of the game server.
//
// This is src/pet/worker.ts moved to Node: the same LiveBrain, the same 16 ms run loop,
// the same rate smoothing in simulated time, talking over worker_threads instead of a
// Web Worker. One thread per room, so a second meadow costs a second core, not the
// first meadow's frame rate.

import { parentPort, workerData } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { LiveBrain, type ModelConstants, type SubnetData } from '../src/pet/sim'
import { parsePacked } from '../src/pet/packed'

interface PetReadout {
  id: string
  sides: { left: number[]; right: number[]; other: number[] }
}

export type BrainIn =
  | { type: 'drive'; rates: [number, number][] }
  | { type: 'speed'; factor: number }
  | { type: 'reset' }

export type BrainOut =
  | { type: 'ready'; n: number }
  | { type: 'tick'; simMs: number; steps: number; rates: Record<string, [number, number]>; wallMs: number }

const port = parentPort!
const { subnetPath, petPath, seed } = workerData as { subnetPath: string; petPath: string; seed: number }

function readPacked<T>(path: string, magic: string): T {
  const b = readFileSync(path)
  // a standalone ArrayBuffer: Buffer views share a pooled backing store
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  return parsePacked<T>(buf, magic, path)
}

const sub = readPacked<SubnetData>(subnetPath, 'FLYS')
const pet = JSON.parse(readFileSync(petPath, 'utf8')) as { model: ModelConstants; readouts: PetReadout[] }
const brain = new LiveBrain(sub, pet.model)
brain.seed(seed)
const readouts = pet.readouts.map(r => ({
  id: r.id,
  left: new Set<number>(r.sides.left),
  right: new Set<number>([...r.sides.right, ...r.sides.other]),
  all: new Set<number>([...r.sides.left, ...r.sides.right, ...r.sides.other]),
  ema: [0, 0] as [number, number],
  l: 0, r: 0,
}))

const RATE_TAU_MS = 80
let speed = 1
let simMs = 0
let acc = 0
let last = performance.now()

function run() {
  const now = performance.now()
  const wall = Math.min(now - last, 50)
  last = now
  acc += wall * speed
  const dt = brain.m.dt_ms
  let steps = Math.floor(acc / dt)
  if (steps > 4000) steps = 4000
  acc -= steps * dt

  for (let s = 0; s < steps; s++) {
    brain.step()
    const sp = brain.lastSpikes
    for (let k = 0; k < sp.length; k++) {
      const i = sp[k]
      for (const r of readouts) {
        if (r.all.has(i)) { if (r.left.has(i)) r.l++; else r.r++ }
      }
    }
  }
  simMs += steps * dt

  const rates: Record<string, [number, number]> = {}
  const win = Math.max(steps * dt, 1e-6)
  const alpha = 1 - Math.exp(-win / RATE_TAU_MS)
  for (const r of readouts) {
    const nl = Math.max(r.left.size, 1), nr = Math.max(r.right.size, 1)
    r.ema[0] += ((r.l / nl) * (1000 / win) - r.ema[0]) * alpha
    r.ema[1] += ((r.r / nr) * (1000 / win) - r.ema[1]) * alpha
    rates[r.id] = [r.ema[0], r.ema[1]]
    r.l = 0; r.r = 0
  }
  const out: BrainOut = { type: 'tick', simMs, steps, rates, wallMs: wall }
  port.postMessage(out)
}

port.on('message', (m: BrainIn) => {
  if (m.type === 'drive') brain.setDrive(new Map(m.rates))
  else if (m.type === 'speed') speed = m.factor
  else if (m.type === 'reset') {
    brain.reset(); simMs = 0; acc = 0; last = performance.now()
    for (const r of readouts) { r.ema = [0, 0]; r.l = 0; r.r = 0 }
  }
})

setInterval(run, 16)
const ready: BrainOut = { type: 'ready', n: sub.n }
port.postMessage(ready)
