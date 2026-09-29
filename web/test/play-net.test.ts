import { describe, it, expect } from 'vitest'
import { Interpolator, lerpAngle, resolveServerUrl, DELAY_MS } from '../src/play/net'
import type { StateMsg, FlyView } from '../src/play/protocol'

const fly = (x: number, h = 0): FlyView => ({
  x, y: 100, h, speed: 20, alt: 0, flying: 0, bank: 0, pitch: 0, hunger: 0.5, startle: 0, eating: 0,
})
const state = (at: number, x: number, h = 0): StateMsg => ({
  t: 'state', tick: at, at, fly: fly(x, h), rates: {}, cursors: [], sps: 0, why: '',
  action: { dominant: 'walking', escape: false, proboscis: 0, groom: 0, forward: 20, turn: 0 },
  round: { n: 1, phase: 'play', left: 1000 },
})
const blank = (): FlyView => fly(0)

describe('interpolating the fly between states', () => {
  it('draws it between the two states that bracket the render time', () => {
    const i = new Interpolator()
    // server and local clocks agree; messages arrive with no delay
    i.push(state(1000, 0), 1000)
    i.push(state(1050, 50), 1050)
    i.push(state(1100, 100), 1100)
    const out = blank()
    // render time = local - delay: at local 1100 + 25 that is 1015 + ... work it through
    const now = 1100 + DELAY_MS - 75            // render time 1025
    expect(i.sample(now, out)).not.toBeNull()
    expect(out.x).toBeCloseTo(25, 5)
  })

  it('holds the last state rather than running past it', () => {
    const i = new Interpolator()
    i.push(state(1000, 0), 1000)
    i.push(state(1050, 50), 1050)
    const out = blank()
    i.sample(1050 + DELAY_MS + 5000, out)
    expect(out.x).toBe(50)
  })

  it('turns the short way round', () => {
    expect(lerpAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5)).toBeCloseTo(Math.PI, 5)
    expect(lerpAngle(0, 1, 0.25)).toBeCloseTo(0.25)
    const i = new Interpolator()
    i.push(state(1000, 0, 3.0), 1000)
    i.push(state(1100, 0, -3.0), 1100)
    const out = blank()
    i.sample(1100 + DELAY_MS - 50, out)          // halfway
    expect(Math.abs(out.h)).toBeCloseTo(Math.PI, 3)
  })

  it('reads the server clock, not arrival time', () => {
    const i = new Interpolator()
    // the local clock is 5 s ahead of the server's; each message takes 40 ms to arrive
    const skew = 5000, lag = 40
    i.push(state(1000, 0), 1000 + skew + lag)
    i.push(state(1050, 50), 1050 + skew + lag)
    i.push(state(1100, 100), 1100 + skew + lag + 30)   // this one was late
    const out = blank()
    i.sample(1100 + skew + lag + DELAY_MS - 75, out)
    // within a unit: the offset is allowed to creep toward a late message, slowly
    expect(Math.abs(out.x - 25)).toBeLessThan(1)
  })

  it('ignores a state older than the newest it has', () => {
    const i = new Interpolator()
    i.push(state(1100, 100), 1100)
    i.push(state(1000, 0), 1101)
    expect(i.count).toBe(1)
    expect(i.latest!.fly.x).toBe(100)
  })

  it('reports the state whose behaviour applies', () => {
    const i = new Interpolator()
    const a = state(1000, 0), b = state(1050, 50)
    b.action = { ...b.action, dominant: 'feeding' }
    i.push(a, 1000); i.push(b, 1050)
    const out = blank()
    expect(i.sample(1050 + DELAY_MS - 40, out)?.action.dominant).toBe('walking')
    expect(i.sample(1050 + DELAY_MS - 10, out)?.action.dominant).toBe('feeding')
  })

  it('returns null until something has arrived', () => {
    expect(new Interpolator().sample(0, blank())).toBeNull()
  })
})

describe('finding the server', () => {
  it('prefers the page, then the build, then its own origin', () => {
    expect(resolveServerUrl('?server=wss://x.example/ws', 'wss://y.example/ws', 'https://z.example'))
      .toBe('wss://x.example/ws')
    expect(resolveServerUrl('', 'wss://y.example/ws', 'https://z.example')).toBe('wss://y.example/ws')
    expect(resolveServerUrl('', undefined, 'https://z.example')).toBe('wss://z.example/ws')
    expect(resolveServerUrl('', '', 'http://localhost:5173')).toBe('ws://localhost:5173/ws')
  })
})
