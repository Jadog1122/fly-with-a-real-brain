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

/**
 * Where each sense the brain is told about actually sits on the body. The mind view draws
 * a stimulus reaching the fly at these points, so they have to be the real organs:
 *   antenna   Johnston's organ (vibration) and the olfactory neurons (smell)
 *   eye       LC4, the looming detectors, look out through the compound eyes
 *   foot      the tarsal taste neurons, on the front feet
 *   labellum  the taste pads at the tip of the proboscis, sugar and bitter both
 *   head      the head bristles - which is what "Dust" drives: every bristle neuron in
 *             this connectome is on the head (antenna base, frons, eye, proboscis)
 */
export type Organ = 'antenna' | 'eye' | 'foot' | 'labellum' | 'head'
export type Side = 'left' | 'right'

// scratch, so the per-frame code allocates nothing
const QA = new THREE.Quaternion()
const QB = new THREE.Quaternion()
const V1 = new THREE.Vector3()
const M1 = new THREE.Matrix4()

// How many pollen specks the head can carry, and how fast grooming visibly sheds them.
const SPECKS = 56

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

  // what the body shows of the fly's state, rather than of what it is doing
  private anchors = new Map<string, THREE.Object3D>()
  private specks?: THREE.InstancedMesh
  private specksShown = 0
  private fallen: THREE.Vector3[] = []
  private belly: { bone: THREE.Object3D; axis: 'x' | 'y' | 'z'; grow: number }[] = []
  /** Pollen on the head, 0..1; set by the engine from mind.ts when update() is not told. */
  dust = 0

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

    this.findOrgans(src)

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

  /**
   * Pin the sense organs, the pollen specks and the belly to the skeleton. The rig binds
   * every vertex to exactly one bone, so an organ is simply the vertices of its bone -
   * measured here in the bind pose, before the model inherits the root's scale, and
   * pinned to that bone so it follows every clip.
   */
  private findOrgans(src: THREE.Object3D) {
    const byBone = new Map<string, THREE.Vector3[]>()
    const eye: THREE.Vector3[] = []
    let bones: THREE.Bone[] = []
    src.traverse(o => {
      const m = o as THREE.SkinnedMesh
      if (!m.isSkinnedMesh) return
      bones = m.skeleton.bones
      m.skeleton.update()
      const si = m.geometry.getAttribute('skinIndex')
      const sw = m.geometry.getAttribute('skinWeight')
      if (!si || !sw) return
      const isEye = (m.material as THREE.Material).name === 'fly_eye'
      for (let i = 0; i < si.count; i++) {
        let best = 0, most = -1
        for (let k = 0; k < 4; k++) {
          const w = sw.getComponent(i, k)
          if (w > most) { most = w; best = si.getComponent(i, k) }
        }
        const p = m.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(m.matrixWorld)
        if (isEye) { eye.push(p); continue }
        const name = m.skeleton.bones[best]?.name
        if (!name) continue
        let list = byBone.get(name)
        if (!list) byBone.set(name, list = [])
        list.push(p)
      }
    })
    const bone = (name: string) => bones.find(b => b.name === name)
    const pin = (key: string, on: THREE.Object3D | undefined, at: THREE.Vector3 | null) => {
      if (!on || !at) return
      const a = new THREE.Object3D()
      a.position.copy(on.worldToLocal(at.clone()))
      on.add(a)
      this.anchors.set(key, a)
    }
    const centroid = (ps: THREE.Vector3[] | undefined) => {
      if (!ps?.length) return null
      const c = new THREE.Vector3()
      for (const p of ps) c.add(p)
      return c.divideScalar(ps.length)
    }
    // the share of an organ's points furthest along a direction: its outer surface
    const outermost = (ps: THREE.Vector3[], dir: THREE.Vector3, share: number) =>
      centroid([...ps].sort((a, b) => b.dot(dir) - a.dot(dir))
        .slice(0, Math.max(1, Math.round(ps.length * share))))

    const head = bone('head')
    for (const [side, s] of [['left', 1], ['right', -1]] as const) {
      const ab = bone(`antenna_${side}`)
      const ant = byBone.get(`antenna_${side}`)
      if (ab && ant) {
        const base = ab.getWorldPosition(new THREE.Vector3())
        pin(`antenna_${side}`, ab,
            ant.reduce((far, p) => p.distanceTo(base) > far.distanceTo(base) ? p : far, base))
      }
      const eyeSide = eye.filter(p => p.z * s > 0)
      if (eyeSide.length) pin(`eye_${side}`, head, outermost(eyeSide, LEFT.clone().multiplyScalar(s), 0.12))
      pin(`foot_${side}`, bone(`tarsal_claw_T1_${side}`), centroid(byBone.get(`tarsal_claw_T1_${side}`)))
    }
    pin('labellum_mid', bone('labrum_left'),
        centroid([...byBone.get('labrum_left') ?? [], ...byBone.get('labrum_right') ?? []]))
    pin('head_mid', head, centroid(byBone.get('head')))

    // Pollen specks where the bristles are: mostly over the eyes, the rest on the head
    // capsule. Parented to the head, so they ride every nod and every grooming pass.
    if (head) {
      const hc = centroid(byBone.get('head')) ?? head.getWorldPosition(new THREE.Vector3())
      const pool = [...eye, ...eye, ...byBone.get('head') ?? []]
      let seed = 7
      const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
      const hs = head.getWorldScale(new THREE.Vector3()).x || 1
      // bigger than real pollen, which is a few hundredths of a millimetre: at the chase
      // camera's distance real grains would be a pixel, and the point is to see them
      const r = this.bodyLen * 0.02 / hs
      const im = new THREE.InstancedMesh(
        new THREE.IcosahedronGeometry(1, 0),
        new THREE.MeshStandardMaterial({ color: 0xffd65a, roughness: 0.5, emissive: 0x6a4a08 }),
        SPECKS)
      im.frustumCulled = false
      im.count = 0
      const q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3()
      for (let i = 0; i < SPECKS && pool.length; i++) {
        const p = pool[Math.floor(rnd() * pool.length)]
        const out = p.clone().sub(hc).normalize()
        const local = head.worldToLocal(p.clone().addScaledVector(out, this.bodyLen * 0.006))
        q.setFromEuler(e.set(rnd() * 6, rnd() * 6, rnd() * 6))
        const k = r * (0.6 + rnd() * 0.9)
        im.setMatrixAt(i, M1.compose(local, q, sc.set(k, k * (0.7 + rnd() * 0.5), k)))
      }
      head.add(im)
      this.specks = im
    }

    // The belly: a crop full of sugar distends the abdomen. Widen the middle segments and
    // take the width back off at the tip, across each bone, never along it - the chain's
    // own axis is whichever way its next bone lies.
    for (const [name, grow] of [['abdomen_2', 1], ['abdomen_6', -1]] as const) {
      const b = bone(name)
      const next = b?.children.find(c => (c as THREE.Bone).isBone)
      if (!b || !next) continue
      const d = next.position
      const ax = Math.abs(d.x) >= Math.max(Math.abs(d.y), Math.abs(d.z)) ? 'x'
        : Math.abs(d.y) >= Math.abs(d.z) ? 'y' : 'z'
      this.belly.push({ bone: b, axis: ax, grow })
    }
  }

  /** Where a sense organ is in the world; false until the model has loaded. */
  organ(organ: Organ, side: Side, out: THREE.Vector3): boolean {
    const a = this.anchors.get(`${organ}_${side}`) ?? this.anchors.get(`${organ}_mid`)
    if (!a) return false
    a.getWorldPosition(out)
    return true
  }

  /** World positions of the specks groomed off since the last call. */
  takeFallen(): THREE.Vector3[] {
    const out = this.fallen
    this.fallen = []
    return out
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
    /** 0 starving .. 1 just fed: how full the crop is */
    satiety?: number
    /** 0..1, pollen on the head bristles (mind.ts) */
    dust?: number
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

    // The belly, about the model's own build at half full: thinner starving, rounder fed.
    this.fill = ease(this.fill, o.satiety ?? 0.5, 1.5, dt)
    const k = 1 + 0.22 * (this.fill - 0.5)
    for (const b of this.belly) {
      const s = b.grow > 0 ? k : 1 / k
      b.bone.scale.set(b.axis === 'x' ? 1 : s, b.axis === 'y' ? 1 : s, b.axis === 'z' ? 1 : s)
    }

    // Pollen on the head. Specks going means grooming took them: hand their positions
    // over so the mind view can drop them, rather than have them blink out.
    const im = this.specks
    if (im) {
      const n = Math.round(THREE.MathUtils.clamp(o.dust ?? this.dust, 0, 1) * SPECKS)
      if (n < this.specksShown && this.fallen.length < 60) {
        for (let i = n; i < this.specksShown; i++) {
          im.getMatrixAt(i, M1)
          this.fallen.push(V1.setFromMatrixPosition(M1.premultiply(im.matrixWorld)).clone())
        }
      }
      this.specksShown = n
      im.count = n
    }
  }

  private fill = 0.5
}
