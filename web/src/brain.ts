// three.js scene: 138k neurons as one Points draw call, cascade edges as LineSegments.
//
// Decay lives in the vertex shader.  Each neuron stores the simulation time of its
// last spike; brightness is exp(-(now - last)/tau) evaluated on the GPU.  The CPU
// therefore only ever writes the handful of neurons that fired in the current frame,
// which keeps per-frame work O(active) rather than O(138639).

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Experiment, NeuronData } from './data'
import { REGION_COLORS } from './data'

const NEVER = -1e9

const VERT = /* glsl */`
attribute float aRegion;
attribute float aLast;
attribute float aSeed;
uniform float uNow, uInvTau, uSize, uDim, uDpr, uFade;
uniform vec3 uPalette[16];
varying vec3 vCol;
varying float vB;
void main() {
  float b = aLast < -1.0 ? 0.0 : clamp(exp(-max(uNow - aLast, 0.0) * uInvTau), 0.0, 1.0);
  vec3 base = uPalette[int(aRegion + 0.5)];
  vec3 hot = vec3(1.0, 0.94, 0.70);
  vec3 seed = vec3(1.0, 0.74, 0.16);
  vec3 col = base * uDim;
  col = mix(col, mix(base * 1.7, hot, b * 0.85), b);
  if (aSeed > 0.5) col = mix(seed * 0.62, seed, max(b, 0.5));
  vCol = col;
  vB = max(b, aSeed > 0.5 ? 0.30 : 0.0);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float s = uSize * (1.0 + 3.0 * b + (aSeed > 0.5 ? 1.1 : 0.0));
  gl_PointSize = max(1.0, s * uDpr * (150.0 / max(-mv.z, 1.0)));
  gl_Position = projectionMatrix * mv;
  vB *= uFade;
}`

const FRAG = /* glsl */`
varying vec3 vCol;
varying float vB;
uniform float uBaseAlpha;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * 4.0;
  if (r2 > 1.0) discard;
  float a = pow(1.0 - r2, 1.5);
  gl_FragColor = vec4(vCol, a * (uBaseAlpha + (1.0 - uBaseAlpha) * vB));
}`

const EVERT = /* glsl */`
attribute float aLast;
attribute float aW;
attribute float aEnd;
uniform float uNow, uInvTau;
varying float vA;
void main() {
  float b = aLast < -1.0 ? 0.0 : clamp(exp(-max(uNow - aLast, 0.0) * uInvTau), 0.0, 1.0);
  vA = b * (0.18 + 0.82 * aW) * (1.0 - 0.55 * aEnd);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const EFRAG = /* glsl */`
varying float vA;
uniform vec3 uColor;
void main() {
  if (vA < 0.004) discard;
  gl_FragColor = vec4(uColor, vA);
}`

export class Brain {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly renderer: THREE.WebGLRenderer
  readonly controls: OrbitControls

  private neurons: NeuronData
  private points: THREE.Points
  private aLast: Float32Array
  private aSeed: Float32Array
  private lastAttr: THREE.BufferAttribute
  private seedAttr: THREE.BufferAttribute
  private touched: number[] = []          // neurons whose aLast is not NEVER

  private edges: THREE.LineSegments | null = null
  private edgeLast: Float32Array | null = null
  private preToEdge = new Map<number, number[]>()
  private touchedEdges: number[] = []

  private marker: THREE.Mesh
  private raycaster = new THREE.Raycaster()
  autoRotate = true
  private idleSince = performance.now()

  constructor(container: HTMLElement, neurons: NeuronData) {
    this.neurons = neurons
    const n = neurons.n

    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.setClearColor(0x05070d, 1)
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 3000)
    this.camera.position.set(0, 14, 150)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 12
    this.controls.maxDistance = 700
    this.controls.addEventListener('start', () => { this.autoRotate = false; this.idleSince = Infinity })
    this.controls.addEventListener('end', () => { this.idleSince = performance.now() })

    // ---- the point cloud
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(neurons.pos, 3))
    const reg = new Float32Array(n)
    for (let i = 0; i < n; i++) reg[i] = neurons.region[i]
    g.setAttribute('aRegion', new THREE.BufferAttribute(reg, 1))
    this.aLast = new Float32Array(n).fill(NEVER)
    this.aSeed = new Float32Array(n)
    this.lastAttr = new THREE.BufferAttribute(this.aLast, 1)
    this.seedAttr = new THREE.BufferAttribute(this.aSeed, 1)
    this.lastAttr.setUsage(THREE.DynamicDrawUsage)
    this.seedAttr.setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('aLast', this.lastAttr)
    g.setAttribute('aSeed', this.seedAttr)
    g.computeBoundingSphere()

    const palette = neurons.regions.map(r => new THREE.Color(REGION_COLORS[r] ?? '#556'))
    while (palette.length < 16) palette.push(new THREE.Color('#556'))

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uNow: { value: 0 }, uInvTau: { value: 1 / 0.02 }, uSize: { value: 1.5 },
        uDim: { value: 1.0 }, uDpr: { value: Math.min(devicePixelRatio, 2) },
        uBaseAlpha: { value: 0.17 }, uFade: { value: 1 }, uPalette: { value: palette },
      },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending,
    })
    this.points = new THREE.Points(g, mat)
    this.points.frustumCulled = false
    this.scene.add(this.points)

    // ---- selection marker
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(1.7, 2.3, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false }))
    this.marker.visible = false
    this.marker.renderOrder = 10
    this.scene.add(this.marker)

    this.resize()
    addEventListener('resize', () => this.resize())
  }

  /** Re-read the host element's size; call after the container changes size. */
  resize() {
    const el = this.renderer.domElement.parentElement!
    const w = el.clientWidth, h = el.clientHeight
    // update the CSS size too, so the canvas fits whatever container it is dropped
    // into rather than relying on a page-specific stylesheet rule
    this.renderer.setSize(w, h)
    this.camera.aspect = w / Math.max(h, 1)
    this.camera.updateProjectionMatrix()
  }

  private u(name: string) { return (this.points.material as THREE.ShaderMaterial).uniforms[name] }

  /** Visual decay constant, given in seconds of *wall clock* and converted to the
   *  simulation-time units the shader works in, so the tail looks the same at any speed. */
  setTau(wallSeconds: number, simSecondsPerWallSecond: number) {
    const tauSim = Math.max(wallSeconds * simSecondsPerWallSecond, 1e-6)
    this.u('uInvTau').value = 1 / tauSim
    if (this.edges) (this.edges.material as THREE.ShaderMaterial).uniforms.uInvTau.value = 1 / (tauSim * 0.75)
  }

  setNow(simTime: number) {
    this.u('uNow').value = simTime
    if (this.edges) (this.edges.material as THREE.ShaderMaterial).uniforms.uNow.value = simTime
  }

  setPointSize(s: number) { this.u('uSize').value = s }
  setDim(d: number) { this.u('uDim').value = d }

  /** Mark the neurons that fired in this frame.  O(number that fired). */
  fireFrame(indices: ArrayLike<number>, simTime: number) {
    const last = this.aLast
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k]
      if (last[i] === NEVER) this.touched.push(i)
      last[i] = simTime
      const es = this.preToEdge.get(i)
      if (es && this.edgeLast) {
        for (let q = 0; q < es.length; q++) {
          const e = es[q]
          if (this.edgeLast[2 * e] === NEVER) this.touchedEdges.push(e)
          this.edgeLast[2 * e] = simTime
          this.edgeLast[2 * e + 1] = simTime
        }
      }
    }
    this.lastAttr.needsUpdate = true
    if (this.edges && indices.length) {
      (this.edges.geometry.getAttribute('aLast') as THREE.BufferAttribute).needsUpdate = true
    }
  }

  /** Clear all activity.  O(neurons that have ever fired since the last clear). */
  clearActivity() {
    for (const i of this.touched) this.aLast[i] = NEVER
    this.touched.length = 0
    if (this.edgeLast) {
      for (const e of this.touchedEdges) { this.edgeLast[2 * e] = NEVER; this.edgeLast[2 * e + 1] = NEVER }
      this.touchedEdges.length = 0
      ;(this.edges!.geometry.getAttribute('aLast') as THREE.BufferAttribute).needsUpdate = true
    }
    this.lastAttr.needsUpdate = true
  }

  setExperiment(exp: Experiment | null) {
    this.aSeed.fill(0)
    if (exp) {
      for (const i of exp.seed_idx) this.aSeed[i] = 1
      for (const i of exp.seed2_idx) this.aSeed[i] = 1
    }
    this.seedAttr.needsUpdate = true

    if (this.edges) {
      this.scene.remove(this.edges)
      this.edges.geometry.dispose()
      ;(this.edges.material as THREE.Material).dispose()
      this.edges = null
      this.edgeLast = null
    }
    this.preToEdge.clear()
    this.touchedEdges.length = 0
    if (!exp || !exp.n_edges) return

    const m = exp.n_edges
    const pos = new Float32Array(m * 6)
    const last = new Float32Array(m * 2).fill(NEVER)
    const wv = new Float32Array(m * 2)
    const end = new Float32Array(m * 2)
    let wmax = 1
    for (let e = 0; e < m; e++) wmax = Math.max(wmax, Math.abs(exp.edgeW[e]))
    const P = this.neurons.pos
    for (let e = 0; e < m; e++) {
      const a = exp.edgePre[e], b = exp.edgePost[e], w = exp.edgeW[e]
      pos[e * 6 + 0] = P[a * 3]; pos[e * 6 + 1] = P[a * 3 + 1]; pos[e * 6 + 2] = P[a * 3 + 2]
      pos[e * 6 + 3] = P[b * 3]; pos[e * 6 + 4] = P[b * 3 + 1]; pos[e * 6 + 5] = P[b * 3 + 2]
      const nw = Math.min(1, Math.log1p(Math.abs(w)) / Math.log1p(wmax))
      wv[e * 2] = nw; wv[e * 2 + 1] = nw
      end[e * 2] = 0; end[e * 2 + 1] = 1
      let arr = this.preToEdge.get(a)
      if (!arr) this.preToEdge.set(a, arr = [])
      arr.push(e)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const la = new THREE.BufferAttribute(last, 1)
    la.setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('aLast', la)
    g.setAttribute('aW', new THREE.BufferAttribute(wv, 1))
    g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1))
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uNow: { value: this.u('uNow').value },
        uInvTau: { value: this.u('uInvTau').value / 0.75 },
        uColor: { value: new THREE.Color('#8fd8ff') },
      },
      vertexShader: EVERT, fragmentShader: EFRAG,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    })
    this.edges = new THREE.LineSegments(g, mat)
    this.edges.frustumCulled = false
    this.edgeLast = last
    this.scene.add(this.edges)
  }

  /** Nearest neuron under the pointer, preferring clickable ones. */
  pick(clientX: number, clientY: number, clickable: Set<number>): number | null {
    const r = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    const dist = this.camera.position.length()
    this.raycaster.params.Points!.threshold = Math.max(0.6, dist * 0.012)
    const hits = this.raycaster.intersectObject(this.points, false)
    if (!hits.length) return null
    hits.sort((a, b) => (a.distanceToRay ?? 0) - (b.distanceToRay ?? 0))
    const near = hits.slice(0, 40)
    const pref = near.find(h => clickable.has(h.index!))
    return (pref ?? near[0]).index ?? null
  }

  select(idx: number | null) {
    if (idx == null) { this.marker.visible = false; return }
    const P = this.neurons.pos
    this.marker.position.set(P[idx * 3], P[idx * 3 + 1], P[idx * 3 + 2])
    this.marker.visible = true
  }

  flyTo(idx: number) {
    const P = this.neurons.pos
    this.controls.target.set(P[idx * 3], P[idx * 3 + 1], P[idx * 3 + 2])
    this.autoRotate = false
    this.idleSince = performance.now()
  }

  resetView() {
    this.controls.target.set(0, 0, 0)
    this.camera.position.set(0, 14, 150)
    this.autoRotate = true
  }

  render(dt: number) {
    if (!this.autoRotate && performance.now() - this.idleSince > 12000) this.autoRotate = true
    if (this.autoRotate) {
      const a = dt * 0.055
      const p = this.camera.position, t = this.controls.target
      const dx = p.x - t.x, dz = p.z - t.z
      p.x = t.x + dx * Math.cos(a) - dz * Math.sin(a)
      p.z = t.z + dx * Math.sin(a) + dz * Math.cos(a)
    }
    this.marker.lookAt(this.camera.position)
    const d = this.camera.position.distanceTo(this.controls.target)
    this.marker.scale.setScalar(Math.max(0.5, d / 120))
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }
}
