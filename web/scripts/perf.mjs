/**
 * Measure the pet's frame rate for real.
 *
 * Every previous attempt to read the frame rate in this project was wrong, in two
 * different ways: the agent-driven browser pane freezes requestAnimationFrame while it
 * is hidden (so the scene looked frozen and the rate read as zero), and a tight timing
 * loop inside the page measured scheduling, not rendering (post-processing measured
 * *faster* switched on, which is impossible). So:
 *
 *   - a real, headed Chromium, so the GPU is the machine's GPU and not SwiftShader;
 *   - --disable-gpu-vsync --disable-frame-rate-limit, so rAF is not pinned to the
 *     display's refresh and a frame time of 8 ms reads as 8 ms rather than 16.7;
 *   - the production build, served by vite preview, reached through ?perf=1;
 *   - each pass toggled one at a time through EffectComposer's own `enabled` flag, so
 *     the number attributed to a pass is that pass's marginal cost and nothing else.
 *
 * Usage: node scripts/perf.mjs [--keep-open]
 */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import process from 'node:process'

const COST_FRAMES = 20       // per timed run, best of three
const THROUGHPUT_S = 3

async function startPreview() {
  const p = spawn('npx', ['vite', 'preview', '--port', '4317', '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  })
  const url = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('vite preview did not start')), 30_000)
    const scan = b => {
      const m = /(http:\/\/localhost:\d+\/?)/.exec(b.toString())
      if (m) { clearTimeout(t); res(m[1].replace(/\/$/, '')) }
    }
    p.stdout.on('data', scan)
    p.stderr.on('data', scan)
  })
  return { proc: p, url }
}

/**
 * True per-frame render cost, in milliseconds.
 *
 * Sampling requestAnimationFrame deltas does not work here. With vsync disabled the
 * CPU queues frames ahead of the GPU, so the deltas come out bimodal - a run of 10 ms
 * frames while the queue fills, then one 85 ms stall while it drains - and a p50 of
 * that reads 92 fps on a configuration that genuinely delivers 38. So: drive the
 * composer directly and put a gl.finish() after every frame, which forces the GPU to
 * drain before the clock is read. That serialises CPU and GPU where a real frame would
 * overlap them, so this slightly overstates the wall-clock cost - but it is the same
 * overstatement for every configuration, which is what attribution needs.
 */
async function cost(page, frames) {
  return page.evaluate(async n => {
    const sc = window.__pet.engine.scene
    const gl = sc.renderer.getContext()
    const px = new Uint8Array(4)
    // gl.finish() is NOT a real device sync in Chrome - it flushes the command buffer
    // and returns, which timed a 5-megapixel frame with ambient occlusion at 0.3 ms.
    // Reading a single pixel back from the default framebuffer does block until the
    // frame has actually been drawn, so that is the sync.
    const sync = () => {
      sc.renderer.setRenderTarget(null)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    }
    const draw = () => (sc.composer ? sc.composer.render(0.016) : sc.renderer.render(sc.scene, sc.camera))
    for (let i = 0; i < 12; i++) draw()      // compile shaders, fill caches
    sync()
    const runs = []
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now()
      for (let i = 0; i < n; i++) { draw(); sync() }
      runs.push((performance.now() - t0) / n)
    }
    return Math.min(...runs)                 // interference only ever adds time
  }, frames)
}

/**
 * Stop the app's own render loop without touching the app.
 *
 * Without this, every cost measurement was interleaved with whole frames the app drew
 * for itself, and each configuration timed a different scene - the fly had moved, the
 * particle count differed - which is how "minus all four passes" came out dearer than
 * "minus depth of field". Swapping requestAnimationFrame for one that parks the
 * callback stops the loop dead; handing the parked callback back to the real rAF
 * starts it again exactly where it left off.
 */
async function freeze(page) {
  return page.evaluate(() => new Promise(done => {
    const real = window.requestAnimationFrame.bind(window)
    window.__realRaf = real
    window.__parked = null
    window.requestAnimationFrame = cb => { window.__parked = cb; return 0 }
    real(() => real(done))          // let the in-flight frame park its successor
  }))
}

async function unfreeze(page) {
  return page.evaluate(() => {
    const real = window.__realRaf
    window.requestAnimationFrame = real
    if (window.__parked) real(window.__parked)
    window.__parked = null
  })
}

/**
 * Throughput as the page actually schedules it: count the frames the app's own loop
 * presents over a fixed window. rAF fires once per presented frame, so frames divided
 * by seconds is the honest number even when individual deltas are not.
 */
async function throughput(page, seconds) {
  return page.evaluate(async s => {
    let n = 0
    await new Promise(done => {
      const t0 = performance.now()
      const tick = now => { n++; if (now - t0 < s * 1000) requestAnimationFrame(tick); else done() }
      requestAnimationFrame(tick)
    })
    return n / s
  }, seconds)
}

/**
 * Apply a configuration: a quality tier, and a set of composer passes to switch off.
 *
 * Passes are identified by a distinctive member rather than by constructor name,
 * because a production build has minified every class name to two letters.
 */
async function configure(page, { quality, off = [], dpr = null }) {
  return page.evaluate(({ quality, off, dpr }) => {
    const kind = p =>
      p.materialBokeh ? 'dof'
      : typeof p.updateGtaoMaterial === 'function' ? 'ao'
      : p.highPassUniforms ? 'bloom'
      : p.uniforms && p.uniforms.grain !== undefined ? 'finish'
      : 'other'
    const sc = window.__pet.engine.scene
    sc.setQuality(quality)
    if (dpr !== null) {
      // setQuality picks the pixel ratio from the device; override it and rebuild the
      // composer so its targets are allocated at the ratio under test.
      sc.renderer.setPixelRatio(dpr)
      sc.buildComposer(quality)
    }
    const passes = sc.composer ? sc.composer.passes : []
    for (const p of passes) p.enabled = !off.includes(kind(p))
    const missing = off.filter(k => !passes.some(p => kind(p) === k))
    if (missing.length) throw new Error('no such pass: ' + missing.join(', '))
    return passes.map(kind)
  }, { quality, off, dpr })
}

const { proc, url } = await startPreview()
const browser = await chromium.launch({
  headless: false,
  args: [
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
    // macOS stops compositing a window it considers fully covered, which pauses rAF
    // and made whole configurations hang for minutes at a time.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ],
})

const VIEWPORTS = [
  { name: 'desktop 1440x900 @2x', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  { name: 'phone   390x844  @3x', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
]

const CONFIGS = [
  ['high (as shipped)', { quality: 'high' }],
  ['high - depth of field', { quality: 'high', off: ['dof'] }],
  ['high - ambient occlusion', { quality: 'high', off: ['ao'] }],
  ['high - bloom', { quality: 'high', off: ['bloom'] }],
  ['high - finish pass', { quality: 'high', off: ['finish'] }],
  ['high - all four', { quality: 'high', off: ['dof', 'ao', 'bloom', 'finish'] }],
  ['high @ dpr 1.75', { quality: 'high', dpr: 1.75 }],
  ['high @ dpr 1.5', { quality: 'high', dpr: 1.5 }],
  ['high @ dpr 1.25', { quality: 'high', dpr: 1.25 }],
  ['high @ dpr 1', { quality: 'high', dpr: 1 }],
  ['medium', { quality: 'medium' }],
  ['low (no composer)', { quality: 'low' }],
]

for (const v of VIEWPORTS) {
  const ctx = await browser.newContext(v)
  const page = await ctx.newPage()
  page.on('pageerror', e => console.error('  page error:', e.message))
  const t0 = Date.now()
  await page.goto(`${url}/pet.html?perf=1`)
  await page.waitForSelector('.pet-boot', { state: 'detached', timeout: 120_000 })
  const bootMs = Date.now() - t0
  await page.bringToFront()

  const gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
    const x = gl.getExtension('WEBGL_debug_renderer_info')
    return x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : 'unknown'
  })
  const px = await page.evaluate(() => {
    const c = document.querySelector('canvas')
    return `${c.width}x${c.height} buffer (dpr ${devicePixelRatio}, renderer cap ${window.__pet.engine.scene.renderer.getPixelRatio()})`
  })

  console.log(`\n=== ${v.name} ===`)
  console.log(`GPU: ${gpu}`)
  console.log(`canvas: ${px}`)
  console.log(`boot: ${(bootMs / 1000).toFixed(1)} s to first playable frame`)
  // info resets itself per renderer.render() call, so reading it between frames caught
  // only the last fullscreen quad. Hold it across one whole frame instead.
  const stats = await page.evaluate(async () => {
    const r = window.__pet.engine.scene.renderer
    r.info.autoReset = false
    r.info.reset()
    await new Promise(d => requestAnimationFrame(() => requestAnimationFrame(d)))
    const out = { calls: r.info.render.calls, tris: r.info.render.triangles, progs: r.info.programs.length }
    r.info.autoReset = true
    return out
  })
  console.log(`draw calls/frame: ${stats.calls} · triangles: ${stats.tris.toLocaleString()} · programs: ${stats.progs}`)

  // Pass one: what the app actually delivers, its own loop driving.
  const fps = new Map()
  for (const [label, cfg] of CONFIGS) {
    await configure(page, cfg)
    await throughput(page, 1)                 // settle after the tier rebuild
    fps.set(label, await throughput(page, THROUGHPUT_S))
  }

  // Pass two: what each pass costs, on a scene that is frozen and therefore identical
  // for every configuration.
  await freeze(page)
  const ms = new Map()
  for (const [label, cfg] of CONFIGS) {
    await configure(page, cfg)
    ms.set(label, await cost(page, COST_FRAMES))
  }
  await unfreeze(page)

  console.log(`${'config'.padEnd(26)} ${'ms/frame'.padStart(9)} ${'fps'.padStart(7)}   cost vs shipped`)
  const base = ms.get(CONFIGS[0][0])
  for (const [label] of CONFIGS) {
    const m = ms.get(label), d = m - base
    const delta = label === CONFIGS[0][0] ? '' : `   ${d >= 0 ? '+' : ''}${d.toFixed(1)} ms`
    console.log(`${label.padEnd(26)} ${m.toFixed(1).padStart(9)} ${fps.get(label).toFixed(0).padStart(7)}${delta}`)
  }
  await ctx.close()
}

if (!process.argv.includes('--keep-open')) {
  await browser.close()
  process.kill(-proc.pid)
}
