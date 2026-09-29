// The play page's side of the wire: the socket, and making 20 messages a second look
// like a fly that moves.
//
// The server sends the fly's state every 50 ms. Drawn as it arrives, that is a fly that
// jumps five times a second. So the client renders a little behind the newest state and
// interpolates between the two states that bracket that moment - on the server's own
// clock, carried in each message, rather than on arrival time, which wobbles with the
// network. If the buffer runs dry it holds the last state and keeps the legs going.

import { parseServerMsg, randomName, type ClientMsg, type ServerMsg, type StateMsg,
         type FlyView, type ToolId } from './protocol'

/** Render this far behind the newest state: two messages' worth, so one late one is absorbed. */
export const DELAY_MS = 110
const KEEP = 12

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
/** Shortest way round between two headings. */
export function lerpAngle(a: number, b: number, t: number) {
  let d = b - a
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return a + d * t
}

/**
 * Where to draw the fly at a given moment, from the states received so far.
 * Pure: hands in the clock, so it can be tested without waiting.
 */
export class Interpolator {
  private buf: StateMsg[] = []
  /** local clock minus server clock, tracked toward the least-delayed message */
  private offset: number | null = null

  push(s: StateMsg, localNow: number) {
    const o = localNow - s.at
    // Take the smallest offset seen (the message that travelled fastest) and let it
    // drift up slowly, so a clock that runs ahead corrects itself in a minute or so.
    this.offset = this.offset === null ? o : Math.min(o, this.offset + 0.002 * (o - this.offset) * 10)
    // in order, and never a duplicate
    if (this.buf.length && s.at <= this.buf[this.buf.length - 1].at) return
    this.buf.push(s)
    if (this.buf.length > KEEP) this.buf.shift()
  }

  get latest(): StateMsg | null { return this.buf[this.buf.length - 1] ?? null }
  get count() { return this.buf.length }

  /**
   * The fly at `localNow`, written into `out`. Returns the state whose non-numeric
   * fields (what it is doing, the rates) apply, or null if nothing has arrived yet.
   */
  sample(localNow: number, out: Omit<FlyView, 'eating'> & { eating?: number }): StateMsg | null {
    const n = this.buf.length
    if (!n || this.offset === null) return null
    const t = localNow - this.offset - DELAY_MS
    let a = this.buf[0], b = this.buf[0]
    for (let i = 0; i < n; i++) {
      if (this.buf[i].at <= t) a = this.buf[i]
      if (this.buf[i].at >= t) { b = this.buf[i]; break }
      b = this.buf[i]
    }
    const span = b.at - a.at
    const k = span > 0 ? Math.max(0, Math.min(1, (t - a.at) / span)) : 1
    const fa = a.fly, fb = b.fly
    out.x = lerp(fa.x, fb.x, k)
    out.y = lerp(fa.y, fb.y, k)
    out.h = lerpAngle(fa.h, fb.h, k)
    out.speed = lerp(fa.speed, fb.speed, k)
    out.alt = lerp(fa.alt, fb.alt, k)
    out.flying = lerp(fa.flying, fb.flying, k)
    out.bank = lerp(fa.bank, fb.bank, k)
    out.pitch = lerp(fa.pitch, fb.pitch, k)
    out.hunger = lerp(fa.hunger, fb.hunger, k)
    out.startle = lerp(fa.startle, fb.startle, k)
    out.eating = k < 0.5 ? fa.eating : fb.eating
    return k < 0.5 ? a : b
  }
}

// --- where the server is ----------------------------------------------------------------

/**
 * The socket URL, in order of preference: `?server=` on the page, the build's
 * VITE_PLAY_SERVER, else `/ws` on the page's own origin - which is right in development
 * (vite proxies it), under `vite preview`, and when the game server serves the site.
 */
export function resolveServerUrl(search: string, env: string | undefined, origin: string): string {
  const q = new URLSearchParams(search).get('server')
  if (q) return q
  if (env) return env
  return origin.replace(/^http/, 'ws') + '/ws'
}

export function serverUrl(): string {
  return resolveServerUrl(location.search, import.meta.env.VITE_PLAY_SERVER as string | undefined,
                          location.origin)
}

// --- the client -------------------------------------------------------------------------

const KEY = 'fly-play-key'
const NAME = 'fly-play-name'

function stored(k: string): string | null {
  try { return localStorage.getItem(k) } catch { return null }
}
function store(k: string, v: string) {
  try { localStorage.setItem(k, v) } catch { /* private mode: a fresh seat next time */ }
}

/** The secret that brings a reload back to the same seat. */
export function playerKey(): string {
  let k = stored(KEY)
  if (!k || !/^[A-Za-z0-9_-]{8,64}$/.test(k)) {
    const bytes = new Uint8Array(12)
    crypto.getRandomValues(bytes)
    k = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
    store(KEY, k)
  }
  return k
}

export function rememberedName(): string {
  return stored(NAME) ?? randomName()
}
export function rememberName(name: string) { store(NAME, name) }

export type Status = 'connecting' | 'open' | 'closed' | 'failed'

export class PlayClient {
  status: Status = 'connecting'
  private ws: WebSocket | null = null
  private closed = false
  private attempts = 0
  private lastCursor = { x: NaN, y: NaN, at: 0 }
  private pending: { x: number; y: number } | null = null
  private cursorTimer = 0

  constructor(readonly url: string, private name: string,
              private onMsg: (m: ServerMsg) => void,
              private onStatus: (s: Status, detail?: string) => void) {
    this.connect()
  }

  private connect() {
    if (this.closed) return
    this.set('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch (e) {
      this.set('failed', e instanceof Error ? e.message : String(e))
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.attempts = 0
      this.set('open')
      this.send({ t: 'join', name: this.name, key: playerKey() })
    }
    ws.onmessage = ev => {
      let raw: unknown
      try { raw = JSON.parse(String(ev.data)) } catch { return }
      const m = parseServerMsg(raw)
      if (m) this.onMsg(m)
    }
    ws.onclose = ev => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.closed) return
      // 4000-series closes are the server's decision; do not argue with them
      if (ev.code >= 4000) { this.set('failed', ev.reason || 'the server closed the connection'); return }
      // the first failure, before anything ever opened, is a wrong address; say so
      if (this.attempts === 0 && this.status === 'connecting') {
        this.set('failed', `could not reach the game server at ${this.url}`)
        return
      }
      this.set('closed')
      this.attempts++
      setTimeout(() => this.connect(), Math.min(8000, 500 * 2 ** Math.min(this.attempts, 4)))
    }
    ws.onerror = () => { /* close follows, with the reason */ }
  }

  private set(s: Status, detail?: string) {
    this.status = s
    this.onStatus(s, detail)
  }

  send(m: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m))
  }

  /** Where the pointer is on the ground; sent at most a dozen times a second, and only if it moved. */
  cursor(x: number | null, y: number | null) {
    if (x === null || y === null) {
      this.pending = null
      if (!Number.isNaN(this.lastCursor.x)) { this.lastCursor = { x: NaN, y: NaN, at: 0 }; this.send({ t: 'cursor', x: null, y: null }) }
      return
    }
    if (Math.hypot(x - this.lastCursor.x, y - this.lastCursor.y) < 2) return
    this.pending = { x, y }
    if (this.cursorTimer) return
    const due = Math.max(0, 80 - (performance.now() - this.lastCursor.at))
    this.cursorTimer = window.setTimeout(() => {
      this.cursorTimer = 0
      if (!this.pending) return
      this.lastCursor = { ...this.pending, at: performance.now() }
      this.send({ t: 'cursor', x: this.pending.x, y: this.pending.y })
      this.pending = null
    }, due)
  }

  place(tool: ToolId, x: number, y: number) { this.send({ t: 'place', tool, x, y }) }
  remove(id: number) { this.send({ t: 'remove', id }) }

  close() {
    this.closed = true
    if (this.cursorTimer) clearTimeout(this.cursorTimer)
    this.ws?.close()
  }
}
