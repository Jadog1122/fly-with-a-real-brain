/** One frozen frame, captured with each pass switched out, to attribute the darkness. */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
const OUT = process.argv[2] || 'dark'
await mkdir(OUT, { recursive: true })
const preview = spawn('npx', ['vite', 'preview', '--port', '4327', '--strictPort'],
  { stdio: ['ignore', 'pipe', 'pipe'] })
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
await page.waitForTimeout(8000)
await page.evaluate(() => new Promise(done => {
  const real = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = cb => { window.__parked = cb; return 0 }
  real(() => real(done))
}))
const kind = `p => p.materialBokeh ? 'dof' : typeof p.updateGtaoMaterial === 'function' ? 'ao'
  : p.highPassUniforms ? 'bloom'
  : p.uniforms && p.uniforms.grain !== undefined ? 'finish' : 'other'`
const shot = async (name, off, exposure) => {
  await page.evaluate(({ off, exposure, kindSrc }) => {
    const kindFn = eval(kindSrc)
    const sc = window.__pet.engine.scene
    for (const p of sc.composer.passes) p.enabled = !off.includes(kindFn(p))
    if (exposure != null) sc.renderer.toneMappingExposure = exposure
    for (let i = 0; i < 3; i++) sc.composer.render(0.016)
  }, { off, exposure, kindSrc: kind })
  await page.waitForTimeout(250)
  await page.screenshot({ path: `${OUT}/${name}.png` })
}
const base = await page.evaluate(() => window.__pet.engine.scene.renderer.toneMappingExposure)
console.log('toneMappingExposure =', base)
await shot('shipped', [], base)
await shot('no_ao', ['ao'], base)
await shot('no_finish', ['finish'], base)
await shot('no_post', ['ao', 'bloom', 'finish', 'dof'], base)
for (const m of [1.5, 2.0, 2.8]) await shot(`exp${m}`, [], base * m)
await shot('shipped2', [], base)
console.log('done')
await browser.close(); preview.kill()
