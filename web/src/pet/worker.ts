// The brain runs here, off the UI thread.  At real time it needs ~10,000 timesteps a
// second, which is more than a 60 fps frame budget allows, so the main thread only
// sends stimulus changes and receives spikes and readout rates.

import { LiveBrain, type ModelConstants, type SubnetData } from './sim'
import { loadPacked } from './packed'

/** One readout group as written into public/data/pet.json by bake/13_pet_config.py. */
interface PetReadout {
  id: string
  label: string
  n: number
  sides: { left: number[]; right: number[]; other: number[] }
  names?: Record<string, string>
  note?: string
}

// Typed locally rather than via `/// <reference lib="webworker" />`, which would swap
// the DOM lib out for the whole project and break the main thread's event types.
const ctx = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent) => void) | null
  setInterval(fn: () => void, ms: number): number
}

type Init = { type: 'init'; subnetUrl: string; petUrl: string }
type Drive = { type: 'drive'; rates: [number, number][] }
type Speed = { type: 'speed'; factor: number }          // 1 = biological real time
type Kick = { type: 'kick'; idx: number[] }
type Reset = { type: 'reset' }
type Msg = Init | Drive | Speed | Kick | Reset

let brain: LiveBrain | null = null
let readouts: { id: string; left: Set<number>; right: Set<number>; all: Set<number>
                ema: [number, number] }[] = []
const RATE_TAU_MS = 80          // smoothing constant, in *simulated* milliseconds
let speed = 1
let simMs = 0
let acc = 0            // simulated ms owed to the clock
let last = 0


// spikes seen since the last report, and the per-readout counts over that window
let spikeAcc: number[] = []
const counts = new Map<string, { l: number; r: number }>()

function run() {
  if (!brain) return
  const now = performance.now()
  const wall = Math.min(now - last, 50)      // never try to catch up more than 50 ms
  last = now
  acc += wall * speed
  const dt = brain.m.dt_ms
  let steps = Math.floor(acc / dt)
  if (steps > 4000) steps = 4000             // hard ceiling so a stall cannot spiral
  acc -= steps * dt

  for (let s = 0; s < steps; s++) {
    brain.step()
    const sp = brain.lastSpikes
    for (let k = 0; k < sp.length; k++) {
      const i = sp[k]
      spikeAcc.push(i)
      for (const r of readouts) {
        if (r.all.has(i)) {
          const c = counts.get(r.id)!
          if (r.left.has(i)) c.l++; else c.r++
        }
      }
    }
  }
  simMs += steps * dt

  // Smooth in simulated time, not per message.  A tick can be a single 0.1 ms step,
  // where one spike from a two-neuron readout reads as 10 kHz; feeding that raw number
  // to the motor decoder would trip every behavioural threshold on noise.
  const rates: Record<string, [number, number]> = {}
  const win = Math.max(steps * dt, 1e-6)
  const alpha = 1 - Math.exp(-win / RATE_TAU_MS)
  for (const r of readouts) {
    const c = counts.get(r.id)!
    const nl = Math.max(r.left.size, 1), nr = Math.max(r.right.size, 1)
    r.ema[0] += ((c.l / nl) * (1000 / win) - r.ema[0]) * alpha
    r.ema[1] += ((c.r / nr) * (1000 / win) - r.ema[1]) * alpha
    rates[r.id] = [r.ema[0], r.ema[1]]
    c.l = 0; c.r = 0
  }
  const spikes = new Uint16Array(spikeAcc)
  spikeAcc = []
  // report the wall time actually consumed: setInterval is throttled in a background
  // tab, so dividing by its nominal period would overstate the rate several-fold
  ctx.postMessage({ type: 'tick', simMs, steps, rates, spikes, wallMs: wall,
                    driven: brain.driveCount }, [spikes.buffer])
}

ctx.onmessage = async (e: MessageEvent) => {
  const m = e.data as Msg
  if (m.type === 'init') {
    const sub = await loadPacked(m.subnetUrl, 'FLYS') as SubnetData
    const pet = await (await fetch(m.petUrl)).json()
    brain = new LiveBrain(sub, pet.model as ModelConstants)
    readouts = pet.readouts.map((r: PetReadout) => ({
      id: r.id,
      left: new Set<number>(r.sides.left),
      right: new Set<number>([...r.sides.right, ...r.sides.other]),
      all: new Set<number>([...r.sides.left, ...r.sides.right, ...r.sides.other]),
      ema: [0, 0] as [number, number],
    }))
    for (const r of readouts) counts.set(r.id, { l: 0, r: 0 })
    last = performance.now()
    ctx.setInterval(run, 16)
    ctx.postMessage({ type: 'ready', n: sub.n, members: sub.members })
  } else if (m.type === 'drive' && brain) {
    brain.setDrive(new Map(m.rates))
  } else if (m.type === 'speed') {
    speed = m.factor
  } else if (m.type === 'kick' && brain) {
    brain.kick(m.idx, 1.0)
  } else if (m.type === 'reset' && brain) {
    brain.reset(); simMs = 0; acc = 0; last = performance.now()
    for (const r of readouts) r.ema = [0, 0]
  }
}

export {}
