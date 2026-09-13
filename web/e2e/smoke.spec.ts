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
