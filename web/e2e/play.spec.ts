import { test, expect, type Page } from '@playwright/test'

/**
 * The meadow, end to end: the page reaches the game server, two people in two browser
 * contexts (two seats, two localStorages) see each other, a token one of them drops
 * carries their name on the other's screen, and the fly the server is stepping moves for
 * both. The server runs the real 45,808-neuron brain (playwright.config.ts starts it);
 * the pages run no brain at all, which is the point of the mode.
 */

const IGNORE = [/favicon/i, /Download the React DevTools/i]

function collectErrors(page: Page) {
  const errors: string[] = []
  page.on('console', m => {
    if (m.type() === 'error' && !IGNORE.some(re => re.test(m.text()))) errors.push(m.text())
  })
  page.on('pageerror', e => errors.push(`uncaught: ${e.message}`))
  return errors
}

/**
 * Two of these pages share CI's two cores and its software renderer, and at full quality
 * a frame there takes seconds, which starves the main thread that has to read the
 * socket. Low quality (no shadows, no post-processing, native resolution) and a smaller
 * viewport keep the question about the meadow, not about SwiftShader.
 */
async function cheap(page: Page) {
  await page.addInitScript(() => {
    try { localStorage.setItem('fly-play-quality', 'low') } catch { /* private mode */ }
  })
  await page.setViewportSize({ width: 900, height: 640 })
}

async function hasWebgl2(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    try { return !!document.createElement('canvas').getContext('webgl2') } catch { return false }
  })
}

/** Take a seat. The page must already be on /play.html?perf=1: navigating again cancels
 *  the model loads still in flight, which WebKit reports as "access control" errors. */
async function join(page: Page, name: string) {
  await expect(page.locator('.play-title')).toHaveText('Lure the fly')
  await page.locator('.play-join input').fill(name)
  await page.locator('.play-go').click()
  // the door closes once the server has seated us
  await expect(page.locator('.play-door')).toHaveCount(0, { timeout: 60_000 })
}

type Pet = { view: {
  me: { id: string } | null
  client: { place: (tool: string, x: number, y: number) => void }
  world: { fly: { x: number; y: number } }
  latest: { fly: { x: number; y: number } } | null
  round: { phase: string; left: number }
  tokens: { owner: string }[]
} }

test('two people share the fly, and see each other in the meadow', async ({ browser, page }) => {
  // Two software-rendered WebGL pages, not one: booting them side by side keeps this
  // inside a budget CI's Chromium can meet (~70 s a page there, one after the other).
  test.setTimeout(480_000)
  const errors = collectErrors(page)
  await cheap(page)
  await page.goto('/play.html?perf=1')

  if (!(await hasWebgl2(page))) {
    const card = page.locator('.play-card')
    await expect(card).toBeVisible()
    await expect(card).toContainText(/can.t run it/i)
    await expect(card).toContainText('WebGL 2')
    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([])
    return
  }

  // a second person: their own context, so their own seat
  const ctx = await browser.newContext()
  const page2 = await ctx.newPage()
  const errors2 = collectErrors(page2)
  await cheap(page2)
  await page2.goto('/play.html?perf=1')
  await Promise.all([join(page, 'Ada'), join(page2, 'Bo')])

  await expect(page.locator('.play-scores')).toContainText('Ada')
  // the round clock and the fly's behaviour both come over the socket
  await expect(page.locator('.play-clock')).not.toHaveText('–:––')
  await expect(page.locator('.play-state b')).not.toHaveText('…', { timeout: 30_000 })
  await expect(page.locator('.play-state i')).toContainText('steps/s on the server')
  await expect(page2.locator('.play-scores')).toContainText('Ada')
  await expect(page.locator('.play-scores')).toContainText('Bo')
  // at least the two of us: a developer's own tab may be seated in the same meadow
  await expect(page.locator('.play-people h2')).toHaveText(/^([2-9]|\d{2,}) in the meadow$/)

  // Bo drops sugar; Ada sees a token wearing Bo's name. Not between rounds, when the
  // server rightly refuses it: booting two software-rendered pages can take long enough
  // in CI to land in that 12 s window.
  await expect.poll(() => page2.evaluate(() => {
    const r = (window as unknown as { __pet: Pet }).__pet.view.round
    return r.phase === 'play' && r.left > 20_000
  }), { message: 'no round to place in', timeout: 40_000 }).toBe(true)
  await page2.evaluate(() => {
    (window as unknown as { __pet: Pet }).__pet.view.client.place('sugar', 380, 245)
  })
  await expect(page.locator('.play-label-token', { hasText: 'Bo' })).not.toHaveCount(0, { timeout: 20_000 })

  // and the fly moves, for both, because the server is stepping it. Read the state the
  // page received rather than the drawn position: a second software-rendered page in CI
  // gets very few frames, and the question is whether the server's fly reaches it.
  const at = (p: Page) => p.evaluate(() => {
    const v = (window as unknown as { __pet: Pet }).__pet.view
    const f = v.latest?.fly ?? v.world.fly
    return [f.x, f.y]
  })
  const a0 = await at(page)
  await expect.poll(async () => {
    const [x, y] = await at(page)
    return Math.hypot(x - a0[0], y - a0[1])
  }, { message: 'the fly never moved on the first screen', timeout: 60_000 }).toBeGreaterThan(2)
  const b0 = await at(page2)
  await expect.poll(async () => {
    const [x, y] = await at(page2)
    return Math.hypot(x - b0[0], y - b0[1])
  }, { message: 'the fly never moved on the second screen', timeout: 60_000 }).toBeGreaterThan(2)

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([])
  expect(errors2, `console errors (Bo): ${errors2.join(' | ')}`).toEqual([])
  await ctx.close()
})

test('the play page is linked from the fly and the explorer', async ({ page }) => {
  for (const [from, selector] of [['/pet.html', 'a[href="./play.html"]'], ['/', '#to-play']] as const) {
    await page.goto(from)
    const href = await page.locator(selector).first().getAttribute('href')
    expect(href, `${from} has no ${selector}`).toBeTruthy()
    const res = await page.goto(new URL(href!, new URL(page.url())).toString())
    expect(res?.status() ?? 0).toBeLessThan(400)
    await expect(page).toHaveURL(/play\.html/)
  }
})
