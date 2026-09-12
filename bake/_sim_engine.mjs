// src/pet/sim.ts
var LiveBrain = class {
  n;
  members;
  m;
  row;
  tgt;
  wmv;
  // synaptic weight already in mV
  // float64 throughout, like Brian2: a neuron sitting exactly on threshold otherwise
  // crosses a step early or late, and this network is close enough to critical that
  // such a step propagates.  Costs ~40 MB and is no slower - JS numbers are doubles.
  v;
  g;
  refr;
  // timesteps of refractoriness left
  rfcSteps;
  // per-neuron refractory length (0 while driven)
  ring;
  // spikes in flight, one slot per delay step
  ringN;
  ringLen;
  // Poisson drive: a sparse list, so an idle brain costs nothing
  driveIdx;
  driveP;
  nDrive = 0;
  A;
  B;
  K;
  rfcDefault;
  delaySteps;
  rng = 2654435769;
  /** Neurons that fired in the most recent step (view into a scratch buffer). */
  lastSpikes;
  spikeBuf;
  steps = 0;
  constructor(sub, m) {
    this.n = sub.n;
    this.members = sub.members;
    this.m = m;
    this.row = sub.row;
    this.tgt = sub.tgt;
    this.wmv = new Float64Array(sub.w.length);
    for (let e = 0; e < sub.w.length; e++) this.wmv[e] = sub.w[e] * m.w_syn_mV;
    this.A = Math.exp(-m.dt_ms / m.t_mbr_ms);
    this.B = Math.exp(-m.dt_ms / m.tau_ms);
    this.K = m.tau_ms / (m.tau_ms - m.t_mbr_ms) * (this.B - this.A);
    this.rfcDefault = Math.round(m.t_rfc_ms / m.dt_ms);
    this.delaySteps = Math.round(m.delay_ms / m.dt_ms) + 1;
    this.v = new Float64Array(this.n).fill(m.v_0);
    this.g = new Float64Array(this.n);
    this.refr = new Int16Array(this.n);
    this.rfcSteps = new Int16Array(this.n).fill(this.rfcDefault);
    this.ringLen = this.delaySteps + 1;
    this.ring = Array.from({ length: this.ringLen }, () => new Uint16Array(this.n));
    this.ringN = new Uint32Array(this.ringLen);
    this.driveIdx = new Uint16Array(this.n);
    this.driveP = new Float64Array(this.n);
    this.spikeBuf = new Uint16Array(this.n);
    this.lastSpikes = this.spikeBuf.subarray(0, 0);
  }
  /** How many neurons currently carry external drive. */
  get driveCount() {
    return this.nDrive;
  }
  /** Reseed the Poisson stream. */
  seed(s) {
    this.rng = s | 0 || 2654435769;
  }
  /** xorshift32 - fast and good enough for Poisson arrivals. */
  rand() {
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x;
    return (x >>> 0) / 4294967296;
  }
  /**
   * Replace the external drive.  `rates` maps subnet index -> Hz.  Upstream `poi()`
   * also zeroes the refractory period of every externally driven neuron, so we do the
   * same, and restore it when the drive goes away.
   */
  setDrive(rates) {
    for (let k2 = 0; k2 < this.nDrive; k2++) this.rfcSteps[this.driveIdx[k2]] = this.rfcDefault;
    let k = 0;
    const pScale = this.m.dt_ms / 1e3;
    for (const [i, hz] of rates) {
      if (hz <= 0) continue;
      this.driveIdx[k] = i;
      this.driveP[k] = hz * pScale;
      this.rfcSteps[i] = 0;
      k++;
    }
    this.nDrive = k;
  }
  /** One 0.1 ms timestep.  Returns the number of spikes; they are in `lastSpikes`. */
  step() {
    const { v, g, refr, rfcSteps, row, tgt, wmv, ring, ringN } = this;
    const t = this.steps;
    const slot = t % this.ringLen;
    const arr = ring[slot], nIn = ringN[slot];
    for (let k = 0; k < nIn; k++) {
      const i = arr[k];
      for (let e = row[i], end = row[i + 1]; e < end; e++) {
        const j = tgt[e];
        if (refr[j] <= 0) g[j] += wmv[e];
      }
    }
    ringN[slot] = 0;
    const wPoi = this.m.w_syn_mV * this.m.f_poi;
    for (let k = 0; k < this.nDrive; k++) {
      if (this.rand() < this.driveP[k]) v[this.driveIdx[k]] += wPoi;
    }
    const os = (t + this.delaySteps) % this.ringLen;
    const out = ring[os];
    const spikes = this.spikeBuf;
    const { A, B, K } = this;
    const v0 = this.m.v_0, vth = this.m.v_th, vrst = this.m.v_rst;
    let nOut = 0;
    for (let i = 0; i < this.n; i++) {
      if (refr[i] > 0) {
        refr[i]--;
        continue;
      }
      const gi = g[i];
      const nv = v0 + (v[i] - v0) * A + gi * K;
      g[i] = gi * B;
      if (nv > vth) {
        v[i] = vrst;
        g[i] = 0;
        refr[i] = rfcSteps[i];
        out[nOut] = i;
        spikes[nOut] = i;
        nOut++;
      } else {
        v[i] = nv;
      }
    }
    ringN[os] = nOut;
    this.lastSpikes = spikes.subarray(0, nOut);
    this.steps = t + 1;
    return nOut;
  }
  /** Push neurons over threshold right now - a deterministic poke, no Poisson. */
  kick(idx, mv = 1e-3) {
    for (let k = 0; k < idx.length; k++) this.v[idx[k]] = this.m.v_th + mv;
  }
  /** Reset membrane state but keep the wiring. */
  reset() {
    this.v.fill(this.m.v_0);
    this.g.fill(0);
    this.refr.fill(0);
    for (const r of this.ring) r.fill(0);
    this.ringN.fill(0);
    this.steps = 0;
  }
};
var RateMeter = class {
  constructor(idx, tauMs = 60) {
    this.idx = idx;
    this.tauMs = tauMs;
  }
  acc = 0;
  value = 0;
  observe(spikes) {
    for (let k = 0; k < spikes.length; k++) if (this.idx.has(spikes[k])) this.acc++;
  }
  /** Call once per simulated millisecond block. */
  settle(ms) {
    const inst = this.idx.size ? this.acc / this.idx.size * (1e3 / ms) : 0;
    const a = 1 - Math.exp(-ms / this.tauMs);
    this.value += (inst - this.value) * a;
    this.acc = 0;
  }
};
export {
  LiveBrain,
  RateMeter
};
