// The other people in the meadow, drawn in it: a ring on the ground where each pointer
// is, a ring under each token in its owner's colour, and a name over both. The rings are
// three.js, in the overlay scene so they draw on top of the grass; the names are HTML,
// projected from the same points each frame, because text in WebGL is a texture and
// text in the DOM is text.

import * as THREE from 'three'
import type { PlayerView, TokenView } from './protocol'

interface Cursor {
  ring: THREE.Mesh
  label: HTMLDivElement
  target: THREE.Vector3
  seen: number
}
interface Owned {
  ring: THREE.Mesh
  label: HTMLDivElement
  phase: number
}
interface Burst {
  ring: THREE.Mesh
  life: number
}

const V = new THREE.Vector3()

export class Presence3D {
  private group = new THREE.Group()
  private cursors = new Map<string, Cursor>()
  private owned = new Map<number, Owned>()
  private bursts: Burst[] = []
  private who = new Map<string, PlayerView>()
  private me: string | null = null
  private cursorGeo = new THREE.RingGeometry(9, 12.5, 40)
  private ownedGeo = new THREE.RingGeometry(20, 23, 48)
  private burstGeo = new THREE.RingGeometry(0.85, 1, 48)
  /** a pale ring under the fly: from the overview it is a few pixels in a busy meadow */
  private flyRing: THREE.Mesh
  private time = 0

  constructor(overlay: THREE.Scene, private camera: THREE.Camera, private labels: HTMLElement) {
    overlay.add(this.group)
    this.flyRing = new THREE.Mesh(new THREE.RingGeometry(30, 33, 48), this.mat('#fff4d6', 0.5))
    this.flyRing.rotation.x = -Math.PI / 2
    this.group.add(this.flyRing)
  }

  /** Where the fly is, this frame. The ring fades as the camera comes in close. */
  setFly(x: number, y: number, alt: number) {
    this.flyRing.position.set(x, 1.6, y)
    const far = Math.min(1, Math.max(0, (this.camera.position.distanceTo(this.flyRing.position) - 350) / 400))
    const m = this.flyRing.material as THREE.MeshBasicMaterial
    m.opacity = (0.28 + 0.22 * Math.sin(this.time * 2.4)) * far * (1 - Math.min(1, alt / 120))
  }

  private mat(colour: string, opacity: number) {
    return new THREE.MeshBasicMaterial({
      color: new THREE.Color(colour), transparent: true, opacity, depthTest: false, depthWrite: false,
      side: THREE.DoubleSide,
    })
  }

  private label(text: string, colour: string, cls: string) {
    const el = document.createElement('div')
    el.className = `play-label ${cls}`
    el.textContent = text
    el.style.color = colour
    this.labels.appendChild(el)
    return el
  }

  setPlayers(players: PlayerView[], me: string | null) {
    for (const p of players) this.who.set(p.id, p)
    this.me = me
    for (const [id, c] of this.cursors) {
      const p = this.who.get(id)
      if (p) {
        c.label.textContent = p.name
        c.label.style.color = p.colour
        ;(c.ring.material as THREE.MeshBasicMaterial).color.set(p.colour)
      }
    }
  }

  /** Every pointer the server knows about, this instant. */
  setCursors(list: [string, number, number][], now: number) {
    const live = new Set<string>()
    for (const [id, x, y] of list) {
      live.add(id)
      let c = this.cursors.get(id)
      const p = this.who.get(id)
      if (!c) {
        const colour = p?.colour ?? '#ffffff'
        const ring = new THREE.Mesh(this.cursorGeo, this.mat(colour, id === this.me ? 0.55 : 0.9))
        ring.rotation.x = -Math.PI / 2
        ring.position.set(x, 1.5, y)
        this.group.add(ring)
        c = { ring, label: this.label(p?.name ?? '', colour, id === this.me ? 'play-label-me' : ''),
              target: new THREE.Vector3(x, 1.5, y), seen: now }
        this.cursors.set(id, c)
      }
      c.target.set(x, 1.5, y)
      c.seen = now
    }
    for (const [id, c] of this.cursors) {
      if (live.has(id)) continue
      this.group.remove(c.ring)
      ;(c.ring.material as THREE.Material).dispose()
      c.label.remove()
      this.cursors.delete(id)
    }
  }

  setTokens(tokens: TokenView[]) {
    const live = new Set<number>()
    for (const t of tokens) {
      live.add(t.id)
      const p = { name: t.name, colour: t.colour }
      const colour = p.colour
      let o = this.owned.get(t.id)
      if (!o) {
        const ring = new THREE.Mesh(this.ownedGeo, this.mat(colour, 0.75))
        ring.rotation.x = -Math.PI / 2
        ring.position.set(t.x, 1.2, t.y)
        this.group.add(ring)
        o = { ring, label: this.label('', colour, 'play-label-token'), phase: Math.random() * 6.28 }
        o.label.dataset.owner = t.owner
        this.owned.set(t.id, o)
      }
      o.ring.position.set(t.x, 1.2, t.y)
      o.label.dataset.spoiled = t.spoiled ? '1' : '0'
      o.label.textContent = t.spoiled ? `${p.name} · spoiled` : p.name
      o.label.style.color = t.spoiled ? '#c9c2b8' : colour
      ;(o.ring.material as THREE.MeshBasicMaterial).color.set(t.spoiled ? '#8a847c' : colour)
    }
    for (const [id, o] of this.owned) {
      if (live.has(id)) continue
      this.group.remove(o.ring)
      ;(o.ring.material as THREE.Material).dispose()
      o.label.remove()
      this.owned.delete(id)
    }
  }

  /** A ring that swells and fades where something happened - a meal, mostly. */
  burst(x: number, y: number, colour: string) {
    const ring = new THREE.Mesh(this.burstGeo, this.mat(colour, 0.9))
    ring.rotation.x = -Math.PI / 2
    ring.position.set(x, 1.8, y)
    ring.scale.setScalar(12)
    this.group.add(ring)
    this.bursts.push({ ring, life: 1 })
  }

  /** Once a frame, after the camera has moved. */
  update(dt: number, now: number, host: HTMLElement) {
    this.time += dt
    const b = host.getBoundingClientRect()
    const k = 1 - Math.exp(-dt * 14)
    for (const c of this.cursors.values()) {
      c.ring.position.lerp(c.target, k)
      // a pointer that has not moved for a while fades, so an idle phone is not a beacon
      const idle = Math.max(0, Math.min(1, (now - c.seen - 6000) / 4000))
      ;(c.ring.material as THREE.MeshBasicMaterial).opacity = (0.9 - idle * 0.6)
      this.place(c.label, c.ring.position, b, -18, 1 - idle * 0.6)
    }
    for (const o of this.owned.values()) {
      const s = 1 + 0.05 * Math.sin(this.time * 3 + o.phase)
      o.ring.scale.setScalar(s)
      this.place(o.label, o.ring.position, b, 14, 1)
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const bu = this.bursts[i]
      bu.life -= dt * 1.4
      bu.ring.scale.setScalar(12 + (1 - bu.life) * 70)
      ;(bu.ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, bu.life) * 0.9
      if (bu.life <= 0) {
        this.group.remove(bu.ring)
        ;(bu.ring.material as THREE.Material).dispose()
        this.bursts.splice(i, 1)
      }
    }
  }

  private place(el: HTMLElement, at: THREE.Vector3, b: DOMRect, dy: number, alpha: number) {
    V.copy(at).project(this.camera)
    if (V.z > 1 || Math.abs(V.x) > 1.2 || Math.abs(V.y) > 1.2) { el.style.display = 'none'; return }
    el.style.display = ''
    el.style.opacity = String(alpha)
    el.style.transform = `translate(-50%, -50%) translate(${((V.x + 1) / 2 * b.width).toFixed(1)}px, ${((1 - V.y) / 2 * b.height + dy).toFixed(1)}px)`
  }

  dispose() {
    this.group.remove(this.flyRing)
    for (const c of this.cursors.values()) { this.group.remove(c.ring); c.label.remove() }
    for (const o of this.owned.values()) { this.group.remove(o.ring); o.label.remove() }
    for (const bu of this.bursts) this.group.remove(bu.ring)
    this.cursors.clear(); this.owned.clear(); this.bursts = []
    this.group.parent?.remove(this.group)
  }
}
