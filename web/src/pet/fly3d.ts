// The fly is Maf'j Alvarez's "shy fly" (Google Poly, CC-BY 3.0) — see NOTICE.
//
// The asset has no bones, but it does ship as eleven loose parts: a body, two eyes,
// two wings and six legs.  So it gets rigged here at load time.  Each part is
// re-parented into a pivot placed at its own attachment point, read off that part's
// own vertices — the top of a leg is its hip, the inboard edge of a wing is its
// hinge — and the brain then drives the model's own geometry rather than a stand-in.
//
// Two things the mesh cannot give us.  The head is welded into the body shell, so
// `startle` rears the whole torso off the legs instead of just the head.  And there
// is no separate proboscis, so `proboscis` extends a second copy of a hind leg from
// the snout: tapered, dark, and the same facet density as everything else, which a
// built tube would not be.

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const MODEL = 'models/fly/shy-fly.glb'

// Part names as they appear in the asset.  glTF splits a part per material, so each
// of these loads as a Group of meshes, and three strips the dots out of the names —
// hence `find` below, which tries the name both ways.
const BODY = 'Sphere.001'
const EYES = ['Sphere.008', 'Sphere.009']
const WINGS = ['BezierCurve.001_Mesh.001', 'BezierCurve_Mesh']
const LEGS = ['Sphere.007', 'Sphere.006', 'Sphere.005',     // left: front, mid, hind
              'Sphere.000', 'Sphere.003', 'Sphere.004']     // right: front, mid, hind

// The old procedural fly was 2.22 units nose to tail and the scene scales the root by
// 34, so matching that length keeps the fly the size the camera and arena expect.
const TARGET_LEN = 2.22

const EYE = 0xd8402a

/** Every vertex of `obj`, in the asset's own coordinates. */
function eachVertex(obj: THREE.Object3D, fn: (v: THREE.Vector3) => void) {
  const v = new THREE.Vector3()
  obj.traverse(o => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    const pos = m.geometry.attributes.position
    for (let i = 0; i < pos.count; i++) {
      fn(v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld))
    }
  })
}

/**
 * Centroid of the `frac` of vertices that score lowest — used to find where a limb
 * meets the body, so it can be rotated about that point instead of the model origin.
 */
function attachPoint(obj: THREE.Object3D, score: (v: THREE.Vector3) => number, frac: number) {
  const scores: number[] = []
  eachVertex(obj, v => scores.push(score(v)))
  const c = new THREE.Vector3()
  if (!scores.length) return c
  const cut = [...scores].sort((a, b) => a - b)[Math.max(0, Math.ceil(scores.length * frac) - 1)]
  let i = 0, n = 0
  eachVertex(obj, v => { if (scores[i++] <= cut) { c.add(v); n++ } })
  return n ? c.divideScalar(n) : c
}

/**
 * Bounds in the asset's own coordinates.  Box3.setFromObject would give world bounds,
 * which are meaningless here: the rig is re-parented and rescaled as it is built.
 */
function modelBox(objs: THREE.Object3D[]) {
  const b = new THREE.Box3()
  for (const o of objs) eachVertex(o, v => b.expandByPoint(v))
  return b
}

/** Hang `obj` off a pivot at `at`, keeping it where it was. */
function pivotAt(obj: THREE.Object3D, at: THREE.Vector3) {
  const g = new THREE.Group()
  g.position.copy(at)
  obj.position.sub(at)
  g.add(obj)
  return g
}

/** One rigged limb: a pivot at the attachment, plus which way is "out" for that side. */
interface Limb { pivot: THREE.Group; side: number }

export class Fly3D {
  readonly root = new THREE.Group()

  // root -> rig (normalise + face +X) -> pose (airborne) -> torso (startle) -> parts
  private rig = new THREE.Group()
  private pose = new THREE.Group()
  private torso = new THREE.Group()

  private legs: Limb[] = []
  private wings: Limb[] = []
  private proboscis?: THREE.Group
  private eyeMat?: THREE.MeshStandardMaterial
  private wingPhase = 0
  private groomPhase = 0
  private ready = false

  constructor() {
    this.rig.add(this.pose)
    this.pose.add(this.torso)
    this.root.add(this.rig)
    void this.load()
  }

  private async load() {
    const gltf = await new GLTFLoader().loadAsync(MODEL)
    const src = gltf.scene
    src.updateMatrixWorld(true)             // so eachVertex reads the asset's own space

    // three strips '[]./:' out of node names when it builds the scene graph.
    const find = (name: string) =>
      src.getObjectByName(name) ?? src.getObjectByName(name.replace(/[[\]./:]/g, ''))

    const body = find(BODY)
    if (!body) { console.warn(`fly3d: ${MODEL} has no part named ${BODY}`); return }

    // Flat shading and a matte finish are what put this in the same world as the
    // Quaternius props, which are faceted and unlit-looking at this size.
    const parts: THREE.Object3D[] = []
    src.traverse(o => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      parts.push(m)
      const mat = m.material as THREE.MeshStandardMaterial
      if (!mat) return
      mat.flatShading = true
      mat.roughness = .92
      mat.metalness = 0
      if (mat.transparent) mat.depthWrite = false
      else m.castShadow = true
      if (mat.name === 'red-eye') {
        mat.emissive = new THREE.Color(EYE).multiplyScalar(.18)
        this.eyeMat = mat
      }
      mat.needsUpdate = true
    })

    // Legs: pivot at the hip, which is the top fifth of the leg's own vertices.
    for (const name of LEGS) {
      const leg = find(name)
      if (!leg) continue
      const hip = attachPoint(leg, v => -v.y, .2)
      this.legs.push({ pivot: pivotAt(leg, hip), side: Math.sign(hip.x) || 1 })
    }
    for (const l of this.legs) this.pose.add(l.pivot)

    // Wings: hinge at the inboard fifth, the edge that meets the thorax.
    for (const name of WINGS) {
      const wing = find(name)
      if (!wing) continue
      const hinge = attachPoint(wing, v => Math.abs(v.x), .2)
      this.wings.push({ pivot: pivotAt(wing, hinge), side: Math.sign(hinge.x) || 1 })
    }

    // The torso is everything that rears together: body, eyes, wings.
    const bodyBox = modelBox([body])
    this.torso.add(body)
    for (const name of EYES) { const e = find(name); if (e) this.torso.add(e) }
    for (const w of this.wings) this.torso.add(w.pivot)

    // Proboscis: a second copy of a hind leg, mounted at the snout.  Its pivot sits
    // where the leg's hip was, so scaling the pivot retracts it into the head.
    const donor = this.legs[2]?.pivot.children[0]
    if (donor) {
      this.proboscis = new THREE.Group()
      this.proboscis.position.set(
        0, bodyBox.min.y + (bodyBox.max.y - bodyBox.min.y) * .42, bodyBox.min.z + .25)
      this.proboscis.rotation.x = .78                  // forward and down, onto the food
      this.proboscis.add(donor.clone())
      this.torso.add(this.proboscis)
    }

    // Normalise: nose to tail becomes TARGET_LEN, and the lowest foot sits on y = 0.
    // The asset is modelled facing -Z; scene3d sets `root.rotation.y = -h + PI`, so at
    // root yaw 0 the fly is heading -X and this yaw has to land the nose there.
    const norm = TARGET_LEN / (bodyBox.max.z - bodyBox.min.z)
    const floor = modelBox(parts).min.y
    this.rig.scale.setScalar(norm)
    this.rig.rotation.y = Math.PI / 2
    this.rig.position.y = -floor * norm

    // The torso rears about the line the legs stand on, not about the model origin.
    const hips = new THREE.Vector3()
    for (const l of this.legs) hips.add(l.pivot.position)
    if (this.legs.length) hips.divideScalar(this.legs.length)
    this.torso.position.copy(hips)
    for (const c of this.torso.children) c.position.sub(hips)

    this.ready = true
  }

  /** `speed` in arena units/s, plus the decoded behaviour. */
  update(dt: number, o: {
    speed: number; legPhase: number; escape: boolean; proboscis: number
    groom: number; startle: number; airborne: number
  }) {
    this.wingPhase += dt * (o.escape ? 90 : 12)
    this.groomPhase += dt * 14
    if (!this.ready) return

    const moving = Math.min(1, Math.abs(o.speed) / 40)
    const grooming = o.groom > .3

    // Alternating tripod: each side's front and hind leg swing with the other side's
    // middle leg, which is how a fly actually walks.
    this.legs.forEach((leg, i) => {
      if (grooming && i % 3 === 0) {
        // front legs come up off the ground and rub the face, the two out of phase
        const r = Math.sin(this.groomPhase + (i ? Math.PI : 0)) * .45
        leg.pivot.rotation.set(1.15 + r, 0, leg.side * .35)
        return
      }
      const phase = o.legPhase * 1.6 + (i % 2 ? Math.PI : 0)
      const swing = Math.sin(phase) * .5 * moving
      const lift = Math.max(0, Math.cos(phase)) * .38 * moving
      leg.pivot.rotation.set(swing, 0, leg.side * lift)
    })

    // Wings idle with a shiver and thrash on escape, hinged at the thorax.
    const beat = Math.sin(this.wingPhase) * (o.escape ? 1.0 : .06)
    for (const w of this.wings) {
      w.pivot.rotation.z = w.side * (beat + (o.escape ? .5 : 0))
      w.pivot.rotation.y = w.side * beat * .3
    }

    if (this.proboscis) {
      this.proboscis.visible = o.proboscis > .01
      this.proboscis.scale.set(.34, .95 * (.02 + o.proboscis), .5)
    }

    // Squash on landing, stretch on takeoff.
    const air = o.airborne
    this.pose.scale.set(1 + air * .06, 1 - air * .10, 1 + air * .10)
    this.pose.position.y = air * 5.8
    this.pose.rotation.x = air * .22

    // Startled flies rear up and their eyes catch the light.
    this.torso.rotation.x = o.startle * .3
    if (this.eyeMat) {
      this.eyeMat.emissive.setHex(EYE).multiplyScalar(.18 + o.startle * .5)
    }
  }
}
