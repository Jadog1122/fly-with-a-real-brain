Replace the procedural cartoon fly in this project with a real open-source 3-D model.

## Context

`/Users/jadog/fly` is a *Drosophila* connectome toy: 45,808 real neurons from FlyWire
run live in a Web Worker, and their descending-neuron firing rates drive a fly walking
around a 3-D meadow. Web app is in `web/` (Vite + React + three.js). Run it with
`cd web && npm run dev`, then open `/pet.html`.

The fly you see is hand-built from ellipsoids in `web/src/pet/fly3d.ts` (179 lines).
It does not read as a fly. Judged against the rest of the scene it looks like a pale
segmented grub or a bee: barrel body with visible banding, wings that read as two flat
blades, and eyes that sit on the silhouette like stuck-on spheres rather than forming a
head. That is the problem to solve.

## The rule that matters most

**Do not hand-roll geometry.** The project owner's standing instruction is: use existing
open-source assets directly — take a model wholesale, or extract parts of one — and if
you must build anything, build it on top of something that already exists. Go find and
verify candidates yourself; do not limit yourself to any list. A better-looking
hand-modelled fly is the wrong answer here.

The scene's existing props are **Quaternius's Stylized Nature MegaKit (CC0)** in
`web/public/models/nature/` — flat-shaded, low-poly, saturated, no texture detail. The
new fly must sit inside that style. Unifying style while sourcing is explicitly allowed:
retint materials, drop a detail pass, rescale — that is expected, not a compromise.

## Hard requirements

**Licence.** CC0 or CC-BY only (permissive equivalents fine). Verify the actual licence
on the source page — do not assume. Record source URL + licence in the "Licences and
data" section at the end of `README.md`, matching how Quaternius is credited there. If
CC-BY, attribution is mandatory. If you cannot confirm a licence, reject that model.

**Budget.** The whole nature kit is 1.9 MB for 22 models. Keep the fly under ~500 KB,
textures ≤512 px, glTF/GLB. Downscale rather than ship a 2048 px map.

**It must read as a fly at a glance**, at the follow camera and in the `V` overview:
two wings (not four), a distinct head with compound eyes that belong to it, a body that
is not a smooth barrel. Cartoon proportions are welcome. Red eyes are correct for
*Drosophila*.

## The interface you must preserve

`web/src/pet/scene3d.ts` owns the fly and touches it in exactly two places:

```ts
// construction, ~line 153
this.fly.root.scale.setScalar(34)     // world units; the arena is 760 x 490
this.scene.add(this.fly.root)

// every frame, ~line 359
this.fly.root.position.set(f.x, 0, f.y)
this.fly.root.rotation.y = -f.h + Math.PI    // so the model must face +X at rotation 0
this.fly.update(dt, {
  speed: f.speed, legPhase: f.legPhase, escape: action.escape,
  proboscis: action.proboscis, groom: action.groom, startle: f.startle,
  airborne: this.airborne,
})
```

Keep `class Fly3D` exporting `readonly root: THREE.Group` and the same `update(dt, o)`
signature. If the model must load asynchronously, `root` has to exist immediately and
populate when the glTF resolves — `scene3d.ts` adds it during construction and must not
have to await anything. Reuse the `GLTFLoader` already imported there.

Every animation channel in `update()` is driven by real simulation output and must keep
working — this is the point of the project, not decoration:

| input | what it is | must still show |
| --- | --- | --- |
| `legPhase`, `speed` | walking decoded from DNa02/P9 | six legs stepping, stopping when stopped |
| `escape` | Giant Fiber / oDN1 escape | wings beating hard (~90 rad/s vs 12 idle) |
| `proboscis` | MN9 proboscis extension | proboscis extends when feeding |
| `groom` | grooming readout | front legs rubbing the head |
| `startle` | startle state | head rears back, eyes brighten |
| `airborne` | takeoff/landing | squash on landing, stretch on takeoff |

If the sourced model has no rig, the sanctioned fallback is: use its body/head/wing
meshes and keep the existing procedural `Leg` class for the legs. Extracting parts is
explicitly allowed. Do not drop a channel because the model lacks a bone — say so and
keep the procedural version of that one part.

## Coordinating with another session

Another session is editing this repo concurrently. **Re-read a file immediately before
editing it.**

- `web/src/pet/scene3d.ts` is **shared**. Confine your edits to the two fly blocks above.
  The scenery/litter arrays near the top and the ground/fog code are being changed by
  the other session — leave them alone.
- Do not touch: `web/vite.config.ts`, `web/src/pet/engine.ts`, `web/src/main.ts`,
  `web/src/style.css`, `web/src/pet/theme.css`, `web/src/pet/pet.css`,
  `web/src/pet/App.tsx`.
- Yours alone: `web/src/pet/fly3d.ts`, `web/public/models/`, and the licence section of
  `README.md`.

## Verify before you report

1. `cd web && npx tsc --noEmit` clean, `npm run build` exit 0.
2. Run the dev server and look at it. Confirm by screenshot, from the follow camera and
   from the `V` overview, that it reads as a fly.
3. Exercise each channel and confirm it animates — you can drive the engine directly
   from the devtools console via `window.__pet.engine` (dev builds expose it), e.g.
   place a sugar token and watch the proboscis extend, or a looming token for escape.
4. Report the model source URL, its licence, the final byte size, and any channel you
   had to keep procedural.

State plainly what you changed and anything you could not do — do not overstate.

## How to hand your work back

The tree is git-tracked (baseline commit `e3bdcaa`, single branch `main`).

1. **Read `handoff/HANDOFF.md` first.** It carries the ground rules, the file-ownership
   table, and the other session's log entries. It is the authoritative version of the
   coordination notes above — if the two disagree, follow `HANDOFF.md`.
2. Commit your own work when it is done, subject prefixed `fly-model:`. Stage explicit
   paths, never `git add -A` — the other session has edits in flight in the same tree.
3. Never `checkout`, `reset`, `revert`, `rebase`, `stash`, or `--amend` anything you did
   not commit yourself.
4. Append your entry to the "Entries" section of `handoff/HANDOFF.md`: model source URL,
   exact licence and where you recorded attribution, total bytes added under
   `web/public/models/`, which animation channels the model's own rig drives versus
   which you kept procedural, the files you changed, your commit hashes, and anything
   you could not do.
