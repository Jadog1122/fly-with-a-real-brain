// Persisting the pet between visits.
//
// What is saved: where the fly is, how hungry and startled it is, how many meals it has
// eaten, what you left lying in the arena, and your settings.
//
// What is deliberately NOT saved: the brain. Its membrane state is 45,808 float64s per
// array, and it re-settles from rest within about a tenth of a second of simulated time,
// so storing it would cost ~400 KB to reproduce something the model reaches on its own.
// The fly wakes with a fresh brain in the body and the world it had.
//
// Everything here tolerates a storage that throws (Safari private mode), is full, or
// holds something written by an older build.

import type { World } from './world'
import type { StimKind } from './sensors'

const KEY = 'fly-pet'
const VERSION = 1

export type Quality = 'low' | 'medium' | 'high'
export const QUALITIES: Quality[] = ['low', 'medium', 'high']

export interface Settings {
  speed: number
  sound: boolean
  picked: string
  volume: number          // 0..1, independent of mute
  quality: Quality
  colourblind: boolean    // switches the HUD ramps to an Okabe-Ito safe set
  reducedMotion: boolean
}

export const DEFAULTS: Omit<Settings, 'picked'> = {
  speed: 1, sound: false, volume: 0.9, quality: 'high',
  colourblind: false, reducedMotion: false,
}

export interface SavedState {
  v: number
  at: number
  fly: { x: number; y: number; h: number; hunger: number; startle: number; fed: number }
  stims: { kind: string; x: number; y: number; adapt: number }[]
  settings: Settings
}

const num = (x: unknown, lo: number, hi: number, fallback: number): number =>
  typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback

/** Snapshot a live world. Pure: takes no storage and touches nothing. */
export function snapshot(world: World, settings: Settings): SavedState {
  const f = world.fly
  return {
    v: VERSION,
    at: Date.now(),
    fly: { x: f.x, y: f.y, h: f.h, hunger: f.hunger, startle: f.startle, fed: f.fed },
    stims: world.stims.map(s => ({ kind: s.kind.id, x: s.x, y: s.y, adapt: s.adapt ?? 1 })),
    settings,
  }
}

/**
 * Validate anything claiming to be a saved state. Returns null rather than throwing, so
 * a corrupt or stale entry just means "start fresh" instead of a page that will not boot.
 */
export function validate(raw: unknown, arenaW: number, arenaH: number,
                         kinds: StimKind[]): SavedState | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.v !== VERSION) return null                      // an older build's shape

  const fly = (o.fly ?? {}) as Record<string, unknown>
  const known = new Map(kinds.map(k => [k.id, k]))
  const stimsIn = Array.isArray(o.stims) ? o.stims : []
  const set = (o.settings ?? {}) as Record<string, unknown>

  return {
    v: VERSION,
    at: num(o.at, 0, Number.MAX_SAFE_INTEGER, 0),
    fly: {
      // clamped to the arena: a saved position from a different arena size would
      // otherwise drop the fly outside its own walls
      x: num(fly.x, 0, arenaW, arenaW / 2),
      y: num(fly.y, 0, arenaH, arenaH / 2),
      h: num(fly.h, -Math.PI * 4, Math.PI * 4, 0),
      hunger: num(fly.hunger, 0, 1, 0.35),
      startle: num(fly.startle, 0, 1, 0),
      fed: Math.floor(num(fly.fed, 0, 1e6, 0)),
    },
    stims: stimsIn
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      // a stimulus kind can be renamed or removed between builds; drop what we no
      // longer understand rather than resurrecting a broken token
      .filter(s => known.has(String(s.kind)))
      .slice(0, 60)                                     // a hand-saved file cannot flood the arena
      .map(s => ({
        kind: String(s.kind),
        x: num(s.x, 0, arenaW, arenaW / 2),
        y: num(s.y, 0, arenaH, arenaH / 2),
        adapt: num(s.adapt, 0, 1, 1),
      })),
    settings: {
      // Fields added after v1 shipped are defaulted rather than version-gated, so an
      // older save still loads instead of silently resetting someone's fly.
      speed: num(set.speed, 0.05, 4, DEFAULTS.speed),
      sound: set.sound === true,
      picked: known.has(String(set.picked)) ? String(set.picked) : (kinds[0]?.id ?? ''),
      volume: num(set.volume, 0, 1, DEFAULTS.volume),
      quality: QUALITIES.includes(set.quality as Quality)
        ? (set.quality as Quality) : DEFAULTS.quality,
      colourblind: set.colourblind === true,
      reducedMotion: set.reducedMotion === true,
    },
  }
}

/** Put a validated state back into a live world. Returns the settings to apply. */
export function restore(state: SavedState, world: World, kinds: StimKind[]): Settings {
  const known = new Map(kinds.map(k => [k.id, k]))
  Object.assign(world.fly, state.fly, { speed: 0, legPhase: 0, wing: 0, eating: 0 })
  world.clear()
  world.trail.length = 0
  for (const s of state.stims) {
    const kind = known.get(s.kind)
    if (kind) world.add(kind, s.x, s.y).adapt = s.adapt
  }
  return state.settings
}

export function read(arenaW: number, arenaH: number, kinds: StimKind[]): SavedState | null {
  try {
    const text = localStorage.getItem(KEY)
    if (!text) return null
    return validate(JSON.parse(text), arenaW, arenaH, kinds)
  } catch {
    return null                                         // unavailable, or not JSON
  }
}

export function write(state: SavedState): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
    return true
  } catch {
    return false                                        // private mode, or quota
  }
}

export function forget(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to do: it was never stored */
  }
}
