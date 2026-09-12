// Spike raster: neurons (ordered by first spike) against time, with a play cursor.

import type { Experiment } from './data'

export class Raster {
  private off = document.createElement('canvas')
  private rows = new Map<number, number>()
  private exp: Experiment | null = null

  constructor(private canvas: HTMLCanvasElement) {}

  load(exp: Experiment | null, seeds: Set<number>, named: Set<number>) {
    this.exp = exp
    this.rows.clear()
    if (!exp) { this.draw(0); return }

    const order: number[] = []
    const seen = new Set<number>()
    for (let k = 0; k < exp.n_frames; k++)
      for (const i of exp.frame(k)) if (!seen.has(i)) { seen.add(i); order.push(i) }
    order.forEach((i, r) => this.rows.set(i, r))

    const dpr = Math.min(devicePixelRatio, 2)
    const w = Math.max(this.canvas.clientWidth, 200) * dpr
    const h = Math.max(this.canvas.clientHeight, 60) * dpr
    this.off.width = w; this.off.height = h
    const g = this.off.getContext('2d')!
    g.clearRect(0, 0, w, h)

    const n = Math.max(order.length, 1)
    const sx = w / exp.n_frames
    const sy = h / n
    const dotW = Math.max(1, sx * 0.85)
    const dotH = Math.max(1, sy * 0.9)
    for (let k = 0; k < exp.n_frames; k++) {
      const x = k * sx
      for (const i of exp.frame(k)) {
        const y = (this.rows.get(i)! + 0.5) * sy
        g.fillStyle = seeds.has(i) ? 'rgba(255,186,45,.95)'
          : named.has(i) ? 'rgba(255,70,110,1)'
            : 'rgba(96,178,255,.72)'
        g.fillRect(x, y - dotH / 2, dotW, dotH)
      }
    }
    this.draw(0)
  }

  draw(frame: number) {
    const dpr = Math.min(devicePixelRatio, 2)
    const w = Math.max(this.canvas.clientWidth, 200) * dpr
    const h = Math.max(this.canvas.clientHeight, 60) * dpr
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h }
    const g = this.canvas.getContext('2d')!
    g.clearRect(0, 0, w, h)
    if (!this.exp) {
      g.fillStyle = 'rgba(150,165,190,.45)'
      g.font = `${12 * dpr}px ui-monospace, monospace`
      g.fillText('no experiment loaded', 10 * dpr, h / 2)
      return
    }
    if (this.off.width) g.drawImage(this.off, 0, 0, w, h)
    const x = Math.min(frame / this.exp.n_frames, 1) * w
    g.strokeStyle = 'rgba(255,255,255,.72)'
    g.lineWidth = Math.max(1, dpr)
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke()
    g.fillStyle = 'rgba(255,255,255,.10)'
    g.fillRect(x, 0, w - x, h)
  }

  /** Frame index for a click at clientX. */
  frameAt(clientX: number): number {
    const r = this.canvas.getBoundingClientRect()
    const t = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    return t * (this.exp?.n_frames ?? 1)
  }
}
