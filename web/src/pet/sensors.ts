// Stimulus objects in the arena -> Poisson drive on the fly's sensory neurons.
//
// Two things make the pet behave rather than just twitch: intensity falls off with
// distance, and the left and right halves of each sensory population are driven
// separately according to which side the stimulus is on.  The asymmetry propagates
// through the real connectome to the left/right steering neurons.

export interface SensorGroup {
  id: string; label: string; modality: string; rate_hz: number; note: string
  cell_types: string[]; n: number
  sides: { left: number[]; right: number[]; other: number[] }
}

export interface StimKind {
  id: string
  label: string
  emoji: string
  colour: string
  range: number        // arena units at which drive has fallen to 1/e
  contact: boolean     // taste: only fires on contact
  edible: boolean
  blurb: string
  tag: string          // three or four words for the command card; blurb is the tooltip
  /**
   * Which sensory populations this stimulus reaches, and over what fraction of its
   * range.  Sugar drives two: the fly's feet meet it first (tarsal taste, wider) and
   * the labellum only once it is standing on it.
   */
  channels: { group: string; rangeMul: number }[]
  artifact?: boolean   // shown in the UI as a known failure mode of the model
}

export const STIMULI: StimKind[] = [
  // taste is contact chemoreception, but a drop is a puddle rather than a point: too
  // small a patch and a fly with no way to smell food never finds it by wandering
  { id: 'sugar', label: 'Sugar', emoji: '🍬', colour: '#ffc24d', range: 56, contact: true, edible: true,
    blurb: 'Feet taste it first, then the mouthparts. Tongue comes out.',
    tag: 'feet first, then tongue',
    channels: [{ group: 'foot', rangeMul: 1.0 }, { group: 'sugar', rangeMul: 0.66 }] },
  { id: 'bitter', label: 'Bitter', emoji: '☠️', colour: '#8f7dd8', range: 56, contact: true, edible: false,
    blurb: 'Also contact. Aversive - it suppresses feeding.',
    tag: 'aversive, blocks feeding',
    channels: [{ group: 'bitter', rangeMul: 1.0 }] },
  { id: 'looming', label: 'Looming', emoji: '🛸', colour: '#ff5f7a', range: 150, contact: false, edible: false,
    blurb: 'A shadow growing overhead. LC4 -> Giant Fiber -> jump.',
    tag: 'LC4 → Giant Fiber → jump',
    channels: [{ group: 'looming', rangeMul: 1.0 }] },
  { id: 'bristle', label: 'Dust', emoji: '✨', colour: '#c8b3ff', range: 80, contact: false, edible: false,
    blurb: 'Specks landing on the body. 1,417 bristles -> the strongest grooming signal in the model.',
    tag: '1,417 bristles → grooming',
    channels: [{ group: 'bristle', rangeMul: 1.0 }] },
  { id: 'touch', label: 'Vibration', emoji: '〰️', colour: '#7ac8ff', range: 90, contact: false, edible: false,
    blurb: "Air movement on the antennae. Johnston's organ -> grooming.",
    tag: "Johnston's organ → grooming",
    channels: [{ group: 'touch', rangeMul: 1.0 }] },
  { id: 'odor', label: 'Geosmin', emoji: '🍄', colour: '#5fd68a', range: 200, contact: false, edible: false,
    blurb: 'A known artifact, kept on purpose: any smell tips this model into a whole-brain runaway whose fixed output is steering. The turn is not a smell response.',
    artifact: true,
    tag: 'known model artifact',
    channels: [{ group: 'odor', rangeMul: 1.0 }] },
]

export interface Stim {
  kind: StimKind; x: number; y: number; id: number
  /** Sensory adaptation, 1 = fresh.  Sustained stimuli fade; removed ones recover. */
  adapt?: number
}

// A stimulus that never fades leaves the fly fleeing, or grooming, forever.  Real
// sensory neurons adapt, so exposure drives this down and absence brings it back.
// Taste keeps a high floor - a fly does not stop tasting sugar halfway through a meal.
// A stimulus that never fades leaves the fly fleeing, or grooming, forever.  Real
// sensory neurons adapt, so exposure drives this down and absence brings it back.
// 0.18 is tuned on the looming response: a constant shadow drops from escaping 100%
// of the time to 55%.  Raising it to 0.28 pushed that back to 97%.
const ADAPT = {
  floorPhasic: 0.18, floorTaste: 0.72,
  tauFallMs: 2200, tauRiseMs: 5000,
}

/** Signed bearing of (x,y) relative to a fly at (fx,fy) heading `h`; +ve is to its left. */
export function bearing(fx: number, fy: number, h: number, x: number, y: number) {
  let a = Math.atan2(y - fy, x - fx) - h
  while (a > Math.PI) a -= 2 * Math.PI
  while (a < -Math.PI) a += 2 * Math.PI
  return a
}

export interface DriveResult {
  rates: Map<number, number>
  perStim: Map<number, number>          // stimulus id -> intensity 0..1, for the UI
  touching: Stim | null
}

/**
 * Build the Poisson drive for the current arena.  `gain` scales every sensor (the pet's
 * hunger raises sugar sensitivity, which is a real effect in starved flies).
 */
export function computeDrive(
  stims: Stim[], fx: number, fy: number, heading: number,
  groups: Map<string, SensorGroup>, gain: (id: string) => number, dtMs = 0,
): DriveResult {
  const rates = new Map<number, number>()
  const perStim = new Map<number, number>()
  let touching: Stim | null = null
  // several stimuli of one kind add up on the same neurons
  const add = (idx: number[], hz: number) => {
    for (const i of idx) rates.set(i, (rates.get(i) ?? 0) + hz)
  }

  for (const s of stims) {
    const d = Math.hypot(s.x - fx, s.y - fy)
    const raw = s.kind.contact
      ? (d < s.kind.range ? 1 - d / s.kind.range : 0)
      : Math.exp(-d / s.kind.range)

    const floor = s.kind.contact ? ADAPT.floorTaste : ADAPT.floorPhasic
    if (s.adapt === undefined) s.adapt = 1
    if (dtMs > 0) {
      const exposed = raw > 0.12
      const tau = exposed ? ADAPT.tauFallMs : ADAPT.tauRiseMs
      const target = exposed ? floor : 1
      s.adapt += (target - s.adapt) * (1 - Math.exp(-dtMs / tau))
    }

    const intensity = raw * s.adapt * gain(s.kind.id)
    if (intensity < 0.01) continue
    if (s.kind.contact && d < s.kind.range * 0.62) touching = s
    perStim.set(s.id, Math.min(1, intensity))

    // Laterality: +1 when the stimulus is on the fly's left, -1 on its right, flat for
    // contact chemoreception.  Screen y grows downward, so a heading of -pi/2 points up
    // the screen and something to the fly's left sits at bearing -pi/2, i.e. sin(b) is
    // -1 there - hence the negation.  Getting this backwards drove the left stimulus
    // into the right antenna and was invisible because the turn sign cancelled it.
    const b = bearing(fx, fy, heading, s.x, s.y)
    const lean = s.kind.contact ? 0 : -Math.sin(b)
    const lg = Math.max(0, 0.5 + 0.5 * lean)
    const rg = Math.max(0, 0.5 - 0.5 * lean)

    for (const ch of s.kind.channels) {
      const g = groups.get(ch.group)
      if (!g) continue
      // a narrower channel needs the fly closer before it responds at all
      const reach = ch.rangeMul >= 1 ? intensity
        : Math.max(0, (raw - (1 - ch.rangeMul)) / ch.rangeMul) * s.adapt * gain(s.kind.id)
      if (reach < 0.01) continue
      const base = g.rate_hz * Math.min(reach, 1)
      add(g.sides.left, base * 2 * lg)
      add(g.sides.right, base * 2 * rg)
      add(g.sides.other, base)
    }
  }
  for (const [i, hz] of rates) rates.set(i, Math.min(hz, 400))   // keep drive sane
  return { rates, perStim, touching }
}


/**
 * Drive that does not come from the arena.
 *
 * Nothing in the connectome makes a fly walk about on its own: P9 and DNa02 are command
 * neurons, and no sensory stimulus we can place drives them much.  A real fly forages,
 * and a hungry one forages harder, so the pet gets an explicit foraging drive on those
 * same neurons.  It is Poisson input on real neurons, exactly like a stimulus - but it
 * is *added by us*, not produced by the model, and the UI says so.
 *
 * `bout`    slow envelope in [0,1]: flies walk in bouts separated by pauses.
 * `wander`  slow heading bias in [-1,1], for gentle meandering.
 * `saccade` brief signed kick in [-1,1].  Walking flies turn saccadically - straight
 *           runs broken by fast body turns - and without it the pet drifts along long
 *           arcs.  Measured over 6 two-minute runs with food 200 units away, this
 *           tightened how close the fly got (median closest approach 99 -> 70 units,
 *           within 100 units in 5 runs of 6 instead of 3).  It did NOT measurably
 *           change how often it actually found the food: 2 runs in 6 either way, and
 *           6 trials cannot separate those.
 */
export function foragingDrive(
  hunger: number, wander: number, bout: number, saccade: number,
  forward: number[], steerL: number[], steerR: number[],
): Map<number, number> {
  const out = new Map<number, number>()
  const walk = (14 + hunger * 46) * bout
  for (const i of forward) out.set(i, walk)
  const lean = 26 * wander + 120 * saccade
  for (const i of steerL) out.set(i, Math.max(0, 22 + lean))
  for (const i of steerR) out.set(i, Math.max(0, 22 - lean))
  return out
}

/** Saccade generator: mostly silent, with a short strong turn every few seconds. */
export class Saccades {
  private until = 0
  private dir = 1
  private next = 1200 + Math.random() * 2200
  private t = 0
  step(dtMs: number): number {
    this.t += dtMs
    if (this.t > this.next) {
      this.t = 0
      this.next = 1100 + Math.random() * 2400
      this.dir = Math.random() < 0.5 ? -1 : 1
      this.until = 180 + Math.random() * 120
    }
    if (this.until > 0) { this.until -= dtMs; return this.dir }
    return 0
  }
}
