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
  // The rate is a moving average that starts from zero, so the HUD can read "0 steps/s"
  // for the moment before the worker's first tick lands; reading it once raced that.
  await expect.poll(() => page.evaluate(() =>
    parseInt((document.querySelector('.pet-doing i')?.textContent ?? '').replace(/\D/g, ''), 10)),
  { message: 'the simulation reported no steps per second', timeout: 10_000 }).toBeGreaterThan(0)

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

/**
 * The fly's body has to actually move.
 *
 * The skeleton lives in the asset (art/fly/build_fly.py builds it in Blender) and this
 * plays clips off it, which means there are several new ways for the fly to end up
 * frozen: the clip names could change, the mixer could never be updated, the weights
 * could all sit at zero, or the asset could ship without its animations. None of those
 * would fail a unit test or a build - the fly would just stand there, which is a thing
 * that has happened to this project more than once for other reasons.
 */
test('the brain moves the fly, and the fly has a skeleton that moves with it', async ({ page }) => {
  await page.goto('/pet.html?perf=1')
  if (!(await hasWebgl2(page))) {
    test.skip(true, 'no WebGL2 on this engine; the unsupported path is covered above')
    return
  }
  await expect(page.locator('.pet-boot')).toHaveCount(0, { timeout: 180_000 })
  await page.waitForTimeout(2000)

  type Pet = { engine: { scene: { fly: {
    act: Record<string, { getClip: () => { name: string } }>
    root: { traverse: (fn: (o: {
      isBone?: boolean; name: string; quaternion: { x: number; y: number; z: number; w: number }
    }) => void) => void }
  } } } }
  const sample = () => page.evaluate(() => {
    const fly = (window as unknown as { __pet: Pet }).__pet.engine.scene.fly
    const bones: Record<string, number[]> = {}
    fly.root.traverse(o => {
      if (o.isBone) bones[o.name] = [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w]
    })
    return { clips: Object.keys(fly.act ?? {}).sort(), bones }
  })

  const a = await sample()
  // The asset carries these; if Blender stops exporting one, the blend silently loses
  // a pose rather than erroring.
  // There is no idle clip any more: three blends leftover weight toward the bind pose,
  // which for this model is the standing pose.
  expect(a.clips, 'the rigged asset is missing clips').toEqual(
    expect.arrayContaining(['flight', 'groom', 'proboscis', 'startle', 'walk']))
  // an anatomical skeleton: coxa to claw on every leg, head, proboscis, abdomen, wings
  expect(Object.keys(a.bones).length, 'the fly has no skeleton').toBeGreaterThanOrEqual(70)

  // Poll rather than snapshot: a fly that happens to be standing still for a moment
  // moves only its wings, and a single 1.5 s window flagged that as "frozen" once.
  // What this guards is frozen FOREVER - so keep looking until it walks, and only a
  // rig that never reaches six moving bones in ten seconds fails.
  let moved: string[] = []
  for (let attempt = 0; attempt < 7 && moved.length < 6; attempt++) {
    await page.waitForTimeout(1500)
    const b = await sample()
    moved = Object.keys(a.bones).filter(k =>
      a.bones[k].some((v, i) => Math.abs(v - b.bones[k][i]) > 1e-3))
  }
  expect(moved.length, `only ${moved.length} of ${Object.keys(a.bones).length} bones ever moved`
    + ' - the fly is frozen').toBeGreaterThanOrEqual(6)
})

/**
 * The tutorial page: static, bilingual, and it carries the one interactive thing the
 * whole explanation leans on - the leaky-cup neuron. If the cup stops firing, the
 * page still "loads" fine, so the test taps it the way a ten-year-old would.
 */
test('the tutorial page teaches in both languages and the cup fires', async ({ page }) => {
  const errors: string[] = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.addInitScript(() => localStorage.setItem('fly-lang', 'zh'))
  await page.goto('/how.html')

  await expect(page.locator('html')).toHaveAttribute('data-lang', 'zh')
  await expect(page.getByRole('heading', { name: '它没有剧本' })).toBeVisible()

  // the toggle swaps every paired element at once
  await page.locator('#lang-btn').click()
  await expect(page.locator('html')).toHaveAttribute('data-lang', 'en')
  await expect(page.getByRole('heading', { name: 'It has no script' })).toBeVisible()

  // four quick signals beat the leak and cross the threshold exactly once
  const btn = page.locator('#drip-btn')
  await btn.scrollIntoViewIfNeeded()
  for (let i = 0; i < 4; i++) await btn.click()
  await expect(page.locator('#spike-count')).not.toHaveText('0')

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([])
})

/**
 * The three pages have to actually reach each other.
 *
 * With three separate Vite entries cross-linking, a href typo or a page dropped from
 * rollupOptions.input breaks navigation in a way nothing else here notices: every page
 * still loads perfectly well on its own.
 *
 * This reads each href out of the DOM and then follows it, rather than clicking. The
 * click version failed on headless Firefox, and correctly so: with no WebGL the
 * explorer covers its whole stage with the "this browser can't run it" card, which
 * intercepts pointer events on the corner links. That says nothing about whether the
 * links are right, which is what this is for. One real click stays, on the tutorial -
 * the one page that needs no WebGL at all.
 */
test('the three pages link to each other', async ({ page }) => {
  const hrefOn = async (from: string, selector: string) => {
    await page.goto(from)
    // `:visible` because the tutorial carries both languages in the markup and hides
    // one set, so its footer link resolves to two anchors - one of them unreachable.
    const href = await page.locator(`${selector}:visible`).first().getAttribute('href')
    expect(href, `${from} has no ${selector}`).toBeTruthy()
    return new URL(href!, new URL(page.url())).toString()
  }

  const hops: [string, string, RegExp][] = [
    ['/', '#to-how', /how\.html$/],           // explorer  -> tutorial
    ['/', '#to-pet', /pet\.html$/],           // explorer  -> the fly
    ['/how.html', '.uv-cta', /pet\.html$/],   // tutorial  -> the fly
    ['/how.html', '.foot a', /index\.html$/], // tutorial  -> explorer
    ['/pet.html', 'a[href="./how.html"]', /how\.html$/],     // the fly -> tutorial
    ['/pet.html', 'a[href="./index.html"]', /index\.html$/], // the fly -> explorer
  ]
  for (const [from, selector, dest] of hops) {
    const target = await hrefOn(from, selector)
    expect(target, `${from} ${selector} points somewhere unexpected`).toMatch(dest)
    // and the page it names was actually built
    const res = await page.goto(target)
    // below 400, not exactly 200: the preview server answers 304 for anything the
    // browser already has cached, and a cached page is still a built page.
    expect(res?.status() ?? 0, `${target} is not a built page`).toBeLessThan(400)
    await expect(page.locator('body')).not.toContainText('Cannot GET')
  }

  // one real click, on the page that needs no WebGL to be usable
  await page.goto('/how.html')
  await page.locator('.uv-cta:visible').first().click()
  await expect(page).toHaveURL(/pet\.html/)
})
