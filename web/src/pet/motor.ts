// Descending-neuron firing rates -> what the fly does.
//
// There is no ventral nerve cord in this connectome: descending axons leave the brain
// and stop.  So this is a *decoder*, not a simulation of movement - the same move the
// Shiu et al. paper makes when it reads behaviour off descending neuron rates.  The
// naming comes from the upstream notebook (P9 = forward velocity, DNa01/DNa02 =
// turning, MDN = backward, Giant Fiber = escape, MN9 = proboscis, aDN1 = grooming).
//
// Turning sign is a choice, and worth stating.  DNa02 is reported to drive *ipsilateral*
// turning, and in this connectome a stimulus on one side drives that side's DNa01/DNa02
// (measured: looming on the left gives DNa01_left 22 spikes, DNa01_right 0).  Taken
// together those two facts predict a fly that steers *into* a looming shadow or a bad
// smell, which is not what flies do.  Rather than quietly picking signs until the
// behaviour looked right, the pet turns away from the side that is firing harder, and
// says so here: the laterality is the model's, the sign convention is ours.

export type Rates = Record<string, [number, number]>   // id -> [left Hz, right Hz]

export interface Action {
  forward: number      // arena units per second
  turn: number         // radians per second, positive = to the fly's left
  escape: boolean
  escapeSpeed: number  // arena units per second while fleeing
  proboscis: number    // 0..1 extension
  groom: number        // 0..1
  dominant: string
}

const TH = { escape: 12, proboscis: 4, groom: 4, walking: 24, steering: 9 }
// Tuned against bake/15_pet_tune.mjs so the fly crosses its arena a couple of times a
// minute rather than a dozen.
const K = { forward: 0.42, backward: 0.38, turn: 0.010, escapeSpeed: 130 }

/** Low-pass every readout so a single spike does not jerk the fly. */
export class MotorDecoder {
  private s: Record<string, [number, number]> = {}
  escapeLatch = 0

  update(r: Rates, dtMs: number): Action {
    const a = 1 - Math.exp(-dtMs / 25)   // the worker already smoothed over 80 sim-ms
    for (const k in r) {
      if (!this.s[k]) this.s[k] = [0, 0]
      this.s[k][0] += (r[k][0] - this.s[k][0]) * a
      this.s[k][1] += (r[k][1] - this.s[k][1]) * a
    }
    const g = (k: string) => this.s[k] ?? [0, 0]
    const sum = (k: string) => g(k)[0] + g(k)[1]

    const fwd = sum('forward'), back = sum('backward')
    const turnL = g('turn_a')[0] + g('turn_b')[0]
    const turnR = g('turn_a')[1] + g('turn_b')[1]
    const esc = sum('escape'), pro = sum('proboscis'), grm = sum('groom')

    if (esc > TH.escape) this.escapeLatch = 420          // ms of takeoff
    this.escapeLatch = Math.max(0, this.escapeLatch - dtMs)

    const dominant =
      this.escapeLatch > 0 ? 'escape'
        : grm > TH.groom ? 'grooming'
          : pro > TH.proboscis ? 'feeding'
            : back > fwd && back > TH.walking ? 'backing up'
              : fwd > TH.walking ? 'walking'
                : Math.abs(turnL - turnR) > TH.steering ? 'turning' : 'idle'

    // Fleeing and grooming stop locomotion.  Feeding does NOT belong here: the
    // proboscis extends as soon as sugar is within range of the receptors, which is
    // further away than the fly can actually reach it - stopping on that signal froze
    // it just short of the food.  The world stops it once it is really on the meal.
    const busy = this.escapeLatch > 0 || grm > TH.groom
    return {
      forward: busy ? 0 : K.forward * fwd - K.backward * back,
      turn: busy ? 0 : K.turn * (turnL - turnR),
      escape: this.escapeLatch > 0,
      escapeSpeed: K.escapeSpeed,
      proboscis: Math.min(1, pro / (TH.proboscis * 3)),
      groom: Math.min(1, grm / (TH.groom * 3)),
      dominant,
    }
  }

  rate(id: string) { const v = this.s[id]; return v ? v[0] + v[1] : 0 }
}
