/**
 * A scripted player for the field notebook: runs every experiment against the real
 * game - brain, sensors, decoder and all - and reports which were discovered, after how
 * much fly time, and what each recorded. If one comes back NOT FOUND, either the judge
 * in src/pet/mind.ts asks for more than live play gives, or the model changed.
 *
 *   npm run build && node scripts/notebook.mjs [out dir]
 *
 * Everything waits in fly time, not wall time: the brain does not always keep up with
 * the clock (a loaded machine ran it at half speed, and every wall-clock timeout lied).
 */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import process from 'node:process'

const OUT = process.argv[2] || 'shots/notebook'
mkdirSync(OUT, { recursive: true })
const preview = spawn('npx', ['vite', 'preview', '--port', '4320', '--strictPort'],
  { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
let failed = 0
try {
  const url = await new Promise(res => {
    const scan = b => { const m = /(http:\/\/localhost:\d+)/.exec(b.toString()); if (m) res(m[1]) }
    preview.stdout.on('data', scan); preview.stderr.on('data', scan)
  })
  const browser = await chromium.launch({
    headless: false,
    args: ['--use-angle=metal', '--ignore-gpu-blocklist',
           '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  page.on('pageerror', e => console.log('pageerror', String(e).slice(0, 400)))
  await page.goto(`${url}/pet.html?perf=1`)
  await page.waitForSelector('.pet-boot', { state: 'detached', timeout: 120_000 })
  await page.bringToFront()

  // side: 0 ahead, -1 its left, +1 its right. The arena's y grows down the screen, so
  // heading - 90 degrees is the fly's LEFT (sensors.ts).
  const put = (k, d, side = 0, dx = 0) => page.evaluate(([k, d, side, dx]) => {
    const e = window.__pet.engine, f = e.world.fly
    const a = f.h + side * Math.PI / 2
    e.world.add(e.stimuli.find(x => x.id === k), f.x + d * Math.cos(a) + dx, f.y + d * Math.sin(a))
  }, [k, d, side, dx])
  const hunger = h => page.evaluate(h => { window.__pet.engine.world.fly.hunger = h }, h)
  const found = () => page.evaluate(() => Object.keys(window.__pet.engine.mind.view.done))
  const simNow = () => page.evaluate(() => window.__pet.engine.simMs)
  const wait = async ms => {
    const t0 = await simNow()
    while (await simNow() - t0 < ms) await page.waitForTimeout(100)
  }
  const settle = async ms => { await page.evaluate(() => window.__pet.engine.world.clear()); await wait(ms) }
  const tries = {}
  /** Wait up to `ms` of fly time for `id`; report it unless `quiet` (a go, not the verdict). */
  const expect = async (id, ms, quiet = false) => {
    const t0 = await simNow()
    while (await simNow() - t0 < ms) {
      if ((await found()).includes(id)) break
      await page.waitForTimeout(150)
    }
    if (quiet) { tries[id] = (tries[id] ?? 0) + 1; return }
    const d = await page.evaluate(i => window.__pet.engine.mind.view.done[i], id)
    if (!d) failed++
    console.log(id.padEnd(8), (d ? (tries[id] ? `go ${tries[id]}` : 'by itself') : 'NOT FOUND').padEnd(10),
      d ? d.readings.map(r => `${r.label}: ${r.value}`).join(' | ') + (d.note ? `  (${d.note})` : '') : '')
  }

  // Each experiment gets up to three goes, as a player would give it: the drive is
  // Poisson noise and the fly is wherever it wandered to, so one go can miss.
  // as a player would when the "stuck" notice comes up: restart the brain, carry on
  const unstick = async () => {
    if (await page.evaluate(() => !!window.__pet.engine.mind.stuck)) {
      await page.evaluate(() => window.__pet.engine.restartBrain())
      await wait(1500)
    }
  }
  const attempt = async (id, tries, run) => {
    for (let k = 0; k < tries && !(await found()).includes(id); k++) { await unstick(); await run() }
    await expect(id, 0)
  }
  await wait(1500)
  await attempt('taste', 3, async () => { await put('sugar', 25); await expect('taste', 15_000, true); await settle(1000) })
  await attempt('meal', 3, async () => { await put('sugar', 20); await expect('meal', 20_000, true); await settle(1500) })
  await attempt('escape', 3, async () => { await put('looming', 80, 1); await expect('escape', 8000, true); await settle(6000) })
  await attempt('dust', 3, async () => { await put('bristle', 40, -1); await expect('dust', 25_000, true); await settle(4000) })
  await attempt('sides', 3, async () => {
    await put('looming', 90, -1); await wait(1500); await settle(6000)
    await put('looming', 90, 1); await expect('sides', 4000, true); await settle(6000)
  })
  await attempt('bitter', 3, async () => {
    await hunger(0.6)
    await put('sugar', 30); await put('bitter', 30, 0, 3); await expect('bitter', 15_000, true); await settle(3000)
  })
  await attempt('antenna', 3, async () => {
    await put('touch', 35, 1); await wait(2600); await settle(1000)
    await put('touch', 35, -1); await expect('antenna', 8000, true); await settle(3000)
  })
  await attempt('odor', 3, async () => {
    await put('odor', 100, -1); await wait(2500); await settle(3000)
    await put('odor', 100, 1); await expect('odor', 5000, true); await settle(3000)
  })
  await attempt('hunger', 3, async () => {
    await hunger(0.95)
    await put('sugar', 34); await wait(1500); await settle(2500)
    await hunger(0.1)
    await put('sugar', 34); await expect('hunger', 6000, true); await settle(2000)
  })
  await attempt('stuck', 3, async () => {
    // a poke, as clicking the fly does
    await page.evaluate(() => { window.__pet.engine.pokeUntil = performance.now() + 700 })
    await expect('stuck', 10_000, true)
  })

  await page.keyboard.press('n')
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/notebook.png` })
  console.log(`discovered ${(await found()).length} of 10`)
  await browser.close()
} finally {
  process.kill(-preview.pid)
}
process.exitCode = failed ? 1 : 0
