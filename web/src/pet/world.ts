// The arena the pet lives in, and how it is drawn.  Canvas 2D; the fly is vector art
// so it can animate its legs, wings and proboscis from the decoded behaviour.

import { damp } from 'maath/easing'
import type { Action } from './motor'
import type { Stim } from './sensors'

export interface Fly {
  x: number; y: number; h: number       // heading, radians
  speed: number
  legPhase: number
  wing: number
  hunger: number                        // 0..1
  startle: number                       // 0..1, decays
  fed: number                           // meals eaten
  eating?: number                       // seconds spent on the current meal

  // --- flight ---
  alt: number                           // height above the ground, world units
  flying: number                        // 0..1, how committed to being airborne
  bank: number                          // roll into a turn, radians
  pitch: number                         // nose attitude, radians
  beat: number                          // wingbeat phase, for the body's bob
  turnRate: number                      // angular velocity, so heading carries momentum
}

export class World {
  // A behaviour chamber, not a field.  Sized so a fly with no way to smell food still
  // runs into a drop of it within a minute or two of wandering - see bake/15_pet_tune.mjs.
  w = 760; h = 490
  fly: Fly = {
    x: 380, y: 245, h: -Math.PI / 2, speed: 0, legPhase: 0, wing: 0,
    hunger: 0.35, startle: 0, fed: 0,
    alt: 0, flying: 0, bank: 0, pitch: 0, beat: 0, turnRate: 0,
  }
  stims: Stim[] = []
  trail: [number, number][] = []
  private nextId = 1

  add(kind: Stim['kind'], x: number, y: number) {
    const s: Stim = { kind, x, y, id: this.nextId++ }
    this.stims.push(s)
    return s
  }
  remove(id: number) { this.stims = this.stims.filter(s => s.id !== id) }

  /**
   * Put the body at rest without touching what it has learned or eaten.
   *
   * Two separate places were resetting the fly field by field - "New fly" and a save
   * restore - and both were written before flight existed, so both left a restored or
   * brand-new fly airborne, banked and still turning. One definition now.
   */
  restBody(f: Fly = this.fly) {
    f.speed = 0; f.legPhase = 0; f.wing = 0; f.eating = 0
    f.alt = 0; f.flying = 0; f.bank = 0; f.pitch = 0; f.beat = 0; f.turnRate = 0
    // maath keeps its spring velocities on the object; leaving them makes a reset fly
    // inherit the motion of the one before it
    delete (f as unknown as { __damp?: unknown }).__damp
  }
  clear() { this.stims = [] }

  step(a: Action, dtMs: number, ate: (s: Stim) => void, touching: Stim | null) {
    const f = this.fly
    const dt = dtMs / 1000
    const onMeal = !!touching && touching.kind.edible && a.proboscis > 0.4 && f.alt < 2

    // --- flight ------------------------------------------------------------
    // The decision to go is the Giant Fibre's: a.escape is the real escape readout.
    // Staying up is ours - the connectome stops at the neck and the flight muscles
    // are thoracic, so nothing in the model can tell us how to hold an altitude.
    // Committing fast and releasing slowly is what makes a startle read as a launch
    // rather than a twitch.
    // Every one of these is maath's damp - Unity's SmoothDamp - rather than the
    // `x += (target - x) * min(1, dt * k)` this file used throughout. That form is
    // frame-rate dependent: it converges in a fixed number of frames, so the same
    // motion takes half as long at 120 fps as at 60. damp converges in a fixed
    // *time*, which is what smoothTime means.
    const wantAir = a.escape ? 1 : 0
    // committing fast and releasing slowly is what makes a startle read as a launch
    damp(f, 'flying', wantAir, wantAir ? 0.07 : 0.55, dt)
    // damp is asymptotic, so this never actually reaches zero and the fly stays
    // fractionally airborne for ever - wings never fully fold, legs never fully
    // resume, and every `flying > 0` check stays alive. Snap the tail off.
    if (wantAir === 0 && f.flying < 0.012) { f.flying = 0; f.turnRate *= 0.5 }

    const CRUISE = 96
    damp(f, 'alt', f.flying * CRUISE, f.flying > f.alt / CRUISE ? 0.13 : 0.34, dt)
    if (f.alt <= 0.01) f.alt = 0

    // Wingbeat. A real fly beats at ~200 Hz, far past what any screen can show, so
    // this is a legible stand-in that drives the body's bob, not a literal rate.
    f.beat += dt * (f.flying > 0.02 ? 34 : 0)

    // Bank into the turn and drop the nose to accelerate - both are how a flying
    // insect reads as flying rather than sliding.
    damp(f, 'bank', Math.max(-0.8, Math.min(0.8, -a.turn * 1.1)) * f.flying, 0.17, dt)

    // Nose up as it settles the last of the way down. A flare is what separates a
    // landing from falling out of the sky, and it is the one bit of the descent an
    // insect visibly does on purpose.
    const settling = f.flying < 0.5 && f.alt > 2
      ? Math.min(1, (0.5 - f.flying) * 2) * Math.min(1, f.alt / 45)
      : 0
    const wantPitch = f.flying * (-0.22 - Math.min(0.3, f.speed / 420)) + settling * 0.55
    damp(f, 'pitch', wantPitch, 0.22, dt)

    // Heading carries momentum. Applying the commanded turn rate straight to the
    // heading made flight turns unnaturally crisp - a body with mass cannot start and
    // stop rotating instantly, and in the air there is no foot friction to do it. The
    // lag is small on the ground, where legs really can stop a turn dead.
    const cmdTurn = onMeal ? 0 : a.turn * (1 + f.flying * 0.9)
    damp(f, 'turnRate', cmdTurn, 0.04 + f.flying * 0.26, dt)
    f.h += f.turnRate * dt
    const target = a.escape ? a.escapeSpeed : onMeal ? 0 : a.forward
    damp(f, 'speed', target, 0.17, dt)
    f.x += Math.cos(f.h) * f.speed * dt
    f.y += Math.sin(f.h) * f.speed * dt

    // A banked turn slips sideways. Flight that tracks its heading exactly reads as
    // being on rails; the slip is what makes a turn feel like it costs something.
    if (f.flying > 0.01) {
      const slip = f.bank * f.flying * 30
      f.x += Math.cos(f.h + Math.PI / 2) * slip * dt
      f.y += Math.sin(f.h + Math.PI / 2) * slip * dt
    }

    const m = 26
    if (f.x < m) { f.x = m; f.h = Math.PI - f.h }
    if (f.x > this.w - m) { f.x = this.w - m; f.h = Math.PI - f.h }
    if (f.y < m) { f.y = m; f.h = -f.h }
    if (f.y > this.h - m) { f.y = this.h - m; f.h = -f.h }

    // Legs only cycle on the ground. They used to keep striding in mid-air.
    f.legPhase += Math.min(Math.abs(f.speed), 200) * dt * 0.09 * (1 - f.flying)
    // wings snap open on takeoff and fold back over ~0.3 s.  This was two statements,
    // the first of which parsed as `a.escape ? 1 : (0 - f.wing)` rather than the
    // intended `(a.escape ? 1 : 0) - f.wing`, and was then overwritten by the second.
    // Wings stay out for as long as it is actually airborne, not just while the Giant
    // Fibre is firing - it fires for a moment, the flight lasts seconds.
    f.wing = Math.max(0, Math.min(1, Math.max(a.escape ? 1 : 0, f.flying)))
    f.startle = Math.max(0, f.startle - dt * 0.45) + (a.escape ? dt * 3 : 0)
    f.startle = Math.min(1, f.startle)
    f.hunger = Math.min(1, f.hunger + dt * 0.0035)   // ~5 minutes from full to starving

    if (onMeal) {
      f.hunger = Math.max(0, f.hunger - dt * 0.22)
      f.eating = Math.min(1, (f.eating ?? 0) + dt * 2)
      if (f.hunger <= 0.02 || (f.eating > 1 && Math.random() < dt * 0.5)) {
        f.fed++; f.eating = 0; ate(touching)
      }
    } else {
      f.eating = Math.max(0, (f.eating ?? 0) - dt)
    }

    if (this.trail.length === 0 || Math.hypot(f.x - this.trail[this.trail.length - 1][0],
      f.y - this.trail[this.trail.length - 1][1]) > 5) {
      this.trail.push([f.x, f.y])
      if (this.trail.length > 260) this.trail.shift()
    }
  }
}

