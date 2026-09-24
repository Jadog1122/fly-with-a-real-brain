/**
 * How much of the fly can you actually see?
 *
 * Written because a look at some cropped screenshots convinced me the leaf litter was
 * burying the fly, and it is not: measured over four frames the fly came out 64-85%
 * unoccluded, 74% on average. The thing that actually made the picture unreadable was
 * the dissolve dither, which a crop makes look like the litter's problem.
 *
 *   A  the frame as it renders
 *   B  the same frame with the fly hidden        -> diff(A,B) = fly pixels you can see
 *   C  the same frame with everything BUT the fly hidden
 *   D  the same frame with the fly hidden too    -> diff(C,D) = the fly's full silhouette
 *
 * visibility = |diff(A,B)| / |diff(C,D)|
 */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
const OUT = process.argv[2]
await mkdir(OUT, { recursive: true })
const preview = spawn('npx', ['vite', 'preview', '--port', '4332', '--strictPort'],
  { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
const url = await new Promise(res => {
  const scan = b => { const m = /(http:\/\/localhost:\d+)/.exec(b.toString()); if (m) res(m[1]) }
  preview.stdout.on('data', scan); preview.stderr.on('data', scan)
})
const browser = await chromium.launch({ headless: false,
  args: ['--use-angle=metal', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage()
await page.goto(`${url}/pet.html?perf=1`)
await page.waitForSelector('.pet-boot', { state: 'detached', timeout: 120_000 })
await page.bringToFront()

const N = Number(process.argv[3] || 4)
for (let shot = 0; shot < N; shot++) {
  await page.waitForTimeout(shot ? 5000 : 6000)
  await page.evaluate(() => new Promise(done => {
    const real = window.requestAnimationFrame.bind(window)
    window.__realRaf = real
    window.requestAnimationFrame = cb => { window.__parked = cb; return 0 }
    real(() => real(done))
  }))
  const draw = () => page.evaluate(() => {
    const sc = window.__pet.engine.scene
    for (let i = 0; i < 3; i++) {
      if (sc.composer) sc.composer.render(0.016)
      else sc.renderer.render(sc.scene, sc.camera)
    }
  })
  const set = (fly, rest) => page.evaluate(({ fly, rest }) => {
    const sc = window.__pet.engine.scene
    for (const c of sc.scene.children) if (c !== sc.fly.root) c.visible = rest
    sc.fly.root.visible = fly
  }, { fly, rest })

  await set(true, true); await draw(); await page.waitForTimeout(200)
  await page.screenshot({ path: `${OUT}/s${shot}_A.png` })
  await set(false, true); await draw(); await page.waitForTimeout(200)
  await page.screenshot({ path: `${OUT}/s${shot}_B.png` })
  await set(true, false); await draw(); await page.waitForTimeout(200)
  await page.screenshot({ path: `${OUT}/s${shot}_C.png` })
  await set(false, false); await draw(); await page.waitForTimeout(200)
  await page.screenshot({ path: `${OUT}/s${shot}_D.png` })
  await set(true, true)
  await page.evaluate(() => {
    window.requestAnimationFrame = window.__realRaf
    if (window.__parked) window.__realRaf(window.__parked)
  })
  console.log('shot', shot)
}
await browser.close(); process.kill(-preview.pid)
