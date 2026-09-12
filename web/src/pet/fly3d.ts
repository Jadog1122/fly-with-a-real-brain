// A cartoon Drosophila, built from primitives so there is no asset to download or
// license.  Proportions follow a real fly: big red eyes taking most of the head, a
// tan thorax, a banded abdomen, wings longer than the body and held back at rest.

import * as THREE from 'three'

const TAN = 0xc89a5b
const TAN_DARK = 0x8a6534
const CHITIN = 0x2b2118
const EYE = 0xd8402a

function ellipsoid(rx: number, ry: number, rz: number, mat: THREE.Material, seg = 20) {
  const g = new THREE.SphereGeometry(1, seg, seg * 0.7)
  g.scale(rx, ry, rz)
  return new THREE.Mesh(g, mat)
}

/** One leg: femur + tibia, driven by a single phase value. */
class Leg {
  root = new THREE.Group()
  private femur: THREE.Mesh
  private tibia: THREE.Group
  constructor(mat: THREE.Material, private side: number, private rest: number) {
    const fg = new THREE.CylinderGeometry(0.035, 0.028, 0.62, 6)
    fg.translate(0, -0.31, 0)
    this.femur = new THREE.Mesh(fg, mat)
    this.tibia = new THREE.Group()
    const tg = new THREE.CylinderGeometry(0.026, 0.016, 0.58, 6)
    tg.translate(0, -0.29, 0)
    const t = new THREE.Mesh(tg, mat)
    this.tibia.add(t)
    this.tibia.position.y = -0.62
    this.femur.add(this.tibia)
    this.root.add(this.femur)
  }
  update(phase: number, moving: number) {
    const swing = Math.sin(phase) * 0.55 * moving
    const lift = Math.max(0, Math.cos(phase)) * 0.42 * moving
    this.root.rotation.z = this.side * (this.rest + 0.25) - this.side * lift
    this.root.rotation.x = swing
    this.femur.rotation.x = -swing * 0.5
    this.tibia.rotation.x = 0.75 + lift * 0.7
  }
}

export class Fly3D {
  readonly root = new THREE.Group()
  private body = new THREE.Group()
  private wings: THREE.Mesh[] = []
  private legs: Leg[] = []
  private proboscis: THREE.Mesh
  private head: THREE.Group
  private eyes: THREE.MeshStandardMaterial
  private wingPhase = 0

  constructor() {
    const tan = new THREE.MeshStandardMaterial({ color: TAN, roughness: .62, metalness: .05 })
    const dark = new THREE.MeshStandardMaterial({ color: TAN_DARK, roughness: .55 })
    const chitin = new THREE.MeshStandardMaterial({ color: CHITIN, roughness: .45 })
    this.eyes = new THREE.MeshStandardMaterial({
      color: EYE, roughness: .28, metalness: .12,
      emissive: new THREE.Color(EYE).multiplyScalar(.18),
    })

    // abdomen, tapered and banded
    const abd = ellipsoid(.46, .40, .72, tan)
    abd.position.set(0, .40, .62)
    this.body.add(abd)
    for (let i = 0; i < 3; i++) {
      const band = ellipsoid(.465, .405, .09, dark, 16)
      band.position.set(0, .40, .32 + i * .30)
      this.body.add(band)
    }

    // thorax
    const thorax = ellipsoid(.44, .42, .48, tan)
    thorax.position.set(0, .46, -.10)
    this.body.add(thorax)
    const scut = ellipsoid(.30, .16, .30, dark, 14)
    scut.position.set(0, .76, -.08)
    this.body.add(scut)

    // head, mostly eye
    this.head = new THREE.Group()
    this.head.position.set(0, .46, -.62)
    const skull = ellipsoid(.30, .30, .26, dark, 18)
    this.head.add(skull)
    for (const s of [-1, 1]) {
      const e = ellipsoid(.22, .27, .23, this.eyes, 20)
      e.position.set(s * .21, .03, .02)
      this.head.add(e)
      const ant = ellipsoid(.06, .07, .05, chitin, 10)
      ant.position.set(s * .10, -.14, -.19)
      this.head.add(ant)
      const arista = new THREE.Mesh(new THREE.CylinderGeometry(.008, .004, .30, 4),
                                    chitin)
      arista.position.set(s * .14, -.20, -.30)
      arista.rotation.set(-.7, 0, s * .4)
      this.head.add(arista)
    }
    const probMat = new THREE.MeshStandardMaterial({ color: 0xe0a44e, roughness: .5 })
    this.proboscis = new THREE.Mesh(new THREE.CapsuleGeometry(.075, .22, 4, 8), probMat)
    this.proboscis.position.set(0, -.22, -.12)
    this.proboscis.rotation.x = Math.PI / 2.2
    this.proboscis.scale.y = 0.01
    this.head.add(this.proboscis)
    this.body.add(this.head)

    // wings: a flattened teardrop, translucent, veined by a darker rim
    const shape = new THREE.Shape()
    shape.moveTo(0, 0)
    shape.bezierCurveTo(.26, .10, .70, .34, 1.45, .16)
    shape.bezierCurveTo(.80, -.02, .34, -.14, 0, 0)
    const wingGeo = new THREE.ShapeGeometry(shape, 24)
    const wingMat = new THREE.MeshStandardMaterial({
      color: 0xd9e8f5, transparent: true, opacity: .30, roughness: .1,
      side: THREE.DoubleSide, depthWrite: false,
    })
    for (const s of [-1, 1]) {
      const w = new THREE.Mesh(wingGeo, wingMat)
      w.position.set(s * .16, .78, -.02)
      w.rotation.set(-Math.PI / 2, 0, s * -1.35)
      w.scale.x = s
      this.wings.push(w)
      this.body.add(w)
    }

    // six legs
    const restAngles = [.55, .30, .12]
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const leg = new Leg(chitin, s, restAngles[i])
        leg.root.position.set(s * .30, .34, -.34 + i * .34)
        this.legs.push(leg)
        this.body.add(leg.root)
      }
    }

    this.body.traverse(o => { o.castShadow = true })
    this.root.add(this.body)
  }

  /** `speed` in arena units/s, `heading` radians, plus the decoded behaviour. */
  update(dt: number, o: {
    speed: number; legPhase: number; escape: boolean; proboscis: number
    groom: number; startle: number; airborne: number
  }) {
    const moving = Math.min(1, Math.abs(o.speed) / 40)
    for (let i = 0; i < this.legs.length; i++) {
      const off = (i % 3) * 2.1 + (i < 3 ? 0 : Math.PI)
      this.legs[i].update(o.legPhase * 1.6 + off, o.groom > .3 && i % 3 === 0 ? 0 : moving)
    }
    // front legs rub the antennae while grooming
    if (o.groom > .3) {
      const r = Math.sin(performance.now() / 70) * .5
      this.legs[0].root.rotation.x = -1.15 + r
      this.legs[3].root.rotation.x = -1.15 - r
    }

    this.wingPhase += dt * (o.escape ? 90 : 12)
    const beat = o.escape ? Math.sin(this.wingPhase) * 1.05 : 0
    this.wings.forEach((w, i) => {
      const s = i === 0 ? -1 : 1
      w.rotation.z = s * (-1.35 + (o.escape ? .55 : 0)) + s * beat * .5
      w.rotation.y = beat * .35
    })

    this.proboscis.scale.y = 0.01 + o.proboscis * 1.6
    // squash on landing, stretch on takeoff
    const air = o.airborne
    this.body.scale.set(1 + air * .06, 1 - air * .10 + (1 - air) * 0, 1 + air * .10)
    this.body.position.y = air * 1.1
    this.body.rotation.x = -air * .22
    // startled flies rear back a little
    this.head.rotation.x = -o.startle * .18
    const e = this.eyes.emissive
    e.setHex(EYE); e.multiplyScalar(.18 + o.startle * .5)
  }
}
