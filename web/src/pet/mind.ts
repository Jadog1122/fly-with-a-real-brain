// The fly's mind, made visible - and something to do with it.
//
// None of this is drawn here (mind3d.ts draws it, Notebook.tsx lists it). Three parts:
//
//   senses     which of the fly's sense organs each stimulus is reaching right now, on
//              which side and how hard. Read off the same falloff and left/right split
//              sensors.ts puts on the real sensory neurons, so the mind view shows the
//              input the brain actually gets, not a guess at it.
//   the body   pollen on the head bristles, nectar left in a drop, how full the crop is:
//              state you can see on the fly rather than in a panel.
//   notebook   experiments. Each asks you to make the fly do something, is judged on the
//              brain's own descending-neuron rates, and records this fly's numbers at the
//              moment it happened. Every one was first run headless on the same model
//              (the `measured` line on each) so none asks for what the model cannot do.
//   stuck      when the brain is running on its own. This network is bistable: a strong
//              enough push leaves some cells keeping each other firing after the input
//              has gone, and nothing in the model tires, so it never stops by itself.
//              Brushing the head bristles hard (a poke, or Dust) locks MN9 - the tongue -
//              on at ~220 /s; a smell leaves DNa01 steering. Measured headless: every
//              poke, every dusting, 90 s and counting. The game says so and offers a
//              restart rather than hiding it.

import { bearing, type Stim } from './sensors'
import type { Action } from './motor'
import type { Fly } from './world'
import type { Organ, Side } from './fly3d'

// --- senses -----------------------------------------------------------------------------

export interface Sense {
  stim: number          // the stimulus's id
  kind: string          // its kind: 'sugar', 'looming', ...
  organ: Organ
  side: Side | 'mid'    // 'mid': both sides alike - taste is not lateralised here
  weight: number        // 0..1, how hard it is driving that organ on that side
}

/**
 * Which organ each kind of stimulus reaches: the sensory populations in pet.json, placed
 * on the body. Dust drives the head bristles, and the biggest class of those (BM_InOm)
 * sits between the facets of the eyes - so dust lands on the eyes.
 */
const ORGANS: Record<string, { organ: Organ; lateral: boolean; both?: boolean; share?: 'near' }[]> = {
  // taste is not split left from right here, so both front feet taste it alike
  sugar: [{ organ: 'foot', lateral: false, both: true }, { organ: 'labellum', lateral: false, share: 'near' }],
  bitter: [{ organ: 'labellum', lateral: false }],
  looming: [{ organ: 'eye', lateral: true }],
  bristle: [{ organ: 'eye', lateral: true }],
  touch: [{ organ: 'antenna', lateral: true }],
  odor: [{ organ: 'antenna', lateral: true }],
}

export function sensesFor(stims: Stim[], perStim: Map<number, number>, fly: Fly): Sense[] {
  const out: Sense[] = []
  for (const s of stims) {
    const p = perStim.get(s.id) ?? 0
    if (p < 0.03) continue
    // the same split sensors.ts applies: +1 when it is on the fly's left
    const lean = -Math.sin(bearing(fly.x, fly.y, fly.h, s.x, s.y))
    for (const o of ORGANS[s.kind.id] ?? []) {
      // the labellum's sugar channel only answers the last third of the range
      const w = o.share === 'near' ? Math.max(0, (p - 0.34) / 0.66) : p
      if (w < 0.03) continue
      if (o.both) {
        for (const side of ['left', 'right'] as const) out.push({ stim: s.id, kind: s.kind.id, organ: o.organ, side, weight: w })
        continue
      }
      if (!o.lateral) { out.push({ stim: s.id, kind: s.kind.id, organ: o.organ, side: 'mid', weight: w }); continue }
      const l = Math.max(0, 0.5 + 0.5 * lean) * w, r = Math.max(0, 0.5 - 0.5 * lean) * w
      if (l > 0.03) out.push({ stim: s.id, kind: s.kind.id, organ: o.organ, side: 'left', weight: l })
      if (r > 0.03) out.push({ stim: s.id, kind: s.kind.id, organ: o.organ, side: 'right', weight: r })
    }
  }
  return out
}

// --- why --------------------------------------------------------------------------------

const sideWord = (fly: Fly, s: Stim) =>
  -Math.sin(bearing(fly.x, fly.y, fly.h, s.x, s.y)) > 0 ? 'left' : 'right'

/**
 * The cause, in a few words, for the HUD: what it is doing, and the input that is driving
 * it. An attribution, not a proof - the strongest input of a kind that reaches that
 * behaviour - and where the drive is ours rather than the model's, it says so.
 */
export function explain(dominant: string, stims: Stim[], perStim: Map<number, number>,
                        fly: Fly, poked: boolean): string {
  const top = (kind: string) => {
    let best: Stim | null = null, bp = 0.05
    for (const s of stims) {
      const p = perStim.get(s.id) ?? 0
      if (s.kind.id === kind && p > bp) { best = s; bp = p }
    }
    return best
  }
  const loom = top('looming'), dust = top('bristle'), touch = top('touch')
  const sugar = top('sugar'), odor = top('odor')
  switch (dominant) {
    case 'escape':
      return loom ? `a shadow looming on its ${sideWord(fly, loom)}` : 'its giant fibre fired'
    case 'grooming':
      if (poked) return 'you poked its bristles'
      if (dust) return 'pollen on the bristles of its head'
      if (touch) return `air moving its ${sideWord(fly, touch)} antenna`
      return 'its grooming command fired'
    case 'feeding':
      if (sugar) return (perStim.get(sugar.id) ?? 0) > 0.5 ? 'sugar on its mouthparts' : 'its feet taste sugar'
      if (dust) return 'the bristles on its proboscis were brushed'
      return 'its tongue command fired'
    case 'backing up':
      return loom ? 'the moonwalker cells, after the shadow' : 'the moonwalker cells fired'
    case 'turning':
    case 'walking':
      if (odor) return 'geosmin tipped the whole brain over'
      if (fly.flying > 0.2) return 'still airborne after the escape'
      return dominant === 'turning' ? 'a saccade from the wander drive we add' : 'the wander drive we add'
    default:
      return 'nothing is driving it'
  }
}

// --- the notebook -----------------------------------------------------------------------

export interface Reading { label: string; value: string }

/** A readout running on its own - see the header. */
export interface Stuck {
  readout: 'proboscis' | 'turn_a'
  rate: number           // Hz, now
  since: number          // fly time it was first seen, ms
  cause: string          // what last drove it, in words
}

/** What an experiment recorded, from this fly, when it happened. */
export interface Discovery {
  id: string
  at: number             // fly time, seconds
  readings: Reading[]
  note?: string
}

export interface Experiment {
  id: string
  title: string
  ask: string            // the goal, as you would ask it of a person at the bench
  hint: string           // shown once it has gone a while without being done
  path: string[]         // input -> ... -> output, the chain the result walks along
  shows: string          // what it tells you about the fly's mind
  ours?: string          // what part of what you saw is the game's, not the connectome's
  measured: string       // the headless result it was checked against
}

/** Everything an experiment's judge can look at, once per tick. */
export interface Moment {
  dtMs: number
  simMs: number
  side: (id: string) => [number, number]     // a descending readout, left and right, Hz
  action: Action
  fly: Fly
  stims: Stim[]
  perStim: Map<number, number>
  touching: Stim | null
  poked: boolean
  dust: number
}

const rate = (m: Moment, id: string) => { const [l, r] = m.side(id); return l + r }
const hz = (x: number) => `${Math.round(x)} /s`
const strongest = (m: Moment, kind: string) => {
  let best: Stim | null = null, bp = 0
  for (const s of m.stims) {
    const p = m.perStim.get(s.id) ?? 0
    if (s.kind.id === kind && p > bp) { best = s; bp = p }
  }
  return { s: best, p: bp }
}
/** +1 left, -1 right, as sensors.ts splits it. */
const leanOf = (m: Moment, s: Stim) => -Math.sin(bearing(m.fly.x, m.fly.y, m.fly.h, s.x, s.y))

type Judge = (m: Moment, done: Record<string, Discovery>, stuck: Stuck | null) => Omit<Discovery, 'id' | 'at'> | null

/** A running mean over a fixed stretch of time. */
class Window {
  sum = 0; t = 0
  constructor(readonly ms: number) {}
  add(x: number, dtMs: number) { this.sum += x * dtMs; this.t += dtMs; return this.t >= this.ms }
  get mean() { return this.t ? this.sum / this.t : 0 }
  reset() { this.sum = 0; this.t = 0 }
}

export const EXPERIMENTS: Experiment[] = [
  {
    id: 'taste', title: 'Taste with its feet',
    ask: 'Put sugar down where the fly will walk onto it.',
    hint: 'Drop the sugar a little way ahead of it, in its path. Flies taste with their feet before their mouths.',
    path: ['11 foot taste neurons', '122 mouthpart sugar neurons', 'MN9', 'tongue out'],
    shows: 'A fly tastes with its feet. The moment sugar touches them, MN9 - the motor neuron that swings the proboscis out - starts firing. Nothing told the game to do that: it is the wiring.',
    measured: 'standing on sugar: MN9 about 138 /s, within one frame',
  },
  {
    id: 'meal', title: 'A full meal',
    ask: 'Let it eat until it has had its fill.',
    hint: 'It needs to be standing on the sugar with its tongue out. A hungrier fly feeds harder.',
    path: ['sugar on the feet', 'MN9', 'drinking', 'a fuller crop'],
    shows: 'Watch the abdomen: a fly drinks into its crop, and it swells. Fed goes up, and a full fly is pickier about the next drop.',
    ours: 'Hunger, how fast it falls while feeding and how much the abdomen swells are the game’s. The tongue that makes eating possible is the connectome’s.',
    measured: 'on sugar, 1 meal in 25 s of fly time, hunger 0.35 -> 0.10',
  },
  {
    id: 'escape', title: 'Make it take off',
    ask: 'Frighten it into the air.',
    hint: 'Something dropping out of the sky is what every fly fears. Try Looming, close by.',
    path: ['104 looming detectors (LC4)', 'Giant Fibre', 'jump and fly'],
    shows: 'The giant fibre is the fastest pathway in the fly: one big cell, from the eyes’ looming detectors straight to the jump muscles. When it fires, nothing else gets a vote.',
    ours: 'How high it flies, and landing again, are the game’s - the connectome stops at the neck.',
    measured: 'looming 60 units away: giant fibre over 200 /s, in the first frame',
  },
  {
    id: 'dust', title: 'Get it dusty',
    ask: 'Dust its head with pollen, and watch it clean itself.',
    hint: 'Put Dust close to it. The specks land on the bristles of its head.',
    path: ['1,417 head bristle neurons', 'aDN1', 'grooming'],
    shows: 'Every bristle on the head has a neuron at its base. Brush enough of them and aDN1 - the command for grooming the head - takes over. Left and right stay apart on the way: in this connectome it is the aDN1 on the side away from the dust that fires hardest.',
    ours: 'The pollen specks are how the game draws the bristles being driven. The grooming that clears them is aDN1’s.',
    measured: 'dust 40 units to its right: aDN1 left 74 /s, right 9 /s',
  },
  {
    id: 'sides', title: 'Left eye, right eye',
    ask: 'Threaten it from its left, and then from its right.',
    hint: 'Put Looming well off to one side of it, then - once it has settled - on the other side.',
    path: ['looming on one side', 'that side’s LC4', 'the other side’s DNa01'],
    shows: 'The brain keeps left and right apart: which of the two DNa01 steering cells fires tells you where the threat is. And it crosses over - a threat on its left drives the right DNa01, one on its right the left. That split is the connectome’s.',
    ours: 'Which way it then turns is the game’s choice of sign (motor.ts explains why).',
    measured: 'looming on its left: DNa01 left 0, right 30 /s; on its right: left 28 /s, right 0',
  },
  {
    id: 'bitter', title: 'Spoil the sugar',
    ask: 'Put bitter right on top of its sugar, so it tastes both.',
    hint: 'Put Bitter right on top of the sugar, in its path, so it tastes both as strongly. Watch whether it stops to feed.',
    path: ['42 bitter taste neurons', 'inhibit the sugar pathway', 'MN9 falls silent'],
    shows: 'Bitter does not just fail to excite - it vetoes. The bitter neurons shut the sugar signal down before it reaches MN9, so the tongue stays in with sugar under its feet - and a fly that does not taste food walks straight over it. It is a balance, though: bitter much fainter than the sugar only takes the edge off.',
    measured: 'sugar alone: MN9 138 /s; bitter beside it, as strong: 2 /s; bitter 25 units further off: 81 /s',
  },
  {
    id: 'antenna', title: 'Tickle its antennae',
    ask: 'Blow on its antennae until it grooms.',
    hint: 'Vibration is air moving the antenna. Put it close - in front of the fly, or off to one side.',
    path: ["471 Johnston's organ neurons", 'aDN1', 'grooming'],
    shows: "Johnston's organ, in the second segment of the antenna, is the fly's ear and its wind sensor. Enough of it firing and the fly grooms.",
    measured: 'vibration in front: aDN1 13 /s; on its left 35 /s; on its right: nothing',
  },
  {
    id: 'odor', title: 'Catch the model out',
    ask: 'Put geosmin on its left, then on its right. Does it turn away from the smell?',
    hint: 'Geosmin well off to one side, give it a few seconds, clear it, then the other side.',
    path: ['39 geosmin receptor neurons', 'a whole-brain runaway', 'the same turn, every time'],
    shows: 'Here the model breaks, and the game shows it rather than hiding it. Any smell tips this brain into a runaway through thousands of neurons, and what comes out is always the same steering - whichever side the smell is on. It cannot smell.',
    ours: 'Nothing: this is the connectome model’s own failure, kept on purpose.',
    measured: 'geosmin on its right: DNa02 left 80 /s, right 33; on its left: left 79, right 29',
  },
  {
    id: 'hunger', title: 'Hungry or full',
    ask: 'Put sugar in its path when it is hungry, and again when it is full. Watch the tongue as it comes near.',
    hint: 'Let it eat to fill it up. Wait a few minutes and it is hungry again - watch the Fed bar.',
    path: ['hunger', 'sugar neurons more sensitive', 'MN9'],
    shows: 'A hungry fly puts its tongue out while the sugar is still a body length away; a full one waits until it is standing in it. The same stimulus, a different answer, because of the state the fly is in.',
    ours: 'Hunger turning up the sugar neurons is the game’s, modelled on what starved flies do. What the circuit makes of it is the connectome’s.',
    measured: 'sugar 30 units away: MN9 about 100 /s starving, 10 /s full; standing on it, both near 130',
  },
  {
    id: 'stuck', title: 'The loop that will not stop',
    ask: 'Poke it - brush its head hard - then take everything away. Does its tongue go back in?',
    hint: 'Click the fly itself. Then wait, with nothing near it, and watch the tongue and the MN9 bar.',
    path: ['a hard brush of the head bristles', 'cells that keep each other firing', 'MN9, on and on'],
    shows: 'This is the model breaking, and it is worth seeing. Push enough of this network past threshold and some cells keep each other going after the push has gone: the tongue command fires on, with nothing to taste, for as long as you care to watch. Real neurons tire - they adapt, their synapses run down - and this model has neither, so nothing in it brings the loop back to rest. A smell does the same to the steering cells.',
    ours: 'The loop is the connectome model’s own. Restarting the brain - every neuron back to rest - is the game’s, and so is spotting it: a readout firing hard for seconds with nothing driving it.',
    measured: 'after one poke: MN9 near 220 /s, still there 90 s later, in every run; the same after Dust',
  },
]

/** One judge per experiment. Each is a small state machine over Moments. */
function makeJudges(): Record<string, Judge> {
  // taste
  let tTouch: number | null = null, tFire: number | null = null, tastePeak = 0, tasteHold = 0
  // meal
  let fed0: number | null = null, hungerAtStart: number | null = null, mealMs = 0
  // escape
  let tLoom: number | null = null, gfPeak = 0, tJump: number | null = null
  // dust
  let dustPeak = 0, groomMs = 0, groomPeak = 0, groomSide: [number, number] = [0, 0], dustFrom = 0
  // sides
  const loomL = new Window(400), loomR = new Window(400)
  let dnL: [number, number] | null = null, dnR: [number, number] | null = null
  const dnAcc = { l: [0, 0] as [number, number], r: [0, 0] as [number, number] }
  // bitter: the tongue command over a visit to sugar with bitter beside it
  let sugarAlone = 0
  const visit = new Window(0)
  // antenna
  let rightTried = 0, antHold = 0, antPeak = 0, antFrom = ''
  // odor
  const odL = new Window(1000), odR = new Window(1000)
  const odAcc = { l: [0, 0] as [number, number], r: [0, 0] as [number, number] }
  let odLeft: [number, number] | null = null, odRight: [number, number] | null = null
  // hunger
  // Measured on the approach, between 18 and 38 units out. Standing in the sugar the
  // tongue command saturates hungry or full (both near 130 /s); it is on the way in that
  // hunger shows. A few hundred ms is all a passing fly gives.
  const hungry = new Window(250), full = new Window(250)
  let hungryMN9: number | null = null, fullMN9: number | null = null, sugarSeen = 0

  const sugarInReach = (m: Moment) => strongest(m, 'sugar').p > 0.3

  return {
    taste: (m, _done, stuck) => {
      // sugar alone: with bitter there too this would record the veto, and the bitter
      // experiment compares against what this one records. And not while the tongue is
      // locked on - that would record the loop, not the taste.
      if (!sugarInReach(m) || m.fly.alt > 2 || strongest(m, 'bitter').p >= 0.1 || stuck?.readout === 'proboscis') {
        tTouch = null; tFire = null; tasteHold = 0; return null
      }
      tTouch ??= m.simMs
      const pro = rate(m, 'proboscis')
      tastePeak = Math.max(tastePeak, pro)
      if (pro > 20) { tFire ??= m.simMs; tasteHold += m.dtMs } else tasteHold = 0
      if (tasteHold < 300) return null
      const lag = Math.max(0, (tFire ?? m.simMs) - tTouch)
      return { readings: [
        { label: 'MN9, the tongue command', value: hz(tastePeak) },
        { label: 'from its feet reaching the sugar', value: lag < 20 ? 'under 20 ms' : `${Math.round(lag)} ms` },
      ] }
    },

    meal: m => {
      fed0 ??= m.fly.fed
      const eating = (m.fly.eating ?? 0) > 0
      if (eating) { hungerAtStart ??= m.fly.hunger; mealMs += m.dtMs }
      if (m.fly.fed <= fed0) return null
      const before = hungerAtStart ?? m.fly.hunger
      return { readings: [
        { label: 'fed', value: `${Math.round((1 - before) * 100)} → ${Math.round((1 - m.fly.hunger) * 100)}` },
        { label: 'time drinking', value: `${(mealMs / 1000).toFixed(1)} s` },
      ], note: 'Its abdomen is rounder now: the crop fills as it drinks.' }
    },

    escape: m => {
      const { p } = strongest(m, 'looming')
      if (p > 0.1) tLoom ??= m.simMs
      else if (p < 0.02 && !m.action.escape && tJump === null) tLoom = null
      if (tLoom !== null) gfPeak = Math.max(gfPeak, rate(m, 'escape'))
      if (m.action.escape && tLoom !== null) tJump ??= m.simMs
      // a moment longer, so the reading is the giant fibre's peak, not the instant it
      // crossed the line that launches the jump
      if (tJump === null || tLoom === null || m.simMs - tJump < 300) return null
      const lag = tJump - tLoom
      return { readings: [
        { label: 'Giant Fibre, at its peak', value: hz(gfPeak) },
        { label: 'from the shadow to the jump', value: lag < 20 ? 'under 20 ms' : `${Math.round(lag)} ms` },
      ], note: lag >= 20
        ? 'Most of that time is the game’s, not the fly’s: firing rates are averaged over 80 ms before anything acts on them. The fibre itself answers in a few milliseconds.'
        : undefined }
    },

    dust: m => {
      dustPeak = Math.max(dustPeak, m.dust)
      const src = strongest(m, 'bristle')
      const g = m.side('groom')
      if (m.action.groom > 0.3 && dustPeak > 0.2) {
        groomMs += m.dtMs
        if (g[0] + g[1] > groomPeak) {
          groomPeak = g[0] + g[1]; groomSide = [g[0], g[1]]
          if (src.s) dustFrom = leanOf(m, src.s)
        }
      }
      if (dustPeak < 0.35 || m.dust > 0.08 || groomMs < 800) return null
      const [l, r] = groomSide
      const lop = Math.max(l, r) > 2.5 * Math.min(l, r) + 3
      const from = Math.abs(dustFrom) > 0.4 ? (dustFrom > 0 ? 'left' : 'right') : null
      const crossed = from && lop ? (from === 'left') === (r > l) : null
      return { readings: [
        { label: 'aDN1, the grooming command', value: hz(groomPeak) },
        { label: 'spent grooming', value: `${(groomMs / 1000).toFixed(1)} s` },
      ], note: !lop
        ? `Both aDN1s fired about equally (${Math.round(l)} /s left, ${Math.round(r)} /s right).`
        : `The ${l > r ? 'left' : 'right'} aDN1 did most of it (${Math.round(l)} /s left, ${Math.round(r)} /s right)` +
          (crossed === null ? '.' : crossed
            ? `, with the pollen coming from its ${from}: the signal crossed over.`
            : `, with the pollen coming from its ${from}: the same side.`) }
    },

    sides: (m, _done, stuck) => {
      // Loose on purpose: the jump carries it away from the shadow within a second,
      // and the brain does not always keep real time, so there is not much to go on.
      const { s, p } = strongest(m, 'looming')
      if (!s || p < 0.15 || stuck?.readout === 'turn_a') return null
      const lean = leanOf(m, s)
      if (Math.abs(lean) < 0.5) return null
      const [l, r] = m.side('turn_a')
      const w = lean > 0 ? loomL : loomR, acc = lean > 0 ? dnAcc.l : dnAcc.r
      acc[0] += l * m.dtMs; acc[1] += r * m.dtMs
      if (w.add(0, m.dtMs)) {
        const mean: [number, number] = [acc[0] / w.t, acc[1] / w.t]
        // only a clear answer counts: one DNa01 well above the other
        if (Math.abs(mean[0] - mean[1]) > 5) { if (lean > 0) dnL = mean; else dnR = mean }
        w.reset(); acc[0] = acc[1] = 0
      }
      if (!dnL || !dnR) return null
      // the side that answers has to change with the side the threat is on
      if (Math.sign(dnL[0] - dnL[1]) === Math.sign(dnR[0] - dnR[1])) return null
      const crossed = dnL[1] > dnL[0]
      return { readings: [
        { label: 'threat on its left: DNa01', value: `left ${Math.round(dnL[0])} · right ${Math.round(dnL[1])}` },
        { label: 'threat on its right: DNa01', value: `left ${Math.round(dnR[0])} · right ${Math.round(dnR[1])}` },
      ], note: crossed
        ? 'Crossed: each threat was answered by the DNa01 on the opposite side.'
        : 'Each threat was answered by the DNa01 on its own side - not what this model usually does.' }
    },

    bitter: (m, done, stuck) => {
      if (stuck?.readout === 'proboscis') { visit.reset(); return null }
      // Vetoed, a fly does not stop to feed: it walks onto the sugar and straight on
      // over it. So the judgement is per visit - from stepping onto the sugar with the
      // bitter there too to stepping off - against this fly's own answer to sugar alone.
      // And in this model the veto is a balance, not a switch: bitter tasted as strongly
      // as the sugar silences the tongue, bitter much fainter only halves it. So only
      // time with the bitter at least 80% as strong as the sugar counts.
      const sugar = strongest(m, 'sugar').p
      const b = strongest(m, 'bitter').p
      const pro = rate(m, 'proboscis')
      const on = sugar >= 0.45 && m.fly.alt <= 2
      if (on && b < 0.1) sugarAlone = Math.max(sugarAlone, pro)
      if (on && b >= 0.8 * sugar) { visit.add(pro, m.dtMs); return null }
      if (visit.t < 400) { visit.reset(); return null }          // no visit, or too brief
      const mean = visit.mean
      visit.reset()
      const ref = sugarAlone > 40 ? sugarAlone
        : done.taste ? parseFloat(done.taste.readings[0].value) : 138
      if (!(mean < 0.5 * ref)) return null
      const alone = sugarAlone > 40 ? hz(sugarAlone)
        : done.taste ? done.taste.readings[0].value : '138 /s (measured headless)'
      return { readings: [
        { label: 'MN9 on sugar alone', value: alone },
        { label: 'MN9 on sugar with bitter', value: hz(mean) },
      ] }
    },

    antenna: m => {
      const { s, p } = strongest(m, 'touch')
      if (!s || p < 0.25) { antHold = 0; return null }
      const lean = leanOf(m, s)
      const g = rate(m, 'groom')
      // pollen already on the head drives grooming as well, so it has to be clean
      const dusty = strongest(m, 'bristle').p > 0.08 || m.dust > 0.05
      if (lean < -0.5 && g < 3 && !dusty) rightTried += m.dtMs
      if (g > 12 && !dusty && m.action.dominant === 'grooming') {
        antHold += m.dtMs
        antPeak = Math.max(antPeak, g)
        antFrom = lean > 0.5 ? 'its left' : lean < -0.5 ? 'its right' : 'in front'
      } else antHold = 0
      if (antHold < 500) return null
      return { readings: [
        { label: 'aDN1, the grooming command', value: hz(antPeak) },
        { label: 'vibration from', value: antFrom },
      ], note: rightTried > 2000
        ? 'From its right it did nothing at all. In this connectome only the left antenna’s Johnston’s organ reaches aDN1 (the right one) - a real asymmetry in the data, or a gap in it.'
        : 'Try it from its right side too. The two antennae do not behave the same in this model.' }
    },

    odor: m => {
      // it adapts to a smell within a couple of seconds, so take what there is
      const { s, p } = strongest(m, 'odor')
      if (!s || p < 0.2) return null
      const lean = leanOf(m, s)
      if (Math.abs(lean) < 0.5) return null
      const [l, r] = m.side('turn_b')
      const w = lean > 0 ? odL : odR, acc = lean > 0 ? odAcc.l : odAcc.r
      acc[0] += l * m.dtMs; acc[1] += r * m.dtMs
      if (w.add(0, m.dtMs)) {
        const mean: [number, number] = [acc[0] / w.t, acc[1] / w.t]
        if (lean > 0) odLeft = mean; else odRight = mean
        w.reset(); acc[0] = acc[1] = 0
      }
      if (!odLeft || !odRight) return null
      const same = Math.sign(odLeft[0] - odLeft[1]) === Math.sign(odRight[0] - odRight[1])
      return { readings: [
        { label: 'geosmin on its left: DNa02', value: `left ${Math.round(odLeft[0])} · right ${Math.round(odLeft[1])}` },
        { label: 'geosmin on its right: DNa02', value: `left ${Math.round(odRight[0])} · right ${Math.round(odRight[1])}` },
      ], note: same
        ? 'The same side won both times. It is not steering by the smell at all.'
        : 'This time the sides came out different - the runaway is noisy. Run it again and compare.' }
    },

    hunger: (m, _done, stuck) => {
      const { s, p } = strongest(m, 'sugar')
      if (stuck?.readout === 'proboscis') { hungry.reset(); full.reset(); return null }
      // The first frames after sugar reaches the feet belong to whatever the tongue was
      // doing before; skip them. Not much more than that: a full fly takes a sip and is
      // done within about half a second, and the sugar goes with it.
      sugarSeen = p > 0.02 ? sugarSeen + m.dtMs : 0
      if (sugarSeen < 150) { hungry.reset(); full.reset(); return null }
      const d = s ? Math.hypot(s.x - m.fly.x, s.y - m.fly.y) : Infinity
      // (drinking counts: sugar is a puddle, and a hungry fly starts on it 30 units out)
      if (d < 18 || d > 38 || m.fly.alt > 2) { hungry.reset(); full.reset(); return null }
      const pro = rate(m, 'proboscis')
      if (m.fly.hunger > 0.7) {
        if (hungry.add(pro, m.dtMs)) { hungryMN9 = Math.max(hungryMN9 ?? 0, hungry.mean); hungry.reset() }
      } else if (m.fly.hunger < 0.3) {
        if (full.add(pro, m.dtMs)) { fullMN9 = fullMN9 === null ? full.mean : Math.min(fullMN9, full.mean); full.reset() }
      }
      if (hungryMN9 === null || fullMN9 === null || hungryMN9 < fullMN9 * 1.5 + 5) return null
      return { readings: [
        { label: 'MN9 coming in hungry', value: hz(hungryMN9) },
        { label: 'MN9 coming in full', value: hz(fullMN9) },
      ] }
    },

    stuck: (m, _done, stuck) => {
      if (!stuck || m.simMs - stuck.since < 3000) return null
      const what = stuck.readout === 'proboscis' ? 'MN9, the tongue' : 'DNa01, steering'
      return { readings: [
        { label: `${what}, with nothing driving it`, value: hz(stuck.rate) },
        { label: 'the last thing to drive it', value: stuck.cause },
      ] }
    },
  }
}

// --- the whole of it -------------------------------------------------------------------

const STORE = 'fly-notebook-v1'

export interface NotebookView {
  done: Record<string, Discovery>
  next: string | null
  /** ms spent on the current experiment, for when to offer its hint */
  onNext: number
}

export class Mind {
  /** 0..1, pollen on the head bristles */
  dust = 0
  /** sugar stimulus id -> 0..1 of its drop still there */
  nectar = new Map<number, number>()
  senses: Sense[] = []
  why = ''
  /** set while a readout is running on its own (see the header) */
  stuck: Stuck | null = null
  private alone = { proboscis: 0, turn_a: 0 }
  private calm = 0
  private cause = { proboscis: 'something it tasted', turn_a: 'a smell' }
  private judges = makeJudges()
  private done: Record<string, Discovery> = {}
  private onNext = 0
  private nextId: string | null = null

  constructor(private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null =
    typeof localStorage === 'undefined' ? null : localStorage) {
    try {
      const raw = this.storage?.getItem(STORE)
      const saved = raw ? JSON.parse(raw) as { done?: Record<string, Discovery> } : null
      if (saved?.done) {
        for (const e of EXPERIMENTS) if (saved.done[e.id]) this.done[e.id] = saved.done[e.id]
      }
    } catch { /* a corrupt or blocked store is an empty notebook, not a crash */ }
    this.nextId = this.pickNext()
  }

  private pickNext() { return EXPERIMENTS.find(e => !this.done[e.id])?.id ?? null }

  /** One tick. Returns a discovery the moment an experiment is completed. */
  step(m: Omit<Moment, 'dust'>): Discovery | null {
    const dt = m.dtMs / 1000
    // Pollen lands faster than a fly can groom it off while Dust is close, comes off
    // while aDN1 has it grooming, and the last few specks drift off on their own.
    let pollen = 0
    for (const s of m.stims) if (s.kind.id === 'bristle') pollen += m.perStim.get(s.id) ?? 0
    this.dust = Math.min(1, Math.max(0,
      this.dust + pollen * dt * 1.2 - m.action.groom * dt * 0.28 - dt * 0.02))

    // Nectar: a drop per sugar, drunk down while the fly is on it.
    for (const s of m.stims) if (s.kind.id === 'sugar' && !this.nectar.has(s.id)) this.nectar.set(s.id, 1)
    for (const id of [...this.nectar.keys()]) if (!m.stims.some(s => s.id === id)) this.nectar.delete(id)
    const meal = (m.fly.eating ?? 0) > 0 && m.touching?.kind.edible ? m.touching.id : null
    if (meal !== null) this.nectar.set(meal, Math.max(0.2, (this.nectar.get(meal) ?? 1) * Math.exp(-dt / 2.4)))

    this.senses = sensesFor(m.stims, m.perStim, m.fly)
    this.watchForLoops(m)
    this.why = this.stuck
      ? `a loop in its brain: ${this.stuck.readout === 'proboscis' ? 'MN9' : 'DNa01'} is firing on its own`
      : explain(m.action.dominant, m.stims, m.perStim, m.fly, m.poked)

    const moment: Moment = { ...m, dust: this.dust }
    this.onNext += m.dtMs
    // Every judge sees every tick, and everything completed is kept: some judges clear
    // their state as they report, so a second discovery on the same tick would be lost
    // for good if it were left for later. They are handed out one at a time.
    let fresh = false
    for (const e of EXPERIMENTS) {
      const r = this.judges[e.id](moment, this.done, this.stuck)
      if (!r || this.done[e.id]) continue
      const d = { id: e.id, at: Math.round(m.simMs / 1000), ...r }
      this.done[e.id] = d
      this.queue.push(d)
      fresh = true
    }
    if (fresh) this.save()
    const next = this.pickNext()
    if (next !== this.nextId) { this.nextId = next; this.onNext = 0 }
    return this.queue.shift() ?? null
  }

  private queue: Discovery[] = []

  get view(): NotebookView { return { done: this.done, next: this.nextId, onNext: this.onNext } }

  /**
   * A readout firing hard for seconds with nothing that drives it anywhere near: the
   * tongue with no taste, no bristle touched and no pollen; steering with no smell and no
   * shadow. The thresholds sit well clear of the foraging drive we add, which reaches
   * neither cell - with nothing placed both read 0.
   */
  private watchForLoops(m: Omit<Moment, 'dust'>) {
    const p = (kind: string) => strongest({ ...m, dust: this.dust }, kind).p
    if (m.poked) this.cause.proboscis = 'a poke'
    else if (p('bristle') > 0.05) this.cause.proboscis = 'Dust on its head'
    else if (this.dust > 0.08) this.cause.proboscis = 'pollen on its head'
    else if (p('sugar') > 0.05) this.cause.proboscis = 'sugar'
    if (p('odor') > 0.05) this.cause.turn_a = 'geosmin'
    else if (p('looming') > 0.05) this.cause.turn_a = 'a looming shadow'
    // (a trace of pollen is not an input that could hold the tongue at 200 /s - and in
    // the loop the fly stops grooming, so a trace can sit on the head a long while)
    const fed = {
      proboscis: m.poked || this.dust > 0.08 || p('bristle') > 0.05 || p('sugar') > 0.05 || p('bitter') > 0.05,
      turn_a: p('odor') > 0.05 || p('looming') > 0.05,
    }
    const hot = { proboscis: 80, turn_a: 15 }
    for (const k of ['proboscis', 'turn_a'] as const) {
      const [l, r] = m.side(k)
      this.alone[k] = !fed[k] && l + r > hot[k] ? this.alone[k] + m.dtMs : 0
      if (!this.stuck && this.alone[k] > 3000) {
        this.stuck = { readout: k, rate: l + r, since: m.simMs - this.alone[k], cause: this.cause[k] }
      }
    }
    if (!this.stuck) return
    const [l, r] = m.side(this.stuck.readout)
    this.stuck.rate = l + r
    // over when it has been down near nothing for a second - a restart, or it let go
    this.calm = l + r < hot[this.stuck.readout] / 3 ? this.calm + m.dtMs : 0
    if (this.calm > 1000) { this.stuck = null; this.calm = 0 }
  }

  /** Start the notebook over; the fly is untouched. */
  forget() {
    this.done = {}
    this.queue = []
    this.stuck = null
    this.judges = makeJudges()
    this.nextId = this.pickNext()
    this.onNext = 0
    try { this.storage?.removeItem(STORE) } catch { /* nothing to undo */ }
  }

  private save() {
    try { this.storage?.setItem(STORE, JSON.stringify({ done: this.done })) } catch { /* full or blocked */ }
  }
}
