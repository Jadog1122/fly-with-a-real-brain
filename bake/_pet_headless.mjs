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
    const { A, B, K: K2 } = this;
    const v0 = this.m.v_0, vth = this.m.v_th, vrst = this.m.v_rst;
    let nOut = 0;
    for (let i = 0; i < this.n; i++) {
      if (refr[i] > 0) {
        refr[i]--;
        continue;
      }
      const gi = g[i];
      const nv = v0 + (v[i] - v0) * A + gi * K2;
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

// src/pet/sensors.ts
var STIMULI = [
  // taste is contact chemoreception, but a drop is a puddle rather than a point: too
  // small a patch and a fly with no way to smell food never finds it by wandering
  {
    id: "sugar",
    label: "Sugar",
    emoji: "\u{1F36C}",
    colour: "#ffc24d",
    range: 56,
    contact: true,
    edible: true,
    blurb: "Feet taste it first, then the mouthparts. Tongue comes out.",
    channels: [{ group: "foot", rangeMul: 1 }, { group: "sugar", rangeMul: 0.66 }]
  },
  {
    id: "bitter",
    label: "Bitter",
    emoji: "\u2620\uFE0F",
    colour: "#8f7dd8",
    range: 56,
    contact: true,
    edible: false,
    blurb: "Also contact. Aversive - it suppresses feeding.",
    channels: [{ group: "bitter", rangeMul: 1 }]
  },
  {
    id: "looming",
    label: "Looming",
    emoji: "\u{1F6F8}",
    colour: "#ff5f7a",
    range: 150,
    contact: false,
    edible: false,
    blurb: "A shadow growing overhead. LC4 -> Giant Fiber -> jump.",
    channels: [{ group: "looming", rangeMul: 1 }]
  },
  {
    id: "bristle",
    label: "Dust",
    emoji: "\u2728",
    colour: "#c8b3ff",
    range: 80,
    contact: false,
    edible: false,
    blurb: "Specks landing on the body. 1,417 bristles -> the strongest grooming signal in the model.",
    channels: [{ group: "bristle", rangeMul: 1 }]
  },
  {
    id: "touch",
    label: "Vibration",
    emoji: "\u3030\uFE0F",
    colour: "#7ac8ff",
    range: 90,
    contact: false,
    edible: false,
    blurb: "Air movement on the antennae. Johnston's organ -> grooming.",
    channels: [{ group: "touch", rangeMul: 1 }]
  },
  {
    id: "odor",
    label: "Geosmin",
    emoji: "\u{1F344}",
    colour: "#5fd68a",
    range: 200,
    contact: false,
    edible: false,
    blurb: "A known artifact, kept on purpose: any smell tips this model into a whole-brain runaway whose fixed output is steering. The turn is not a smell response.",
    artifact: true,
    channels: [{ group: "odor", rangeMul: 1 }]
  }
];
var ADAPT = {
  floorPhasic: 0.18,
  floorTaste: 0.72,
  tauFallMs: 2200,
  tauRiseMs: 5e3
};
function bearing(fx, fy, h, x, y) {
  let a = Math.atan2(y - fy, x - fx) - h;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
function computeDrive(stims, fx, fy, heading, groups, gain, dtMs = 0) {
  const rates = /* @__PURE__ */ new Map();
  const perStim = /* @__PURE__ */ new Map();
  let touching = null;
  const add = (idx, hz) => {
    for (const i of idx) rates.set(i, (rates.get(i) ?? 0) + hz);
  };
  for (const s of stims) {
    const d = Math.hypot(s.x - fx, s.y - fy);
    const raw = s.kind.contact ? d < s.kind.range ? 1 - d / s.kind.range : 0 : Math.exp(-d / s.kind.range);
    const floor = s.kind.contact ? ADAPT.floorTaste : ADAPT.floorPhasic;
    if (s.adapt === void 0) s.adapt = 1;
    if (dtMs > 0) {
      const exposed = raw > 0.12;
      const tau = exposed ? ADAPT.tauFallMs : ADAPT.tauRiseMs;
      const target = exposed ? floor : 1;
      s.adapt += (target - s.adapt) * (1 - Math.exp(-dtMs / tau));
    }
    const intensity = raw * s.adapt * gain(s.kind.id);
    if (intensity < 0.01) continue;
    if (s.kind.contact && d < s.kind.range * 0.62) touching = s;
    perStim.set(s.id, Math.min(1, intensity));
    const b = bearing(fx, fy, heading, s.x, s.y);
    const lean = s.kind.contact ? 0 : -Math.sin(b);
    const lg = Math.max(0, 0.5 + 0.5 * lean);
    const rg = Math.max(0, 0.5 - 0.5 * lean);
    for (const ch of s.kind.channels) {
      const g = groups.get(ch.group);
      if (!g) continue;
      const reach = ch.rangeMul >= 1 ? intensity : Math.max(0, (raw - (1 - ch.rangeMul)) / ch.rangeMul) * s.adapt * gain(s.kind.id);
      if (reach < 0.01) continue;
      const base = g.rate_hz * Math.min(reach, 1);
      add(g.sides.left, base * 2 * lg);
      add(g.sides.right, base * 2 * rg);
      add(g.sides.other, base);
    }
  }
  for (const [i, hz] of rates) rates.set(i, Math.min(hz, 400));
  return { rates, perStim, touching };
}
function foragingDrive(hunger, wander, bout, saccade, forward, steerL, steerR) {
  const out = /* @__PURE__ */ new Map();
  const walk = (14 + hunger * 46) * bout;
  for (const i of forward) out.set(i, walk);
  const lean = 26 * wander + 120 * saccade;
  for (const i of steerL) out.set(i, Math.max(0, 22 + lean));
  for (const i of steerR) out.set(i, Math.max(0, 22 - lean));
  return out;
}
var Saccades = class {
  until = 0;
  dir = 1;
  next = 1200 + Math.random() * 2200;
  t = 0;
  step(dtMs) {
    this.t += dtMs;
    if (this.t > this.next) {
      this.t = 0;
      this.next = 1100 + Math.random() * 2400;
      this.dir = Math.random() < 0.5 ? -1 : 1;
      this.until = 180 + Math.random() * 120;
    }
    if (this.until > 0) {
      this.until -= dtMs;
      return this.dir;
    }
    return 0;
  }
};

// src/pet/motor.ts
var TH = { escape: 12, proboscis: 4, groom: 4, walking: 24, steering: 9 };
var K = { forward: 0.42, backward: 0.38, turn: 0.01, escapeSpeed: 130 };
var MotorDecoder = class {
  s = {};
  escapeLatch = 0;
  update(r, dtMs) {
    const a = 1 - Math.exp(-dtMs / 25);
    for (const k in r) {
      if (!this.s[k]) this.s[k] = [0, 0];
      this.s[k][0] += (r[k][0] - this.s[k][0]) * a;
      this.s[k][1] += (r[k][1] - this.s[k][1]) * a;
    }
    const g = (k) => this.s[k] ?? [0, 0];
    const sum = (k) => g(k)[0] + g(k)[1];
    const fwd = sum("forward"), back = sum("backward");
    const turnL = g("turn_a")[0] + g("turn_b")[0];
    const turnR = g("turn_a")[1] + g("turn_b")[1];
    const esc = sum("escape"), pro = sum("proboscis"), grm = sum("groom");
    if (esc > TH.escape) this.escapeLatch = 420;
    this.escapeLatch = Math.max(0, this.escapeLatch - dtMs);
    const dominant = this.escapeLatch > 0 ? "escape" : grm > TH.groom ? "grooming" : pro > TH.proboscis ? "feeding" : back > fwd && back > TH.walking ? "backing up" : fwd > TH.walking ? "walking" : Math.abs(turnL - turnR) > TH.steering ? "turning" : "idle";
    const busy = this.escapeLatch > 0 || grm > TH.groom;
    return {
      forward: busy ? 0 : K.forward * fwd - K.backward * back,
      turn: busy ? 0 : K.turn * (turnL - turnR),
      escape: this.escapeLatch > 0,
      escapeSpeed: K.escapeSpeed,
      proboscis: Math.min(1, pro / (TH.proboscis * 3)),
      groom: Math.min(1, grm / (TH.groom * 3)),
      dominant
    };
  }
  rate(id) {
    const v = this.s[id];
    return v ? v[0] + v[1] : 0;
  }
};

// src/pet/world.ts
var World = class {
  // A behaviour chamber, not a field.  Sized so a fly with no way to smell food still
  // runs into a drop of it within a minute or two of wandering - see bake/15_pet_tune.mjs.
  w = 760;
  h = 490;
  fly = { x: 380, y: 245, h: -Math.PI / 2, speed: 0, legPhase: 0, wing: 0, hunger: 0.35, startle: 0, fed: 0 };
  stims = [];
  trail = [];
  nextId = 1;
  add(kind, x, y) {
    const s = { kind, x, y, id: this.nextId++ };
    this.stims.push(s);
    return s;
  }
  remove(id) {
    this.stims = this.stims.filter((s) => s.id !== id);
  }
  clear() {
    this.stims = [];
  }
  step(a, dtMs, ate, touching) {
    const f = this.fly;
    const dt = dtMs / 1e3;
    const onMeal = !!touching && touching.kind.edible && a.proboscis > 0.4;
    f.h += (onMeal ? 0 : a.turn) * dt;
    const target = a.escape ? a.escapeSpeed : onMeal ? 0 : a.forward;
    f.speed += (target - f.speed) * Math.min(1, dt * 6);
    f.x += Math.cos(f.h) * f.speed * dt;
    f.y += Math.sin(f.h) * f.speed * dt;
    const m = 26;
    if (f.x < m) {
      f.x = m;
      f.h = Math.PI - f.h;
    }
    if (f.x > this.w - m) {
      f.x = this.w - m;
      f.h = Math.PI - f.h;
    }
    if (f.y < m) {
      f.y = m;
      f.h = -f.h;
    }
    if (f.y > this.h - m) {
      f.y = this.h - m;
      f.h = -f.h;
    }
    f.legPhase += Math.min(Math.abs(f.speed), 200) * dt * 0.09;
    f.wing += (a.escape ? 1 : 0 - f.wing) * dt * 8;
    f.wing = Math.max(0, Math.min(1, a.escape ? 1 : f.wing - dt * 3));
    f.startle = Math.max(0, f.startle - dt * 0.45) + (a.escape ? dt * 3 : 0);
    f.startle = Math.min(1, f.startle);
    f.hunger = Math.min(1, f.hunger + dt * 35e-4);
    if (onMeal) {
      f.hunger = Math.max(0, f.hunger - dt * 0.22);
      f.eating = Math.min(1, (f.eating ?? 0) + dt * 2);
      if (f.hunger <= 0.02 || f.eating > 1 && Math.random() < dt * 0.5) {
        f.fed++;
        f.eating = 0;
        ate(touching);
      }
    } else {
      f.eating = Math.max(0, (f.eating ?? 0) - dt);
    }
    if (this.trail.length === 0 || Math.hypot(
      f.x - this.trail[this.trail.length - 1][0],
      f.y - this.trail[this.trail.length - 1][1]
    ) > 5) {
      this.trail.push([f.x, f.y]);
      if (this.trail.length > 260) this.trail.shift();
    }
  }
};
export {
  LiveBrain,
  MotorDecoder,
  STIMULI,
  Saccades,
  World,
  computeDrive,
  foragingDrive
};
