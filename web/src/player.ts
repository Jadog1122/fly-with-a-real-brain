// Playback clock.  Owns the current frame and pushes spikes into the Brain.

import type { Brain } from './brain'
import type { Experiment } from './data'

export class Player {
  exp: Experiment | null = null
  frame = 0                 // fractional frame index
  playing = false
  simMsPerSec = 50          // simulation milliseconds per wall-clock second
  tauWall = 0.42            // visual decay constant, wall-clock seconds
  onChange: (() => void) | null = null

  private fired = -1        // highest integer frame already pushed to the Brain
  constructor(private brain: Brain) {}

  get nFrames() { return this.exp ? this.exp.n_frames : 1 }
  get frameMs() { return this.exp ? this.exp.frame_ms : 5 }
  get simTime() { return this.frame * this.frameMs / 1000 }
  get timeMs() { return this.frame * this.frameMs }
  get durationMs() { return this.nFrames * this.frameMs }

  private applyTau() {
    this.brain.setTau(this.tauWall, this.simMsPerSec / 1000)
  }

  load(exp: Experiment | null) {
    this.exp = exp
    this.brain.setExperiment(exp)
    this.applyTau()
    this.seek(0)
    this.playing = !!exp
  }

  setSpeed(simMsPerSec: number) {
    this.simMsPerSec = simMsPerSec
    this.applyTau()
  }

  /** Jump to a frame: clear, then replay just enough history for the decay tail. */
  seek(f: number) {
    if (!this.exp) return
    this.frame = Math.max(0, Math.min(f, this.nFrames))
    this.brain.clearActivity()
    const tailFrames = Math.ceil((this.tauWall * this.simMsPerSec) / this.frameMs * 4) + 1
    const target = Math.floor(this.frame)
    const from = Math.max(0, target - tailFrames)
    for (let k = from; k <= target && k < this.nFrames; k++) {
      this.brain.fireFrame(this.exp.frame(k), k * this.frameMs / 1000)
    }
    this.fired = Math.min(target, this.nFrames - 1)
    this.brain.setNow(this.simTime)
    this.onChange?.()
  }

  step(n: number) {
    this.playing = false
    this.seek(Math.floor(this.frame) + n)
  }

  toggle() {
    if (!this.exp) return
    if (this.frame >= this.nFrames) this.seek(0)
    this.playing = !this.playing
    this.onChange?.()
  }

  tick(dt: number) {
    if (!this.exp) return
    if (this.playing) {
      this.frame += dt * this.simMsPerSec / this.frameMs
      const target = Math.floor(this.frame)
      while (this.fired < target && this.fired + 1 < this.nFrames) {
        this.fired++
        this.brain.fireFrame(this.exp.frame(this.fired), this.fired * this.frameMs / 1000)
      }
      if (this.frame >= this.nFrames) {
        this.frame = this.nFrames
        this.playing = false
      }
      this.onChange?.()
    }
    this.brain.setNow(this.simTime)
  }

  /** Neurons active in the current frame (for the readout). */
  activeNow(): number {
    if (!this.exp) return 0
    const k = Math.min(Math.floor(this.frame), this.nFrames - 1)
    return k < 0 ? 0 : this.exp.frame(k).length
  }

  /** Distinct neurons recruited up to the current frame. */
  recruited(): number {
    if (!this.exp) return 0
    const k = Math.min(Math.floor(this.frame), this.nFrames - 1)
    if (this.cumKey !== this.exp.exp_id) this.buildCum()
    return this.cum[Math.max(0, k)] ?? 0
  }

  private cum: number[] = []
  private cumKey = ''
  private buildCum() {
    const seen = new Set<number>()
    const e = this.exp!
    this.cum = []
    for (let k = 0; k < e.n_frames; k++) {
      for (const i of e.frame(k)) seen.add(i)
      this.cum.push(seen.size)
    }
    this.cumKey = e.exp_id
  }
}
