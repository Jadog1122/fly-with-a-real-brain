// Live leaky integrate-and-fire simulation of the fly subnetwork.
//
// This integrates exactly the same system Brian2 does in bake/_sim_worker.py, with the
// same closed-form ("linear" method) step, so the browser and the offline reference
// agree.  For dv/dt = (v0 - v + g)/t_mbr with dg/dt = -g/tau the exact update over one
// timestep is
//     g' = g * B                     B = exp(-dt/tau)
//     v' = v0 + (v - v0) * A + g * K A = exp(-dt/t_mbr), K = tau/(tau-t_mbr) * (B-A)
// Everything is in millivolts and milliseconds.
//
// Plain typed arrays, no WASM: measured at ~10k steps/s for this network on an M3,
// i.e. real time, with 4x headroom at the slow-motion rate the visualiser uses.

export interface ModelConstants {
  dt_ms: number; v_0: number; v_rst: number; v_th: number
  t_mbr_ms: number; tau_ms: number; t_rfc_ms: number; delay_ms: number
  w_syn_mV: number; f_poi: number
}

export interface SubnetData {
  n: number; n_syn: number; n_full: number
  members: Uint32Array      // subnet index -> index in neurons.bin
  row: Uint32Array          // CSR row starts, by presynaptic neuron
  tgt: Uint16Array
  w: Int16Array             // signed connectivity; multiply by w_syn for millivolts
}

export class LiveBrain {
  readonly n: number
  readonly members: Uint32Array
  readonly m: ModelConstants

  private row: Uint32Array
  private tgt: Uint16Array
  private wmv: Float64Array          // synaptic weight already in mV

  // float64 throughout, like Brian2: a neuron sitting exactly on threshold otherwise
  // crosses a step early or late, and this network is close enough to critical that
  // such a step propagates.  Costs ~40 MB and is no slower - JS numbers are doubles.
  private v: Float64Array
  private g: Float64Array
  private refr: Int16Array           // timesteps of refractoriness left
  private rfcSteps: Int16Array       // per-neuron refractory length (0 while driven)

  private ring: Uint16Array[]        // spikes in flight, one slot per delay step
  private ringN: Uint32Array
  private ringLen: number

  // Poisson drive: a sparse list, so an idle brain costs nothing
  private driveIdx: Uint16Array
  private driveP: Float64Array
  private nDrive = 0

  private A: number; private B: number; private K: number
  private rfcDefault: number
  private delaySteps: number
  private rng = 0x9e3779b9

  /** Neurons that fired in the most recent step (view into a scratch buffer). */
  lastSpikes: Uint16Array
  private spikeBuf: Uint16Array
  steps = 0

  constructor(sub: SubnetData, m: ModelConstants) {
    this.n = sub.n
    this.members = sub.members
    this.m = m
    this.row = sub.row
    this.tgt = sub.tgt
    this.wmv = new Float64Array(sub.w.length)
    for (let e = 0; e < sub.w.length; e++) this.wmv[e] = sub.w[e] * m.w_syn_mV

    this.A = Math.exp(-m.dt_ms / m.t_mbr_ms)
    this.B = Math.exp(-m.dt_ms / m.tau_ms)
    this.K = (m.tau_ms / (m.tau_ms - m.t_mbr_ms)) * (this.B - this.A)
    this.rfcDefault = Math.round(m.t_rfc_ms / m.dt_ms)
    // Brian2 applies on_pre in its `synapses` slot, which runs *after* the state
    // update, so a spike detected at step t only moves the postsynaptic membrane at
    // step t + delay/dt + 1.  We deliver at the top of a step instead, so the ring
    // carries one extra slot to land on exactly the same step.  Verified spike-for-
    // spike against Brian2 in bake/14_validate_engine.py.
    this.delaySteps = Math.round(m.delay_ms / m.dt_ms) + 1

    this.v = new Float64Array(this.n).fill(m.v_0)
    this.g = new Float64Array(this.n)
    this.refr = new Int16Array(this.n)
    this.rfcSteps = new Int16Array(this.n).fill(this.rfcDefault)

    this.ringLen = this.delaySteps + 1
    this.ring = Array.from({ length: this.ringLen }, () => new Uint16Array(this.n))
    this.ringN = new Uint32Array(this.ringLen)

    this.driveIdx = new Uint16Array(this.n)
    this.driveP = new Float64Array(this.n)
    this.spikeBuf = new Uint16Array(this.n)
    this.lastSpikes = this.spikeBuf.subarray(0, 0)
  }

  /** How many neurons currently carry external drive. */
  get driveCount() { return this.nDrive }

  /** Reseed the Poisson stream. */
  seed(s: number) { this.rng = (s | 0) || 0x9e3779b9 }

  /** xorshift32 - fast and good enough for Poisson arrivals. */
  private rand(): number {
    let x = this.rng
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5
    this.rng = x
    return (x >>> 0) / 4294967296
  }

  /**
   * Replace the external drive.  `rates` maps subnet index -> Hz.  Upstream `poi()`
   * also zeroes the refractory period of every externally driven neuron, so we do the
   * same, and restore it when the drive goes away.
   */
  setDrive(rates: Map<number, number>) {
    for (let k = 0; k < this.nDrive; k++) this.rfcSteps[this.driveIdx[k]] = this.rfcDefault
    let k = 0
    const pScale = this.m.dt_ms / 1000
    for (const [i, hz] of rates) {
      if (hz <= 0) continue
      this.driveIdx[k] = i
      this.driveP[k] = hz * pScale
      this.rfcSteps[i] = 0
      k++
    }
    this.nDrive = k
  }

  /** One 0.1 ms timestep.  Returns the number of spikes; they are in `lastSpikes`. */
  step(): number {
    const { v, g, refr, rfcSteps, row, tgt, wmv, ring, ringN } = this
    const t = this.steps
    const slot = t % this.ringLen

    // Synapses that left their presynaptic neuron `delay` ago land now.  Brian2
    // discards synaptic input to a neuron that is refractory - `g` carries the
    // (unless refractory) flag, which gates writes from synapses as well as the
    // differential equation.  Verified empirically; dropping this guard inflates
    // spike counts by ~76% once the network is firing hard enough that a large
    // fraction of neurons are refractory at any moment.
    const arr = ring[slot], nIn = ringN[slot]
    for (let k = 0; k < nIn; k++) {
      const i = arr[k]
      for (let e = row[i], end = row[i + 1]; e < end; e++) {
        const j = tgt[e]
        if (refr[j] <= 0) g[j] += wmv[e]
      }
    }
    ringN[slot] = 0

    // Poisson drive: PoissonInput(N=1, target_var='v') adds w_syn*f_poi straight to v
    const wPoi = this.m.w_syn_mV * this.m.f_poi
    for (let k = 0; k < this.nDrive; k++) {
      if (this.rand() < this.driveP[k]) v[this.driveIdx[k]] += wPoi
    }

    // integrate and threshold
    const os = (t + this.delaySteps) % this.ringLen
    const out = ring[os]
    const spikes = this.spikeBuf
    const { A, B, K } = this
    const v0 = this.m.v_0, vth = this.m.v_th, vrst = this.m.v_rst
    let nOut = 0
    for (let i = 0; i < this.n; i++) {
      if (refr[i] > 0) { refr[i]--; continue }   // v and g are both frozen: (unless refractory)
      const gi = g[i]
      const nv = v0 + (v[i] - v0) * A + gi * K
      g[i] = gi * B
      if (nv > vth) {
        v[i] = vrst; g[i] = 0; refr[i] = rfcSteps[i]
        out[nOut] = i; spikes[nOut] = i; nOut++
      } else {
        v[i] = nv
      }
    }
    ringN[os] = nOut
    this.lastSpikes = spikes.subarray(0, nOut)
    this.steps = t + 1
    return nOut
  }

  /** Push neurons over threshold right now - a deterministic poke, no Poisson. */
  kick(idx: ArrayLike<number>, mv = 1e-3) {
    for (let k = 0; k < idx.length; k++) this.v[idx[k]] = this.m.v_th + mv
  }

  /** Reset membrane state but keep the wiring. */
  reset() {
    this.v.fill(this.m.v_0)
    this.g.fill(0)
    this.refr.fill(0)
    for (const r of this.ring) r.fill(0)
    this.ringN.fill(0)
    this.steps = 0
  }
}

/** Exponentially smoothed firing rate of a set of neurons, in Hz. */
export class RateMeter {
  private acc = 0
  value = 0
  constructor(private idx: Set<number>, private tauMs = 60) {}
  observe(spikes: Uint16Array) {
    for (let k = 0; k < spikes.length; k++) if (this.idx.has(spikes[k])) this.acc++
  }
  /** Call once per simulated millisecond block. */
  settle(ms: number) {
    const inst = this.idx.size ? (this.acc / this.idx.size) * (1000 / ms) : 0
    const a = 1 - Math.exp(-ms / this.tauMs)
    this.value += (inst - this.value) * a
    this.acc = 0
  }
}
