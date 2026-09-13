// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { missingFeatures, webgl2, roundRect } from '../src/support'

afterEach(() => vi.restoreAllMocks())

describe('feature detection', () => {
  it('reports WebGL2 as missing when the context cannot be created', () => {
    // mocked rather than leaning on jsdom's unimplemented getContext, which logs a
    // full stack trace to stderr and buries the real test output
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect(webgl2()).toBe(false)
    expect(missingFeatures().some(m => m.name === 'WebGL 2')).toBe(true)
  })

  it('does not throw when a getContext call itself throws', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      throw new Error('blocked by the browser')
    })
    expect(() => webgl2()).not.toThrow()
    expect(webgl2()).toBe(false)
    expect(() => roundRect()).not.toThrow()
  })

  it('gives every missing feature a human reason', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    for (const m of missingFeatures()) {
      expect(m.name.length).toBeGreaterThan(0)
      expect(m.why.length).toBeGreaterThan(10)
    }
  })

  it('treats a working WebGL2 context as supported', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(((kind: string) => (kind === 'webgl2' ? {} : null)) as never)
    expect(webgl2()).toBe(true)
    expect(missingFeatures().some(m => m.name === 'WebGL 2')).toBe(false)
  })
})
