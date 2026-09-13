# Handoff log

Two Claude Code sessions share this working tree. This file is the channel between
them. Append to it; never rewrite someone else's entry.

## Ground rules

- The repo is git-tracked as of commit `e3bdcaa` (baseline). One branch, `main`.
  Both sessions commit to it sequentially — branches give no isolation in a shared
  working tree, so they are not used here.
- **There is now a public remote:** https://github.com/Jadog1122/fly-with-a-real-brain
  `git pull --rebase` before you push, in case the other session pushed first.
  **Never `push --force`.** Anything you commit here becomes public immediately.
- **Commit your own work when a coherent piece is done.** That is what makes it
  possible to see who changed what and to undo one session's work without touching
  the other's.
- Prefix your commit subjects so they are attributable: `fly-model:` or `world:`.
- **Never** run `git checkout`, `git reset`, `git revert`, `git rebase`, `git stash`,
  or `git commit --amend` against commits you did not make. If you think another
  session's change is wrong, write it in your entry below instead.
- Re-read a file immediately before editing it. The other session may have changed
  it since you last looked.
- `git status` before you start and before you commit, so you never stage someone
  else's in-flight edits. Stage explicit paths (`git add web/src/pet/fly3d.ts`),
  not `git add -A`.

## File ownership

| Path | Owner |
| --- | --- |
| `web/src/pet/fly3d.ts` | fly-model session |
| `web/public/models/**` | fly-model session |
| `web/src/pet/scene3d.ts` | **shared** — fly session touches only the two fly blocks (`fly.root.scale`/`add`, and the `fly.update(...)` call); world session owns scenery, litter, ground, fog, camera |
| `README.md` | fly session owns the licence/attribution section only |
| `web/vite.config.ts`, `web/src/pet/engine.ts`, `web/src/main.ts` | world session |
| `web/src/pet/{App.tsx,pet.css,theme.css}`, `web/src/style.css` | world session |

## Entries

### 2026-09-12 — world session — baseline
Committed `e3bdcaa`. Repo initialised, `.gitignore` added. Immediately prior work:
UI colour audit and correction round (18 leaked library tokens retinted, Explorer
page unified onto the same warm palette, label clipping and sub-11px type fixed,
fog range bound to camera mode, crumb-particle leak capped), plus a litter rewrite
in `scene3d.ts`. Next: brain-chunk code splitting in `vite.config.ts`/`engine.ts`.

### 2026-09-12 — world session — litter, bundle split
`716c09c` ground litter: all five pebble and three petal variants, dropped in seven
drifts rather than uniformly, each tilted and bedded into the dirt (it was reading as
even noise, and flat pebbles at a grazing angle looked like open books).
`<next>` build: `vite.config.ts` still told the dep optimizer to pre-bundle
`crystal-menu-ui`, which was uninstalled in the UI swap — removed. Added `manualChunks`
so `three` and `react` are named vendor chunks. **The "582 kB brain chunk" was a
misreading on my part**: that chunk was three.js keyed to `brain.ts`. The whole-brain
viewer's own code is 10.5 kB, so lazy-loading it would save nothing. Net real win: the
Explorer no longer ships React at all (221 kB). Both built pages verified in a browser,
zero console errors.

### 2026-09-12 — world session — engineering quality (section A)

**Action needed on your side: run `npm ci` in `web/` before your next build.**
Dependencies moved (vite 5 -> 6, vitest 2 -> 4) to clear 6 npm advisories; your
node_modules is stale.

New commands, all of which CI now runs on every push:

```
cd web
npm run check          # typecheck + lint + 72 unit tests, ~15 s
npm run test:e2e:local # Chromium + Firefox smoke tests (skips WebKit, see below)
```

**Please run `npm run check` before you commit.** Lint is at `--max-warnings 0`,
so a stray `any` or unused variable will fail CI.

What changed that touches you:

* `src/pet/fly3d.ts` is untouched. I have stayed out of it.
* `src/pet/sim.ts`: `LiveBrain.kick()`'s default changed from 1e-3 to 1 mV. The
  old default was a no-op - `step()` decays the membrane before thresholding, so
  a neuron needs ~0.035 mV of margin to survive one step. Both real callers
  already passed 1.0.
* `src/pet/scene3d.ts`: falls back to `rect` when `roundRect` is missing
  (Safari < 16.4). Still only the two fly blocks are yours.
* `src/pet/engine.ts`: `boot()` takes an optional third argument, an error
  callback. The worker's `onerror` now reaches the UI.
* New: `src/support.ts` (feature detection), `src/pet/packed.ts` (the payload
  parser, unified from two divergent copies), `src/pet/BootOverlay.tsx`,
  `src/pet/ErrorBoundary.tsx`.
* A boot failure now shows a card instead of a black page. If your model fails
  to load, you will see the reason on screen.

WebKit cannot be run on this Mac (Playwright's bundled build segfaults on
launch). CI covers it on Linux, and it passes.

### <date> — fly-model session — <result>
<!-- Fill this in when you finish. Required:
     - model source URL, exact licence, and where you recorded attribution
     - final byte size of everything added under web/public/models/
     - which of the seven animation channels are driven by the model's own rig and
       which you kept procedural, and why
     - files you changed, and your commit hashes
     - anything you could not do, stated plainly
-->
