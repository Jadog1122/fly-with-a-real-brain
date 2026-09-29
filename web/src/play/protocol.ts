// What the game server and the play page say to each other, and the rules they share.
//
// One file, imported by both ends, so the message shapes cannot drift apart the way
// the worker protocol once did (it was typed `any` on both sides, which hid two bugs).
// Everything that arrives over the wire is validated here before anything acts on it:
// the server trusts nothing a client sends, and the client trusts nothing it did not
// ask for.

/** The arena the fly lives in. Must match World in ../pet/world.ts. */
export const ARENA = { w: 760, h: 490 } as const

export type ToolId = 'sugar' | 'looming' | 'bitter'

export interface ToolRule {
  id: ToolId
  label: string
  emoji: string
  /** what it does, in the words on the button */
  does: string
  /** the pathway, for the panel that shows the brain */
  how: string
  /** how many of yours can be on the field at once; placing one more picks up the oldest */
  max: number
  /** ms after placing one before you can place another */
  cooldownMs: number
  /** ms a token lasts on the field; null lasts until eaten or the round ends */
  lifeMs: number | null
}

/**
 * Three tools. Each is a stimulus the single-player pet already has, chosen because
 * each reaches a specific behaviour through the connectome without tipping it into a
 * loop it cannot leave (Dust and a poke lock MN9 on for good; a smell leaves DNa01
 * steering - see mind.ts). Sugar is the only way to score; the other two are how you
 * fight over the fly.
 */
export const TOOLS: ToolRule[] = [
  { id: 'sugar', label: 'Sugar', emoji: '🍬', does: 'If it eats yours, you score',
    how: 'feet taste it, then the mouthparts: MN9, the tongue',
    max: 2, cooldownMs: 1500, lifeMs: null },
  { id: 'looming', label: 'Shadow', emoji: '🛸', does: 'It jumps and flies away',
    how: 'LC4 looming detectors → the giant fibre',
    max: 1, cooldownMs: 10_000, lifeMs: 3000 },
  { id: 'bitter', label: 'Bitter', emoji: '☠️', does: 'Spoils sugar next to it',
    how: 'bitter taste neurons suppress MN9',
    max: 1, cooldownMs: 12_000, lifeMs: 20_000 },
]
export const TOOL = new Map(TOOLS.map(t => [t.id, t]))

/** A sugar drop within this many units of a bitter drop is spoiled. */
export const SPOIL_RANGE = 48

export const ROUND = {
  playMs: 90_000,
  betweenMs: 12_000,
} as const

/** Player colours: distinct from each other and from a green-and-brown meadow. */
export const PALETTE = [
  '#ff6b6b', '#ffa94d', '#ffe066', '#a9e34b', '#63e6be', '#4dd4ff',
  '#748ffc', '#b197fc', '#f783ac', '#f8f9fa', '#ff8787', '#69db7c',
]

export const NAME_MAX = 16
/** Cursor and place messages above this rate are dropped rather than acted on. */
export const RATE_LIMIT_PER_S = 40

// --- what the client sends ------------------------------------------------------------

export type ClientMsg =
  | { t: 'join'; name: string; key: string }
  | { t: 'cursor'; x: number | null; y: number | null }
  | { t: 'place'; tool: ToolId; x: number; y: number }
  | { t: 'remove'; id: number }

// --- what the server sends ------------------------------------------------------------

export interface PlayerView {
  id: string
  name: string
  colour: string
  /** meals the fly has eaten from this player's sugar, this round */
  score: number
  /** across every round since they joined */
  total: number
}

export interface TokenView {
  id: number
  kind: ToolId
  x: number
  y: number
  owner: string
  /** the owner's name and colour travel with the token: they may have just left */
  name: string
  colour: string
  /** ms of life left, or null for one that stays */
  left: number | null
  /** a sugar drop with bitter next to it: the fly will not eat it */
  spoiled: boolean
}

/** The body, as the world carries it (world.ts Fly, minus what the client derives). */
export interface FlyView {
  x: number; y: number; h: number
  speed: number
  alt: number; flying: number; bank: number; pitch: number
  hunger: number; startle: number
  /** seconds spent on the current meal, 0 when not eating */
  eating: number
}

/** The decoded behaviour (motor.ts Action, without the constant). */
export interface ActionView {
  dominant: string
  escape: boolean
  proboscis: number
  groom: number
  forward: number
  turn: number
}

export interface RoundView {
  n: number
  phase: 'play' | 'between'
  /** ms left in this phase */
  left: number
}

/** One tool's availability for one player. */
export interface PouchSlot {
  out: number
  max: number
  /** ms until it can be placed again; 0 when ready */
  readyIn: number
}
export type Pouch = Record<ToolId, PouchSlot>

export type GameEvent =
  | { kind: 'meal'; by: string; x: number; y: number }
  | { kind: 'taste'; by: string }
  | { kind: 'spoiled'; by: string; owner: string }
  | { kind: 'scared'; by: string }
  | { kind: 'round-start'; n: number }
  | { kind: 'round-end'; n: number; podium: PlayerView[] }
  | { kind: 'restart'; why: string }
  | { kind: 'joined'; who: string }
  | { kind: 'left'; who: string }

export interface StateMsg {
  t: 'state'
  tick: number
  /** the server's clock, ms, so the client can interpolate on it rather than on arrival jitter */
  at: number
  fly: FlyView
  action: ActionView
  /** smoothed rate of each readout, Hz, both sides summed */
  rates: Record<string, number>
  /** every player's pointer on the ground: id, x, y */
  cursors: [string, number, number][]
  round: RoundView
  /** brain steps per second the server is managing (10,000 is real time) */
  sps: number
  /** why it is doing what it is doing (mind.ts) */
  why: string
}

export type ServerMsg =
  | { t: 'welcome'; you: PlayerView; room: string; players: PlayerView[]; tokens: TokenView[]
      round: RoundView; pouch: Pouch; arena: { w: number; h: number } }
  | { t: 'players'; players: PlayerView[] }
  | { t: 'tokens'; tokens: TokenView[] }
  | { t: 'pouch'; pouch: Pouch }
  | StateMsg
  | { t: 'event'; e: GameEvent }
  | { t: 'error'; msg: string }

// --- validation --------------------------------------------------------------------------

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Inside the arena, with the same margin the fly's own walls keep. */
export function inArena(x: number, y: number) {
  return x >= 0 && x <= ARENA.w && y >= 0 && y <= ARENA.h
}

/**
 * A name anyone can be shown next to: printable, short, and never empty. Anything else
 * becomes the name the client was given.
 */
export function cleanName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim()
  return s || fallback
}

/** Parse one message from a client. Null for anything malformed - the sender is not told why. */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  switch (m.t) {
    case 'join': {
      if (typeof m.key !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(m.key)) return null
      return { t: 'join', name: typeof m.name === 'string' ? m.name : '', key: m.key }
    }
    case 'cursor': {
      if (m.x === null || m.y === null) return { t: 'cursor', x: null, y: null }
      if (!finite(m.x) || !finite(m.y) || !inArena(m.x, m.y)) return null
      return { t: 'cursor', x: m.x, y: m.y }
    }
    case 'place': {
      if (typeof m.tool !== 'string' || !TOOL.has(m.tool as ToolId)) return null
      if (!finite(m.x) || !finite(m.y) || !inArena(m.x, m.y)) return null
      return { t: 'place', tool: m.tool as ToolId, x: m.x, y: m.y }
    }
    case 'remove': {
      if (!finite(m.id) || m.id < 0 || m.id !== Math.floor(m.id)) return null
      return { t: 'remove', id: m.id }
    }
    default:
      return null
  }
}

/**
 * Parse one message from the server. Lighter than the other direction - a server that
 * lies is the operator's problem, not a security one - but a message of an unknown shape
 * must not reach the renderer as a `state`.
 */
export function parseServerMsg(raw: unknown): ServerMsg | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  switch (m.t) {
    case 'welcome': case 'players': case 'tokens': case 'pouch': case 'event': case 'error':
      return m as unknown as ServerMsg
    case 'state': {
      const f = m.fly as Record<string, unknown> | undefined
      if (!f || !finite(f.x) || !finite(f.y) || !finite(f.h)) return null
      if (!m.action || !m.round || !m.rates) return null
      return m as unknown as StateMsg
    }
    default:
      return null
  }
}

/** A short, sayable default name; the player can change it. */
export function randomName(rand = Math.random): string {
  const a = ['Quick', 'Shy', 'Bold', 'Wet', 'Dusty', 'Sunny', 'Sleepy', 'Loud', 'Tiny', 'Brave', 'Odd', 'Calm']
  const b = ['Bee', 'Moth', 'Ant', 'Snail', 'Wasp', 'Gnat', 'Beetle', 'Cricket', 'Aphid', 'Mite', 'Slug', 'Midge']
  return `${a[Math.floor(rand() * a.length)]} ${b[Math.floor(rand() * b.length)]}`
}
