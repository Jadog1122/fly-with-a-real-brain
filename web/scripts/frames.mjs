/** Capture the game as it actually runs, several seconds apart. */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import process from 'node:process'

const OUT = process.argv[2] || 'shots'
await mkdir(OUT, { recursive: true })
const preview = spawn('npx', ['vite', 'preview', '--port', '4319', '--strictPort'],
  { stdio: ['ignore', 'pipe', 'pipe'] })
const url = await new Promise(res => {
  const scan = b => { const m = /(http:\/\/localhost:\d+)/.exec(b.toString()); if (m) res(m[1]) }
  preview.stdout.on('data', scan); preview.stderr.on('data', scan)
})
const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist',
         '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
})
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto(`${url}/pet.html?perf=1`)
await page.waitForSelector('.pet-boot', { state: 'detached', timeout: 120_000 })
await page.bringToFront()

const rows = []
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(i === 0 ? 2500 : 5000)
  await page.screenshot({ path: `${OUT}/live${i}.png` })
  const s = await page.evaluate(() => {
    const sc = window.__pet.engine.scene
    const f = window.__pet.engine.world.fly
    // Where the fly lands on screen, so the frame can be cropped to the subject.
    // Projecting its whole bounding box rather than its origin: a crop around a point
    // tells you nothing if you have guessed the subject's on-screen size wrong.
    const cv = sc.renderer.domElement
    const V = sc.camera.position.constructor
    const lo = new V(1e9, 1e9, 1e9), hi = new V(-1e9, -1e9, -1e9)
    sc.fly.root.updateWorldMatrix(true, true)
    sc.fly.root.traverse(o => {
      if (!o.isMesh) return
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox()
      const g = o.geometry.boundingBox
      for (const x of [g.min.x, g.max.x]) for (const y of [g.min.y, g.max.y])
        for (const z of [g.min.z, g.max.z])
          { const w = new V(x, y, z).applyMatrix4(o.matrixWorld); lo.min(w); hi.max(w) }
    })
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
    for (const x of [lo.x, hi.x]) for (const y of [lo.y, hi.y]) for (const z of [lo.z, hi.z]) {
      const v = new V(x, y, z).project(sc.camera)
      const px = (v.x * .5 + .5) * cv.width, py = (-v.y * .5 + .5) * cv.height
      x0 = Math.min(x0, px); x1 = Math.max(x1, px)
      y0 = Math.min(y0, py); y1 = Math.max(y1, py)
    }
    return {
      box: [x0, y0, x1, y1].map(Math.round), canvas: [cv.width, cv.height],
      fly: [Math.round(f.x), Math.round(f.y), Math.round(f.alt)],
      cam: [sc.camera.position.x, sc.camera.position.y, sc.camera.position.z].map(Math.round),
      target: [sc.camTarget.x, sc.camTarget.y, sc.camTarget.z].map(Math.round),
      focus: sc.bokeh ? Math.round(sc.bokeh.uniforms.focus.value) : null,
      fps: Math.round(sc.fps), quality: sc.quality,
    }
  })
  console.log(`live${i}`, JSON.stringify(s))
  rows.push(s)
}
writeFileSync(`${OUT}/where.json`, JSON.stringify(rows, null, 1))
await browser.close()
preview.kill()
