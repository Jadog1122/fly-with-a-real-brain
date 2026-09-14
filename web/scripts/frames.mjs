/** Capture the game as it actually runs, several seconds apart. */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
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

for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(i === 0 ? 2500 : 5000)
  await page.screenshot({ path: `${OUT}/live${i}.png` })
  const s = await page.evaluate(() => {
    const sc = window.__pet.engine.scene
    const f = window.__pet.engine.world.fly
    return {
      fly: [Math.round(f.x), Math.round(f.y), Math.round(f.alt)],
      cam: [sc.camera.position.x, sc.camera.position.y, sc.camera.position.z].map(Math.round),
      target: [sc.camTarget.x, sc.camTarget.y, sc.camTarget.z].map(Math.round),
      focus: sc.bokeh ? Math.round(sc.bokeh.uniforms.focus.value) : null,
      fps: Math.round(sc.fps), quality: sc.quality,
    }
  })
  console.log(`live${i}`, JSON.stringify(s))
}
await browser.close()
preview.kill()
