// The fly's world, in three.js.
//
// Props are Quaternius's Stylized Nature MegaKit (CC0, opengameart.org) loaded as glTF.
// At a fly's scale a clover is a canopy, a pebble is a boulder and a blade of grass is a
// tree, so the arena wall is a real ring of rocks rather than an invisible edge.
// The fly itself is Maf'j Alvarez's CC-BY "shy fly", flat-shaded to sit in the same
// style and rigged at load time in fly3d.ts.  See NOTICE.

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { Sky } from 'three/examples/jsm/objects/Sky.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader.js'
import { BrightnessContrastShader } from 'three/examples/jsm/shaders/BrightnessContrastShader.js'
import type { Quality } from './save'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Fly3D } from './fly3d'
import type { Action } from './motor'
import type { Stim } from './sensors'
import type { World } from './world'

// The kit's 22 models share 5 textures, and GLTFLoader fetches them all in parallel -
// so the same PNG was requested up to 6 times before the HTTP cache filled, 3.1 MB of
// a 5.3 MB first load. three's loader cache is off by default; this dedupes them.
THREE.Cache.enabled = true

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
  private particles: {
    mesh: THREE.Mesh; vx: number; vy: number; vz: number
    life: number; decay: number; grav: number; drag: number
    spin: number; grow: number; fade: boolean
  }[] = []
  private particleGeo = new THREE.TetrahedronGeometry(3.2)
  private puffGeo = new THREE.SphereGeometry(1, 7, 5)
  private crumbMats = new Map<number, THREE.MeshStandardMaterial>()
  private puffMat = new THREE.MeshStandardMaterial({
    color: 0xbda780, roughness: 1, transparent: true, opacity: .5, depthWrite: false,
  })
  private sparkMat = new THREE.MeshStandardMaterial({
    color: 0xffe6a8, roughness: .6, emissive: 0x6a4a12, transparent: true, opacity: .9,
    depthWrite: false,
  })
  private footCooldown = 0
  private wasAirborne = 0

  // adaptive quality
  private quality: Quality = 'high'
  private fpsTime = 0
  private fpsFrames = 0
  private lastDegrade = 0
  /** Called when the renderer decides it has to drop a tier to keep up. */
  onDegrade: ((q: Quality) => void) | null = null
  private airborne = 0
  ready = false

  constructor(host: HTMLElement, private world: World) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))   // replaced by setQuality
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.08
    host.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(38, 1, 10, 4000)

    // The sky was a flat fill colour. This is three's own Sky - a Rayleigh/Mie
    // scattering dome - so the horizon actually warms and the zenith deepens, and the
    // sun sits where the key light is rather than being implied.
    const sky = new Sky()
    sky.scale.setScalar(20000)
    const u = sky.material.uniforms
    u.turbidity.value = 4.5          // haze: low, so the meadow keeps its colour
    u.rayleigh.value = 1.6           // how blue the sky gets away from the sun
    u.mieCoefficient.value = 0.006
    u.mieDirectionalG.value = 0.8    // tightness of the glow around the sun
    const SUN = new THREE.Vector3(380, 620, 260).normalize()
    u.sunPosition.value.copy(SUN)
    this.scene.add(sky)

    // Light the scene from that same sky rather than from a guessed ambient colour:
    // PMREM turns the dome into an environment map, which is what gives the props
    // their bounce and their sky-tinted shadow side.
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    pmrem.compileEquirectangularShader()
    const skyRT = pmrem.fromScene(sky as unknown as THREE.Scene)
    this.scene.environment = skyRT.texture
    this.scene.environmentIntensity = 0.26   // enough to tint the shade, not to flatten it
    pmrem.dispose()

    // Fog tinted to the sky's horizon, not to the old flat blue, or distant grass
    // reads as a different colour from the sky behind it.
    this.scene.fog = new THREE.Fog(0xb4d3e6, 780, 1700)

    // warm sun
    this.key = new THREE.DirectionalLight(0xfff0d8, 2.7)
    this.key.position.set(380, 620, 260)
    this.key.castShadow = true
    this.key.shadow.mapSize.set(2048, 2048)
    const d = 620
    Object.assign(this.key.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 60, far: 1800 })
    this.key.shadow.bias = -0.0012
    this.key.shadow.normalBias = 1.2   // stops thin grass blades shadow-acneing themselves
    this.scene.add(this.key, this.key.target)

    // A cool fill from the opposite side, so the shadow side of a prop is modelled
    // rather than flat. Half the key's intensity and no shadow of its own.
    const fill = new THREE.DirectionalLight(0xbcd8ff, 0.34)
    fill.position.set(-320, 260, -420)
    this.scene.add(fill)

    // Ground bounce only - the sky half of this is now doing its job through the
    // environment map, so the hemisphere light is much weaker than it was.
    this.scene.add(new THREE.HemisphereLight(0xbfe4ff, 0x5a7b42, 0.22))

    // Ground.  Both surfaces were a single flat colour over a very large area, which
    // reads as paper however good the lighting is.  The Quaternius kit is flat-shaded
    // and has no tileable ground texture to borrow, and bolting a normal map onto a
    // faceted kit would fight its style - so this is low-frequency mottling only:
    // enough value variation to break the flatness, no surface detail that pretends
    // the ground is photographic.
    const mottle = (cells: number, contrast: number) => {
      const c = document.createElement('canvas')
      c.width = c.height = 256
      const g = c.getContext('2d')!
      g.fillStyle = '#808080'
      g.fillRect(0, 0, 256, 256)
      // a few octaves of soft blobs, wrapped by drawing each one nine times
      for (let oct = 0; oct < 3; oct++) {
        const n = cells * (oct + 1) * 3
        const rad = 150 / (oct + 1)
        g.globalAlpha = contrast / (oct + 1.4)   // contrast is now ~0.2, not ~0.6
        for (let i = 0; i < n; i++) {
          const x = Math.random() * 256, y = Math.random() * 256
          // near-grey, not black and white: the map multiplies the base colour, so a
          // full-range blob reads as scorched ground rather than as uneven soil
          const v = Math.random() < .5 ? 112 : 146
          for (const [dx, dy] of [[0, 0], [256, 0], [-256, 0], [0, 256], [0, -256],
                                  [256, 256], [-256, -256], [256, -256], [-256, 256]]) {
            const grd = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad)
            grd.addColorStop(0, `rgba(${v},${v},${v},1)`)
            grd.addColorStop(1, `rgba(${v},${v},${v},0)`)
            g.fillStyle = grd
            g.beginPath(); g.arc(x + dx, y + dy, rad, 0, 6.2832); g.fill()
          }
        }
      }
      g.globalAlpha = 1
      const t = new THREE.CanvasTexture(c)
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.colorSpace = THREE.SRGBColorSpace
      return t
    }

    const grassTex = mottle(5, 0.22)
    grassTex.repeat.set(7, 7)
    const dirtTex = mottle(7, 0.26)
    dirtTex.repeat.set(6, 6)

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(1300, 64),
      new THREE.MeshStandardMaterial({ color: 0x6f9c4a, roughness: .96,
                                       map: grassTex, roughnessMap: grassTex }))
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
    // roundRect only landed in Safari 16.4; a plain rect through the same blur still
    // feathers the edge, it just loses the rounded corners
    if (typeof fx.roundRect === 'function') fx.roundRect(22, 22, 212, 212, 58)
    else fx.rect(30, 30, 196, 196)
    fx.fill()
    const dirt = new THREE.Mesh(
      new THREE.PlaneGeometry(this.world.w - 10, this.world.h - 10),
      new THREE.MeshStandardMaterial({
        color: 0x8a7350, roughness: 1, transparent: true, depthWrite: false,
        alphaMap: new THREE.CanvasTexture(fade),
        map: dirtTex, roughnessMap: dirtTex,
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
      this.place(file, ring[i][0], -14, ring[i][1],
                 0, r() * Math.PI * 2, 0, S * mul * (0.95 + r() * 0.45), true)
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
        const sx = px + (edgeX ? nx * out : (r() - .5) * 60)
        const sz = pz + (edgeX ? (r() - .5) * 60 : nz * out)
        this.place(file, sx, -6, sz, 0, r() * Math.PI * 2, 0,
                   S * mul * (0.8 + r() * 0.6), true)
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
        this.place(file, x, 0, z, 0, r() * Math.PI * 2, 0,
                   S * mul * (0.9 + r() * 0.7), true)
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
        let x: number, z: number
        if (r() < .72) {                        // most pieces belong to a drift
          const [cx, cz] = drifts[(r() * drifts.length) | 0]
          x = cx + (r() + r() - 1) * 115
          z = cz + (r() + r() - 1) * 115
        } else {                                // the rest are strays
          x = 60 + r() * (w - 120)
          z = 60 + r() * (h - 120)
        }
        // the dirt sits at y 0.6, so petals rest on it and pebbles sink a little.
        // A pebble with no shadow floats; petals lie flat enough not to need one.
        this.place(file,
                   Math.max(45, Math.min(w - 45, x)), petal ? .75 : .42,
                   Math.max(45, Math.min(h - 45, z)),
                   (r() - .5) * .55, r() * Math.PI * 2, (r() - .5) * .55,
                   S * mul * (0.6 + r() * 0.8), !petal)
      }
    }
    await this.buildInstances()
    this.ready = true
  }

  /**
   * Record where a prop goes instead of cloning it. Scenery, the kerb, the skirt and
   * the litter are all static, and the kit reuses 49 geometries across 374 objects, so
   * they are merged into InstancedMeshes once placement is finished.
   */
  private place(file: string, x: number, y: number, z: number,
                rx: number, ry: number, rz: number, s: number, shadow: boolean) {
    let list = this.placements.get(file)
    if (!list) this.placements.set(file, list = [])
    list.push({ x, y, z, rx, ry, rz, s, shadow })
  }

  /**
   * One InstancedMesh per (prototype part, shadow flag). The split on shadow is
   * needed because castShadow is a property of the object, not of an instance, and
   * petals deliberately do not cast one.
   */
  private async buildInstances() {
    const mat4 = new THREE.Matrix4()
    const quat = new THREE.Quaternion()
    const euler = new THREE.Euler()
    const pos = new THREE.Vector3()
    const scl = new THREE.Vector3()

    for (const [file, list] of this.placements) {
      const proto = await this.load(file).catch(() => null)
      if (!proto) continue

      // The old code overwrote the clone's root transform, so the prototype root's own
      // transform was never applied. Zero it here to keep the layout identical.
      proto.position.set(0, 0, 0)
      proto.rotation.set(0, 0, 0)
      proto.scale.setScalar(1)
      proto.updateMatrixWorld(true)

      const parts: { geo: THREE.BufferGeometry; mat: THREE.Material; local: THREE.Matrix4 }[] = []
      proto.traverse(o => {
        const mesh = o as THREE.Mesh
        if (mesh.isMesh) {
          parts.push({ geo: mesh.geometry, mat: mesh.material as THREE.Material,
                       local: mesh.matrixWorld.clone() })
        }
      })
      if (!parts.length) continue

      for (const shadow of [true, false]) {
        const subset = list.filter(pl => pl.shadow === shadow)
        if (!subset.length) continue
        for (const part of parts) {
          const im = new THREE.InstancedMesh(part.geo, part.mat, subset.length)
          im.castShadow = shadow
          im.receiveShadow = true
          for (let i = 0; i < subset.length; i++) {
            const pl = subset[i]
            euler.set(pl.rx, pl.ry, pl.rz)
            quat.setFromEuler(euler)
            pos.set(pl.x, pl.y, pl.z)
            scl.setScalar(pl.s)
            mat4.compose(pos, quat, scl).multiply(part.local)
            im.setMatrixAt(i, mat4)
          }
          im.instanceMatrix.needsUpdate = true
          // without this the bounds are one instance's, and the whole batch pops in
          // and out of view as the camera turns
          im.computeBoundingSphere()
          this.scene.add(im)
        }
      }
    }
    this.placements.clear()
  }

  private resize(host: HTMLElement) {
    const b = host.getBoundingClientRect()
    if (!b.width || !b.height) return
    this.renderer.setSize(b.width, b.height)
    this.camera.aspect = b.width / Math.max(b.height, 1)
    this.camera.updateProjectionMatrix()
    this.composer?.setSize(b.width, b.height)
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
        mesh: m, life: 1, decay: 1.2, grav: 420, drag: 0, spin: 1, grow: 0, fade: false,
        vx: (Math.random() - .5) * 150, vy: 90 + Math.random() * 120, vz: (Math.random() - .5) * 150,
      })
    }
    this.trimParticles()
  }

  private trimParticles() {
    while (this.particles.length > this.particleCap) {
      this.scene.remove(this.particles.shift()!.mesh)
    }
  }

  /**
   * Soft ground dust: kicked up by footfalls, thrown out on landing, and stirred while
   * grooming.  Slow, draggy and fading, so it reads as air rather than as debris - the
   * crumb tetrahedra are the only thing that should look solid.
   */
  private spawnPuff(x: number, z: number, n: number, speed: number, up: number, size: number) {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(this.puffGeo, this.puffMat)
      m.position.set(x + (Math.random() - .5) * 8, 2 + Math.random() * 4, z + (Math.random() - .5) * 8)
      m.scale.setScalar(size * (.6 + Math.random() * .8))
      this.scene.add(m)
      this.particles.push({
        mesh: m, life: 1, decay: 1.6, grav: 30, drag: 2.4, spin: .2, grow: 1.9, fade: true,
        vx: (Math.random() - .5) * speed, vy: up * (.5 + Math.random()), vz: (Math.random() - .5) * speed,
      })
    }
    this.trimParticles()
  }

  /** A bright scatter on takeoff, so an escape has a visible moment of impact. */
  private spawnSparks(x: number, z: number) {
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(this.particleGeo, this.sparkMat)
      m.position.set(x, 8, z)
      m.scale.setScalar(.45 + Math.random() * .5)
      this.scene.add(m)
      this.particles.push({
        mesh: m, life: 1, decay: 2.2, grav: 300, drag: .8, spin: 9, grow: 0, fade: true,
        vx: (Math.random() - .5) * 320, vy: 120 + Math.random() * 180, vz: (Math.random() - .5) * 320,
      })
    }
    this.trimParticles()
  }

  kick(amount: number) { this.shake = Math.min(1, this.shake + amount) }

  /**
   * Drop a quality tier if the frame rate will not hold.  Only ever downward, and at
   * most once every ten seconds, because stepping back up on a brief recovery makes
   * the picture flicker between settings.
   *
   * Frames while the page is hidden or mid-stall are thrown away rather than counted:
   * requestAnimationFrame is throttled or stopped there, and counting it would degrade
   * a machine that is coping perfectly well.
   */
  private measureFps(dt: number) {
    if (!this.ready || this.quality === 'low') return
    if (dt > 0.2 || document.visibilityState !== 'visible') return
    this.fpsTime += dt
    this.fpsFrames++
    if (this.fpsTime < 3) return

    const fps = this.fpsFrames / this.fpsTime
    this.fpsTime = 0
    this.fpsFrames = 0
    const now = performance.now()
    if (fps >= 24 || now - this.lastDegrade < 10_000) return

    this.lastDegrade = now
    this.onDegrade?.(this.quality === 'high' ? 'medium' : 'low')
  }

  /** Pull back to see the whole arena, or drop back in behind the fly. */
  private particleCap = 120
  private placements = new Map<string, {
    x: number; y: number; z: number
    rx: number; ry: number; rz: number
    s: number; shadow: boolean
  }[]>()

  /**
   * The three knobs worth turning. Resolution dominates fill cost, shadows dominate
   * the extra geometry pass, and particles are the only thing that grows without
   * bound during play.
   */
  private composer: EffectComposer | null = null

  /**
   * Post-processing, rebuilt per quality tier.
   *
   * The ambient-occlusion pass is the one that matters visually: every prop cast a
   * directional shadow already, but nothing darkened where it met the ground, so
   * pebbles and grass tufts read as floating. AO is what seats them.
   *
   * Low skips the composer entirely and renders straight to the screen.
   */
  private buildComposer(q: Quality) {
    this.composer?.dispose()
    this.composer = null
    if (q === 'low') return

    const b = this.renderer.domElement
    const w = b.width || 1, h = b.height || 1
    const c = new EffectComposer(this.renderer)
    c.setSize(w, h)
    c.addPass(new RenderPass(this.scene, this.camera))

    if (q === 'high') {
      const ao = new GTAOPass(this.scene, this.camera, w, h)
      ao.output = GTAOPass.OUTPUT.Default
      // the arena is ~760 units across and the props are small, so the sampling
      // radius is in tens of units, not the single-digit default
      ao.updateGtaoMaterial({ radius: 18, distanceExponent: 1.4, thickness: 12,
                              scale: 1.1, samples: 12 })
      c.addPass(ao)

      const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.22, 0.7, 0.92)
      c.addPass(bloom)   // threshold high: only the sunlit highlights, not the whole meadow
    }

    const grade = new ShaderPass(BrightnessContrastShader)
    grade.uniforms.brightness.value = 0.01
    grade.uniforms.contrast.value = 0.10
    c.addPass(grade)

    const vignette = new ShaderPass(VignetteShader)
    vignette.uniforms.offset.value = 1.05
    vignette.uniforms.darkness.value = 0.85
    c.addPass(vignette)

    c.addPass(new OutputPass())   // tone mapping and colour space, once, at the end
    this.composer = c
  }

  setQuality(q: Quality) {
    this.quality = q
    this.fpsTime = 0
    this.fpsFrames = 0
    const dpr = devicePixelRatio || 1
    if (q === 'low') {
      this.renderer.setPixelRatio(1)
      this.renderer.shadowMap.enabled = false
      this.particleCap = 35
    } else if (q === 'medium') {
      this.renderer.setPixelRatio(Math.min(dpr, 1.5))
      this.renderer.shadowMap.enabled = true
      this.key.shadow.mapSize.set(1024, 1024)
      this.particleCap = 70
    } else {
      this.renderer.setPixelRatio(Math.min(dpr, 2))
      this.renderer.shadowMap.enabled = true
      this.key.shadow.mapSize.set(2048, 2048)
      this.particleCap = 120
    }
    // the shadow map is allocated lazily, so it has to be dropped to be resized
    this.key.shadow.map?.dispose()
    this.key.shadow.map = null
    this.key.shadow.needsUpdate = true
    while (this.particles.length > this.particleCap) {
      this.scene.remove(this.particles.shift()!.mesh)
    }
    this.buildComposer(q)
  }

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

    this.measureFps(dt)
    this.airborne += ((action.escape ? 1 : 0) - this.airborne) * Math.min(1, dt * 7)

    // Ground contact, as dust.  Everything here is driven by decoded behaviour, so the
    // fly kicks up dirt for the same reason it walks.
    if (this.particleCap > 40) {                 // low quality skips this entirely
      const A = this.airborne, W = this.wasAirborne
      if (A > .35 && W <= .35) {                 // takeoff
        this.spawnSparks(f.x, f.y)
        this.spawnPuff(f.x, f.y, 7, 150, 70, 3.4)
      } else if (A < .25 && W >= .25) {          // landing
        this.spawnPuff(f.x, f.y, 6, 110, 45, 3.0)
      }
      this.footCooldown -= dt
      if (this.footCooldown <= 0) {
        const moving = Math.abs(f.speed) > 25 && A < .3
        if (moving) {
          this.spawnPuff(f.x, f.y, 1, 26, 16, 1.5)
          this.footCooldown = .16
        } else if (action.groom > .3) {
          this.spawnPuff(f.x, f.y, 1, 34, 26, 1.2)
          this.footCooldown = .22
        } else {
          this.footCooldown = .1
        }
      }
      this.wasAirborne = A
    }
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
      p.life -= dt * p.decay
      p.vy -= p.grav * dt
      if (p.drag) {
        const k = Math.max(0, 1 - p.drag * dt)
        p.vx *= k; p.vz *= k; p.vy *= k
      }
      p.mesh.position.x += p.vx * dt
      p.mesh.position.y = Math.max(2, p.mesh.position.y + p.vy * dt)
      p.mesh.position.z += p.vz * dt
      p.mesh.rotation.x += dt * 6 * p.spin
      p.mesh.rotation.z += dt * 4 * p.spin
      if (p.grow) p.mesh.scale.multiplyScalar(1 + p.grow * dt)
      // opacity is on the shared material, so per-particle fade is done with scale
      if (p.fade && p.life < .45) p.mesh.scale.multiplyScalar(Math.max(0, 1 - dt * 4))
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

    if (this.composer) this.composer.render()
    else this.renderer.render(this.scene, this.camera)
  }
}
