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
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js'
import { FilmPass } from 'three/examples/jsm/postprocessing/FilmPass.js'
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader.js'
import { BrightnessContrastShader } from 'three/examples/jsm/shaders/BrightnessContrastShader.js'
import { damp, damp3 } from 'maath/easing'
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
  private prevAlt = 0
  private airCooldown = 0
  private rippleCooldown = 0
  private ripples: { mesh: THREE.Mesh; life: number }[] = []
  private rippleGeo = new THREE.RingGeometry(0.55, 1, 28)
  private rippleMat = new THREE.MeshBasicMaterial({
    color: 0xdff0ff, transparent: true, opacity: 0.5,
    depthWrite: false, side: THREE.DoubleSide,
  })

  /**
   * Downwash. A fly passing low over water pushes air into it, and the rings that
   * spread from that are the most legible thing water does. Rings rather than any
   * perturbation of the surface normals: the surface is a scrolling normal map, and
   * poking a local dent into it costs far more than drawing an expanding circle.
   */
  private spawnRipple(x: number, z: number) {
    const m = new THREE.Mesh(this.rippleGeo, this.rippleMat.clone())
    m.rotation.x = -Math.PI / 2
    m.position.set(x, (this.water?.position.y ?? 1.1) + 0.35, z)
    m.scale.setScalar(3)
    m.renderOrder = 2
    this.scene.add(m)
    this.ripples.push({ mesh: m, life: 1 })
    while (this.ripples.length > 14) this.scene.remove(this.ripples.shift()!.mesh)
  }

  /** Is this point over the puddle? The blob is roughly an ellipse, so treat it as one. */
  private overWater(x: number, z: number) {
    const w = this.water
    if (!w) return false
    const dx = (x - w.position.x) / 168
    const dz = (z - w.position.z) / 104
    return dx * dx + dz * dz < 1
  }

  // adaptive quality
  private quality: Quality = 'high'
  private fpsTime = 0
  private fpsFrames = 0
  private lastDegrade = 0
  /** Smoothed frames per second, for the HUD and for anyone reporting a problem. */
  fps = 0
  /** Called when the renderer decides it has to drop a tier to keep up. */
  onDegrade: ((q: Quality) => void) | null = null
  private airborne = 0
  ready = false

  constructor(host: HTMLElement, private world: World) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))   // replaced by setQuality
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    // AgX rather than ACES. ACES compresses bright outdoor highlights toward white
    // and desaturates them; AgX holds hue through the rolloff, which is what a sunlit
    // meadow needs. It renders darker, hence the higher exposure.
    this.renderer.toneMapping = THREE.AgXToneMapping
    this.renderer.toneMappingExposure = 1.15
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
    const SUN = new THREE.Vector3(620, 330, 430).normalize()   // ~23 degrees: late, but still on the ground
    u.sunPosition.value.copy(SUN)
    this.scene.add(sky)

    // Ambient light comes from a real captured environment, not a guess. The sky dome
    // is used as a stand-in until the HDRI arrives, so first paint never waits on it.
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    pmrem.compileEquirectangularShader()
    this.scene.environment = pmrem.fromScene(sky as unknown as THREE.Scene).texture
    this.scene.environmentIntensity = 0.26   // enough to tint the shade, not to flatten it

    // A real autumn-forest capture (Poly Haven, CC0), downsampled hard: only the
    // ambient is taken from it - the sun is the directional light below - and PMREM
    // blurs it anyway, so 341x170 carries the same mean radiance as the 1k original
    // at an eighth of the bytes.
    new RGBELoader().loadAsync('env/meadow_1k.hdr').then(hdr => {
      hdr.mapping = THREE.EquirectangularReflectionMapping
      const env = pmrem.fromEquirectangular(hdr).texture
      this.scene.environment = env
      // Low on purpose. Measured off the framebuffer: at 0.9 the whole frame sat at a
      // mean of 0.57 with nothing ever dark - flat and grey however the exposure was
      // set. At 0.25 the histogram matches the reference photographs: p05 at true
      // black, median 0.15, p95 at 0.93. Mostly shadow, with bright pools of sun.
      this.scene.environmentIntensity = 0.55
      hdr.dispose()
      pmrem.dispose()
    }).catch(() => pmrem.dispose())           // the sky stand-in is a fine fallback

    // Fog tinted to the sky's horizon, not to the old flat blue, or distant grass
    // reads as a different colour from the sky behind it.
    // At ground level the camera sees the whole arena, so fog that starts close
    // greys out everything past the fly.
    this.scene.fog = new THREE.Fog(0x9db58f, 1700, 4200)

    // warm sun
    this.key = new THREE.DirectionalLight(0xffd9a0, 4.4)   // late sun is warmer and harder
    this.key.position.set(620, 330, 430)
    this.key.castShadow = true
    this.key.shadow.mapSize.set(2048, 2048)
    // Tight, and moved with the fly each frame (see updateShadowBox). A single box
    // over the whole 760x490 arena at 2048 gives ~0.6 world units per texel, which
    // turns grass shadows into mush; 300 units across is four times sharper.
    const d = 300
    Object.assign(this.key.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 10, far: 2400 })
    this.key.shadow.bias = -0.0012
    this.key.shadow.normalBias = 1.2   // stops thin grass blades shadow-acneing themselves
    this.scene.add(this.key, this.key.target)

    // A cool fill from the opposite side, so the shadow side of a prop is modelled
    // rather than flat. Half the key's intensity and no shadow of its own.
    const fill = new THREE.DirectionalLight(0x9fc4e8, 0.11)
    fill.position.set(-320, 260, -420)
    this.scene.add(fill)

    // Ground bounce only - the sky half of this is now doing its job through the
    // environment map, so the hemisphere light is much weaker than it was.
    this.scene.add(new THREE.HemisphereLight(0xa8c8e8, 0x6b5334, 0.14))

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
    const dirtGeo = new THREE.PlaneGeometry(this.world.w - 10, this.world.h - 10)
    // aoMap reads uv1, which PlaneGeometry does not have
    dirtGeo.setAttribute('uv1', dirtGeo.attributes.uv)
    const dirtMat = new THREE.MeshStandardMaterial({
      color: 0xbfb09a, roughness: 1, transparent: true, depthWrite: false,
      alphaMap: new THREE.CanvasTexture(fade),
      map: dirtTex, roughnessMap: dirtTex,
    })
    const dirt = new THREE.Mesh(dirtGeo, dirtMat)

    // Real wet-mud-and-leaf-litter PBR (Poly Haven brown_mud_leaves_01, CC0) in place
    // of the procedural mottling, which was only ever a patch over a flat colour.
    // Loaded after first paint; the mottled version stands in until it lands.
    const tl = new THREE.TextureLoader()
    const aniso = this.renderer.capabilities.getMaxAnisotropy()
    const setup = (t: THREE.Texture, srgb: boolean) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.repeat.set(9, 6)
      // A ground-level camera sees the floor at a very grazing angle, where without
      // anisotropic filtering the texture smears into mush a few units out.
      t.anisotropy = aniso
      if (srgb) t.colorSpace = THREE.SRGBColorSpace
      return t
    }
    Promise.all([
      tl.loadAsync('tex/ground_diff.jpg'),
      tl.loadAsync('tex/ground_nor.jpg'),
      tl.loadAsync('tex/ground_arm.jpg'),
    ]).then(([diff, nor, arm]) => {
      dirtMat.map = setup(diff, true)
      dirtMat.normalMap = setup(nor, false)
      dirtMat.normalScale.set(1.4, 1.4)
      dirtMat.aoMap = setup(arm, false)
      dirtMat.roughnessMap = arm        // green channel
      dirtMat.color.setHex(0xffffff)    // the albedo carries the colour now
      dirtMat.needsUpdate = true
    }).catch(() => { /* the procedural stand-in is a fine fallback */ })
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
    // Near ground level, not a 3/4 view from above: at 3 mm tall the world should be
    // read from inside it, with grass overhead. ~14 degrees of elevation.
    this.camera.position.set(f.x - Math.cos(f.h) * 300, 78, f.y - Math.sin(f.h) * 300)
    this.camera.lookAt(this.camTarget)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = .08
    this.controls.minDistance = 95        // close enough to fill the frame on purpose
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
            if (mat) {
              // Everything is wet. Wet stone is near-glossy and noticeably darker;
              // wet foliage is damp rather than shiny. A uniform 0.92 roughness made
              // the whole scene read as dry chalk whatever the lighting did.
              const stone = /^(Pebble|Rock)/.test(file)
              mat.roughness = stone ? 0.34 : 0.72
              mat.metalness = 0
              mat.envMapIntensity = stone ? 1.5 : 1.0
              if (stone) mat.color.multiplyScalar(0.72)   // water darkens what it soaks
            }
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
    this.addWaterAndDew(r)
    await this.addMossAndCanopy(r, this.cache)
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
        const windy = Scene3D.WINDY.test(file)
        for (const part of parts) {
          // each windy prop gets its own material clone so the sway can be scaled to
          // how tall that species actually is
          let pmat = part.mat
          if (windy) {
            part.geo.computeBoundingBox()
            const hgt = Math.max(0.01, part.geo.boundingBox!.max.y)
            pmat = part.mat.clone()
            this.windify(pmat, hgt, hgt * 0.09)
          }
          const im = new THREE.InstancedMesh(part.geo, pmat, subset.length)
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
          this.occluders.push(im)
        }
      }
    }
    this.placements.clear()
  }

  private resize(host: HTMLElement) {
    const b = host.getBoundingClientRect()
    if (!b.width || !b.height) return
    this.renderer.setSize(b.width, b.height)
    const aspect = b.width / Math.max(b.height, 1)
    this.camera.aspect = aspect

    // Vertical FOV is fixed, so on a portrait phone the horizontal field collapses and
    // the fly ends up outside the frame. Hold the horizontal field instead and let the
    // vertical one open up, capped so it does not go fisheye.
    const V = 38
    const fov = aspect >= 1
      ? V
      : Math.min(76, 2 * Math.atan(Math.tan((V / 2) * Math.PI / 180) / aspect) * 180 / Math.PI)

    // Opening the field up is only half of it. At a fixed distance a 73-degree
    // portrait view showed 677 world units of height, so the fly filled 12% of the
    // frame instead of 40 - small and far enough that its walking was not visible at
    // all, which is what "the fly is stuck" actually was. Pull the camera in by the
    // same factor so the subject keeps its size on screen whatever the aspect.
    const k = Math.tan((V / 2) * Math.PI / 180) / Math.tan((fov / 2) * Math.PI / 180)
    if (Math.abs(k - this.framingK) > 1e-4) {
      const rescale = k / this.framingK
      const dir = new THREE.Vector3().subVectors(this.camera.position, this.camTarget)
      this.camera.position.copy(this.camTarget).addScaledVector(dir, rescale)
      this.camDist *= rescale
      this.controls.minDistance = 95 * k
      this.controls.maxDistance = 1400 * k
      this.framingK = k
    }
    this.baseFov = fov
    this.fovNow = fov
    this.camera.fov = fov
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
  /**
   * Keep the shadow frustum over what the camera is actually looking at. A
   * directional light's shadow map is a fixed box in world space, so a box big enough
   * for the whole arena wastes almost all its resolution on ground nobody is looking
   * at. In the overview the box has to open up again to cover everything.
   */
  private updateShadowBox() {
    const cam = this.key.shadow.camera as THREE.OrthographicCamera
    const d = this.overview ? 640 : 300
    if (cam.left !== -d) {
      cam.left = -d; cam.right = d; cam.top = d; cam.bottom = -d
      cam.updateProjectionMatrix()
    }
    // The sun follows the camera's azimuth rather than sitting at a fixed world
    // direction. Physically a cheat, but with a fixed sun the fly was flatly lit from
    // one side of the arena and silhouetted from the other, and which you got depended
    // on where it had wandered. Held ~130 degrees off the view direction it is always
    // a back-three-quarter rim light - the reference's lighting, and what every game
    // does for the same reason.
    const t = this.camTarget
    const a = Math.atan2(this.camera.position.z - t.z, this.camera.position.x - t.x) + 2.27
    this.key.position.set(t.x + Math.cos(a) * 700, 330, t.z + Math.sin(a) * 700)
    this.key.target.position.set(t.x, 0, t.z)
    this.key.target.updateMatrixWorld()
  }

  private measureFps(dt: number) {
    if (!this.ready) return
    if (dt > 0.2 || document.visibilityState !== 'visible') return
    this.fpsTime += dt
    this.fpsFrames++
    if (this.fpsTime < 3) return

    const fps = this.fpsFrames / this.fpsTime
    this.fps = fps
    this.fpsTime = 0
    this.fpsFrames = 0
    const now = performance.now()
    if (this.quality === 'low' || fps >= 24 || now - this.lastDegrade < 10_000) return

    this.lastDegrade = now
    this.onDegrade?.(this.quality === 'high' ? 'medium' : 'low')
  }

  /** Pull back to see the whole arena, or drop back in behind the fly. */
  /**
   * Moss cushions and the tall grass that arches into frame.
   *
   * The cushions are domed discs rather than flat patches - moss grows as a mound,
   * and at this scale a flat green decal reads as paint. They are placed around the
   * puddle, because that is where moss actually is.
   *
   * The arching grass is deliberately NOT added to the occluder list. The camera
   * dodges anything that blocks it, which is right for scenery you need to see past,
   * but wrong here: this grass exists precisely to drift through the foreground and
   * be thrown out of focus, which is the framing in every macro photograph. Letting
   * the camera dodge it would delete the effect.
   */
  private async addMossAndCanopy(r: () => number, proto: Map<string, THREE.Group>) {
    const { w, h } = this.world
    const tl = new THREE.TextureLoader()
    const aniso = this.renderer.capabilities.getMaxAnisotropy()

    const mossMat = new THREE.MeshStandardMaterial({ color: 0x5c7a3a, roughness: 1 })
    Promise.all([
      tl.loadAsync('tex/moss_diff.jpg'),
      tl.loadAsync('tex/moss_nor.jpg'),
      tl.loadAsync('tex/moss_arm.jpg'),
    ]).then(([d, n, a]) => {
      for (const t of [d, n, a]) {
        t.wrapS = t.wrapT = THREE.RepeatWrapping
        t.repeat.set(2.5, 2.5)
        t.anisotropy = aniso
      }
      d.colorSpace = THREE.SRGBColorSpace
      mossMat.map = d
      mossMat.normalMap = n
      mossMat.normalScale.set(1.6, 1.6)
      mossMat.aoMap = a
      mossMat.roughnessMap = a
      mossMat.color.setHex(0xffffff)
      mossMat.needsUpdate = true
    }).catch(() => { /* the flat green stands in */ })

    const mossTops: { x: number; y: number; z: number; r: number }[] = []
    const wx = this.water ? this.water.position.x : w * 0.62
    const wz = this.water ? this.water.position.z : h * 0.44
    for (let i = 0; i < 9; i++) {
      const rad = 55 + r() * 95
      const geo = new THREE.SphereGeometry(rad, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.42)
      geo.setAttribute('uv1', geo.attributes.uv)
      const pos = geo.attributes.position as THREE.BufferAttribute
      for (let v = 0; v < pos.count; v++) {          // lumpy, not a clean dome
        const k = 1 + (Math.sin(pos.getX(v) * 0.09) + Math.cos(pos.getZ(v) * 0.11)) * 0.06
        pos.setXYZ(v, pos.getX(v) * k, pos.getY(v) * 0.36 * k, pos.getZ(v) * k)
      }
      geo.computeVertexNormals()
      const m = new THREE.Mesh(geo, mossMat)
      const ang = r() * Math.PI * 2, dist = 120 + r() * 230
      m.position.set(
        Math.max(60, Math.min(w - 60, wx + Math.cos(ang) * dist)),
        -rad * 0.16,
        Math.max(60, Math.min(h - 60, wz + Math.sin(ang) * dist * 0.7)))
      m.rotation.y = r() * Math.PI * 2
      m.receiveShadow = true
      m.castShadow = true
      this.scene.add(m)
      this.occluders.push(m)                          // solid: the camera should avoid it
      mossTops.push({ x: m.position.x, y: m.position.y, z: m.position.z, r: rad })
    }

    // Dew beads on the moss as well as on the ground. In the reference photographs
    // this is most of what you actually see of the water - droplets caught on the
    // cushions, each one a single bright highlight.
    if (mossTops.length) {
      const bead = new THREE.SphereGeometry(1, 8, 6)
      const beadMat = new THREE.MeshPhysicalMaterial({
        color: 0xc8dae8, roughness: 0.03, metalness: 0,
        transparent: true, opacity: 0.24, depthWrite: false,
        envMapIntensity: 1.1, clearcoat: 1, clearcoatRoughness: 0,
      })
      const COUNT = 260
      const beads = new THREE.InstancedMesh(bead, beadMat, COUNT)
      const bm = new THREE.Matrix4(), bq = new THREE.Quaternion(), bs = new THREE.Vector3()
      const bv = new THREE.Vector3()
      for (let i = 0; i < COUNT; i++) {
        const c = mossTops[(r() * mossTops.length) | 0]
        // a point on the dome, so the beads sit on the surface rather than inside it
        const th = r() * Math.PI * 2, ph = r() * Math.PI * 0.4
        bv.set(c.x + Math.sin(ph) * Math.cos(th) * c.r * 0.95,
               c.y + Math.cos(ph) * c.r * 0.37 + 1.2,
               c.z + Math.sin(ph) * Math.sin(th) * c.r * 0.95)
        const sz = 0.7 + r() * 1.5
        bs.set(sz, sz * 0.8, sz)
        bm.compose(bv, bq, bs)
        beads.setMatrixAt(i, bm)
      }
      beads.instanceMatrix.needsUpdate = true
      beads.computeBoundingSphere()
      this.scene.add(beads)
    }

    // Fallen leaves. The kit's petals are the right shape but far too small to read
    // as leaf litter at this scale, so the same geometry goes down much larger, laid
    // almost flat, tilted every which way and tinted through autumn browns. Each one
    // is a distinct object at fly scale - something to walk under.
    const leafFiles = ['Petal_1', 'Petal_2', 'Petal_3', 'Clover_2']
    const LEAF_TINTS = [0x8a5a28, 0xa8763a, 0x6b4420, 0xb08948, 0x7d5c2e]
    for (const lf of leafFiles) {
      const lproto = proto.get(lf)
      if (!lproto) continue
      lproto.updateMatrixWorld(true)
      const lparts: { geo: THREE.BufferGeometry; mat: THREE.Material; local: THREE.Matrix4 }[] = []
      lproto.traverse(o => {
        const me = o as THREE.Mesh
        if (me.isMesh) lparts.push({ geo: me.geometry, mat: me.material as THREE.Material,
                                     local: me.matrixWorld.clone() })
      })
      const LN = 16
      const lm = new THREE.Matrix4(), lq = new THREE.Quaternion()
      const le = new THREE.Euler(), lv = new THREE.Vector3(), ls = new THREE.Vector3()
      for (const part of lparts) {
        const pm = (part.mat as THREE.MeshStandardMaterial).clone()
        pm.color.setHex(LEAF_TINTS[(r() * LEAF_TINTS.length) | 0])
        pm.roughness = 0.62            // damp, not dry
        pm.side = THREE.DoubleSide     // seen from underneath as often as above
        // No sway - a fallen leaf is not attached to anything - but the same
        // near-camera dissolve. Making these occluders had the camera shoving itself
        // around to avoid litter lying flat on the floor, and pressing right up
        // against one whenever the fly walked near it.
        this.windify(pm, 1, 0, 170)
        const im = new THREE.InstancedMesh(part.geo, pm, LN)
        im.castShadow = true
        im.receiveShadow = true
        for (let i = 0; i < LN; i++) {
          lv.set(70 + r() * (w - 140), 1.4 + r() * 3, 70 + r() * (h - 140))
          // nearly flat, but curled up at an angle - a dried leaf never lies true
          le.set((r() - .5) * 0.7, r() * Math.PI * 2, (r() - .5) * 0.7)
          lq.setFromEuler(le)
          const k = S * (0.9 + r() * 1.1)
          ls.set(k, k * (0.7 + r() * 0.5), k)
          lm.compose(lv, lq, ls).multiply(part.local)
          im.setMatrixAt(i, lm)
        }
        im.instanceMatrix.needsUpdate = true
        im.computeBoundingSphere()
        this.scene.add(im)
      }
    }

    // Tall blades arcing in from the edges of frame.
    const tallFile = 'Grass_Wispy_Tall'
    const tall = proto.get(tallFile)
    if (!tall) return
    const parts: { geo: THREE.BufferGeometry; mat: THREE.Material; local: THREE.Matrix4 }[] = []
    tall.updateMatrixWorld(true)
    tall.traverse(o => {
      const me = o as THREE.Mesh
      if (me.isMesh) parts.push({ geo: me.geometry, mat: me.material as THREE.Material,
                                  local: me.matrixWorld.clone() })
    })
    const N = 34
    const mat4 = new THREE.Matrix4(), q = new THREE.Quaternion()
    const e = new THREE.Euler(), v3 = new THREE.Vector3(), sc = new THREE.Vector3()
    for (const part of parts) {
      part.geo.computeBoundingBox()
      const hgt = Math.max(0.01, part.geo.boundingBox!.max.y)
      const pm = part.mat.clone()
      // Fades from further out than the rest: in flight the camera rises into this
      // canopy, and at 210 it was still solid enough to bury the shot.
      this.windify(pm, hgt, hgt * 0.16, 330)
      const im = new THREE.InstancedMesh(part.geo, pm, N)
      im.castShadow = true
      for (let i = 0; i < N; i++) {
        const edge = r()
        const [px, pz] = perimeter(edge, w, h)
        const inward = Math.atan2(h / 2 - pz, w / 2 - px)
        v3.set(px + (r() - .5) * 90, -12, pz + (r() - .5) * 90)
        // leaned in toward the middle, so it arcs over the arena rather than away
        e.set(0.35 + r() * 0.5, inward + Math.PI / 2 + (r() - .5) * 0.8, 0)
        q.setFromEuler(e)
        const k = S * (2.2 + r() * 2.1)                // much larger than the skirt
        sc.set(k, k * (1.1 + r() * 0.5), k)
        mat4.compose(v3, q, sc).multiply(part.local)
        im.setMatrixAt(i, mat4)
      }
      im.instanceMatrix.needsUpdate = true
      im.computeBoundingSphere()
      this.scene.add(im)
    }
  }

  private water: THREE.Mesh | null = null
  private rippleA: THREE.Texture | null = null
  private rippleB: THREE.Texture | null = null

  /**
   * A ripple normal map, summed from a few sine waves. Two copies of it scrolled in
   * different directions and at different speeds is the standard cheap way to get
   * water that never visibly repeats.
   */
  private makeRipple(): THREE.Texture {
    const N = 256
    const c = document.createElement('canvas')
    c.width = c.height = N
    const ctx = c.getContext('2d')!
    const img = ctx.createImageData(N, N)
    const hgt = (x: number, y: number) => {
      let h = 0
      for (const [fx, fy, a] of [[3, 2, 1], [-2, 5, .6], [7, -3, .35], [5, 9, .2]]) {
        h += Math.sin((x / N * fx + y / N * fy) * Math.PI * 2) * a
      }
      return h
    }
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        // central difference of the height field gives the surface normal
        const dx = hgt(x + 1, y) - hgt(x - 1, y)
        const dy = hgt(x, y + 1) - hgt(x, y - 1)
        const nx = -dx * 0.5, ny = -dy * 0.5, nz = 1
        const l = Math.hypot(nx, ny, nz)
        const i = (y * N + x) * 4
        img.data[i] = (nx / l * 0.5 + 0.5) * 255
        img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255
        img.data[i + 2] = (nz / l * 0.5 + 0.5) * 255
        img.data[i + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
    const t = new THREE.CanvasTexture(c)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    return t
  }

  /**
   * A shallow puddle and the dew on the ground around it. Both exist for the same
   * reason: at this scale water is the thing that catches the sun, and a bright
   * specular glint is what sells "wet" far more than any amount of darkened albedo.
   */
  private addWaterAndDew(r: () => number) {
    const { w, h } = this.world

    // an irregular blob rather than a disc - a round puddle reads as a dinner plate
    const geo = new THREE.CircleGeometry(150, 64)
    const pos = geo.attributes.position as THREE.BufferAttribute
    for (let i = 1; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i)
      const a = Math.atan2(y, x)
      const k = 1 + Math.sin(a * 3) * 0.18 + Math.sin(a * 5 + 1.7) * 0.12 + Math.sin(a * 9) * 0.06
      pos.setXY(i, x * k, y * k * 0.62)
    }
    geo.computeVertexNormals()

    this.rippleA = this.makeRipple()
    this.rippleB = this.makeRipple()
    this.rippleA.repeat.set(3, 3)
    this.rippleB.repeat.set(5, 5)

    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x10161a, roughness: 0.04, metalness: 0,
      transparent: true, opacity: 0.82,
      normalMap: this.rippleA, normalScale: new THREE.Vector2(0.22, 0.22),
      envMapIntensity: 2.4,          // the sun glint is the whole point
      clearcoat: 1, clearcoatRoughness: 0.03,
    })
    this.water = new THREE.Mesh(geo, mat)
    this.water.rotation.x = -Math.PI / 2
    this.water.position.set(w * 0.62, 1.1, h * 0.44)
    this.water.renderOrder = 1
    this.scene.add(this.water)

    // Dew. Instanced, and deliberately not using transmission: that needs its own
    // render pass per frame and at this count it would cost more than the whole rest
    // of the scene. A near-mirror sphere against the captured sky reads the same at
    // this size - what you actually see of a 0.2 mm droplet is one bright highlight.
    const drop = new THREE.SphereGeometry(1, 8, 6)
    // Nearly invisible except where it catches the sun. At opacity 0.55 with a strong
    // environment these read as solid white balls, because a near-mirror sphere
    // reflects the whole bright sky across its surface - the opposite of a droplet,
    // which is transparent with one small specular highlight.
    const dropMat = new THREE.MeshPhysicalMaterial({
      color: 0xc8dae8, roughness: 0.03, metalness: 0,
      transparent: true, opacity: 0.2, depthWrite: false,
      envMapIntensity: 0.9, clearcoat: 1, clearcoatRoughness: 0,
    })
    const N = 300
    const dew = new THREE.InstancedMesh(drop, dropMat, N)
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3()
    const v = new THREE.Vector3()
    for (let i = 0; i < N; i++) {
      // clustered near the puddle, thinning out across the rest of the ground
      const near = r() < 0.55
      const cx = near ? this.water.position.x : w / 2
      const cz = near ? this.water.position.z : h / 2
      const spread = near ? 230 : 420
      v.set(cx + (r() + r() - 1) * spread, 1.6 + r() * 2.4, cz + (r() + r() - 1) * spread * 0.7)
      v.x = Math.max(30, Math.min(w - 30, v.x))
      v.z = Math.max(30, Math.min(h - 30, v.z))
      const sz = 0.8 + r() * 1.9
      // beaded, not spherical: surface tension flattens a droplet against the ground
      sc.set(sz, sz * 0.72, sz)
      m.compose(v, q, sc)
      dew.setMatrixAt(i, m)
    }
    dew.instanceMatrix.needsUpdate = true
    dew.computeBoundingSphere()
    this.scene.add(dew)
  }

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
  private windTime = { value: 0 }
  /** xyz = where the fly is, w = how hard it is pressing down. Shared by every plant. */
  private downwash = { value: new THREE.Vector4(0, 1e6, 0, 0) }

  /**
   * Plants sway; pebbles do not. Matched on the kit's own file names.
   */
  private static WINDY = /^(Grass|Fern|Clover|Plant|Flower)/

  /**
   * Wind, and light coming through a leaf.
   *
   * Both are injected into the standard material rather than written from scratch, so
   * the props keep their PBR shading, shadows and fog. The sway is weighted by height
   * within the model so the base stays planted in the ground and only the tip moves,
   * and it is offset by the instance's world position so the whole meadow does not
   * flex as one object.
   *
   * The translucency is a wrap-lighting approximation, not real subsurface: when the
   * sun is behind a leaf, add light proportional to how directly it is behind. Real
   * transmission needs its own render pass per frame and there are thousands of these.
   */
  private windify(mat: THREE.Material, height: number, sway: number, fadeNear = 0) {
    mat.onBeforeCompile = shader => {
      shader.uniforms.uTime = this.windTime
      shader.uniforms.uHeight = { value: height }
      shader.uniforms.uSway = { value: sway }
      shader.uniforms.uFadeNear = { value: fadeNear }
      shader.uniforms.uFly = this.downwash
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float uTime; uniform float uHeight; uniform float uSway;
          uniform vec4 uFly;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          {
            vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
            float ph = ip.x * 0.011 + ip.z * 0.017;
            float gust = sin(uTime * 1.05 + ph) + 0.45 * sin(uTime * 2.37 + ph * 1.9);
            float k = pow(clamp(transformed.y / uHeight, 0.0, 1.0), 1.7) * uSway;
            transformed.x += gust * k;
            transformed.z += gust * k * 0.55;

            // Downwash. A fly passing low pushes air straight down, and the grass
            // under it lies away from the column. Falls off with horizontal distance
            // and with how high the fly is, so it only bites when it is genuinely
            // low overhead.
            if (uFly.w > 0.001) {
              vec3 away = ip - uFly.xyz;
              float near = smoothstep(105.0, 14.0, length(away.xz));
              float low = smoothstep(150.0, 20.0, abs(uFly.y - ip.y));
              float press = uFly.w * near * low;
              vec2 dir = normalize(away.xz + vec2(0.0001, 0.0001));
              transformed.xz += dir * press * k * 11.0;
              transformed.y -= press * k * 3.0;
            }
          }`)
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uFadeNear;`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          // Foliage right in front of the lens frames the shot at mid distance and
          // blocks it entirely up close. Dissolve it as it gets near, with a dithered
          // discard rather than alpha so nothing has to be depth-sorted.
          if (uFadeNear > 0.0) {
            float dcam = length(vViewPosition);
            float vis = smoothstep(uFadeNear * 0.35, uFadeNear, dcam);
            float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
            if (vis < dither) discard;
          }`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          {
            // sun behind the surface, seen through it
            vec3 L = normalize(directionalLights[0].direction);
            float back = pow(max(dot(-L, normalize(vNormal)), 0.0), 2.0);
            reflectedLight.directDiffuse += directionalLights[0].color
              * back * 0.55 * diffuseColor.rgb;
          }`)
    }
    // One cache key for every windy material, not one per height. Height and sway are
    // uniforms, so they can differ per material while all of them share a single
    // compiled program - keying on the values compiled twenty near-identical shaders.
    mat.customProgramCacheKey = () => 'windy' + (fadeNear > 0 ? 'F' : '')
  }

  private occluders: THREE.Object3D[] = []
  private ray = new THREE.Raycaster()
  private camDist = 300
  /** Distance multiplier that keeps the subject the same size across aspect ratios. */
  private framingK = 1
  private wasFlying = 0
  private baseFov = 38
  private fovNow = 38

  /**
   * Third-person camera collision. At ground level inside a meadow the camera spends
   * most of its time behind a grass blade, so cast from what we are looking at back
   * toward the camera and, if the scenery is in the way, sit just in front of it.
   */
  private avoidOccluders() {
    const t = this.camTarget
    const dir = new THREE.Vector3().subVectors(this.camera.position, t)
    const want = dir.length()
    if (want < 1e-3) return
    dir.divideScalar(want)

    this.ray.set(t, dir)
    this.ray.far = want
    const hits = this.ray.intersectObjects(this.occluders, false)
    // pull in to the nearest blocker, but never closer than the orbit's own minimum
    const free = hits.length ? Math.max(this.controls.minDistance, hits[0].distance - 14) : want
    // ease out, snap in: popping back out as a blade passes is far more distracting
    // than tightening quickly as one arrives
    this.camDist = free < this.camDist ? free : this.camDist + (free - this.camDist) * 0.06
    this.camera.position.copy(t).addScaledVector(dir, this.camDist)
  }

  private composer: EffectComposer | null = null
  private bokeh: BokehPass | null = null

  /**
   * Focus on the fly itself, not on the orbit target.
   *
   * The target deliberately lags behind the fly so the camera moves smoothly, which
   * meant the focal plane sat tens of units behind the subject - and at this aperture
   * that is enough to blur the one thing you are meant to be looking at. Measured at
   * 57 units of lag, with the fly at 210 and the focus easing toward 171.
   */
  private updateFocus() {
    if (!this.bokeh) return
    const f = this.world.fly
    const dx = this.camera.position.x - f.x
    const dy = this.camera.position.y - 26
    const dz = this.camera.position.z - f.y
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const u = this.bokeh.uniforms as Record<string, { value: number }>
    u.focus.value += (d - u.focus.value) * 0.25     // eased, or it snaps while orbiting
    // Focus narrows with speed. A shallower plane at pace is how a long lens reads
    // velocity, and it keeps the eye on the fly exactly when it is hardest to follow.
    const rush = Math.min(1, this.world.fly.speed / 150) * this.world.fly.flying
    u.aperture.value = 0.00008 * (1 + rush * 1.6)
  }

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

    // Sizes here are CSS pixels, not drawing-buffer pixels. EffectComposer.setSize
    // multiplies by the pixel ratio itself, so feeding it domElement.width (which is
    // already scaled) built a target twice too big in each axis and the frame ended up
    // letterboxed into a band with dead space above and below. Only visible on a
    // device with a pixel ratio above 1, which is every phone.
    const size = this.renderer.getSize(new THREE.Vector2())
    const dpr = this.renderer.getPixelRatio()
    const w = Math.max(1, size.x), h = Math.max(1, size.y)

    // EffectComposer's own default target has samples: 0, so switching post-processing
    // on silently turned anti-aliasing OFF - the renderer's antialias flag only applies
    // when drawing straight to the canvas. Give it a multisampled target instead. This
    // one is in buffer pixels, since it is the actual allocation.
    const target = new THREE.WebGLRenderTarget(w * dpr, h * dpr, {
      type: THREE.HalfFloatType,
      samples: q === 'high' ? 4 : 2,
    })
    const c = new EffectComposer(this.renderer, target)
    c.setSize(w, h)
    c.addPass(new RenderPass(this.scene, this.camera))

    if (q === 'high') {
      const ao = new GTAOPass(this.scene, this.camera, w, h)
      ao.output = GTAOPass.OUTPUT.Default
      // the arena is ~760 units across and the props are small, so the sampling
      // radius is in tens of units, not the single-digit default
      ao.updateGtaoMaterial({ radius: 14, distanceExponent: 1.5, thickness: 8,
                              scale: 1.0, samples: 16 })
      // GTAO samples stochastically, so raw output is speckled - it was throwing
      // coloured noise across the whole ground. The denoise pass is not optional;
      // without configuring it the default is far too tight for a 14-unit radius.
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3,
                            radius: 4, radiusExponent: 1, rings: 2, samples: 16 })
      c.addPass(ao)

      const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.55, 0.65, 0.78)   // CSS px, resized by setSize
      c.addPass(bloom)   // threshold high: only the sunlit highlights, not the whole meadow
    }

    if (q === 'high') {
      // Depth of field is the strongest scale cue there is. A 3 mm subject shot
      // close up has millimetres of focus, and everything being pin-sharp is exactly
      // what made this read as a toy diorama rather than a macro photograph.
      // Focus distance is driven per frame in updateFocus().
      this.bokeh = new BokehPass(this.scene, this.camera, {
        focus: 300, aperture: 0.00008, maxblur: 0.013,
      })
      c.addPass(this.bokeh)
    } else {
      this.bokeh = null
    }

    const grade = new ShaderPass(BrightnessContrastShader)
    grade.uniforms.brightness.value = 0.0
    grade.uniforms.contrast.value = 0.14
    c.addPass(grade)

    const vignette = new ShaderPass(VignetteShader)
    vignette.uniforms.offset.value = 1.05
    vignette.uniforms.darkness.value = 0.85
    c.addPass(vignette)

    if (q === 'high') {
      // A trace of grain, last before output. Every photograph has some, and a
      // perfectly clean frame is one of the things that makes render look like render.
      // three's FilmPass is grain only in r169 - no scanlines - so it is usable as is.
      c.addPass(new FilmPass(0.14))
    }

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
      : new THREE.Vector3(f.x - Math.cos(f.h) * 300, 78, f.y - Math.sin(f.h) * 300)
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
    if (this.rippleA && this.rippleB) {
      // two layers drifting apart, so the surface never visibly tiles or loops
      this.rippleA.offset.x += dt * 0.013
      this.rippleA.offset.y += dt * 0.009
      this.rippleB.offset.x -= dt * 0.008
      this.rippleB.offset.y += dt * 0.017
    }
    this.windTime.value += dt
    // Only while airborne and low; on the ground the fly displaces nothing.
    const dw = this.downwash.value
    dw.set(f.x, f.alt, f.y, f.flying * Math.max(0, 1 - f.alt / 150))
    // The world owns the flight now, so the renderer follows it rather than easing its
    // own copy off the escape flag.
    this.airborne = f.flying

    // Ground contact, as dust.  Everything here is driven by decoded behaviour, so the
    // fly kicks up dirt for the same reason it walks.
    if (this.particleCap > 40) {                 // low quality skips this entirely
      const A = this.airborne, W = this.wasFlying
      // Descent rate at the moment of contact, from the altitude itself - maath keeps
      // the spring's velocity privately, so it is derived here rather than read.
      const fall = Math.max(0, (this.prevAlt - f.alt) / Math.max(dt, 1e-4))
      this.prevAlt = f.alt

      if (A > .35 && W <= .35) {                 // takeoff
        this.spawnSparks(f.x, f.y)
        this.spawnPuff(f.x, f.y, 7, 150, 70, 3.4)
      } else if (f.alt < 3 && this.wasAirborne >= 3) {
        // Landing, scaled by how hard it came down. A touchdown and a crash used to
        // throw exactly the same puff.
        // fall is a rate, units per second, not a per-frame delta - a 3-unit drop in
        // one frame is already 180/s. Against a 140 divisor every landing saturated
        // and a drift-down threw the same dust as a crash. The spring brings it down
        // from cruise at roughly 400/s, so that is what full impact should mean.
        const hard = Math.min(1, fall / 520)
        this.spawnPuff(f.x, f.y, 4 + Math.round(hard * 9), 70 + hard * 120,
                       30 + hard * 60, 2.4 + hard * 2.2)
        if (hard > 0.45) this.kick(hard * 0.4)
      }
      this.wasAirborne = f.alt

      // Downwash on the puddle, whenever it passes low over the water.
      if (f.flying > 0.25 && f.alt < 130 && this.overWater(f.x, f.y)) {
        this.rippleCooldown -= dt
        if (this.rippleCooldown <= 0) {
          this.spawnRipple(f.x, f.y)
          // closer means faster and harder, the way downwash actually works
          this.rippleCooldown = 0.12 + (f.alt / 130) * 0.3
        }
      }

      // Turbulence: motes shed into the air behind a flying fly. Nothing at this scale
      // moves through air without disturbing it, and in flight there is otherwise no
      // contact with anything to show speed against.
      if (f.flying > 0.3) {
        this.airCooldown -= dt
        if (this.airCooldown <= 0) {
          const back = f.h + Math.PI
          this.spawnPuff(f.x + Math.cos(back) * 14, f.y + Math.sin(back) * 14,
                         1, 22, 8, 1.1)
          // placed at the fly's height rather than on the ground
          const last = this.particles[this.particles.length - 1]
          if (last) last.mesh.position.y = f.alt + (Math.random() - .5) * 10
          this.airCooldown = 0.07
        }
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
    }
    // Altitude, plus a small bob locked to the wingbeat: a fly in the air is never
    // still vertically, and without it the flight reads as a slide along a rail.
    const bob = Math.sin(f.beat) * 2.6 * f.flying
    this.fly.root.position.set(f.x, f.alt + bob, f.y)
    this.fly.root.rotation.set(f.pitch, -f.h + Math.PI, f.bank, 'YXZ')
    this.fly.update(dt, {
      speed: f.speed, legPhase: f.legPhase, escape: action.escape,
      proboscis: action.proboscis, groom: action.groom, startle: f.startle,
      airborne: this.airborne,
    })

    // The contact shadow stays on the ground and spreads and fades as it climbs, which
    // is the main cue for how high it actually is.
    this.shadow.position.set(f.x, 1.2, f.y)
    const climb = Math.min(1, f.alt / 96)
    this.shadow.scale.setScalar(1 + climb * 1.5)
    ;(this.shadow.material as THREE.MeshBasicMaterial).opacity = .34 * (1 - climb * 0.72)

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

    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const rp = this.ripples[i]
      rp.life -= dt * 0.85
      rp.mesh.scale.multiplyScalar(1 + dt * 2.6)     // spreads as it weakens
      const mm = rp.mesh.material as THREE.MeshBasicMaterial
      mm.opacity = Math.max(0, rp.life * 0.5)
      if (rp.life <= 0) { this.scene.remove(rp.mesh); mm.dispose(); this.ripples.splice(i, 1) }
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
    damp(this, 'shake', 0, 0.34, dt)
    if (this.shake < 0.002) this.shake = 0

    // Takeoff shoves the camera. A launch that the frame does not react to reads as
    // the fly sliding upward; a kick on the leading edge of flight, scaled by how
    // sharply it left, makes it read as a launch. Only on the way up.
    if (f.flying > 0.25 && this.wasFlying <= 0.25) this.kick(0.55)
    this.wasFlying = f.flying

    // The lens widens a little under acceleration and settles back - a small, cheap
    // borrow from every chase camera ever made, and the thing that makes speed felt
    // rather than merely shown.
    const wantFov = this.baseFov * (1 + f.flying * 0.09 + Math.min(0.05, f.speed / 2600))
    damp(this, 'fovNow', wantFov, 0.5, dt)
    if (Math.abs(this.camera.fov - this.fovNow) > 0.01) {
      this.camera.fov = this.fovNow
      this.camera.updateProjectionMatrix()
    }
    // The camera orbits a target you can spin and zoom; the target is what follows the
    // fly (or the whole arena in overview), so looking around never fights the chase.
    const goal = this.overview
      ? new THREE.Vector3(this.world.w / 2, 0, this.world.h / 2)
      : new THREE.Vector3(f.x, 26 + f.alt * 0.85, f.y)
    // damp3 rather than lerp: a lerp with dt baked into t converges in a fixed number
    // of frames, so the camera chased harder at high frame rates than at low.
    damp3(this.camTarget, goal, this.overview ? 0.62 : 0.34, dt)
    this.controls.target.copy(this.camTarget)
    const sh = this.shake * 12
    this.camera.position.x += (Math.random() - .5) * sh
    this.camera.position.y += (Math.random() - .5) * sh
    this.controls.update()
    this.avoidOccluders()
    this.updateShadowBox()
    this.updateFocus()

    if (this.composer) this.composer.render()
    else this.renderer.render(this.scene, this.camera)
  }
}
