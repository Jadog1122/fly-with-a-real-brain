// The game server: the meadows people join, the fly in each, and the sockets.
//
//   node server/dist/main.mjs            (built by server/build.mjs)
//
// One process. Each meadow (a Room from game.ts) has its own brain thread and its own
// 16 ms clock; this file only routes messages, validates them, and broadcasts state at
// 20 Hz. It also serves the built site from ../dist when that exists, so one container
// can host both the pages and the game - or the pages can live on a static host and
// point here with VITE_PLAY_SERVER.
//
// Environment:
//   PORT             8787
//   ROOM_CAP         players per meadow before a second one opens (16)
//   MAX_ROOMS        meadows at most, each a brain on its own core (3)
//   ROUND_MS         length of a round (90000)
//   DATA_DIR         where subnet.bin and pet.json are (../public/data)
//   STATIC_DIR       the built site to serve, if present (../dist)
//   ALLOWED_ORIGINS  comma-separated browser origins allowed to connect; unset allows all

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { WebSocketServer, WebSocket } from 'ws'
import { Room, type ReadoutIdx } from './game'
import type { BrainIn, BrainOut } from './brain-thread'
import { parseClientMsg, RATE_LIMIT_PER_S, ARENA, type ServerMsg } from '../src/play/protocol'
import type { SensorGroup } from '../src/pet/sensors'
import type { Rates } from '../src/pet/motor'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 8787
const ROOM_CAP = Number(process.env.ROOM_CAP) || 16
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 3
const ROUND_MS = Number(process.env.ROUND_MS) || undefined
const DATA_DIR = process.env.DATA_DIR ?? resolve(here, '../../public/data')
const STATIC_DIR = process.env.STATIC_DIR ?? resolve(here, '../../dist')
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean)

const SUBNET = join(DATA_DIR, 'subnet.bin')
const PET = join(DATA_DIR, 'pet.json')
if (!existsSync(SUBNET) || !existsSync(PET)) {
  console.error(`[play] no brain to run: ${SUBNET} or ${PET} is missing (has the bake been run?)`)
  process.exit(1)
}

// the sensor and readout wiring, as engine.ts reads it
const pet = JSON.parse(readFileSync(PET, 'utf8')) as {
  sensors: SensorGroup[]
  readouts: { id: string; sides: { left: number[]; right: number[]; other: number[] } }[]
}
const groups = new Map<string, SensorGroup>(pet.sensors.map(s => [s.id, s]))
const readouts = new Map<string, ReadoutIdx>(pet.readouts.map(r => [r.id, {
  id: r.id, left: r.sides.left, right: [...r.sides.right, ...r.sides.other],
  all: [...r.sides.left, ...r.sides.right, ...r.sides.other],
}]))

// --- one meadow: a room, its brain, and the sockets in it ------------------------------

const log = (...a: unknown[]) => console.log(new Date().toISOString(), '[play]', ...a)

class Meadow {
  readonly room: Room
  readonly sockets = new Map<string, WebSocket>()
  private brain: Worker
  private brainReady = false
  private simMs = 0
  private simPending = 0
  private lastRates: Rates = {}
  private stepsPerSec = 0
  private speed = -1
  private timers: ReturnType<typeof setInterval>[] = []

  constructor(readonly name: string, seed: number) {
    this.room = new Room(groups, readouts, Date.now(), { playMs: ROUND_MS })
    this.brain = new Worker(new URL('./brain-thread.mjs', import.meta.url), {
      workerData: { subnetPath: SUBNET, petPath: PET, seed },
    })
    this.brain.on('message', (m: BrainOut) => this.onBrain(m))
    this.brain.on('error', e => log(`${name}: brain thread failed:`, e))
    this.brain.on('exit', code => { if (code !== 0) log(`${name}: brain thread exited ${code}`) })
    this.timers.push(setInterval(() => this.tick(), 16))
    this.timers.push(setInterval(() => this.broadcast(), 50))
    this.setSpeed(0)
  }

  private post(m: BrainIn) { this.brain.postMessage(m) }

  /** An empty meadow does not step: its fly waits, and the round clock waits with it. */
  private setSpeed(f: number) {
    if (this.speed === f) return
    this.speed = f
    this.post({ type: 'speed', factor: f })
    if (f === 0) this.simPending = 0
  }

  private onBrain(m: BrainOut) {
    if (m.type === 'ready') { this.brainReady = true; log(`${this.name}: brain ready, ${m.n.toLocaleString()} neurons`); return }
    this.lastRates = m.rates
    // a restarted brain starts its clock again from zero; owe the body nothing for it
    if (m.simMs >= this.simMs) this.simPending = Math.min(this.simPending + (m.simMs - this.simMs), 400)
    this.simMs = m.simMs
    const wall = Math.max(m.wallMs, 1) / 1000
    this.stepsPerSec = this.stepsPerSec * 0.88 + (m.steps / wall) * 0.12
  }

  private tick() {
    const now = Date.now()
    const dt = Math.min(this.simPending, 120)
    this.simPending -= dt
    this.room.sps = this.stepsPerSec
    const { drive, restart } = this.room.step(now, dt, this.lastRates)
    if (this.brainReady) this.post({ type: 'drive', rates: [...drive] })
    if (restart) {
      this.post({ type: 'reset' })
      this.lastRates = {}
      this.simPending = 0
      log(`${this.name}: brain restarted: ${restart}`)
    }
    this.flush(now)
  }

  /** Things that changed: players, tokens, pouches and events go out as they happen. */
  private flush(now: number) {
    const d = this.room.dirty
    if (d.players) {
      this.sendAll({ t: 'players', players: this.room.playersView() })
      d.players = false
      this.setSpeed(this.room.connected().length ? 1 : 0)
    }
    if (d.tokens) {
      this.sendAll({ t: 'tokens', tokens: this.room.tokensView(now) })
      d.tokens = false
    }
    for (const id of d.pouch) this.sendTo(id, { t: 'pouch', pouch: this.room.pouchFor(id, now) })
    d.pouch.clear()
    for (const e of this.room.drainEvents()) {
      this.sendAll({ t: 'event', e })
      if (e.kind === 'round-end') log(`${this.name}: round ${e.n} over, podium ${e.podium.map(p => `${p.name} ${p.score}`).join(', ') || 'empty'}`)
    }
  }

  private broadcast() {
    if (!this.sockets.size) return
    this.sendAll(this.room.stateMsg(Date.now()))
  }

  sendAll(m: ServerMsg) {
    const s = JSON.stringify(m)
    for (const ws of this.sockets.values()) if (ws.readyState === WebSocket.OPEN) ws.send(s)
  }

  sendTo(id: string, m: ServerMsg) {
    const ws = this.sockets.get(id)
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
  }

  /** Someone joins, or comes back. Returns the welcome to send them. */
  admit(ws: WebSocket, key: string, name: string): ServerMsg {
    const now = Date.now()
    const p = this.room.join(key, name, now)
    // the same key from a second tab takes the seat over
    const old = this.sockets.get(p.id)
    if (old && old !== ws) old.close(4000, 'joined from another tab')
    this.sockets.set(p.id, ws)
    this.setSpeed(1)
    return {
      t: 'welcome', you: this.room.playerView(p), room: this.name,
      players: this.room.playersView(), tokens: this.room.tokensView(now),
      round: this.room.roundView(now), pouch: this.room.pouchFor(p.id, now),
      arena: { w: ARENA.w, h: ARENA.h },
    }
  }

  seatOf(ws: WebSocket): string | null {
    for (const [id, s] of this.sockets) if (s === ws) return id
    return null
  }

  leave(ws: WebSocket) {
    const id = this.seatOf(ws)
    if (id === null) return
    this.sockets.delete(id)
    this.room.leave(id, Date.now())
  }

  hasKey(key: string) {
    for (const p of this.room.players.values()) if (p.key === key) return true
    return false
  }

  get count() { return this.room.connected().length }
}

const meadows: Meadow[] = []

/** The meadow to seat someone in: theirs if they have one, else the first with room. */
function assign(key: string): Meadow | null {
  for (const m of meadows) if (m.hasKey(key)) return m
  for (const m of meadows) if (m.count < ROOM_CAP) return m
  if (meadows.length >= MAX_ROOMS) return null
  const m = new Meadow(meadows.length ? `meadow-${meadows.length + 1}` : 'meadow', 4242 + meadows.length * 97)
  meadows.push(m)
  log(`opened ${m.name}`)
  return m
}

// --- http: health, and the built site if it is there ------------------------------------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.hdr': 'application/octet-stream', '.wasm': 'application/wasm', '.txt': 'text/plain',
  '.map': 'application/json', '.woff2': 'font/woff2',
}

const staticRoot = existsSync(STATIC_DIR) ? resolve(STATIC_DIR) : null

function http(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/healthz' || url.pathname === '/rooms') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    res.end(JSON.stringify({
      ok: true,
      rooms: meadows.map(m => ({ name: m.name, players: m.count, round: m.room.roundView(Date.now()) })),
    }))
    return
  }
  if (!staticRoot) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('fly game server: connect a client to /ws\n')
    return
  }
  // never outside the built site, whatever the path says
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = resolve(staticRoot, '.' + (rel.startsWith('/') ? rel : '/' + rel))
  if (!file.startsWith(staticRoot + sep) && file !== staticRoot) {
    res.writeHead(403); res.end(); return
  }
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html')
    const st = statSync(file)
    const ext = extname(file)
    res.writeHead(200, {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'content-length': st.size,
      // vite's hashed assets can be cached for ever; pages and data cannot
      'cache-control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    createReadStream(file).pipe(res)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found\n')
  }
}

const server = createServer(http)
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 })

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin
  if (ALLOWED_ORIGINS.length && (!origin || !ALLOWED_ORIGINS.includes(origin))) {
    ws.close(4003, 'origin not allowed')
    return
  }
  let meadow: Meadow | null = null
  let seat: string | null = null
  let alive = true
  // a token bucket: cursor and place messages come from a human, not a script
  let budget = RATE_LIMIT_PER_S
  let refill = Date.now()

  ws.on('pong', () => { alive = true })
  ws.on('message', data => {
    const now = Date.now()
    budget = Math.min(RATE_LIMIT_PER_S, budget + ((now - refill) / 1000) * RATE_LIMIT_PER_S)
    refill = now
    if (budget < 1) return
    budget--
    let raw: unknown
    try { raw = JSON.parse(String(data)) } catch { return }
    const m = parseClientMsg(raw)
    if (!m) return
    if (m.t === 'join') {
      if (meadow) return
      const target = assign(m.key)
      if (!target) {
        ws.send(JSON.stringify({ t: 'error', msg: 'Every meadow is full right now. Try again in a minute.' } satisfies ServerMsg))
        ws.close(4001, 'full')
        return
      }
      meadow = target
      const welcome = meadow.admit(ws, m.key, m.name)
      seat = meadow.seatOf(ws)
      ws.send(JSON.stringify(welcome))
      log(`${meadow.name}: ${seat} joined (${meadow.count} here)`)
      return
    }
    if (!meadow || !seat) return
    if (m.t === 'cursor') meadow.room.cursor(seat, m.x, m.y)
    else if (m.t === 'place') {
      const r = meadow.room.place(seat, m.tool, m.x, m.y, now)
      if (!r.ok) ws.send(JSON.stringify({ t: 'error', msg: r.why } satisfies ServerMsg))
    } else if (m.t === 'remove') meadow.room.remove(seat, m.id)
  })
  ws.on('close', () => {
    if (meadow && seat) {
      meadow.leave(ws)
      log(`${meadow.name}: ${seat} left (${meadow.count} here)`)
    }
  })
  ws.on('error', () => { /* close follows */ })
  ws.once('close', () => { alive = false })
  // heartbeat: a phone that fell off the network never sends a close frame
  const beat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) { clearInterval(beat); return }
    if (!alive) { ws.terminate(); clearInterval(beat); return }
    alive = false
    ws.ping()
  }, 30_000)
})

server.listen(PORT, () => {
  log(`listening on :${PORT}${staticRoot ? `, serving ${staticRoot}` : ''}; brain data in ${DATA_DIR}`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { log(`${sig}, bye`); process.exit(0) })
}
