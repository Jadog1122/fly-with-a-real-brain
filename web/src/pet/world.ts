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
  vAlt: number                          // vertical velocity
  flying: number                        // 0..1, how committed to being airborne
  bank: number                          // roll into a turn, radians
  pitch: number                         // nose attitude, radians
  beat: number                          // wingbeat phase, for the body's bob
}

export class World {
  // A behaviour chamber, not a field.  Sized so a fly with no way to smell food still
  // runs into a drop of it within a minute or two of wandering - see bake/15_pet_tune.mjs.
  w = 760; h = 490
  fly: Fly = {
    x: 380, y: 245, h: -Math.PI / 2, speed: 0, legPhase: 0, wing: 0,
    hunger: 0.35, startle: 0, fed: 0,
    alt: 0, vAlt: 0, flying: 0, bank: 0, pitch: 0, beat: 0,
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

    const CRUISE = 96
    damp(f, 'alt', f.flying * CRUISE, f.flying > f.alt / CRUISE ? 0.13 : 0.34, dt)
    if (f.alt <= 0.01) f.alt = 0

    // Wingbeat. A real fly beats at ~200 Hz, far past what any screen can show, so
    // this is a legible stand-in that drives the body's bob, not a literal rate.
    f.beat += dt * (f.flying > 0.02 ? 34 : 0)

    // Bank into the turn and drop the nose to accelerate - both are how a flying
    // insect reads as flying rather than sliding.
    damp(f, 'bank', Math.max(-0.8, Math.min(0.8, -a.turn * 1.1)) * f.flying, 0.17, dt)
    damp(f, 'pitch', f.flying * (-0.22 - Math.min(0.3, f.speed / 420)), 0.22, dt)

    // Airborne it turns faster and carries more speed; on the ground nothing changes.
    f.h += (onMeal ? 0 : a.turn * (1 + f.flying * 0.9)) * dt
    const target = a.escape ? a.escapeSpeed : onMeal ? 0 : a.forward
    damp(f, 'speed', target, 0.17, dt)
    f.x += Math.cos(f.h) * f.speed * dt
    f.y += Math.sin(f.h) * f.speed * dt

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

export function draw(ctx: CanvasRenderingContext2D, world: World, a: Action,
                     intens: Map<number, number>, scale: number) {
  const { w, h } = world
  ctx.save()
  ctx.scale(scale, scale)
  ctx.clearRect(0, 0, w, h)

  // floor: the same glass the panels are made of, seen from above
  const bg = ctx.createRadialGradient(w / 2, h * .35, 40, w / 2, h / 2, Math.max(w, h) * .8)
  bg.addColorStop(0, '#0f1a2a'); bg.addColorStop(1, '#04070e')
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h)

  ctx.strokeStyle = 'rgba(75,205,255,.05)'; ctx.lineWidth = 1
  for (let x = 40; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke() }
  for (let y = 40; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke() }
  ctx.strokeStyle = 'rgba(75,205,255,.11)'; ctx.lineWidth = 1
  for (let x = 200; x < w; x += 200) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke() }
  for (let y = 200; y < h; y += 200) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke() }

  // arena rim, with the same corner ticks the panels carry
  ctx.strokeStyle = 'rgba(129,223,255,.30)'; ctx.lineWidth = 1.5
  ctx.strokeRect(1, 1, w - 2, h - 2)
  ctx.strokeStyle = 'rgba(75,205,255,.9)'; ctx.lineWidth = 2.5
  const T = 26
  for (const [cx, cy, dx, dy] of [[1, 1, 1, 1], [w - 1, 1, -1, 1], [1, h - 1, 1, -1], [w - 1, h - 1, -1, -1]]) {
    ctx.beginPath()
    ctx.moveTo(cx + dx * T, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + dy * T)
    ctx.stroke()
  }

  // trail
  if (world.trail.length > 1) {
    ctx.beginPath()
    ctx.moveTo(world.trail[0][0], world.trail[0][1])
    for (const [x, y] of world.trail) ctx.lineTo(x, y)
    ctx.strokeStyle = 'rgba(75,205,255,.17)'; ctx.lineWidth = 1.5; ctx.stroke()
  }

  // stimuli, with their field of influence
  for (const s of world.stims) {
    const k = s.kind
    const it = intens.get(s.id) ?? 0
    const rg = ctx.createRadialGradient(s.x, s.y, 2, s.x, s.y, k.range)
    rg.addColorStop(0, k.colour + '3d'); rg.addColorStop(.55, k.colour + '14')
    rg.addColorStop(1, k.colour + '00')
    ctx.fillStyle = rg
    ctx.beginPath(); ctx.arc(s.x, s.y, k.range, 0, 7); ctx.fill()
    // field edge, brighter while the fly is actually inside it
    ctx.strokeStyle = k.colour + (it > .05 ? '66' : '22')
    ctx.lineWidth = 1; ctx.setLineDash([5, 7])
    ctx.beginPath(); ctx.arc(s.x, s.y, k.range, 0, 7); ctx.stroke()
    ctx.setLineDash([])
    // the token itself, as a crystal facet
    const r = 13 + it * 4
    ctx.beginPath()
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2
      ctx[i ? 'lineTo' : 'moveTo'](s.x + Math.cos(a) * r, s.y + Math.sin(a) * r)
    }
    ctx.closePath()
    ctx.fillStyle = k.colour + 'e6'; ctx.fill()
    ctx.strokeStyle = '#ffffff66'; ctx.lineWidth = 1; ctx.stroke()
    ctx.font = '15px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(k.emoji, s.x, s.y + 1)
  }

  drawFly(ctx, world.fly, a)
  ctx.restore()
}

function drawFly(ctx: CanvasRenderingContext2D, f: Fly, a: Action) {
  ctx.save()
  ctx.translate(f.x, f.y)
  ctx.rotate(f.h + Math.PI / 2)      // art points "up"; heading 0 is +x
  const S = 1.95            // the pet is the subject; at 1.25 it was a speck
  ctx.scale(S, S)

  if (a.escape) {
    ctx.beginPath(); ctx.arc(0, 0, 30, 0, 7)
    ctx.fillStyle = 'rgba(255,65,102,.18)'; ctx.fill()
    ctx.strokeStyle = 'rgba(255,65,102,.5)'; ctx.lineWidth = 1; ctx.stroke()
  }

  // legs
  ctx.strokeStyle = '#0e1524'; ctx.lineWidth = 2.1; ctx.lineCap = 'round'
  for (let s = -1; s <= 1; s += 2) {
    for (let i = 0; i < 3; i++) {
      const base = [-3, 1, 5][i]
      const sw = Math.sin(f.legPhase + i * 2.1 + (s > 0 ? Math.PI : 0)) * 4
      const groom = a.groom > 0.3 && i === 0 ? Math.sin(f.legPhase * 3) * 5 : 0
      ctx.beginPath()
      ctx.moveTo(s * 4, base)
      ctx.quadraticCurveTo(s * 12, base + sw - 2, s * (15 - groom), base + sw + 6 - groom * 2)
      ctx.stroke()
    }
  }

  // wings
  ctx.save()
  const spread = 0.35 + f.wing * 0.55
  for (const s of [-1, 1]) {
    ctx.beginPath()
    ctx.ellipse(s * 5, 3, 4.6, 12.5, s * spread, 0, 7)
    ctx.fillStyle = `rgba(190,220,255,${0.18 + f.wing * 0.22})`; ctx.fill()
    ctx.strokeStyle = 'rgba(190,220,255,.30)'; ctx.lineWidth = 0.7; ctx.stroke()
  }
  ctx.restore()

  // abdomen, thorax, head
  ctx.fillStyle = '#2c3550'
  ctx.beginPath(); ctx.ellipse(0, 9.5, 5.4, 9.5, 0, 0, 7); ctx.fill()
  ctx.fillStyle = '#3b4668'
  ctx.beginPath(); ctx.ellipse(0, 0, 5.9, 7.2, 0, 0, 7); ctx.fill()
  ctx.fillStyle = '#49567e'
  ctx.beginPath(); ctx.ellipse(0, -8.5, 5.2, 4.8, 0, 0, 7); ctx.fill()

  // eyes - redder when startled
  const eye = `rgb(${190 + f.startle * 60},${60 - f.startle * 30},${70 - f.startle * 30})`
  for (const s of [-1, 1]) {
    ctx.beginPath(); ctx.ellipse(s * 3.5, -9, 2.5, 3.1, s * 0.3, 0, 7)
    ctx.fillStyle = eye; ctx.fill()
  }
  // antennae
  ctx.strokeStyle = '#1b2338'; ctx.lineWidth = 1.4
  for (const s of [-1, 1]) {
    ctx.beginPath(); ctx.moveTo(s * 1.8, -11.5); ctx.lineTo(s * 3.4, -15.5); ctx.stroke()
  }
  // proboscis
  if (a.proboscis > 0.03) {
    const L = 3 + a.proboscis * 8
    ctx.strokeStyle = '#e8a24d'; ctx.lineWidth = 2.6; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(0, -11 - L); ctx.stroke()
    ctx.beginPath(); ctx.arc(0, -11 - L, 1.7, 0, 7); ctx.fillStyle = '#f2bc6e'; ctx.fill()
  }
  ctx.restore()
}
