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
- **Staging explicit paths is not enough.** `git commit` commits the whole index,
  including anything the other session has already staged. This is exactly how
  `1381686` ended up a joint commit. Always pass the pathspec to commit as well:

  ```
  git commit -F msg.txt -- web/src/pet/fly3d.ts web/public/models/
  ```

  and check `git show --stat HEAD` afterwards to confirm only your files went in.

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

### 2026-09-24 — fly-model session — the fly rebuilt; every scenery model refined

The user asked for every model in the game to be refined rather than imported as-is, so
this session's scope now covers `web/public/models/**` as a whole, not only the fly.

**The fly (`0f465dc`, unpushed at the time of writing).** Replaced the shy fly with
*Drosophila melanogaster* from DeepMind/Janelia's flybody (Apache-2.0), rebuilt by
`art/fly/build.sh`: 22.6k triangles, eye facets and bristles baked, own skeleton, five
clips (walk, groom, proboscis, startle, flight). `fly3d.ts` keeps the same interface;
`scene3d.ts` passes one extra field to `fly.update` (`turn`), inside the fly block.

**The scenery (this commit).** `art/kit/build.sh` rebuilds all 22 kit models from the
untouched originals, now kept in `art/src/nature` (byte-identical to what shipped
before): blades rebuilt with form and venation, leaf/petal atlases re-rendered at 4x with
veins and normal maps, stones re-meshed round onto a granite texture, mushrooms smoothed.
Plus **four new models**, `Litter_Oak/Beech/Birch/Maple`: the kit has no fallen leaves,
and the petal models the litter used are whole little flowers — blown up and tinted
brown, they were the "red paper". Same file names for everything else, so nothing that
loads a kit model by name needed to change.

**What I changed in `scene3d.ts` outside the fly blocks — please read:**

1. The loader has a meshopt decoder (`setMeshoptDecoder`). The refined kit ships
   meshopt-compressed; without it the models fail to load.
2. `windify`'s translucency term had three bugs, and they were most of why the meadow
   looked wrong: it used `vNormal`, which a double-sided leaf does not flip for its back
   face, so leaves seen from below got no light through them at all (the black "bats"
   against the sky); it ignored the sun's shadow, so shaded leaves glowed; and it had no
   1/pi, so what got through was brighter than direct sun. It now uses the face-corrected
   `normal`, the sun's colour *after* its shadow test (captured inside three's own light
   loop — `LIGHTS_KEEPING_SUN`, with a fallback if a three upgrade moves that code), and
   a pigment-filtered colour. Your sun is held behind the subject, so most foliage in
   frame is backlit and this term decides how the whole meadow reads.
3. The litter block loads the four `Litter_*` models instead of `Petal_1..3`/`Clover_2`,
   varies each instance's weathering with `setColorAt` instead of one brown tint per
   model, and tilts them less (the models are already curled). Counts, sizes and
   placement are yours and unchanged. The random sequence after it shifts, so the tall
   arcing grass lands in different places — still deterministic.

Also: `e2e/smoke.spec.ts` — "the simulation reported no steps per second" raced the
HUD's moving average, which starts at 0; it now polls. The five `web/scripts/*.mjs`
capture scripts leaked their `vite preview` (killing `npx` does not kill vite), which
then held the port and hung the next run; they now spawn it detached and kill the group.

Verified: `npm run check` green, Chromium and Firefox e2e green, live captures in
Chromium (Metal) from the follow camera, the overview, and every stimulus placed in
front of the fly. Frame rate unchanged (35 fps at 2x DPR on this Mac).

**Next, from the same user request:** a game layer that shows the fly's mental model —
what it senses, what it decides, and why — with actions you can see. That will touch
`App.tsx`/`engine.ts`/`pet.css`. I will keep it in new files where I can and write down
anything I change in yours.

### 2026-09-24 — fly-model session — the mind layer: seeing what the fly senses and decides

The user's second request: a game mechanism whose purpose is to show the fly's mental
model, with the fly doing things you can see. What went in:

- **Mind view** (`src/pet/mind.ts` decides, `src/pet/mind3d.ts` draws; **M** toggles):
  threads from each stimulus to the organ it drives, on the side it drives; a glow on
  each organ; an arrow showing where the decoded walk/steer command points; a "because
  ..." line under what it is doing in the HUD.
- **Body state**: pollen specks on the head (Dust), the abdomen swelling as it feeds, a
  nectar drop that shrinks as it drinks. The pollen feeds back as bristle drive until it
  is groomed off, so the grooming stops by itself (engine.ts, after the poke).
- **Field notebook** (**N**; `Notebook.tsx`, `mind.css`): ten experiments judged on the
  brain's own descending rates, persisted in `localStorage['fly-notebook-v1']`.
  `web/scripts/notebook-headless.mjs` plays all ten against the real model with no
  browser (it bundles the current source in memory - `bake/_pet_headless.mjs` is from
  before flight and I left it alone); `web/scripts/notebook.mjs` plays them in the game.

**Changes in files you own, all additive:**

- `engine.ts`: creates `Mind` and `MindView`, calls `mind.step()` every tick after
  `world.step`, adds the pollen drive before posting to the worker, five snapshot fields
  (`why`, `notebook`, `discovery` - numbered so the 50 ms snapshot throttle cannot drop
  one - `mindView` and `stuck`), `setMindView()` / `forgetNotebook()`, and
  `restartBrain()`, which sends the worker the `reset` it already understood but nothing
  sent. The worker's clock restarts from zero on that, so `onWorker` no longer adds a
  negative interval to `simPending`, and the whole-brain view gets a banked offset
  (`simBase`) so its time never runs backwards; the mind gets its own forward-only clock.
- `App.tsx`: the why line, a Mind toggle in the title row, M and N keys, a legend line,
  and the tracker, notebook and discovery toast.
- `scene3d.ts`: a `beforeDraw` hook called after the fly is posed, a second `overlay`
  scene drawn after the composer (inside the scene GTAO renders every mesh into its
  depth pass with its own material, which turned the glowing threads into dark shadows
  of themselves), `tokenCentre()`, and `satiety` in the fly block's `fly.update` call.
- `motor.ts`: a read-only `side(id)` next to `rate(id)`.
- `vitest.config.ts`: `mind` in the coverage list. `e2e/smoke.spec.ts`: one test - sugar
  at its feet is discovered and the card carries this fly's own MN9 rate.
- `how.html`: experiment 3 said tapping the fly makes the giant fibre "slam to full". It
  does not: a tap drives the head bristles, and measured headless (three seeds) that
  gives grooming (aDN1 ~230 /s) and the tongue (MN9 ~230 /s) with the giant fibre at 0.
  It now uses Looming, says what a tap really does, and points at the notebook - both
  languages.

**Please read - the brain gets stuck, and it always has.** One poke of the fly - 700 ms of
full bristle drive, `tap()` - locks MN9 on at ~220 /s, and it is still on 90 s later with
nothing there: measured headless, three seeds of three, and Dust does the same. A smell
leaves DNa01 at 20-40 /s the same way (looming and vibration let go). The network is
bistable and nothing in the LIF model tires, so it never comes back by itself: after the
first poke the proboscis stays out and the HUD says "feeding" for good. The notebook's
tongue experiments were failing because of it. `mind.ts` now detects it (a readout firing
hard for 3 s with nothing driving it), the HUD says so, and a notice offers "Restart its
brain". I did not change the model: the engine is validated against Brian2, and adding
adaptation would break that.

**Please read - left and right.** The arena's y grows down the screen, so bearing -90
degrees is the fly's LEFT (`sensors.ts` says so, and the 3-D scene agrees: I checked
which eye the threads reach). Measured that way, laterality in this connectome is
**crossed**: looming on its left gives DNa01 left 0 / right 30, on its right 28 / 0; dust
on one side drives the opposite aDN1; vibration grooms from its left and does nothing
from its right. The note in `motor.ts` ("looming on the left gives DNa01_left 22
spikes") matches placing the stimulus at +90 degrees, which here is the fly's right, and
the turn sign was chosen on that reading. I have **not** changed `motor.ts`: during an
escape the decoder does not steer at all, so the looming response looks identical either
way, and the sign is your call. My own first probe made the same mistake, which is how I
found it.

Verified: `npm run check` green (114 tests, 14 new), Chromium and Firefox e2e, and the
scripted player in `scripts/notebook.mjs`.
