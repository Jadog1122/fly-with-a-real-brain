/**
 * Photograph every authored pose through the game's own renderer.
 *
 * Freezes the app's loop, drives fly.update() by hand with each behaviour forced, and
 * captures the fly close up - so a broken clip is visible as a picture, not inferred
 * from bone numbers. Then unfreezes and triggers the real behaviours through the real
 * input path: Dust placed by a click for grooming, a click on the fly for the poke.
 *
 * Usage: node scripts/poses.mjs <outdir>
 */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import process from 'node:process'

const OUT = process.argv[2] || 'poses'
await mkdir(OUT, { recursive: true })
const preview = spawn('npx', ['vite', 'preview', '--port', '4333', '--strictPort'],
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
await page.waitForTimeout(4000)

// ---- controlled poses on a frozen frame -------------------------------------------
await page.evaluate(() => new Promise(done => {
  const real = window.requestAnimationFrame.bind(window)
  window.__realRaf = real
  window.requestAnimationFrame = cb => { window.__parked = cb; return 0 }
  real(() => real(done))
}))

const POSES = {
  rest:      { speed: 0,  legPhase: 0,   escape: false, proboscis: 0, groom: 0, startle: 0, airborne: 0 },
  walk_a:    { speed: 60, legPhase: 0.6, escape: false, proboscis: 0, groom: 0, startle: 0, airborne: 0 },
  walk_b:    { speed: 60, legPhase: 2.5, escape: false, proboscis: 0, groom: 0, startle: 0, airborne: 0 },
  flight:    { speed: 0,  legPhase: 0,   escape: true,  proboscis: 0, groom: 0, startle: 0, airborne: 1 },
  groom:     { speed: 0,  legPhase: 0,   escape: false, proboscis: 0, groom: 1, startle: 0, airborne: 0 },
  proboscis: { speed: 0,  legPhase: 0,   escape: false, proboscis: 1, groom: 0, startle: 0, airborne: 0 },
  startle:   { speed: 0,  legPhase: 0,   escape: false, proboscis: 0, groom: 0, startle: 1, airborne: 0 },
}

const boxes = {}
for (const [name, o] of Object.entries(POSES)) {
  boxes[name] = await page.evaluate(({ o }) => {
    const sc = window.__pet.engine.scene
    sc.setQuality('medium')                 // no depth of field: poses want to be sharp
    // Everything except the fly goes invisible: the first attempt shot it buried in
    // litter, with the legs - the whole point of the exercise - hidden behind leaves.
    for (const c of sc.scene.children) c.visible = c === sc.fly.root
    const f = sc.fly.root.position
    // A true profile relative to the fly's own heading, not the world axes, so every
    // pose is seen from its side whatever direction the fly stopped facing.
    const h = window.__pet.engine.world.fly.h
    const side = { x: -Math.sin(h), z: Math.cos(h) }
    sc.camera.position.set(f.x + side.x * 150, f.y + 30, f.z + side.z * 150)
    sc.camera.lookAt(f.x, f.y + 14, f.z)
    // let the eased blends converge on the forced behaviour
    for (let i = 0; i < 40; i++) sc.fly.update(0.1, o)
    for (let i = 0; i < 3; i++) {
      if (sc.composer) sc.composer.render(0.016)
      else sc.renderer.render(sc.scene, sc.camera)
    }
    // the fly's screen box, for cropping
    const cv = sc.renderer.domElement
    const V = sc.camera.position.constructor
    const lo = new V(1e9, 1e9, 1e9), hi = new V(-1e9, -1e9, -1e9)
    sc.fly.root.updateWorldMatrix(true, true)
    sc.fly.root.traverse(m => {
      if (!m.isMesh) return
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
      const g = m.geometry.boundingBox
      for (const x of [g.min.x, g.max.x]) for (const y of [g.min.y, g.max.y])
        for (const z of [g.min.z, g.max.z])
          { const w = new V(x, y, z).applyMatrix4(m.matrixWorld); lo.min(w); hi.max(w) }
    })
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
    for (const x of [lo.x, hi.x]) for (const y of [lo.y, hi.y]) for (const z of [lo.z, hi.z]) {
      const v = new V(x, y, z).project(sc.camera)
      x0 = Math.min(x0, (v.x * .5 + .5) * cv.width); x1 = Math.max(x1, (v.x * .5 + .5) * cv.width)
      y0 = Math.min(y0, (-v.y * .5 + .5) * cv.height); y1 = Math.max(y1, (-v.y * .5 + .5) * cv.height)
    }
    return { box: [x0, y0, x1, y1].map(Math.round), canvas: [cv.width, cv.height] }
  }, { o })
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${OUT}/pose_${name}.png` })
  console.log('pose', name, JSON.stringify(boxes[name].box))
}
// scene visibility back on before the live half
await page.evaluate(() => {
  const sc = window.__pet.engine.scene
  for (const c of sc.scene.children) c.visible = true
})
writeFileSync(`${OUT}/boxes.json`, JSON.stringify(boxes, null, 1))

// ---- the real input path ----------------------------------------------------------
await page.evaluate(() => {
  window.requestAnimationFrame = window.__realRaf
  if (window.__parked) window.__realRaf(window.__parked)
})
await page.waitForTimeout(1000)

/** Map the fly's world position to CSS-pixel page coordinates. */
const flyOnPage = () => page.evaluate(() => {
  const sc = window.__pet.engine.scene
  const cv = sc.renderer.domElement
  const r = cv.getBoundingClientRect()
  const v = sc.fly.root.position.clone().project(sc.camera)
  return { x: r.left + (v.x * .5 + .5) * r.width, y: r.top + (-v.y * .5 + .5) * r.height }
})

// Dust next to the fly, through the dock and a real click: grooming's real trigger.
await page.click('text=Dust')
const p1 = await flyOnPage()
await page.mouse.click(p1.x + 60, p1.y + 30)
for (let i = 0; i < 4; i++) {
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${OUT}/live_dust_${i}.png` })
}
// A poke: click the fly itself. The Giant Fibre answers with a jump.
const p2 = await flyOnPage()
await page.mouse.click(p2.x, p2.y)
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/live_poke_${i}.png` })
}
console.log('done')
await browser.close(); process.kill(-preview.pid)
