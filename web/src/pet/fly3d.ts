// The fly is Drosophila melanogaster: the body model from `flybody`, built by Google
// DeepMind and HHMI Janelia from a real fly (Apache-2.0, see NOTICE), rebuilt for the
// game by art/fly/build_fly.py - 272k triangles down to 22.6k with the compound eyes'
// facets and the fine bristles baked into maps, the abdomen given its tergite bands, the
// wings folded the way a resting fly folds them, and every clip authored on the model's
// own skeleton with its own foot IK.
//
// Who moves what, and why they never fight:
//
//   clips  walk, groom, flight, startle (legs and thorax) and proboscis (its four bones).
//          Weighted every frame from the brain's state; none of them runs on a clock.
//          Where the fly is in its stride comes from legPhase, the motor neurons'
//          integral, at the no-slip rate the model's own stride implies - so the feet
//          stay planted instead of skating.
//   code   head, antennae, wings and halteres: attention and oscillators, rewritten
//          from the bind pose every frame, never accumulated. No clip carries a channel
//          for any of them - art/fly/optimize.mjs strips them - so a clip cannot drag
//          one back toward rest, and a manual rotation cannot pile up frame on frame
//          (which is how startle once left the old fly standing on its head).

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

const MODEL = 'models/fly/drosophila.glb'

// Nose to tail in root units. The scene scales the root by 34, and the camera, arena and
// every stimulus range were tuned against a fly this long.
const TARGET_LEN = 2.22

// world.ts advances legPhase by this many radians per arena unit walked.
const LEG_PHASE_PER_UNIT = 0.09

// The body's own axes in the model's frame (glTF, Y up). The fly faces -X; Blender's +Y
// is its right, which the Y-up conversion carries to -Z.
const BACK = new THREE.Vector3(1, 0, 0)
const UP = new THREE.Vector3(0, 1, 0)
const LEFT = new THREE.Vector3(0, 0, 1)

const EYE = 0xd8402a
const TAU = Math.PI * 2

/**
 * Frame-rate independent easing toward a target. A plain `cur += (t - cur) * k` moves
 * further per second the faster the machine renders.
 */
function ease(cur: number, target: number, rate: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt))
}

/**
 * Bounds of the bind pose, measured the way three draws it. Two traps: the geometry is
 * quantized, and for a SKINNED mesh the dequantisation lives in the skin's inverse-bind
 * matrices rather than in any node - so raw geometry bounds are in the wrong units; and
 * three skins through bone matrices it only computes on the first render, so they must
 * be brought up to date first. Call this before the model is attached to anything, or
 * the root's own scale leaks into the measurement.
 */
function bindBox(model: THREE.Object3D, only?: THREE.Object3D) {
  model.updateMatrixWorld(true)
  const box = new THREE.Box3()
  model.traverse(o => {
    const m = o as THREE.SkinnedMesh
    if (!m.isMesh || (only && m !== only)) return
    if (m.isSkinnedMesh) {
      m.skeleton.update()
      m.computeBoundingBox()
      box.union(m.boundingBox!.clone().applyMatrix4(m.matrixWorld))
    } else {
      box.expandByObject(m)
    }
  })
  return box
}

/** A bone the game drives itself: its bind pose, and the body's axes in its PARENT'S frame. */
interface Driven {
  bone: THREE.Object3D
  rest: THREE.Quaternion
  back: THREE.Vector3
  up: THREE.Vector3
  left: THREE.Vector3
}

// scratch, so the per-frame code allocates nothing
const QA = new THREE.Quaternion()
const QB = new THREE.Quaternion()

export class Fly3D {
  readonly root = new THREE.Group()

  // root -> rig (normalise) -> pose (airborne squash, lift, pitch) -> the skinned model
  private rig = new THREE.Group()
  private pose = new THREE.Group()

  private mixer?: THREE.AnimationMixer
  private act: Record<string, THREE.AnimationAction> = {}
  private driven: Record<string, Driven> = {}
  private wingMats: THREE.Material[] = []
  private eyeMat?: THREE.MeshStandardMaterial
  private strideRoot = 1          // one walk cycle, in root units
  private bodyLen = 1             // nose to tail, in model units

  private wingPhase = 0
  private groomPhase = 0
  private escapeBlend = 0
  private groomBlend = 0
  private proboscisBlend = 0
  private walkCycle = 0
  private lastLegPhase = 0
  private look = 0
  private time = 0
  private twitch = 0
  private twitchSide = 1
  private nextTwitch = 1.5
  private ready = false

  constructor() {
    this.rig.add(this.pose)
    this.root.add(this.rig)
    void this.load()
  }

  private async load() {
    const loader = new GLTFLoader()
    loader.setMeshoptDecoder(MeshoptDecoder)
    const gltf = await loader.loadAsync(MODEL)
    const src = gltf.scene
    src.updateMatrixWorld(true)

    let cuticle: THREE.Mesh | undefined
    src.traverse(o => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      // Skinned: three bounds it by the bind pose, and a flying fly's wings leave that.
      m.frustumCulled = false
      const mat = m.material as THREE.MeshStandardMaterial
      if (mat.name === 'fly_cuticle') cuticle = m
      if (mat.transparent) {
        // A wing beating at flight speed covers its whole arc several times a frame, so
        // a solid one strobes; thinning it with the beat is the standard stand-in for
        // motion blur.
        mat.depthWrite = false
        mat.side = THREE.DoubleSide
        this.wingMats.push(mat)
      } else {
        m.castShadow = true
      }
      if (mat.name === 'fly_eye') {
        mat.emissive = new THREE.Color(EYE).multiplyScalar(.06)
        this.eyeMat = mat
      }
    })
    if (!cuticle) { console.warn(`fly3d: ${MODEL} has no fly_cuticle mesh`); return }

    // The bones the game drives: the body's axes, expressed in each one's parent frame at
    // bind time, so a rotation about "up" is about the fly's up wherever the bone points.
    for (const name of ['head', 'antenna_left', 'antenna_right', 'wing_left', 'wing_right',
                        'haltere_left', 'haltere_right']) {
      const bone = src.getObjectByName(name)
      if (!bone?.parent) { console.warn(`fly3d: no bone ${name}`); continue }
      bone.parent.getWorldQuaternion(QA)
      QA.invert()
      this.driven[name] = {
        bone, rest: bone.quaternion.clone(),
        back: BACK.clone().applyQuaternion(QA), up: UP.clone().applyQuaternion(QA),
        left: LEFT.clone().applyQuaternion(QA),
      }
    }

    // Normalise: nose to tail becomes TARGET_LEN, and the lowest claw sits on y = 0.
    // Measured now, before the model hangs under the root and inherits its scale.
    const box = bindBox(src, cuticle)
    this.bodyLen = box.max.x - box.min.x
    const norm = TARGET_LEN / this.bodyLen
    const floor = bindBox(src).min.y
    this.rig.scale.setScalar(norm)
    this.rig.position.y = -floor * norm
    const stride = Number(src.getObjectByName('Armature')?.userData.stride)
    this.strideRoot = (Number.isFinite(stride) && stride > 0 ? stride : 0.9) * norm

    this.pose.add(src)
    this.mixer = new THREE.AnimationMixer(src)
    for (const clip of gltf.animations) {
      const a = this.mixer.clipAction(clip)
      a.play()
      a.setEffectiveWeight(0)
      // every clip is scrubbed by hand from the brain's state, never by the mixer's clock
      a.paused = true
      this.act[clip.name] = a
    }
    for (const need of ['walk', 'groom', 'flight', 'startle', 'proboscis']) {
      if (!this.act[need]) console.warn(`fly3d: ${MODEL} has no ${need} clip`)
    }

    this.ready = true
  }

  /** Park a clip at a fraction of its own length. */
  private at(name: string, frac: number) {
    const a = this.act[name]
    if (!a) return
    a.time = ((frac % 1) + 1) % 1 * a.getClip().duration
  }

  /**
   * `speed` in arena units/s, `turn` the heading's angular velocity (rad/s, the sign
   * world.ts gives it), plus the decoded behaviour.
   */
  update(dt: number, o: {
    speed: number; legPhase: number; escape: boolean; proboscis: number
    groom: number; startle: number; airborne: number; turn?: number
  }) {
    // Behaviours arrive as booleans or raw rates; easing them makes each transition a
    // blend rather than a one-frame cut, at the same wall-clock pace at any frame rate.
    this.escapeBlend = ease(this.escapeBlend, o.escape ? 1 : 0, 11, dt)
    this.groomBlend = ease(this.groomBlend, o.groom > .3 ? 1 : 0, 8, dt)
    this.proboscisBlend = ease(this.proboscisBlend, o.proboscis, 14, dt)
    this.wingPhase += dt * (9 + this.escapeBlend * 110)
    this.groomPhase += dt * 9
    this.time += dt
    if (!this.ready || !this.mixer) return

    const moving = Math.min(1, Math.abs(o.speed) / 40)

    // Weights that sum to at most one. Whatever is left over, three's mixer blends toward
    // each bone's bind pose - which for this model is the standing pose - so a partial
    // weight is a partial pose, not a whole one.
    const wFlight = this.escapeBlend
    const wStartle = o.startle * (1 - wFlight)
    const wGroom = this.groomBlend * (1 - wFlight - wStartle)
    const wWalk = moving * (1 - wFlight - wStartle - wGroom)
    this.act.flight?.setEffectiveWeight(wFlight)
    this.act.startle?.setEffectiveWeight(wStartle)
    this.act.groom?.setEffectiveWeight(wGroom)
    this.act.walk?.setEffectiveWeight(wWalk)

    // The stride. One walk cycle carries the body exactly one stride, so the cycle count is
    // distance walked over stride length - legs neither skate nor paddle in place. The
    // distance is legPhase's, so the motor neurons still own it; its sign follows the
    // velocity so that backing up (MDN, the moonwalker cells) runs the stride in reverse.
    let d = o.legPhase - this.lastLegPhase
    this.lastLegPhase = o.legPhase
    if (d < 0 || d > 3) d = 0                     // a reset fly, not a stride
    const strideArena = this.strideRoot * (this.root.scale.x || 1)
    this.walkCycle += Math.sign(o.speed) * d / LEG_PHASE_PER_UNIT / strideArena
    this.at('walk', this.walkCycle)
    this.at('groom', this.groomPhase / TAU)
    // The proboscis clip is a slider, not a loop, over bones nothing else touches.
    const pro = this.act.proboscis
    if (pro) {
      pro.setEffectiveWeight(1)
      pro.time = this.proboscisBlend * pro.getClip().duration
    }

    this.mixer.update(dt)

    // --- after the mixer: the bones the game drives itself ------------------------------

    // Wings. Folded over the abdomen is the bind pose; flight swings them out sideways
    // and beats them. Rotations are about the body's own axes in the wing's parent frame,
    // pre-multiplied onto the bind pose: spread first, then the stroke.
    const spread = this.escapeBlend
    const beat = Math.sin(this.wingPhase) * (.025 + spread * 1.05)
    for (const [side, s] of [['left', 1], ['right', -1]] as const) {
      const w = this.driven[`wing_${side}`]
      if (!w) continue
      QA.setFromAxisAngle(w.up, -s * 1.62 * spread)            // back -> out to the side
      QB.setFromAxisAngle(w.back, -s * (beat + spread * .18))   // stroke, a little raised
      w.bone.quaternion.copy(QB).multiply(QA).multiply(w.rest)
      // halteres beat in antiphase to the wings - they are the fly's gyroscopes
      const h = this.driven[`haltere_${side}`]
      if (h) {
        QA.setFromAxisAngle(h.back, s * Math.sin(this.wingPhase) * (.06 + spread * .55))
        h.bone.quaternion.copy(QA).multiply(h.rest)
      }
    }
    const blur = .95 - spread * .6
    for (const m of this.wingMats) m.opacity = blur

    // Head. It leads a turn, the way flies turn their head before their body, dips into
    // the legs when grooming and toward the food when feeding, and comes up on a startle.
    this.look = ease(this.look, THREE.MathUtils.clamp(-(o.turn ?? 0) * .32, -.45, .45), 10, dt)
    const nod = this.groomBlend * .28 + this.proboscisBlend * .2 - o.startle * .16
      + Math.sin(this.time * 1.3) * .015                         // never perfectly still
    const head = this.driven.head
    if (head) {
      QA.setFromAxisAngle(head.up, this.look)
      QB.setFromAxisAngle(head.left, nod)
      head.bone.quaternion.copy(QA).multiply(QB).multiply(head.rest)
    }

    // Antennae: a slow restless flutter and the occasional flick, sharper when startled.
    this.nextTwitch -= dt
    if (this.nextTwitch <= 0) {
      this.twitch = 1
      this.twitchSide = Math.random() < .5 ? -1 : 1
      this.nextTwitch = 1.2 + Math.random() * 3 * (1 - o.startle * .7)
    }
    this.twitch = ease(this.twitch, 0, 7, dt)
    for (const [side, s] of [['left', 1], ['right', -1]] as const) {
      const a = this.driven[`antenna_${side}`]
      if (!a) continue
      const lift = Math.sin(this.time * 2.4 + s) * .05 + this.twitch * (s === this.twitchSide ? .3 : .1)
        + o.startle * .2
      QA.setFromAxisAngle(a.left, -lift)
      a.bone.quaternion.copy(QA).multiply(a.rest)
    }

    // Squash on landing, stretch on takeoff: along the body, which is this model's X.
    const air = o.airborne
    this.pose.scale.set(1 + air * .10, 1 - air * .10, 1 + air * .06)
    this.pose.position.y = air * this.bodyLen * .5
    this.pose.rotation.z = -air * .22                            // nose up

    if (this.eyeMat) this.eyeMat.emissive.setHex(EYE).multiplyScalar(.06 + o.startle * .4)
  }
}
