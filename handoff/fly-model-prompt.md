Replace the procedural cartoon fly in this project with a real open-source 3-D model.

## The project

`/Users/jadog/fly` is a *Drosophila* connectome toy. 45,808 real neurons from the FlyWire
connectome run live in a Web Worker, and the firing rates of their descending neurons
drive a fly walking around a 3-D meadow. The web app is `web/` (Vite + React + three.js).

```
cd /Users/jadog/fly/web && npm run dev      # then open /pet.html
```

Public repo: https://github.com/Jadog1122/fly-with-a-real-brain

## Your task

The fly is hand-built from ellipsoids in `web/src/pet/fly3d.ts` (179 lines). It does not
read as a fly. Against the rest of the scene it looks like a pale segmented grub or a
bee: a barrel body with visible banding, wings that read as two flat blades, and eyes
that sit on the silhouette like stuck-on spheres instead of belonging to a head. Replace
it with a real model.

## The rule that matters most

**Do not hand-roll geometry.** The project owner's standing instruction: use existing
open-source assets directly — take a model wholesale, or extract parts of one — and if
you must build anything, build on top of something that already exists. Go find and
verify candidates yourself; do not limit yourself to any list anyone gives you. A
better-looking hand-modelled fly is the wrong answer here.

The scene's props are **Quaternius's Stylized Nature MegaKit (CC0)** in
`web/public/models/nature/` — flat-shaded, low-poly, saturated, no surface detail. The
new fly must sit inside that style. Unifying style while sourcing is explicitly
encouraged: retint materials, drop a detail pass, rescale. That is the job, not a
compromise.

## Hard requirements

**Licence.** CC0 or CC-BY only (or equivalent permissive). Verify the licence on the
actual source page — do not assume from a listing. **The repo is public**, so anything
you commit is redistribution. Record source URL + licence in `NOTICE` at the repo root,
alongside the existing entries, and in the licence section at the end of `README.md`.
If CC-BY, attribution is mandatory. If you cannot confirm a licence, reject that model.

**Budget.** The whole 22-model nature kit is 1.9 MB. Keep the fly under ~500 KB, textures
≤512 px, glTF/GLB. Downscale rather than ship a 2048 px map. Note `THREE.Cache.enabled`
is already set in `scene3d.ts`, so shared textures are fetched once — reuse the kit's
existing textures if they fit.

**It must read as a fly at a glance**, both from the follow camera and in the `V`
overview: two wings (not four), a distinct head whose compound eyes belong to it, and a
body that is not a smooth barrel. Cartoon proportions are welcome. Red eyes are correct
for *Drosophila*.

## The interface you must preserve

`web/src/pet/scene3d.ts` owns the fly and touches it in exactly two places:

```ts
// construction, ~line 158
this.fly.root.scale.setScalar(34)     // world units; the arena is 760 x 490
this.scene.add(this.fly.root)

// every frame, ~line 388
this.fly.root.position.set(f.x, 0, f.y)
this.fly.root.rotation.y = -f.h + Math.PI    // so the model must face +X at rotation 0
this.fly.update(dt, {
  speed: f.speed, legPhase: f.legPhase, escape: action.escape,
  proboscis: action.proboscis, groom: action.groom, startle: f.startle,
  airborne: this.airborne,
})
```

Keep `class Fly3D` exporting `readonly root: THREE.Group` and the same `update(dt, o)`
signature. If the model loads asynchronously, `root` must exist immediately and populate
when the glTF resolves — `scene3d.ts` adds it during construction and must not have to
await anything. There is a private `load(file)` helper and a shared `GLTFLoader` already
in `scene3d.ts`; reuse that pattern.

Every channel in `update()` is driven by real simulation output and must keep working.
This is the entire point of the project, not decoration:

| input | what it is | must still show |
| --- | --- | --- |
| `legPhase`, `speed` | walking decoded from DNa02 / P9 | six legs stepping, stopping when it stops |
| `escape` | Giant Fiber / oDN1 escape | wings beating hard (~90 rad/s vs 12 idle) |
| `proboscis` | MN9 proboscis extension | proboscis extends when feeding |
| `groom` | grooming readout | front legs rubbing the head |
| `startle` | startle state | head rears back, eyes brighten |
| `airborne` | takeoff / landing | squash on landing, stretch on takeoff |

If the sourced model has no rig, the sanctioned fallback is: use its body/head/wing
meshes and keep the existing procedural `Leg` class for the legs. Extracting parts is
explicitly allowed. Do not silently drop a channel because the model lacks a bone — keep
the procedural version of that part and say so in your report.

## How we coordinate

Another Claude Code session ("the world session") is working in this same tree right now.
It owns rendering, the world, the HUD and the build; you own the fly.

**Read `/Users/jadog/fly/handoff/HANDOFF.md` before you start.** It holds the ground
rules, the file-ownership table and the other session's log. If it disagrees with
anything here, HANDOFF.md wins.

- The tree is git-tracked, single branch `main`, with a **public** remote `origin`.
  Branches give no isolation in a shared working tree, so both sessions commit to `main`
  sequentially.
- **Re-read a file immediately before editing it.** The other session may have changed it
  since you last looked. This is not theoretical — `scene3d.ts` has moved several times.
- `git status` before you start and before you commit. **Stage explicit paths**
  (`git add web/src/pet/fly3d.ts`), never `git add -A` — you will pick up the other
  session's in-flight edits.
- Commit your own work with subjects prefixed `fly-model:`. `git pull --rebase` before
  pushing. **Never `push --force`.**
- **Never** run `checkout`, `reset`, `revert`, `rebase`, `stash` or `commit --amend`
  against commits you did not make. If you think the other session's change is wrong,
  write it in your HANDOFF entry instead of touching it.

**File ownership:**

| Path | Owner |
| --- | --- |
| `web/src/pet/fly3d.ts`, `web/public/models/**` | **you** |
| `NOTICE`, the licence section of `README.md` | **you**, for your attribution entry only |
| `web/src/pet/scene3d.ts` | **shared** — you touch only the two fly blocks above. Scenery, litter, ground, fog, camera and `THREE.Cache` belong to the world session |
| `web/vite.config.ts`, `web/src/pet/engine.ts`, `web/src/main.ts` | world session |
| `web/src/pet/{App.tsx,pet.css,theme.css}`, `web/src/style.css` | world session |

## Verify before you report

1. `cd web && npx tsc --noEmit` clean, and `npm run build` exits 0.
2. Actually look at it. Run the dev server and take screenshots from the follow camera
   and from the `V` overview, and confirm it reads as a fly in both.
3. Exercise every animation channel and confirm each one animates. In dev builds the
   engine is exposed as `window.__pet.engine` — e.g. place a sugar token and watch the
   proboscis extend, or a looming token to trigger escape. Note that the in-app browser
   freezes `requestAnimationFrame` when its pane is hidden, so force a frame with a
   screenshot before trusting any measurement that depends on rendering.
4. Check the first-load weight did not regress (it is 2.28 MB today).

## Report

Append an entry to the "Entries" section of `handoff/HANDOFF.md` with:

- model source URL, exact licence, and where you recorded attribution
- total bytes added under `web/public/models/`
- which of the six animation channels the model's own rig drives, and which you kept
  procedural, and why
- files changed and your commit hashes
- anything you could not do

State plainly what you changed and what you could not. Do not overstate.
