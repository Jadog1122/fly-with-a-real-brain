// The fly is Maf'j Alvarez's "shy fly" (Google Poly, CC-BY 3.0) — see NOTICE.
//
// The asset ships as eleven loose rigid parts with no bones, so this used to build a
// rig at load time: each part re-parented into a pivot placed at its own attachment
// point, and every pose computed as numbers inside update().  It worked, but a rigidly
// rotated part cannot bend — the legs were sticks that swung from the hip with no knee
// — and there was no way to cross-fade between two poses because there were no poses,
// only arithmetic.
//
// The skeleton now lives in the asset.  art/rig_fly.py builds it in Blender: seventeen
// bones, two per leg so the leg bends, and five clips — idle, walk, groom, flight and
// proboscis.  This file plays them.
//
// What deliberately did NOT move into clips:
//
//   The wingbeat.  A fly beats its wings at a couple of hundred hertz and the rate is
//   driven by the brain's escape signal; sampling that off a 24-frame clip would alias
//   into a stutter.  Clips are for poses, code is for oscillators.
//
//   The walk cycle's PHASE.  The clip holds the shape of a stride, but where in the
//   stride the fly is still comes from `legPhase`, which comes out of the motor
//   neurons.  That is the whole point of the project: the brain drives the body, and a
//   canned animation playing off a clock would be a lie.

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const MODEL = 'models/fly/shy-fly-rigged.glb'

const BODY = 'Sphere.001'

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
 * Bounds in the asset's own coordinates.  Box3.setFromObject would give world bounds,
 * which are meaningless here: the rig is re-parented and rescaled as it is built.
 */
function modelBox(objs: THREE.Object3D[]) {
  const b = new THREE.Box3()
  for (const o of objs) eachVertex(o, v => b.expandByPoint(v))
  return b
}

/**
 * Frame-rate independent easing toward a target.  A plain `cur += (t - cur) * k` moves
 * further per second the faster the machine renders, so a pose that eases in over a
 * quarter second at 60 fps snaps at 144.
 */
function ease(cur: number, target: number, rate: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt))
}

const TAU = Math.PI * 2

// scratch, so the per-frame wingbeat allocates nothing
const BEAT_EULER = new THREE.Euler()
const BEAT_Q = new THREE.Quaternion()

export class Fly3D {
  readonly root = new THREE.Group()

  // root -> rig (normalise + face +X) -> pose (airborne) -> the skinned model
  private rig = new THREE.Group()
  private pose = new THREE.Group()

  private mixer?: THREE.AnimationMixer
  private act: Record<string, THREE.AnimationAction> = {}
  private wings: { bone: THREE.Object3D; rest: THREE.Quaternion }[] = []
  private wingMats: THREE.MeshStandardMaterial[] = []
  private eyeMat?: THREE.MeshStandardMaterial

  private wingPhase = 0
  private groomPhase = 0
  private escapeBlend = 0
  private groomBlend = 0
  private proboscisBlend = 0
  private ready = false

  constructor() {
    this.rig.add(this.pose)
    this.root.add(this.rig)
    void this.load()
  }

  private async load() {
    const gltf = await new GLTFLoader().loadAsync(MODEL)
    const src = gltf.scene
    src.updateMatrixWorld(true)             // so eachVertex reads the asset's own space

    // three strips '[]./:' out of node names when it builds the scene graph, so the
    // bones Blender called `wing.L` and `leg.L.1.upper` arrive as `wingL`, `legL1upper`.
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

    // Keep each wing's rest orientation. A bone's local transform in a glTF skeleton
    // carries its orientation relative to its parent, which for these is most of a
    // right angle - so writing rotation.set() every frame would throw that away and
    // hang the wings off the thorax at the wrong angle entirely. The beat composes
    // onto the rest pose instead of replacing it.
    for (const n of ['wing.L', 'wing.R']) {
      const b = find(n)
      if (b) this.wings.push({ bone: b, rest: b.quaternion.clone() })
    }
    src.traverse(o => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      const mat = m.material as THREE.MeshStandardMaterial
      // A wing beating at flight speed covers its whole arc several times per frame,
      // so a solid wing strobes rather than blurs.  Thinning it as the beat rises is
      // the standard stand-in for motion blur and costs nothing.
      if (mat?.name === 'flywings-dark' || mat?.name === 'fly-white') {
        const wm = mat.clone()
        wm.transparent = true
        wm.depthWrite = false
        wm.side = THREE.DoubleSide
        m.material = wm
        this.wingMats.push(wm)
      }
    })

    this.pose.add(src)

    this.mixer = new THREE.AnimationMixer(src)
    for (const clip of gltf.animations) {
      // Blender's exporter samples EVERY bone into every action, so each clip arrives
      // carrying rest-pose tracks for bones it was never meant to touch. That is not
      // harmless: the proboscis clip at weight 1 was writing the rest pose into all
      // twelve leg bones, diluting walk, groom and flight to half strength - and idle
      // was writing scale 1 into the proboscis bone, which averaged with the
      // proboscis clip's 0.02 to exactly the 0.51 the probe measured. Each clip keeps
      // only what it owns: the proboscis clip its one bone, the pose clips the legs
      // and thorax. Nothing owns the wings (the wingbeat is code) or the root.
      clip.tracks = clip.tracks.filter(t => {
        const bone = t.name.split('.')[0]
        if (clip.name === 'proboscis') return bone === 'proboscis'
        return /^leg|^thorax/.test(bone)
      })
      const a = this.mixer.clipAction(clip)
      a.play()
      a.enabled = true
      a.setEffectiveWeight(0)
      // Every clip is driven by hand from the brain's state, so none of them are
      // allowed to advance on the mixer's own clock.
      a.paused = true
      this.act[clip.name] = a
    }
    if (!this.act.idle) console.warn('fly3d: the asset has no idle clip; blends will snap')
    this.act.idle?.setEffectiveWeight(1)

    // Normalise: nose to tail becomes TARGET_LEN, and the lowest foot sits on y = 0.
    // The asset is modelled facing -Z; scene3d sets `root.rotation.y = -h + PI`, so at
    // root yaw 0 the fly is heading -X and this yaw has to land the nose there.
    const bodyBox = modelBox([body])
    const norm = TARGET_LEN / (bodyBox.max.z - bodyBox.min.z)
    const floor = modelBox(parts).min.y
    this.rig.scale.setScalar(norm)
    this.rig.rotation.y = Math.PI / 2
    this.rig.position.y = -floor * norm

    this.ready = true
  }

  /** Park a clip at a fraction of its own length. */
  private at(name: string, frac: number) {
    const a = this.act[name]
    if (!a) return
    a.time = ((frac % 1) + 1) % 1 * a.getClip().duration
  }

  /** `speed` in arena units/s, plus the decoded behaviour. */
  update(dt: number, o: {
    speed: number; legPhase: number; escape: boolean; proboscis: number
    groom: number; startle: number; airborne: number
  }) {
    // Behaviours arrive as booleans from the decoder, and using them directly made
    // every transition a hard cut: legs teleported into the grooming pose, wings went
    // from a shiver to a thrash in one frame, the proboscis popped into existence.
    // These blends ease between poses instead.  exp(-rate * dt) rather than a fixed
    // step per frame, so the timing is the same at 30 fps and at 144.
    this.escapeBlend = ease(this.escapeBlend, o.escape ? 1 : 0, 11, dt)
    this.groomBlend = ease(this.groomBlend, o.groom > .3 ? 1 : 0, 8, dt)
    this.proboscisBlend = ease(this.proboscisBlend, o.proboscis, 14, dt)

    this.wingPhase += dt * (12 + this.escapeBlend * 78)
    this.groomPhase += dt * 14
    if (!this.ready || !this.mixer) return

    const moving = Math.min(1, Math.abs(o.speed) / 40)

    // Weights that sum to one, because AnimationMixer takes a weighted AVERAGE of
    // whatever is playing rather than layering it over the rest pose.  A walk clip
    // alone at weight 0.1 would not come out as a tenth of a stride, it would come out
    // as a whole stride - it is the only thing in the average.  `idle` takes up the
    // slack so a partial blend is a partial pose.
    const wFlight = this.escapeBlend
    const wStartle = o.startle * (1 - wFlight)
    const wGroom = this.groomBlend * (1 - wFlight - wStartle)
    const wWalk = moving * (1 - wFlight - wStartle - wGroom)
    this.act.flight?.setEffectiveWeight(wFlight)
    this.act.startle?.setEffectiveWeight(wStartle)
    this.act.groom?.setEffectiveWeight(wGroom)
    this.act.walk?.setEffectiveWeight(wWalk)
    this.act.idle?.setEffectiveWeight(Math.max(0, 1 - wFlight - wStartle - wGroom - wWalk))

    // The brain owns the phase.  1.6 is the stride-per-radian factor the procedural
    // version used, kept so the gait reads at the same rate against the same speed.
    this.at('walk', o.legPhase * 1.6 / TAU)
    this.at('groom', this.groomPhase / TAU)
    // The proboscis clip is a position on a slider, not a loop: the one bone it drives
    // is touched by nothing else, so it can sit outside the weighted set at full
    // strength and simply be scrubbed.
    this.act.proboscis?.setEffectiveWeight(1)
    const pro = this.act.proboscis
    if (pro) pro.time = this.proboscisBlend * pro.getClip().duration

    this.mixer.update(dt)

    // --- after the mixer: the things that are oscillators rather than poses ---------

    // Wings idle with a shiver and thrash on escape, hinged at the thorax.  No clip
    // touches these bones, so writing them here cannot fight the blend.
    // Opacity follows the beat rate, not the pose: still at rest, a smear in flight.
    const blur = 0.92 - this.escapeBlend * 0.58
    for (const wm of this.wingMats) wm.opacity = blur

    const beat = Math.sin(this.wingPhase) * (.06 + this.escapeBlend * .94)
    BEAT_EULER.set(beat + this.escapeBlend * .5, beat * .3, 0)
    BEAT_Q.setFromEuler(BEAT_EULER)
    for (const w of this.wings) w.bone.quaternion.copy(w.rest).multiply(BEAT_Q)

    // Startle is a clip in the weighted set like everything else. It was a rotateX()
    // applied here, after the mixer - which accumulated without bound, because the
    // mixer only rewrites a bone when the blended pose CHANGES, and a fly standing
    // still evaluates to the same pose every frame, so the manual rotation was never
    // overwritten. Post-mixer writes are reserved for bones no clip owns: the wings.

    // Squash on landing, stretch on takeoff.
    const air = o.airborne
    this.pose.scale.set(1 + air * .06, 1 - air * .10, 1 + air * .10)
    this.pose.position.y = air * 5.8
    this.pose.rotation.x = air * .22

    if (this.eyeMat) {
      this.eyeMat.emissive.setHex(EYE).multiplyScalar(.18 + o.startle * .5)
    }
  }
}
