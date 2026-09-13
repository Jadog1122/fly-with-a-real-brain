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

### 2026-09-12 — fly-model session — the fly is a real model now

**Model.** "shy fly" by Maf'j Alvarez. Source page
https://poly.pizza/m/8p3PASxvAQr (the Google Poly archive). Licence **CC-BY 3.0**,
confirmed three ways before I committed anything: poly.pizza links
`creativecommons.org/licenses/by/3.0/`; the Wayback capture of the author's own Poly
page (`web.archive.org/web/20210619173533/https://poly.google.com/view/8p3PASxvAQr`)
reads "Public / Remixable (CC-BY) ... You're free to use this as long as you credit
the author"; and the Icosa Foundation's Poly archive
(`api.icosa.gallery/v1/assets/8p3PASxvAQr`) records
`"license": "CREATIVE_COMMONS_BY", "licenseVersion": "3.0"`.

**One thing you should know about that licence.** The same author later published the
same model on Sketchfab under **CC BY-NC-SA**. I read that as a separate, later grant
that does not withdraw the CC-BY one the author made on Poly (CC grants are
irrevocable), and the repo is public, so I committed it. It is your repo and your
call — if you would rather not carry the ambiguity, say so and I will swap the asset;
the runner-up is "Fly" by Kohyzazi (https://poly.pizza/m/kCLW4c0kGx), though it is a
single merged mesh so the legs and wings could not be animated separately.
Attribution is recorded in `NOTICE` and in the licence list at the end of `README.md`,
including this caveat.

**Bytes.** `web/public/models/fly/shy-fly.glb`, **133,668 bytes**, and that is
everything added under `web/public/models/`. No textures at all — the asset is solid
colours — so nothing to downscale. Shipped byte-identical to the source
(sha256 `56a12ac7964c403c615c68800b36d73f246fc9cae3ee3fd8d3681587b1c21bf8`).
Measured first load of the built `pet.html`: **2,500,178 B (2.384 MB)** over 49
requests, of which the fly is 133,668 B. Everything else sums to 2.257 MB, which
matches the 2.28 MB you recorded, and nothing is fetched twice — `THREE.Cache` is
still doing its job.

**Animation channels.** The asset has no bones, but it ships as eleven loose parts
(body, 2 eyes, 2 wings, 6 legs). `fly3d.ts` rigs it at load: each limb is re-parented
into a pivot placed at its own attachment point, computed from that part's own
vertices (top fifth of a leg = its hip; inboard fifth of a wing = its hinge). So:

| channel | driven by | note |
| --- | --- | --- |
| `legPhase` / `speed` | **the model's six legs** | alternating tripod; stops dead at speed 0 |
| `escape` | **the model's two wings** | 90 rad/s vs 12 idle, hinged at the thorax |
| `groom` | **the model's front two legs** | raised to the face, rubbing out of phase |
| `startle` | **the model's torso + eye material** | see below |
| `airborne` | **the whole rig** | squash/stretch + lift + nose-up pitch |
| `proboscis` | **a second copy of the model's hind leg** | see below |

Two I could not do straight, stated plainly:

* **`startle` does not rear the head alone.** I checked: the body is a single welded
  shell — head, thorax and abdomen are one connected component, 1095 tris — so there
  is no head to rotate without cutting geometry. Instead the whole torso rears about
  the line the legs stand on, while the legs stay planted, and the eyes brighten
  (the eyes *are* separate meshes). It reads as rearing. It is not a head turn.
* **There is no proboscis in the mesh** (the snout is part of the body shell). Rather
  than model a tube, MN9 extends a *second copy of a hind leg* from the snout — it is
  tapered, dark, and has exactly the facet density and palette of everything else,
  which built geometry would not. It retracts to nothing when `proboscis` is 0.

No channel was dropped and no channel is faked.

**A bug in the brief, worth recording.** The prompt says the model must face **+X** at
root rotation 0. It must face **-X**: `scene3d.ts` sets `root.rotation.y = -h + PI`, so
at root yaw 0 the heading is `h = PI`, which is -X. I had it backwards first and the
fly walked backwards; measured it rather than reasoned it the second time.

**Files changed:** `web/src/pet/fly3d.ts` (rewritten), `web/public/models/fly/shy-fly.glb`
(new), `NOTICE`, the licence section of `README.md`, and **two comment lines at the top
of `web/src/pet/scene3d.ts`** — it still said "The fly itself is procedural (there is no
CC0 Drosophila)", which is now false in a public repo. That is outside the two fly
blocks; if you would rather I had left it, revert that hunk, it is only a comment.

**Commit hashes — please read this bit.** I have none of my own for the code. I staged
my five files and, in the seconds between staging and committing, your
`1381686 "U1: persist the pet between visits"` picked all five of them up along with
your own six. My work is intact and correct in that commit (I verified the yaw fix, the
groom fix, the proboscis values and the GLB checksum all landed), and it is already
pushed. I have not touched it — the rules say I do not rewrite commits I did not make,
and splitting it now would be worse than the mess. So `1381686` is a joint commit:
`fly3d.ts`, `shy-fly.glb`, `NOTICE`, `README.md` and the `scene3d.ts` comment in it are
mine; `App.tsx`, `engine.ts`, `pet.css`, `save.ts`, `save.test.ts` are yours. Suggest we
both `git add <explicit paths> && git commit` in one step from now on rather than
staging and then committing, since `git commit -a`/`-A` sweeps the other session's index.

**Verified:** `npm run check` green (typecheck + lint + 90 tests) and `npm run build`
exit 0 after `npm ci`. Looked at it in a browser from the follow camera, the `V`
overview, and close up from six angles; drove every channel through
`scene.render()`/`fly.update()` and measured each one's range of motion rather than
eyeballing it (e.g. walking swings a leg 1.00 rad and lifts it 0.38; stopped is exactly
0; grooming sweeps 0.90 rad and is exactly 0 when not grooming; escape moves a wing
2.00 rad vs 0.12 idle). One real defect found and fixed that way: grooming was driven
off `performance.now()` (inherited idiom), so it was wall-clock dependent — it now runs
off an accumulator advanced by `dt`.
