# A fly brain you can poke — and a fly that lives in it

Two pages on the same connectome:

| | |
| --- | --- |
| **`/` — Explorer** | Click a neuron in a 3-D point cloud of the whole brain and watch the spike it triggers cascade through the real FlyWire wiring, with a scrubbable spike raster. Plays **pre-baked** simulations. |
| **`/pet.html` — The pet** | A fly walking around an arena with **45,808 of its neurons simulated live in your browser**. Drop sugar, bitter, a looming shadow, a smell or a vibration into its world and it reacts — because the spikes actually propagate through the connectome to its motor neurons. |

The explorer is a player: simulations are baked offline, which is what makes it a
one-evening project. The pet is not — its brain runs in a Web Worker at roughly real
time, and the JavaScript engine is verified spike-for-spike against Brian2.

![sugar cascade](data/cache/smoke_raster.png)

---

## What is actually being shown

138,639 neurons and 15,091,983 synapses from the **FlyWire 783** connectome, wired into
the leaky integrate-and-fire model of **Shiu et al.** and run in **Brian2**. Poking a
neuron drives its whole cell type with a Poisson input, exactly as the paper's own
`run_exp` does, and records every spike in the brain for 500 ms. The pet runs the same
model, same constants, on a validated 45,808-neuron subnetwork, live in the browser.

The headline result reproduces: activate the 23 labellar **sugar** receptor neurons and
**MN9**, the proboscis-extension motor neuron, fires at 26 ms — while the descending
neurons for escape, walking and turning stay silent. Activate the **LC4** looming
detectors instead and the **Giant Fibers** fire at 6 ms. The cascades are specific, not
generic excitation.

---

## Quick start

```bash
git clone https://github.com/eonsystemspbc/fly-brain.git upstream   # connectome + model
brew install uv node                                                # toolchain
uv venv --python 3.11 .venv && VIRTUAL_ENV=$PWD/.venv uv pip install \
    brian2 "numpy>=2.0,<2.4" "pandas>=2.0,<3" pyarrow scipy matplotlib joblib
cd bake && for s in 00_fetch_annotations 01_prepare 02_select 03_run 04_export \
                    10_pet_probe 11_subnet 12_validate_subnet 13_pet_config 14_validate_engine; do
    ../.venv/bin/python $s.py || break; done
cd ../web && npm install && npm run dev
```

Then `/` is the explorer and `/pet.html` is the pet.

Already baked? Just:

```bash
cd web && npm install && npm run dev
```

---

## Environment notes (macOS, Apple Silicon)

Built and tested on an **M3 MacBook, 8 GB RAM, macOS 26**. Three things in the original
plan do not work on this machine, and the pipeline is built around the alternatives:

| Planned | What actually happened | What is used instead |
| --- | --- | --- |
| `conda env create -f environment.yml` | Pins CUDA PyTorch, `brian2cuda`, `pygenn`, `nest-gpu` — none exist for macOS arm64 | Hand-built venv, CPU only |
| `conda create -n flybrain` | conda is not installed; installing it rewrites the user's shell profile | `uv venv --python 3.11` (self-contained CPython, no Homebrew linkage) |
| `brew install python@3.11` | The bottle's `pyexpat` links against a `/usr/lib/libexpat` that no longer exports `_XML_SetAllocTrackerActivationThreshold`, so `plistlib` → `platform.mac_ver()` → `pip` bootstrap all fail | `uv`'s standalone CPython |

`xcode-select --install` was not needed — Command Line Tools were already present, which
is all Brian2's `cpp_standalone` mode needs. `libomp` was not installed either;
`prefs.devices.cpp_standalone.openmp_threads = 0` keeps Brian2 single-threaded, which is
fine at this problem size.

**Version pins that matter:** NumPy must stay `< 2.4`. Brian2 2.9.0 still references
`np.ndarray.ptp`, which NumPy removed in 2.4, so `import brian2` raises `AttributeError`
on a default install. Pandas is held at 2.x to match the upstream code.

---

## Where the brief and the repository disagree

Checked against the actual repository rather than assumed:

- **The Brian2 code lives in `code/paper-phil-drosophila/`, not `code/paper-brian2/`.**
  Same contents: `model.py`, `utils.py`, `example.ipynb`.
- **`2025_Completeness_783.csv` has no cell-type column.** It is two columns — flywire ID
  and a `Completed` boolean — so neurons cannot be selected from it by cell type.
  Annotations come from [flywire_annotations](https://github.com/flyconnectome/flywire_annotations)
  instead (see below).
- **The connectome has 15.1 M edges, not 5 M.**
- `weight_coo.pkl` / `weight_csr.pkl` never appear: those belong to the PyTorch runner,
  not this code path.
- `data/sez_neurons.pickle` turns out to be 106 named subesophageal-zone cell types →
  flywire IDs, and is used as a selection source.

### Coordinates: no FlyWire token needed

The brief expected a `FLYWIRE_TOKEN` and the L2-cache centroid route, with a
graph-layout fallback. Neither is used. `bake/00_fetch_annotations.py` fetches
supplemental file 1 of **Schlegel et al. 2024** (CC-BY-4.0) from a public GitHub repo,
which carries, for every neuron in the 783 release:

- `pos_x/y/z` and `soma_x/y/z` — real anatomical coordinates in 4×4×40 nm voxels
- `super_class`, `cell_class`, `cell_type`, `side`, `top_nt`

It matches **138,625 of 138,639** simulated neurons (100.0 %), all with coordinates. So
the page always shows **real anatomy**, no fallback layout and no account needed. Soma
position is preferred (118,086 neurons); the arbour representative point is used for the
rest. The 14 unmatched neurons are parked at the median position and coloured
"unannotated".

---

## Pipeline

Everything is resumable: experiment IDs are slugs of their labels, and any stage skips
work whose output already exists.

| Script | Does | Time |
| --- | --- | --- |
| `bake/00_fetch_annotations.py` | Sparse-clones the FlyWire annotation TSV (32 MB) into `data/cache/` | ~20 s, cached |
| `bake/01_prepare.py` | Joins annotations to the network, computes degrees, writes `neurons.parquet` and the browser's `neurons.bin` | ~40 s |
| `bake/02_select.py` | Picks what is pokeable, writes `experiments_todo.json` | ~15 s |
| `bake/03_run.py` | One Brian2 subprocess per experiment | **~10 min for 65** |
| `bake/04_export.py` | Time-bins spikes, slices the connectome, writes `web/public/data/` | ~90 s |
| `bake/10_pet_probe.py` | Whole-brain probes of every state the pet can drive (each sensor bilaterally, one side at a time, weak, and in combination) | ~3 min |
| `bake/11_subnet.py` | Extracts the subnetwork the browser simulates live | ~40 s |
| `bake/12_validate_subnet.py` | Subnetwork vs whole brain, against a measured noise floor | ~3 min |
| `bake/13_pet_config.py` | Sensor and readout wiring in subnet-local indices | ~20 s |
| `bake/14_validate_engine.py` | JavaScript engine vs Brian2, spike for spike | ~1 min |
| `bake/15_pet_tune.mjs` | Runs the pet headless and reports what it actually did; how the behaviour constants were set | ~1 min per simulated minute |
| `bake/smoke.py`, `bake/plot_raster.py` | One-off sanity run and raster plot | ~10 s |

`bake/pet_groups.py` defines the sensor and readout populations. The notebook's ID lists
are partly unilateral — its sugar set is 23 left-side LB3 cells out of 122 in the brain —
so each group is expanded to the full bilateral population of the cell types the notebook
used. A cell type is only pulled in if the notebook's list covers a real share of that
type's whole-brain population: the Or56a list contains one stray `ORN_VA1d` out of 97 in
the brain, and expanding on that would have added an entire wrong glomerulus.

A single whole-brain experiment — 138,639 LIF neurons, 15.1 M synapses, 500 ms of
biological time — takes **6–14 s wall clock** on the M3, C++ code generation and compile
included. The whole bake is about 12 minutes, not the hours the brief budgeted.

### How the experiments are chosen

Poking a lone neuron is a dud: one cell at 200 Hz rarely pushes anything downstream past
threshold. So a poke drives a **cell type**, which is both the biologically meaningful
unit and the one that produces a visible cascade. Every member of a chosen type becomes
clickable — **2,984 neurons** across **60 experiments**.

1. **Canonical pathways lifted from the upstream notebook** (parsed with `ast`, not
   copy-pasted, so they track upstream): sugar GRNs, bitter GRNs, sugar+bitter, LC4,
   Or56a, Johnston's organ and four of its subtypes, and the named descending/motor
   neurons P9, DNa01/02, MDN, Giant Fiber, MN9, aDN1.
2. **14 SEZ cell types** from `sez_neurons.pickle`, ranked by out-degree.
3. **33 high-fanout annotated cell types**, quota'd across regions for coverage — and
   filtered to **predominantly cholinergic** types. This matters: activating a GABAergic
   or glutamatergic type *silences* its targets, so those experiments come back empty.
   Screening on `top_nt` took the dead-experiment rate from 15/62 down to 5/65.

Five selections are dropped at export for producing no cascade, and every one has a
reason: **MN9** and **DNa01** are motor and descending neurons whose axons leave for the
ventral nerve cord, which this connectome does not contain, and three SEZ types are
inhibitory dead ends. They stay visible and inspectable in the UI, just not pokeable.

### Downsampling contract

- `t_run` 500 ms, binned at **5 ms → 100 frames** per experiment (the brief said 10 ms;
  at 10 ms the whole interesting part of a cascade is six frames, so the bin was halved)
- each frame stores the **row indices** of neurons that fired in it, never flywire IDs
- edges are restricted to the subgraph where **both endpoints fired**, capped at 5,000,
  keeping causal edges (presynaptic neuron fired first) ahead of the rest, then by weight

Payload: `neurons.bin` 3.8 MB, experiments 12.3 MB total, **median 88 KB and largest
1,032 KB** per experiment — comfortably under the 2 MB ceiling.

### Why binary instead of JSON

`neurons.json` in the brief's shape would be ~14 MB of text for 138,639 neurons, and the
busiest cascades pushed a JSON experiment file to 2,048 KB — right at the limit. Both
payloads are therefore `MAGIC | uint32 header length | JSON header | 8-byte-aligned typed
arrays`, and the browser builds typed-array views straight onto the downloaded
`ArrayBuffer` with no parse step. Same content, half the bytes, no parse cost.

Flywire IDs are 18-digit integers that exceed JavaScript's exact-integer range, so they
travel as a `BigInt64Array` and are only ever rendered via `BigInt.toString()`.

---

## The pet — a live brain in the browser

`/pet.html`. A fly in an arena; you place stimuli; its brain decides what it does.

### Is real-time whole-brain simulation actually possible in a browser?

Measured before committing to an approach, rather than assumed:

- Across all 104 baked whole-brain runs, only **21,740 of 138,639 neurons ever fire**
  (15.7 %), wired by 2.4 M of the 15.1 M synapses. Most of the brain never moves under
  any stimulus we can present.
- Graph distance is no help — breadth-first search from the 3,006 stimulable neurons
  reaches 133,355 of them in **two hops**. The connectome is small-world, so the
  reduction has to be functional, not structural.
- A benchmark of the actual inner loop in plain JavaScript, worst case (random synapse
  targets, no cache locality): **11,332 timesteps/s at rest, 4,424 during a 585-spike
  avalanche** — 1.1× and 0.44× biological real time for a 25 k-neuron network.

So **no WASM**. Plain typed arrays are fast enough, and the original plan to port the
integrator to Rust was dropped as unnecessary complexity.

### The subnetwork, and whether it is honest

`bake/11_subnet.py` keeps every neuron that fired in any whole-brain run, plus every
neuron that could ever be an input or a readout (all sensory, ascending, descending,
motor, endocrine and visual-projection cells): **45,808 neurons, 3.5 M synapses, 8.9 MB
gzipped**.

Reductions like this usually break by silently removing inhibition — 33 % of these
synapses are inhibitory. So `bake/12_validate_subnet.py` does not assert, it measures:
for each stimulus it runs the whole brain a second time with a different random seed to
establish a **noise floor**, then compares the subnetwork against the original.

| Stimulus | noise floor (whole brain, other seed) | subnetwork |
| --- | --- | --- |
| Sugar GRNs | jaccard 0.873, rate *r* 0.994 | 0.865, 0.991 |
| Bitter GRNs | 0.958, 0.993 | **0.965**, 0.994 |
| LC4 looming | 0.905, 0.992 | 0.891, 0.992 |
| Or56a | 0.973, 0.999 | 0.972, 0.999 |
| Johnston organ | 0.916, 0.994 | **0.925**, 0.994 |
| probe sugar-full | 0.972, 0.998 | **0.974**, 0.998 |
| probe touch-full | 0.935, 0.994 | **0.945**, 0.994 |

The reduction error sits inside the model's own run-to-run variability; on several
conditions the subnetwork tracks the reference more closely than an independent
whole-brain rerun does. Readouts survive too: MN9 54→51 spikes (21→23 ms), Giant Fiber
65→63 (7→6 ms), aDN1 31→33 (21→21 ms).

What it does *not* prove: the basis comes from 104 stimulus conditions. A stimulus far
outside that space could recruit neurons the subnetwork does not contain.

### Does the JavaScript engine reproduce Brian2?

`bake/14_validate_engine.py`, and it is the part of this project most worth not
trusting by eye. Two tests: a deterministic one (a single suprathreshold kick, no
Poisson, no RNG anywhere — the two engines must agree exactly), and the stochastic
drives the pet really uses.

```
=== 1. deterministic: one kick, no RNG - must agree exactly ===
  sugar     brian2   179 spikes | js   179 | identical   179  -> EXACT MATCH
  looming   brian2   164 spikes | js   164 | identical   164  -> EXACT MATCH

=== 2. stochastic: the drives the pet uses (RNG streams differ) ===
  stimulus    brian2 spikes   js spikes   ratio  brian2 active  js active   ratio
  sugar             231,621     235,720   1.018          8,715      8,739   1.003
  touch              90,173      91,525   1.015          1,523      1,532   1.006
```

Getting there took two fixes, neither visible without the test:

1. **Synaptic delay is `delay/dt + 1` steps, not `delay/dt`.** Brian2 applies `on_pre`
   in its `synapses` schedule slot, which runs *after* the state update, so the
   postsynaptic membrane only moves on the following step. Symptom: every spike arrived
   one step early per synaptic hop, compounding down the cascade.
2. **Brian2 discards synaptic input to a refractory neuron.** The `(unless refractory)`
   flag on `g` gates writes from synapses, not just the differential equation — verified
   directly: a spike delivered to a refractory neuron leaves its `g` at zero. Without
   that gate the engine ran **76 % hot**, but only in avalanches, where many neurons are
   refractory at once. Quiet stimuli agreed to 3 %, which is exactly why this needed a
   test at the loud end rather than a glance at the quiet one.

State is `Float64Array`, matching Brian2: this network is close enough to critical that
a neuron sitting exactly on threshold crossing one step early can change the outcome.

### How a stimulus becomes behaviour

**In:** each stimulus has a falloff (contact chemoreception for taste, exponential for
smell, vision and vibration) and a bearing. Intensity sets the Poisson rate; the bearing
splits it across the **left and right halves of the sensory population** — the FlyWire
`side` annotation is what makes this possible, and the asymmetry then propagates through
the real wiring to the left and right steering neurons.

**Out:** the firing rates of the descending neurons the upstream notebook names — P9
(forward), DNa01/DNa02 (turning), MDN (backward), Giant Fiber (escape), MN9 (proboscis),
aDN1 (grooming). Measured live in the browser, with the stimulus off to the fly's left:

| Stimulus | what its descending neurons do |
| --- | --- |
| Sugar | **proboscis 118 Hz**, nothing else — it sticks its tongue out |
| Bitter | proboscis 1.3 Hz — essentially nothing, which is the point |
| Looming | **escape 197 Hz**, backward 10 Hz |
| Geosmin | **turning 80 Hz**, escape 4 Hz — it turns away |
| Vibration | **grooming 44 Hz** |

That specificity is not configured anywhere. It is what the connectome does.

### What this model can and cannot be asked

The obvious next move with a whole-brain connectome is to wire up more of the sensory
system and watch behaviour appear. The receptors really are all there: 16,933 sensory
neurons, including **53 olfactory glomeruli**, 408 gustatory cells, 2,656
mechanosensory, 74 humidity, 29 temperature, and the retina itself (R1-6, R7, R8).

So we screened them. `bake/16_odor_screen.py` drives every glomerulus on the whole
brain; `bake/17_modality_screen.py` does the same for everything else.

**Olfaction cannot reach a behaviour in this model, at any setting.** All 53 glomeruli
give the same answer: ~8,300 neurons active (a 2.6 % spread across all of them) and a
fixed readout of turn_a ~13, turn_b ~26, with every other descending neuron silent.
That is not a map of odour to behaviour, it is one response 53 times. Dose does not fix
it — the network is bistable, and below the tipping point nothing reaches the descending
neurons at all (DA2 at 20 Hz: 39 neurons active, zero readouts). Neither does the one
free parameter: scaling the global synaptic weight to 0.6 / 0.35 / 0.2 moves the
threshold without ever opening a window where different odours drive different
behaviour.

So **the "turning" an odour produces is the signature of the runaway, not olfactory
processing** — every avalanche gives it, whatever triggered it, and nothing below the
avalanche gives anything. The pet keeps geosmin for exactly that reason, flagged in the
UI as a known artifact.

We did not localise the runaway. The obvious guess was the mushroom body, which the
avalanche recruits heavily (3,354 of 5,177 Kenyon cells), but silencing every Kenyon
cell's output changes almost nothing: 8,324 active becomes 7,894 and the readouts are
untouched. The mushroom body is a passenger, not the cause.

**Everything that is a short reflex arc works.** The modality screen found four channels
that reach a specific descending neuron without tipping the network over:

| Input | neurons | drives | |
| --- | --- | --- | --- |
| Tarsal taste `dorsal_tpGRN` | **11** | proboscis 25 | sugar on the feet extends the tongue — the classic fly experiment |
| Labellar `LB4` | **4** | proboscis 49 | a second taste channel, four neurons |
| Body bristles `BM` | 1,417 | grooming **101** | the strongest grooming signal anywhere in the model |
| Leg/body ascending `SA_` | 327 | forward 12 | the only input that drives forward walking at all |

Photoreceptors drive nothing — but that is expected rather than a failure: driving all
7,932 of R1-6 uniformly is "the lights came on everywhere", which is not a visual
stimulus. Vision is spatial and temporal, and LC4 works precisely because it is the
*output* of that computation.

The line is clean: **taste and touch reach behaviour, smell and humidity and temperature
do not** — and the ones that fail are exactly the ones that project into the antennal
lobe.

### Two things that are ours, not the model's

- **There is no ventral nerve cord.** Descending axons leave this connectome and stop,
  so behaviour is *decoded* from descending firing rates, exactly as the paper reads its
  results. The fly's movement is an interpretation, not a simulation of legs.
- **A foraging drive is added.** Nothing in the connectome makes a fly walk about on its
  own. The pet gets an explicit hunger-scaled Poisson drive on P9 and DNa02 so it
  wanders. It is the same kind of input as a stimulus, on real neurons, but we add it —
  and the UI says so on screen.

  We looked for a real pathway to replace it. The leg and body ascending neurons (`SA_`)
  are the only input in the whole sensory system that drives forward walking, and they
  cannot carry it: at 200 Hz they give the P9 group 12 spikes in half a second, and
  driving them harder makes it *worse*, not better — at 400 Hz forward collapses to 1
  and the proboscis readout jumps to 103, because a different pathway takes over. So the
  added drive stays, but it stays after a test rather than an assumption.

Hunger also raises sugar sensitivity, which is a real effect in starved flies.

### Tuning it by measurement, not by feel

`bake/15_pet_tune.mjs` runs the pet's real brain, sensors, decoder and world headless in
Node and reports what the fly actually did over minutes of fly time. The constants in
`motor.ts` and `sensors.ts` were set against those numbers rather than by watching it.

The first run said the thing was broken in ways that were not obvious on screen:

| | before | after |
| --- | --- | --- |
| idle speed | 179 units/s, **10.8 arena crossings a minute** | 11–30 units/s, 0.9–1.8 crossings |
| what it was doing | `walking 100 %` — one state, forever | walking 47 %, turning 51 %, idle 2 % |
| a looming shadow | `escape 100 %` for as long as it was there | escape 67 %, then it settles |
| a vibration | `grooming 100 %`, speed 0 — a dead pet | grooming 62 %, walking 24 % |
| standing on sugar | **0 meals**, and it got hungrier | 1 meal, hunger 0.35 → 0.10 |

Four fixes came out of it:

1. **Sensory adaptation.** A stimulus that never fades leaves the fly fleeing, or
   grooming, forever. Exposure now drives each stimulus's drive down toward a floor and
   absence brings it back — with a high floor for taste, since a fly does not stop
   tasting sugar halfway through a meal.
2. **Feeding must not freeze locomotion — the world decides that, not the decoder.**
   Stopping the fly whenever its proboscis extended looked right and was a deadlock: the
   proboscis extends as soon as sugar is within receptor range, which is further than
   the fly can reach, so it froze just short of the food and starved with `feeding 94 %`.
   It now stops only once it is genuinely on the meal.
3. **Walking bouts.** Constant drive gave a fly cruising at a fixed speed forever. A slow
   envelope on the foraging drive gives runs and pauses, as flies actually walk.
4. **Saccadic turns.** Flies walk in straight runs broken by fast body turns. Without
   them the pet drifted along long arcs. They are injected as a brief one-sided kick to
   the steering neurons, so the turn still comes out of the brain.

   Worth being precise about what that bought, because the obvious claim is not the one
   the data supports. Over six two-minute runs with food 200 units away, saccades
   tightened how close the fly got — median closest approach 99 → 70 units, and it came
   within 100 units in five runs of six instead of three. They did **not** measurably
   change how often it actually found the food: two runs in six either way, and six
   trials cannot tell 1/6 from 2/6. Coverage improved; the hit rate is unresolved, and
   separating 30 % from 50 % would need about fifty runs, which is hours of simulation
   for a number that would not change the design.

One more bug fell out of reading the geometry rather than the screen: **the left and
right sensory populations were swapped.** Screen y grows downward, so a stimulus on the
fly's left sits at bearing −π/2 and `sin(bearing)` is −1 there; the drive was going into
the wrong antenna. It was invisible because the turn sign cancelled it — two inverted
conventions producing plausible behaviour between them.

That turn sign is itself a choice, and the code says so. DNa02 is reported to drive
*ipsilateral* turning, and in this connectome a stimulus on one side drives that side's
steering neurons (looming on the left: DNa01_left 22 spikes, DNa01_right 0). Those two
facts together predict a fly that steers *into* a looming shadow, which is not what flies
do. Rather than quietly picking signs until the behaviour looked right, the pet turns
away from the side firing harder and the comment in `motor.ts` records that the
laterality is the model's and the sign convention is ours.

### The interface

The pet's HUD **is** [@rpgjs/ui-css](https://github.com/RSamaium/RPG-JS) (MIT), the UI
layer of RPG-JS, installed from npm and used as-is. Nothing about its CSS is rewritten:
the library is entirely driven by `--rpg-ui-*` custom properties, so `theme.css`
overrides colour and size tokens only, and the meadow palette falls out of that. Layout
lives in `pet.css` and is placement alone.

`.rpg-ui-hud`, `.rpg-ui-avatar`, `.rpg-ui-status-bar`, `.rpg-ui-glass-panel`,
`.rpg-ui-bar`, `.rpg-ui-dock`, `.rpg-ui-btn` and `.rpg-ui-fab` render the chrome. The
simulation stays imperative in `PetEngine`; React only draws the snapshot it emits.

The mapping is what makes it work, because the library's abstractions happen to fit a
brain:

| The library's idea | What it is here |
| --- | --- |
| `.rpg-ui-avatar` with a level chip | the fly, and the chip counts meals it has actually eaten (hidden at zero rather than reading "level 0") |
| `.rpg-ui-status-bar` ×2 | how fed it is and how startled it is |
| `.rpg-ui-bar[data-type]` in a panel | the seven descending neurons, each bar a live firing rate in Hz |
| `.rpg-ui-dock` slots | the stimulus palette — what you can put in the world |
| the library's `rpg-float` keyframe | a rate that just crossed threshold, thrown as a number with the neuron's name under it: `GIANT FIBER 194`, `MN9 165` |

An earlier pass built this look by hand in CSS and it was rejected, correctly: a
hand-rolled imitation of a component library is strictly worse than the library. A
crystal/cyan kit was tried before that and dropped for a different reason — glass and
cyan around a cartoon meadow reads as two products bolted together. The Explorer page's
palette was retinted onto this same warm ramp for exactly that reason; only its colour
variables changed, and the connectome's own region colours were left alone because they
encode data, not decoration.

One real bug came out of the integration: Vite's dependency optimizer pre-bundled the
library with its own copy of `react/jsx-runtime`, giving the app two React instances and
an `Invalid hook call`. `resolve.dedupe` plus an explicit `optimizeDeps.include` fixes
it. The package also has no `.` export, so the stylesheet is imported by its real path,
`@rpgjs/ui-css/index.css`.

And one design fix that outlived the styling: **the simulation no longer runs on
`requestAnimationFrame`.** rAF stops entirely when the page is not being painted, which
froze the fly and the whole HUD with it. The fly's life is on a timer now; only drawing
is tied to the paint schedule.

### The world

The pet lives in a three.js diorama, not on a 2-D grid. The props are **Quaternius's
Stylized Nature MegaKit** (CC0, via opengameart.org) loaded as glTF — 22 of its 68
models, textures downscaled from 2048 to 512 px, 1.9 MB in total.

The scale is the point. At a fly's size a clover is a canopy, a pebble is a boulder and
a blade of grass is a tree, so the arena's wall is a real kerb of stones with a skirt of
planting behind it rather than an invisible line. The stimulus tokens are props too, and
one of them is exact rather than decorative: **geosmin's token is a mushroom**, because
geosmin is the smell of mould.

The fly itself is procedural — there is no CC0 *Drosophila* — built from primitives with
real proportions: eyes taking most of the head, a banded abdomen, wings longer than the
body and held back at rest, six legs on a tripod gait. It is flat-shaded to sit in the
same style as the kit.

Three placement bugs are worth recording because each looked fine until the camera moved
through it: the wall was first laid out as an ellipse while the physics bounces off a
**rectangle**, so the fly walked into the scenery and buried the camera; the planting
skirt had the same ellipse problem and dropped grass inside the arena at the diagonals;
and the camera eased in from the origin, which is invisible at 60 fps and renders a black
frame when the page is only painted a few times.

Feel, in the order it matters: a contact shadow that shrinks as the fly takes off, squash
and stretch on the jump, a camera that lags behind and shakes when the Giant Fibers go
off, crumbs when it eats, and **poking the fly**, which is not a shortcut — a poke drives
the same 1,417 body bristles the Dust stimulus uses, so the grooming that follows comes
out of the connectome.

### The sound

Synthesised in WebAudio; there are no samples and nothing to license. The wing buzz sits
at **200 Hz because that is roughly a real Drosophila wingbeat**, and it only plays while
the fly is airborne — on the ground you hear footfalls, driven by the same leg phase the
renderer animates. The blips are triggered by the same threshold crossings that throw the
damage numbers, pitched per behaviour, so the sound is driven by the simulation rather
than laid over it.

### Architecture

The brain needs ~10,000 timesteps per second of fly time, which is more than a 60 fps
frame budget allows, so it runs in a **Web Worker**. The main thread sends stimulus
changes and receives spikes and smoothed readout rates. The world is clocked by the
*simulated* time the brain got through rather than by wall time, so body and brain stay
in lockstep at any speed and cannot drift apart when the frame rate dips.

Readout rates are smoothed in simulated time inside the worker. Per-message rates are
useless: a message can cover a single 0.1 ms step, where one spike from a two-neuron
readout reads as 10 kHz and trips every behavioural threshold on noise.

---

## The explorer

Vite + TypeScript + three.js, fully static, no backend.

- **138,639 neurons in one `THREE.Points` draw call** with a custom shader — not 138,639
  meshes.
- **Decay lives in the vertex shader.** Each neuron stores the simulation time of its
  last spike; brightness is `exp(-(now - last)/tau)` evaluated on the GPU. The CPU only
  ever writes the handful of neurons that fired this frame, so per-frame work is
  **O(active), not O(138,639)** — measured at **0.053 ms/frame** of JavaScript. Seeking
  backwards clears only the neurons that have actually fired since the last clear.
- Cascade edges are one `THREE.LineSegments`; an edge flashes when its presynaptic neuron
  fires, with alpha modulated by synaptic weight.
- Neurons are coloured by region, dim at rest, flaring to white-hot and growing on a
  spike, with an exponential tail — the tail is what makes it read as a brain rather than
  a string of blinking lights. Seeds stay amber throughout.
- Spike raster is a 2-D canvas, drawn once per experiment and blitted with a cursor.

Controls: drag to rotate, scroll to zoom, click to poke, `Space` play/pause, `R` reset,
`←`/`→` step one frame, drag the scrubber or the raster to seek.

**Guided tour** (top right) plays the sugar → proboscis story with captions timed off the
experiment's own numbers — the MN9 caption reads its firing time out of the data rather
than hard-coding it.

---

## Layout

```
bake/
  00..04_*.py      the explorer: annotations, neuron table, selection, simulation, export
  10..14_*.py      the pet: probes, subnetwork, and the two validations
  pet_groups.py    sensor / readout populations, expanded to full bilateral cell types
  common.py        paths, constants, binary writer, notebook parsing
  _sim_worker.py   one Brian2 run (whole brain or subnetwork), invoked per experiment
web/
  index.html       the explorer
  pet.html         the pet
  src/
    data.ts brain.ts player.ts raster.ts main.ts      explorer
    pet/ sim.ts     the LIF engine, verified against Brian2
    pet/ worker.ts  runs it off the UI thread
    pet/ sensors.ts stimuli -> Poisson drive, with laterality
    pet/ motor.ts   descending firing rates -> behaviour
    pet/ world.ts   the arena, and the fly's vector art
  pet/ _headless.ts  re-exports the above for the offline tuning harness
public/   -> web/public  (the baked data, at the path the brief names)
data/
  cache/  annotations, neuron table, subnetwork, Brian2 build dirs, validation runs
  raw/    one .npz of raw spikes per run (the resume checkpoints)
upstream/ the cloned fly-brain repo (not modified)
```

### Disk footprint

| Path | Size | Regenerable |
| --- | --- | --- |
| `upstream/` | 379 MB | clone |
| `data/cache/b2_build`, `data/cache/b2_smoke` | 591 MB each | **yes** — Brian2's generated C++ and its static arrays (15.1 M synapse weights as raw doubles). Safe to delete; the next run rebuilds in seconds |
| `data/raw/` | 9 MB | these are the resume checkpoints — deleting them means re-simulating |
| `data/cache/*.tsv`, `*.parquet` | 33 MB | yes, re-fetched/recomputed |
| `public/data/` | 31 MB | the deliverable (14 MB of it is the pet's subnetwork) |

To reclaim ~1.2 GB without losing any simulation results:

```bash
rm -rf data/cache/b2_build data/cache/b2_smoke
```

---

## Licences and terms

- Upstream model and connectome tables: **GPL-2.0-or-later**
  ([eonsystemspbc/fly-brain](https://github.com/eonsystemspbc/fly-brain)); the original
  Brian2 model is by Philip Shiu et al. `bake/` imports `model.py` rather than copying
  it. A fork of this project must keep that licence and attribution.
- Neuron annotations and coordinates: **CC-BY-4.0**, Schlegel et al. 2024,
  [flyconnectome/flywire_annotations](https://github.com/flyconnectome/flywire_annotations).
- FlyWire connectome data carries its own terms. This is a personal experiment; check
  [flywire.ai](https://flywire.ai) before deploying publicly or commercially.
- Interface components: [@rpgjs/ui-css](https://github.com/RSamaium/RPG-JS), **MIT**,
  installed from npm and used directly, retinted through its own CSS variables.
- 3-D props: **Stylized Nature MegaKit** by [Quaternius](https://quaternius.com),
  **CC0** — no attribution required, given here anyway.
