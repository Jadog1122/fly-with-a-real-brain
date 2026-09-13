// Everything you hear is synthesised here - no samples, nothing to license.
//
// The wing buzz sits at 200 Hz because that is roughly a real Drosophila wingbeat, and
// the spike blips are triggered by the same threshold crossings that throw the damage
// numbers, so the sound is driven by the simulation rather than laid over it.

type Ctx = AudioContext

/** One-pole noise buffer, reused by every noise voice. */
function noiseBuffer(ctx: Ctx, seconds = 2) {
  const n = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, n, ctx.sampleRate)
  const d = buf.getChannelData(0)
  let last = 0
  for (let i = 0; i < n; i++) {
    const white = Math.random() * 2 - 1
    last = (last + 0.04 * white) / 1.04       // brown-ish, less hissy than white
    d[i] = last * 3.2
  }
  return buf
}

const BLIP: Record<string, { hz: number; tone: 'sine' | 'triangle' | 'square'; len: number }> = {
  escape:    { hz: 880, tone: 'square',   len: 0.16 },
  proboscis: { hz: 523, tone: 'sine',     len: 0.22 },
  groom:     { hz: 392, tone: 'triangle', len: 0.20 },
  backward:  { hz: 294, tone: 'triangle', len: 0.16 },
  forward:   { hz: 659, tone: 'sine',     len: 0.10 },
  turn_a:    { hz: 587, tone: 'sine',     len: 0.08 },
  turn_b:    { hz: 494, tone: 'sine',     len: 0.08 },
}

export class PetAudio {
  private ctx: Ctx | null = null
  private master!: GainNode
  private noise!: AudioBuffer
  private wingGain!: GainNode
  private wingOsc!: OscillatorNode
  private wingFilter!: BiquadFilterNode
  private roomGain!: GainNode
  private eatGain!: GainNode
  private lastStep = 0
  enabled = false

  /** Must be called from a user gesture; browsers will not start audio otherwise. */
  async enable() {
    if (this.ctx) { await this.ctx.resume(); this.enabled = true; return }
    const ctx = new (window.AudioContext || window.webkitAudioContext!)() as Ctx
    this.ctx = ctx
    this.noise = noiseBuffer(ctx)

    this.master = ctx.createGain()
    this.master.gain.value = 0.9
    this.master.connect(ctx.destination)

    // room tone: a whisper of filtered noise so silence is not a dead line
    const room = ctx.createBufferSource()
    room.buffer = this.noise; room.loop = true
    const roomLP = ctx.createBiquadFilter()
    roomLP.type = 'lowpass'; roomLP.frequency.value = 340
    this.roomGain = ctx.createGain(); this.roomGain.gain.value = 0.012
    room.connect(roomLP).connect(this.roomGain).connect(this.master)
    room.start()

    // wings: a real Drosophila wingbeat is about 200 Hz
    this.wingOsc = ctx.createOscillator()
    this.wingOsc.type = 'sawtooth'
    this.wingOsc.frequency.value = 200
    this.wingFilter = ctx.createBiquadFilter()
    this.wingFilter.type = 'bandpass'
    this.wingFilter.frequency.value = 420
    this.wingFilter.Q.value = 4
    this.wingGain = ctx.createGain(); this.wingGain.gain.value = 0
    this.wingOsc.connect(this.wingFilter).connect(this.wingGain).connect(this.master)
    this.wingOsc.start()

    this.eatGain = ctx.createGain(); this.eatGain.gain.value = 0
    const eatSrc = ctx.createBufferSource()
    eatSrc.buffer = this.noise; eatSrc.loop = true
    const eatLP = ctx.createBiquadFilter()
    eatLP.type = 'lowpass'; eatLP.frequency.value = 700
    eatSrc.connect(eatLP).connect(this.eatGain).connect(this.master)
    eatSrc.start()

    await ctx.resume()
    this.enabled = true
  }

  mute(on: boolean) {
    if (!this.ctx) return
    this.master.gain.setTargetAtTime(on ? 0 : 0.9, this.ctx.currentTime, 0.05)
  }

  /** A footfall: short filtered noise tick. */
  private step(vol: number) {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    src.playbackRate.value = 1.6 + Math.random() * 0.5
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'; bp.frequency.value = 1800 + Math.random() * 900; bp.Q.value = 2
    const g = ctx.createGain()
    const t = ctx.currentTime
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(vol, t + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.055)
    src.connect(bp).connect(g).connect(this.master)
    src.start(t, Math.random() * 1.5, 0.08)
  }

  /** A neuron crossed its behavioural threshold. */
  blip(id: string, strength = 1) {
    if (!this.ctx || !this.enabled) return
    const spec = BLIP[id] ?? BLIP.turn_a
    const ctx = this.ctx, t = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = spec.tone
    osc.frequency.setValueAtTime(spec.hz, t)
    osc.frequency.exponentialRampToValueAtTime(spec.hz * 0.72, t + spec.len)
    const g = ctx.createGain()
    const peak = Math.min(0.22, 0.09 + strength * 0.13)
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(peak, t + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, t + spec.len)
    osc.connect(g).connect(this.master)
    osc.start(t); osc.stop(t + spec.len + 0.02)
  }

  /** Called every simulation tick with the current state. */
  update(o: { speed: number; escape: boolean; eating: boolean; legPhase: number; groom: number }) {
    if (!this.ctx || !this.enabled) return
    const t = this.ctx.currentTime

    // wings only while airborne; on the ground you hear feet, not wings
    const wing = o.escape ? 0.16 : 0
    this.wingGain.gain.setTargetAtTime(wing, t, 0.04)
    this.wingOsc.frequency.setTargetAtTime(o.escape ? 200 : 150, t, 0.08)
    this.wingFilter.frequency.setTargetAtTime(420 + o.speed * 1.6, t, 0.1)

    // footfalls follow the leg cycle the renderer already animates
    const half = Math.floor(o.legPhase / Math.PI)
    if (!o.escape && Math.abs(o.speed) > 4 && half !== this.lastStep) {
      this.lastStep = half
      this.step(Math.min(0.05, 0.012 + Math.abs(o.speed) * 0.0004))
    }

    this.eatGain.gain.setTargetAtTime(o.eating ? 0.05 : 0, t, 0.08)
    this.roomGain.gain.setTargetAtTime(0.012 + o.groom * 0.05, t, 0.12)
  }
}
