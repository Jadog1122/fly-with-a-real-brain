// The fly's world, in three.js.
//
// Props are Quaternius's Stylized Nature MegaKit (CC0, opengameart.org) loaded as glTF.
// At a fly's scale a clover is a canopy, a pebble is a boulder and a blade of grass is a
// tree, so the arena wall is a real ring of rocks rather than an invisible edge.
// The fly itself is procedural (there is no CC0 Drosophila) and flat-shaded to sit in
// the same style.

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Fly3D } from './fly3d'
import type { Action } from './motor'
import type { Stim } from './sensors'
import type { World } from './world'

const M = 'models/nature/'
/** Quaternius units -> arena units.  A fly is ~50 arena units long. */
const S = 62

// which prop stands in for which stimulus.  Geosmin is the smell of mould, so its
// token is literally a mushroom.
export const STIM_PROP: Record<string, { file: string; scale: number; y: number }> = {
  sugar:   { file: 'Flower_4_Single', scale: S * 0.9, y: 0 },
  bitter:  { file: 'Mushroom_Laetiporus', scale: S * 0.8, y: 0 },
  odor:    { file: 'Mushroom_Common', scale: S * 1.0, y: 0 },
  bristle: { file: 'Petal_2', scale: S * 1.6, y: 0 },
  touch:   { file: 'Grass_Wispy_Tall', scale: S * 1.1, y: 0 },
  looming: { file: 'Rock_Medium_1', scale: S * 2.2, y: 620 },    // falls from overhead
}

const SCENERY: [string, number, number][] = [
  // file, scale multiplier, how many
  ['Grass_Common_Tall', 1.15, 26], ['Grass_Common_Short', 1.0, 22],
  ['Grass_Wispy_Tall', 1.1, 14], ['Clover_1', 1.3, 9], ['Clover_2', 1.3, 7],
  ['Fern_1', 1.2, 5], ['Plant_1', 1.0, 6], ['Plant_7', 1.0, 5],
  ['Flower_3_Single', 0.9, 6], ['Mushroom_Common', 1.0, 4],
  ['Pebble_Round_1', 1.0, 7], ['Pebble_Round_2', 1.0, 6], ['Pebble_Square_1', 0.9, 5],
]
/** A dense skirt of planting just outside the kerb, to hide the horizon. */
const SKIRT: [string, number, number][] = [
  ['Grass_Common_Tall', 1.25, 40], ['Grass_Wispy_Tall', 1.2, 28],
  ['Clover_1', 1.5, 14], ['Clover_2', 1.5, 12], ['Fern_1', 1.4, 10],
]
const WALL: [string, number][] = [
  ['Pebble_Round_1', 0.85], ['Pebble_Square_1', 0.72],
  ['Pebble_Round_2', 0.9], ['Pebble_Square_2', 0.78],
]

/** A point on the rectangle's perimeter, parameterised 0..1. */
function perimeter(t: number, w: number, h: number): [number, number] {
  const per = 2 * (w + h)
  let d = t * per
  if (d < w) return [d, 0]
  d -= w
  if (d < h) return [w, d]
  d -= h
  if (d < w) return [w - d, h]
  return [0, h - (d - w)]
}

/** Deterministic scatter so the world is the same every visit. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
}

export class Scene3D {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly renderer: THREE.WebGLRenderer
  readonly fly = new Fly3D()

  private loader = new GLTFLoader()
  private cache = new Map<string, THREE.Group>()
  private stimObjects = new Map<number, THREE.Object3D>()
  private stimLayer = new THREE.Group()
  private shadow: THREE.Mesh
  private key: THREE.DirectionalLight
  private shake = 0
  controls: OrbitControls
  overview = false
  private loomShadows = new Map<number, THREE.Mesh>()
  private camTarget = new THREE.Vector3()
  private particles: { mesh: THREE.Mesh; vx: number; vy: number; vz: number; life: number }[] = []
  private particleGeo = new THREE.TetrahedronGeometry(3.2)
  private crumbMats = new Map<number, THREE.MeshStandardMaterial>()
  private airborne = 0
  ready = false

  constructor(host: HTMLElement, private world: World) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.08
    host.appendChild(this.renderer.domElement)

    this.scene.background = new THREE.Color(0x9fd0ea)
    this.scene.fog = new THREE.Fog(0x9fd0ea, 620, 1500)

    this.camera = new THREE.PerspectiveCamera(38, 1, 10, 4000)

    // warm sun, cool sky bounce
    this.key = new THREE.DirectionalLight(0xfff0d8, 2.5)
    this.key.position.set(380, 620, 260)
    this.key.castShadow = true
    this.key.shadow.mapSize.set(2048, 2048)
    const d = 620
    Object.assign(this.key.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 60, far: 1800 })
    this.key.shadow.bias = -0.0012
    this.scene.add(this.key, this.key.target)
    this.scene.add(new THREE.HemisphereLight(0xbfe4ff, 0x4a6b3a, 1.15))

    // ground
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(1300, 64),
      new THREE.MeshStandardMaterial({ color: 0x6f9c4a, roughness: .96 }))
    ground.rotation.x = -Math.PI / 2
    ground.position.set(this.world.w / 2, 0, this.world.h / 2)
    ground.receiveShadow = true
    this.scene.add(ground)
    // The clearing used to be an opaque rectangle laid on the grass, which met it
    // at a hard seam and read as a decal.  Same rectangle, but feathered through an
    // alpha map so the worn ground fades into the meadow at its edge.
    const fade = document.createElement('canvas')
    fade.width = fade.height = 256
    const fx = fade.getContext('2d')!
    fx.filter = 'blur(23px)'
    fx.fillStyle = '#fff'
    fx.beginPath()
    fx.roundRect(22, 22, 212, 212, 58)
    fx.fill()
    const dirt = new THREE.Mesh(
      new THREE.PlaneGeometry(this.world.w - 10, this.world.h - 10),
      new THREE.MeshStandardMaterial({
        color: 0x8a7350, roughness: 1, transparent: true, depthWrite: false,
        alphaMap: new THREE.CanvasTexture(fade),
      }))
    dirt.rotation.set(-Math.PI / 2, 0, 0)
    dirt.position.set(this.world.w / 2, .6, this.world.h / 2)
    dirt.receiveShadow = true
    this.scene.add(dirt)

    // contact shadow that follows the fly
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(34, 24),
      new THREE.MeshBasicMaterial({ color: 0x1d2a12, transparent: true, opacity: .34, depthWrite: false }))
    this.shadow.rotation.x = -Math.PI / 2
    this.scene.add(this.shadow)

    this.fly.root.scale.setScalar(34)
    this.scene.add(this.fly.root)
    this.scene.add(this.stimLayer)

    // frame the fly on the very first render rather than easing in from the origin
    const f = world.fly
    this.camTarget.set(f.x, 26, f.y)
    this.camera.position.set(f.x - Math.cos(f.h) * 250, 340, f.y - Math.sin(f.h) * 250)
    this.camera.lookAt(this.camTarget)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = .08
    this.controls.minDistance = 120
    this.controls.maxDistance = 1400
    this.controls.maxPolarAngle = Math.PI / 2.12      // never go under the ground
    this.controls.enablePan = false

    this.populate()
    this.resize(host)
    new ResizeObserver(() => this.resize(host)).observe(host)
  }

  private load(file: string): Promise<THREE.Group> {
    const hit = this.cache.get(file)
    if (hit) return Promise.resolve(hit)
    return new Promise((res, rej) => {
      this.loader.load(`${M}${file}.gltf`, g => {
        g.scene.traverse(o => {
          if ((o as THREE.Mesh).isMesh) {
            const m = o as THREE.Mesh
            m.castShadow = true; m.receiveShadow = true
            const mat = m.material as THREE.MeshStandardMaterial
            if (mat) { mat.roughness = .92; mat.metalness = 0 }
          }
        })
        this.cache.set(file, g.scene)
        res(g.scene)
      }, undefined, rej)
    })
  }

  private async populate() {
    const r = rng(7)
    const { w, h } = this.world
    const MARGIN = 26            // World.step bounces the fly at this inset

    // The wall follows the rectangle the physics actually bounces off, not a circle.
    // Getting this wrong put the scenery inside the walkable area and buried the camera.
    const ring: [number, number][] = []
    const stepX = (w - MARGIN * 2) / 13, stepZ = (h - MARGIN * 2) / 9
    for (let i = 0; i <= 13; i++) {
      ring.push([MARGIN + i * stepX, MARGIN - 6], [MARGIN + i * stepX, h - MARGIN + 6])
    }
    for (let i = 1; i < 9; i++) {
      ring.push([MARGIN - 6, MARGIN + i * stepZ], [w - MARGIN + 6, MARGIN + i * stepZ])
    }
    for (let i = 0; i < ring.length; i++) {
      const [file, mul] = WALL[i % WALL.length]
      const proto = await this.load(file).catch(() => null)
      if (!proto) continue
      const o = proto.clone(true)
      o.position.set(ring[i][0], -14, ring[i][1])
      o.rotation.y = r() * Math.PI * 2
      o.scale.setScalar(S * mul * (0.95 + r() * 0.45))
      this.scene.add(o)
    }

    // a close skirt of tall planting just beyond the kerb
    for (const [file, mul, count] of SKIRT) {
      const proto = await this.load(file).catch(() => null)
      if (!proto) continue
      for (let i = 0; i < count; i++) {
        // along the rectangle's perimeter, pushed outward - an ellipse here dropped
        // grass inside the arena at the diagonals and hid the kerb
        const [px, pz] = perimeter(r(), w, h)
        const out = 26 + r() * 150
        const nx = px < w / 2 ? -1 : 1, nz = pz < h / 2 ? -1 : 1
        const edgeX = Math.min(px, w - px) < Math.min(pz, h - pz)
        const o = proto.clone(true)
        o.position.set(px + (edgeX ? nx * out : (r() - .5) * 60),
                       -6,
                       pz + (edgeX ? (r() - .5) * 60 : nz * out))
        o.rotation.y = r() * Math.PI * 2
        o.scale.setScalar(S * mul * (0.8 + r() * 0.6))
        this.scene.add(o)
      }
    }

    // scenery lives strictly outside that rectangle
    for (const [file, mul, count] of SCENERY) {
      const proto = await this.load(file).catch(() => null)
      if (!proto) continue
      for (let i = 0; i < count; i++) {
        let x = 0, z = 0
        for (let tries = 0; tries < 20; tries++) {
          const a = r() * Math.PI * 2
          const rad = 380 + r() * 380
          x = w / 2 + Math.cos(a) * rad
          z = h / 2 + Math.sin(a) * rad
          const inside = x > -40 && x < w + 40 && z > -40 && z < h + 40
          if (!inside) break
        }
        const o = proto.clone(true)
        o.position.set(x, 0, z)
        o.rotation.y = r() * Math.PI * 2
        o.scale.setScalar(S * mul * (0.9 + r() * 0.7))
        this.scene.add(o)
      }
    }
    // Litter on the bare earth: without it the arena floor reads as a paved road.
    // The first pass scattered three near-identical pebbles uniformly, every piece
    // level and floating 0.4 above the dirt, which read as even noise - and flat
    // pebbles seen at a grazing angle looked like little open books.  Same kit, but
    // every pebble and petal variant is used, pieces fall in drifts rather than
    // uniformly, and each one is tilted and bedded into the surface.
    const LITTER: [string, number, number][] = [
      ['Pebble_Round_1', .22, 12], ['Pebble_Square_1', .18, 10],
      ['Pebble_Round_2', .20, 9],  ['Pebble_Round_3', .19, 9],
      ['Pebble_Square_2', .17, 8], ['Petal_1', .50, 7],
      ['Petal_3', .45, 6],         ['Petal_2', .48, 6],
    ]
    const drifts: [number, number][] = Array.from({ length: 7 },
      () => [90 + r() * (w - 180), 90 + r() * (h - 180)])
    for (const [file, mul, count] of LITTER) {
      const proto = await this.load(file).catch(() => null)
      if (!proto) continue
      const petal = file.startsWith('Petal')
      for (let i = 0; i < count; i++) {
        const o = proto.clone(true)
        let x: number, z: number
        if (r() < .72) {                        // most pieces belong to a drift
          const [cx, cz] = drifts[(r() * drifts.length) | 0]
          x = cx + (r() + r() - 1) * 115
          z = cz + (r() + r() - 1) * 115
        } else {                                // the rest are strays
          x = 60 + r() * (w - 120)
          z = 60 + r() * (h - 120)
        }
        // the dirt sits at y 0.6, so petals rest on it and pebbles sink a little
        o.position.set(Math.max(45, Math.min(w - 45, x)), petal ? .75 : .42,
                       Math.max(45, Math.min(h - 45, z)))
        o.rotation.set((r() - .5) * .55, r() * Math.PI * 2, (r() - .5) * .55)
        o.scale.setScalar(S * mul * (0.6 + r() * 0.8))
        // a pebble with no shadow floats; petals lie flat enough not to need one
        o.traverse(m => { (m as THREE.Mesh).castShadow = !petal })
        this.scene.add(o)
      }
    }
    this.ready = true
  }

  private resize(host: HTMLElement) {
    const b = host.getBoundingClientRect()
    if (!b.width || !b.height) return
    this.renderer.setSize(b.width, b.height)
    this.camera.aspect = b.width / Math.max(b.height, 1)
    this.camera.updateProjectionMatrix()
  }

  /** Keep the 3-D tokens in sync with the arena's stimulus list. */
  private async syncStimuli(stims: Stim[]) {
    const alive = new Set(stims.map(s => s.id))
    for (const [id, obj] of this.stimObjects) {
      if (!alive.has(id)) { this.stimLayer.remove(obj); this.stimObjects.delete(id) }
    }
    for (const s of stims) {
      if (this.stimObjects.has(s.id)) continue
      const spec = STIM_PROP[s.kind.id]
      if (!spec) continue
      const proto = await this.load(spec.file).catch(() => null)
      if (!proto) continue
      const o = proto.clone(true)
      o.scale.setScalar(spec.scale)
      o.userData.baseY = spec.y
      this.stimObjects.set(s.id, o)
      this.stimLayer.add(o)
    }
    for (const s of stims) {
      const o = this.stimObjects.get(s.id)
      if (o) o.position.set(s.x, o.userData.baseY ?? 0, s.y)
    }
  }

  spawnCrumbs(x: number, z: number, colour: number) {
    // Crumbs are retired in the render loop, but the fly goes on eating when the page
    // is not being painted (its clock comes from the worker, not rAF).  So share one
    // material per colour and hard-cap the pool - otherwise a backgrounded tab grows
    // both meshes and materials without bound.
    let mat = this.crumbMats.get(colour)
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color: colour, roughness: .8 })
      this.crumbMats.set(colour, mat)
    }
    for (let i = 0; i < 7; i++) {
      const m = new THREE.Mesh(this.particleGeo, mat)
      m.position.set(x, 14, z)
      this.scene.add(m)
      this.particles.push({
        mesh: m, life: 1,
        vx: (Math.random() - .5) * 150, vy: 90 + Math.random() * 120, vz: (Math.random() - .5) * 150,
      })
    }
    while (this.particles.length > 120) {
      this.scene.remove(this.particles.shift()!.mesh)
    }
  }

  kick(amount: number) { this.shake = Math.min(1, this.shake + amount) }

  /** Pull back to see the whole arena, or drop back in behind the fly. */
  setOverview(on: boolean) {
    this.overview = on
    const f = this.world.fly
    const p = on
      ? new THREE.Vector3(this.world.w / 2, 820, this.world.h / 2 + 520)
      : new THREE.Vector3(f.x - Math.cos(f.h) * 250, 340, f.y - Math.sin(f.h) * 250)
    this.camera.position.copy(p)
    // The overview sits ~970 units out, which put the whole arena inside a fog band
    // tuned for the follow camera and washed it to flat grey.  Push the haze back so
    // the wide shot keeps its colour; restore the close range on the way down.
    const fog = this.scene.fog as THREE.Fog
    if (on) { fog.near = 1250; fog.far = 3200 } else { fog.near = 620; fog.far = 1500 }
  }

  render(dt: number, action: Action, stims: Stim[]) {
    void this.syncStimuli(stims)
    const f = this.world.fly

    this.airborne += ((action.escape ? 1 : 0) - this.airborne) * Math.min(1, dt * 7)
    this.fly.root.position.set(f.x, 0, f.y)
    this.fly.root.rotation.y = -f.h + Math.PI
    this.fly.update(dt, {
      speed: f.speed, legPhase: f.legPhase, escape: action.escape,
      proboscis: action.proboscis, groom: action.groom, startle: f.startle,
      airborne: this.airborne,
    })

    this.shadow.position.set(f.x, 1.2, f.y)
    const lift = 1 - this.airborne * .55
    this.shadow.scale.setScalar(lift)
    ;(this.shadow.material as THREE.MeshBasicMaterial).opacity = .34 * lift

    // A looming stimulus is a thing falling towards you, so it has to fall: it drops
    // from 620 to just overhead on a ~2.4 s cycle and drags a shadow that widens as it
    // comes.  Sitting it on the ground as a pebble made the most dramatic behaviour in
    // the whole model look like scenery.
    for (const st of stims) {
      const o = this.stimObjects.get(st.id)
      if (!o || st.kind.id !== 'looming') continue
      const cycle = (performance.now() % 2400) / 2400
      const drop = 1 - Math.pow(1 - cycle, 2.6)              // slow away, fast near
      o.position.y = 620 - drop * 520
      o.rotation.y += dt * .8
      o.rotation.x = drop * .4
      let sh = this.loomShadows.get(st.id)
      if (!sh) {
        sh = new THREE.Mesh(new THREE.CircleGeometry(1, 28),
          new THREE.MeshBasicMaterial({ color: 0x14240c, transparent: true, depthWrite: false }))
        sh.rotation.x = -Math.PI / 2
        this.scene.add(sh)
        this.loomShadows.set(st.id, sh)
      }
      sh.position.set(st.x, 2.2, st.y)
      sh.scale.setScalar(40 + drop * 150)
      ;(sh.material as THREE.MeshBasicMaterial).opacity = .12 + drop * .42
    }
    for (const [id, sh] of this.loomShadows) {
      if (!stims.some(x => x.id === id)) { this.scene.remove(sh); this.loomShadows.delete(id) }
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      p.life -= dt * 1.2
      p.vy -= 420 * dt
      p.mesh.position.x += p.vx * dt
      p.mesh.position.y = Math.max(2, p.mesh.position.y + p.vy * dt)
      p.mesh.position.z += p.vz * dt
      p.mesh.rotation.x += dt * 6; p.mesh.rotation.z += dt * 4
      if (p.life <= 0) { this.scene.remove(p.mesh); this.particles.splice(i, 1) }
    }

    // a 3/4 chase camera that lags behind the fly, plus a shake on takeoff
    this.shake = Math.max(0, this.shake - dt * 2.6)
    // The camera orbits a target you can spin and zoom; the target is what follows the
    // fly (or the whole arena in overview), so looking around never fights the chase.
    const goal = this.overview
      ? new THREE.Vector3(this.world.w / 2, 0, this.world.h / 2)
      : new THREE.Vector3(f.x, 26, f.y)
    this.camTarget.lerp(goal, Math.min(1, dt * (this.overview ? 1.6 : 2.6)))
    this.controls.target.copy(this.camTarget)
    const sh = this.shake * 12
    this.camera.position.x += (Math.random() - .5) * sh
    this.camera.position.y += (Math.random() - .5) * sh
    this.controls.update()

    this.key.target.position.copy(this.camTarget)
    this.key.position.set(this.camTarget.x + 380, 620, this.camTarget.z + 260)

    this.renderer.render(this.scene, this.camera)
  }
}
