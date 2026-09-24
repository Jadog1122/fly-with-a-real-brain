// The mind view: what the fly is sensing and what its brain is telling its body, drawn
// in the world where it happens. mind.ts decides what there is to show; this draws it.
//
//   threads   a stimulus reaching a sense organ: from the thing to the organ it drives,
//             on the side it drives, pulses running inward faster the harder it drives.
//             Drawn through the scenery on purpose - it is the fly's input, not an
//             object in the meadow.
//   organs    a glow on each organ being driven.
//   intent    where the walking and steering commands (P9, DNa01, DNa02, MDN) would
//             carry it over the next two seconds, laid on the ground ahead of it. It is
//             the decoded command, not a plan: nothing in the model looks ahead.
//   nectar    a drop at each sugar, drunk down while it feeds.
//   pollen    specks groomed off the head, falling.

import * as THREE from 'three'
import { STIMULI, type Stim } from './sensors'
import type { Action } from './motor'
import type { Fly } from './world'
import type { Fly3D } from './fly3d'
import type { Mind } from './mind'

const COLOUR = new Map(STIMULI.map(k => [k.id, new THREE.Color(k.colour)]))
const SAMPLES = 28

const RIBBON_VERT = /* glsl */`
  attribute vec2 aT;
  varying vec2 vT;
  void main() {
    vT = aT;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`

const THREAD_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uTime, uSpeed, uAlpha;
  varying vec2 vT;   // x: 0 at the stimulus .. 1 at the organ; y: -1..1 across
  void main() {
    float across = 1.0 - vT.y * vT.y;
    // packets of drive running inward, like spikes down an axon
    float packet = pow(max(0.0, sin((vT.x * 6.0 - uTime * uSpeed) * 6.2832)), 10.0);
    float ends = smoothstep(0.0, 0.06, vT.x) * smoothstep(1.0, 0.94, vT.x);
    float a = (0.3 * across + 1.4 * packet * across * across) * ends * uAlpha;
    gl_FragColor = vec4(uColor * (1.0 + packet), a);
    #include <colorspace_fragment>
  }`

const ARC_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uTime, uAlpha;
  varying vec2 vT;   // x: metres along the path, normalised; y: -1..1 across
  void main() {
    // chevrons travelling forward along the path
    float c = fract(vT.x * 5.0 - abs(vT.y) * 0.35 - uTime * 0.9);
    float chevron = smoothstep(0.0, 0.08, c) * smoothstep(0.34, 0.24, c);
    float edge = smoothstep(1.0, 0.7, abs(vT.y));
    float fade = smoothstep(0.0, 0.08, vT.x) * (1.0 - smoothstep(0.55, 1.0, vT.x));
    float a = (0.16 + 0.9 * chevron) * edge * fade * uAlpha;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }`

/** A camera-facing (or ground-lying) strip whose centreline is rewritten every frame. */
class Ribbon {
  readonly mesh: THREE.Mesh
  readonly mat: THREE.ShaderMaterial
  private pos: THREE.BufferAttribute
  alpha = 0          // eased toward the target so threads fade rather than pop

  constructor(frag: string, uniforms: Record<string, THREE.IUniform>) {
    const g = new THREE.BufferGeometry()
    this.pos = new THREE.BufferAttribute(new Float32Array(SAMPLES * 2 * 3), 3)
    this.pos.setUsage(THREE.DynamicDrawUsage)
    const t = new Float32Array(SAMPLES * 2 * 2)
    const idx: number[] = []
    for (let i = 0; i < SAMPLES; i++) {
      t.set([i / (SAMPLES - 1), -1, i / (SAMPLES - 1), 1], i * 4)
      if (i < SAMPLES - 1) {
        const a = i * 2
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    }
    g.setAttribute('position', this.pos)
    g.setAttribute('aT', new THREE.BufferAttribute(t, 2))
    g.setIndex(idx)
    this.mat = new THREE.ShaderMaterial({
      vertexShader: RIBBON_VERT, fragmentShader: frag, uniforms,
      transparent: true, depthWrite: false, depthTest: false, toneMapped: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    })
    this.mesh = new THREE.Mesh(g, this.mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 40
  }

  /** Lay the strip along `pts`, `width(u)` wide, facing `eye` (or flat, if eye is null). */
  set(pts: THREE.Vector3[], width: (u: number) => number, eye: THREE.Vector3 | null) {
    const a = this.pos.array as Float32Array
    const tan = new THREE.Vector3(), side = new THREE.Vector3(), view = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0)
    for (let i = 0; i < SAMPLES; i++) {
      const p = pts[i]
      tan.subVectors(pts[Math.min(i + 1, SAMPLES - 1)], pts[Math.max(i - 1, 0)]).normalize()
      if (eye) side.crossVectors(tan, view.subVectors(eye, p)).normalize()
      else side.crossVectors(up, tan).normalize()
      const w = width(i / (SAMPLES - 1)) / 2
      a[i * 6 + 0] = p.x - side.x * w; a[i * 6 + 1] = p.y - side.y * w; a[i * 6 + 2] = p.z - side.z * w
      a[i * 6 + 3] = p.x + side.x * w; a[i * 6 + 4] = p.y + side.y * w; a[i * 6 + 5] = p.z + side.z * w
    }
    this.pos.needsUpdate = true
  }
}

function glowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  r.addColorStop(0, 'rgba(255,255,255,1)')
  r.addColorStop(0.25, 'rgba(255,255,255,.55)')
  r.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = r
  g.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}

interface Speck { v: THREE.Vector3; p: THREE.Vector3; life: number }

export class MindView {
  readonly group = new THREE.Group()
  private threads = new Map<string, Ribbon>()
  private spare: Ribbon[] = []
  private glows: THREE.Sprite[] = []
  private glowTex = glowTexture()
  private arc: Ribbon
  private drops = new Map<number, THREE.Mesh>()
  private dropGeo = new THREE.SphereGeometry(1, 20, 12)
  private dropMat = new THREE.MeshStandardMaterial({
    color: 0xffae2e, roughness: 0.06, metalness: 0, emissive: 0x5a3000,
    transparent: true, opacity: 0.88,
  })
  private specks: Speck[] = []
  private speckMesh: THREE.InstancedMesh
  private time = 0
  private shown = true
  private bez: THREE.Vector3[] = Array.from({ length: SAMPLES }, () => new THREE.Vector3())
  private a = new THREE.Vector3()
  private b = new THREE.Vector3()
  private c = new THREE.Vector3()
  private m4 = new THREE.Matrix4()

  /**
   * `overlay` is drawn after the finished frame (threads, glows, the intent arc);
   * `world` is the lit scene, for what is really there - the nectar and the pollen.
   */
  constructor(overlay: THREE.Scene, private world: THREE.Scene, private camera: THREE.Camera,
              private fly3d: Fly3D, private tokenAt: (id: number, out: THREE.Vector3) => boolean) {
    this.arc = new Ribbon(ARC_FRAG, {
      uColor: { value: new THREE.Color(0xffe9c4) }, uTime: { value: 0 }, uAlpha: { value: 0 },
    })
    this.group.add(this.arc.mesh)
    this.speckMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshStandardMaterial({ color: 0xf0d27a, roughness: 0.55, emissive: 0x3a2a08 }), 64)
    this.speckMesh.frustumCulled = false
    this.speckMesh.count = 0
    overlay.add(this.group)
    world.add(this.speckMesh)
  }

  setVisible(on: boolean) {
    this.shown = on
    this.group.visible = on
  }

  update(dt: number, mind: Mind, action: Action, fly: Fly, stims: Stim[]) {
    this.time += dt
    this.updateDrops(dt, mind, stims)
    this.updateSpecks(dt)
    if (!this.shown) return
    this.updateThreads(dt, mind)
    this.updateArc(dt, action, fly)
  }

  // --- threads and organ glows ------------------------------------------------------------

  private updateThreads(dt: number, mind: Mind) {
    const eye = this.camera.position
    const live = new Set<string>()
    let g = 0
    // one glow per organ and side, at the strongest drive reaching it
    const organs = new Map<string, { w: number; kind: string }>()
    for (const s of mind.senses) {
      const key = `${s.stim}:${s.organ}:${s.side}`
      live.add(key)
      const ok = this.fly3d.organ(s.organ, s.side === 'mid' ? 'left' : s.side, this.b)
      if (!ok || !this.tokenAt(s.stim, this.a)) continue
      // sugar is tasted where the drop is, on the ground, not at the flower's head
      if (s.kind === 'sugar') this.a.y = 2
      let r = this.threads.get(key)
      if (!r) {
        r = this.spare.pop() ?? new Ribbon(THREAD_FRAG, {
          uColor: { value: new THREE.Color() }, uTime: { value: 0 },
          uSpeed: { value: 1 }, uAlpha: { value: 0 },
        })
        r.alpha = 0
        this.threads.set(key, r)
        this.group.add(r.mesh)
      }
      r.alpha += (1 - r.alpha) * (1 - Math.exp(-dt * 6))
      this.curve(this.a, this.b)
      const w = 2.4 + 6 * s.weight
      r.set(this.bez, u => w * (1 - 0.6 * u), eye)
      r.mat.uniforms.uColor.value.copy(COLOUR.get(s.kind) ?? new THREE.Color(1, 1, 1))
      r.mat.uniforms.uTime.value = this.time
      r.mat.uniforms.uSpeed.value = 0.5 + 2.4 * s.weight
      r.mat.uniforms.uAlpha.value = r.alpha * (0.45 + 0.55 * s.weight)
      const ok2 = `${s.organ}:${s.side}`
      const prev = organs.get(ok2)
      if (!prev || prev.w < s.weight) organs.set(ok2, { w: s.weight, kind: s.kind })
    }
    for (const [key, r] of this.threads) {
      if (live.has(key)) continue
      r.alpha *= Math.exp(-dt * 5)
      r.mat.uniforms.uAlpha.value = r.alpha * 0.6
      r.mat.uniforms.uTime.value = this.time
      if (r.alpha < 0.02) {
        this.group.remove(r.mesh)
        this.threads.delete(key)
        this.spare.push(r)
      }
    }
    for (const [key, o] of organs) {
      const [organ, side] = key.split(':') as [Parameters<Fly3D['organ']>[0], string]
      if (!this.fly3d.organ(organ, side === 'mid' ? 'left' : side as 'left' | 'right', this.b)) continue
      const sp = this.glows[g] ?? this.newGlow()
      g++
      sp.visible = true
      sp.position.copy(this.b)
      const pulse = 0.8 + 0.2 * Math.sin(this.time * (6 + 10 * o.w))
      sp.scale.setScalar((6 + 12 * o.w) * pulse)
      ;(sp.material as THREE.SpriteMaterial).color.copy(COLOUR.get(o.kind) ?? new THREE.Color(1, 1, 1))
      ;(sp.material as THREE.SpriteMaterial).opacity = 0.35 + 0.5 * o.w
    }
    for (let i = g; i < this.glows.length; i++) this.glows[i].visible = false
  }

  private newGlow() {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending, toneMapped: false,
    }))
    sp.renderOrder = 41
    this.glows.push(sp)
    this.group.add(sp)
    return sp
  }

  /** A quadratic Bezier from a to b, arched up so it reads as reaching over to the fly. */
  private curve(a: THREE.Vector3, b: THREE.Vector3) {
    const d = a.distanceTo(b)
    this.c.addVectors(a, b).multiplyScalar(0.5)
    this.c.y = Math.max(a.y, b.y) + d * 0.28 + 6
    for (let i = 0; i < SAMPLES; i++) {
      const t = i / (SAMPLES - 1), s = 1 - t
      this.bez[i].set(
        s * s * a.x + 2 * s * t * this.c.x + t * t * b.x,
        s * s * a.y + 2 * s * t * this.c.y + t * t * b.y,
        s * s * a.z + 2 * s * t * this.c.z + t * t * b.z)
    }
  }

  // --- intent -----------------------------------------------------------------------

  private arcAlpha = 0

  private updateArc(dt: number, action: Action, fly: Fly) {
    // The decoded command, integrated forward: the same forward speed and turn rate the
    // world is about to apply, held for two seconds.
    const v = action.forward, turn = action.turn
    // held still on a meal, the command is there but the world is not carrying it out
    const walking = !action.escape && fly.flying < 0.1 && !(fly.eating ?? 0) && Math.abs(v) > 3
    const target = walking ? Math.min(1, Math.abs(v) / 25) : 0
    this.arcAlpha += (target - this.arcAlpha) * (1 - Math.exp(-dt * 5))
    const u = this.arc.mat.uniforms
    u.uAlpha.value = this.arcAlpha * 0.8
    u.uTime.value = this.time * Math.sign(v || 1)
    this.arc.mesh.visible = this.arcAlpha > 0.02
    if (!this.arc.mesh.visible) return
    const horizon = 2.2
    const len = Math.max(40, Math.abs(v) * horizon)
    const nose = 40                          // start at its head (or tail, backing up)
    let h = fly.h
    const dir = Math.sign(v) || 1
    let x = fly.x + Math.cos(h) * nose * dir, z = fly.y + Math.sin(h) * nose * dir
    const step = len / (SAMPLES - 1)
    const turnPerUnit = turn / Math.max(Math.abs(v), 1)
    for (let i = 0; i < SAMPLES; i++) {
      this.bez[i].set(x, 4, z)
      h += turnPerUnit * step
      x += Math.cos(h) * step * dir
      z += Math.sin(h) * step * dir
    }
    // Facing the camera rather than lying flat: from a chase camera 14 degrees above
    // the ground, a decal on the floor is a sliver.
    this.arc.set(this.bez, uu => 7 * (1 - 0.4 * uu), this.camera.position)
  }

  // --- nectar -------------------------------------------------------------------------

  private updateDrops(dt: number, mind: Mind, stims: Stim[]) {
    for (const [id, mesh] of this.drops) {
      if (!mind.nectar.has(id)) { this.world.remove(mesh); this.drops.delete(id) }
    }
    for (const s of stims) {
      const left = mind.nectar.get(s.id)
      if (left === undefined) continue
      let m = this.drops.get(s.id)
      if (!m) {
        m = new THREE.Mesh(this.dropGeo, this.dropMat)
        m.castShadow = false
        m.userData.r = 0
        this.drops.set(s.id, m)
        // the drop is part of the world, not of the overlay: it stays when the view is off
        this.world.add(m)
      }
      // swells in when placed, shrinks as it is drunk
      m.userData.r += (9 * (0.3 + 0.7 * left) - m.userData.r) * (1 - Math.exp(-dt * 4))
      const r = m.userData.r as number
      m.scale.set(r, r * 0.5, r)
      m.position.set(s.x, r * 0.32, s.y)
    }
  }

  // --- pollen -------------------------------------------------------------------------

  private updateSpecks(dt: number) {
    for (const p of this.fly3d.takeFallen()) {
      if (this.specks.length >= 64) this.specks.shift()
      this.specks.push({
        p, life: 1,
        v: new THREE.Vector3((Math.random() - 0.5) * 60, 10 + Math.random() * 30, (Math.random() - 0.5) * 60),
      })
    }
    let n = 0
    for (let i = this.specks.length - 1; i >= 0; i--) {
      const s = this.specks[i]
      s.life -= dt * 0.8
      s.v.y -= 160 * dt
      s.v.multiplyScalar(Math.max(0, 1 - dt * 1.5))
      s.p.addScaledVector(s.v, dt)
      if (s.p.y < 1) { s.p.y = 1; s.v.set(0, 0, 0) }
      if (s.life <= 0) { this.specks.splice(i, 1); continue }
    }
    for (const s of this.specks) {
      const k = 1.1 * Math.min(1, s.life * 3)
      this.m4.makeScale(k, k, k).setPosition(s.p)
      this.speckMesh.setMatrixAt(n++, this.m4)
    }
    this.speckMesh.count = n
    this.speckMesh.instanceMatrix.needsUpdate = true
  }
}
