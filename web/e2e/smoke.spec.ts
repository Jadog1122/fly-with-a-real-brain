import { test, expect, type Page } from '@playwright/test'

/** Console noise that is not the app's fault. */
const IGNORE = [/favicon/i, /Download the React DevTools/i]

function collectErrors(page: Page) {
  const errors: string[] = []
  page.on('console', m => {
    if (m.type() === 'error' && !IGNORE.some(re => re.test(m.text()))) errors.push(m.text())
  })
  page.on('pageerror', e => errors.push(`uncaught: ${e.message}`))
  return errors
}

// Each of these boots a 45,808-neuron simulation, so they are deliberately few and
// coarse: the question is whether the app runs on this engine at all, not what it does.
//
// Some CI engines have no WebGL at all - headless Firefox on Linux ships no software
// renderer - and there the correct behaviour is the friendly "this browser can't run
// it" message, not a working world. So each test asks the browser what it can do and
// then checks the right outcome. That makes the unsupported path real coverage on a
// real engine rather than something only ever seen in jsdom.

/** Does this browser actually give us a WebGL2 context? */
async function hasWebgl2(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    try {
      return !!document.createElement('canvas').getContext('webgl2')
    } catch {
      return false
    }
  })
}

test('the pet page boots the brain, runs it and renders the world', async ({ page }) => {
  const errors = collectErrors(page)
  await page.goto('/pet.html')

  if (!(await hasWebgl2(page))) {
    // the unsupported path: a card naming what is missing, and no crash
    const card = page.locator('.pet-boot')
    await expect(card).toBeVisible()
    await expect(card).toContainText(/can.t run it/i)
    await expect(card).toContainText('WebGL 2')
    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([])
    return
  }

  // the boot overlay must clear, rather than settle on the error card
  await expect(page.locator('.pet-boot')).toHaveCount(0, { timeout: 60_000 })

  // HUD text is driven by worker messages, so this proves the simulation is running
  await expect(page.locator('.pet-doing b')).not.toHaveText('…')
  await expect(page.locator('.pet-doing i')).toContainText('steps/s')
  const stepsPerSec = await page.evaluate(() =>
    parseInt((document.querySelector('.pet-doing i')?.textContent ?? '').replace(/\D/g, ''), 10))
  expect(stepsPerSec, 'the simulation reported no steps per second').toBeGreaterThan(0)

  // WebGL actually produced a canvas at a sane size
  const canvas = page.locator('.pet-viewport canvas')
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  expect(box!.width).toBeGreaterThan(200)
  expect(box!.height).toBeGreaterThan(200)

  // and the HUD the world session built is present
  await expect(page.locator('.rpg-ui-hud')).toBeVisible()
  expect(await page.locator('.rpg-ui-dock-slot').count()).toBeGreaterThan(3)

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([])
})

test('the explorer page loads the connectome', async ({ page }) => {
  const errors = collectErrors(page)
  await page.goto('/')

  if (!(await hasWebgl2(page))) {
    await expect(page.locator('#loading')).toHaveClass(/failed/)
    await expect(page.locator('#loading-msg')).toContainText('WebGL 2')
    // the page logs that same explanation on purpose; nothing else may appear
    expect(errors.filter(e => !/missing WebGL 2/.test(e)),
      `unexpected console errors: ${errors.join(' | ')}`).toEqual([])
    return
  }

  await expect(page.locator('#loading')).toHaveClass(/gone/, { timeout: 60_000 })
  await expect(page.locator('#loading')).not.toHaveClass(/failed/)
  await expect(page.locator('#stage canvas')).toBeVisible()
  await expect(page.locator('#exp-label')).not.toHaveText('—')

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([])
})

/**
 * Tone mapping must come before the display-referred passes.
 *
 * This exists because of a bug nothing else could see. The colour grade was running
 * BEFORE tone mapping, so BrightnessContrastShader's `(c - 0.5) / (1 - contrast) + 0.5`
 * was pivoting around 0.5 in LINEAR light, where mid grey is about 0.21. Everything
 * below linear 0.07 - most of the frame - was driven negative and clipped to pure
 * black. Measured on the running game, the picture's 25th percentile was 0.000 and its
 * median 0.021 against a calibration target of 0.31: more than half of every frame was
 * crushed, the meadow read as a dark hole and the fly was invisible in it. Every unit
 * test passed and the build was clean.
 *
 * The obvious guard - render a frame and assert its histogram - was tried first and
 * does not work here. On this software renderer the camera's view at boot is almost
 * entirely bright sky, so with the bug deliberately reintroduced the frame measured
 * p05 0.46 with not one clipped pixel, and the assertion passed. A test that cannot
 * fail on the bug it was written for is worse than no test, so this asserts the
 * invariant itself instead: a grade, a vignette and film grain are display-referred
 * operations and every one of them has to run after OutputPass. That holds whatever
 * the camera happens to be looking at.
 */
test('tone mapping runs before the grade, the vignette and the grain', async ({ page }) => {
  await page.goto('/pet.html?perf=1')
  if (!(await hasWebgl2(page))) {
    test.skip(true, 'no WebGL2 on this engine; the unsupported path is covered above')
    return
  }
  await expect(page.locator('.pet-boot')).toHaveCount(0, { timeout: 180_000 })

  const order = await page.evaluate(() => {
    type U = Record<string, unknown> | undefined
    const sc = (window as unknown as { __pet: { engine: { scene: {
      setQuality: (q: string) => void
      composer: { passes: { uniforms?: U }[] } | null
    } } } }).__pet.engine.scene
    sc.setQuality('high')                  // the tier every one of these passes lives in
    return (sc.composer?.passes ?? []).map(p => {
      const u = p.uniforms
      if (!u) return 'other'
      if ('toneMappingExposure' in u) return 'output'
      if ('contrast' in u) return 'grade'
      if ('darkness' in u) return 'vignette'
      if ('grayscale' in u) return 'grain'
      return 'other'
    })
  })

  const output = order.indexOf('output')
  expect(output, `no OutputPass in the chain: ${order.join(' -> ')}`).toBeGreaterThanOrEqual(0)
  for (const displayReferred of ['grade', 'vignette', 'grain']) {
    const at = order.indexOf(displayReferred)
    if (at < 0) continue                   // not present at this tier, nothing to check
    expect(at, `${displayReferred} runs in linear light, before tone mapping: `
      + order.join(' -> ')).toBeGreaterThan(output)
  }
})
