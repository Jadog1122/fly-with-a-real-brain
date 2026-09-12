"""Choose which neurons are pokeable and write the experiment list.

Poking a *cell type* rather than a lone neuron: one neuron at 200 Hz rarely drives
anything downstream past threshold, while a labelled type is both the biologically
meaningful unit and the one that produces a visible cascade.  Every member of a
selected type becomes clickable in the web app and plays that type's experiment.
"""
import json, pickle, re
import numpy as np, pandas as pd
from common import PATH_SEZ, CACHE, load_neurons, write_json, notebook_constants

nbc = notebook_constants()
print(f'[select] lifted {len(nbc)} constants from example.ipynb')
for k in ('sugar_GRNs', 'bitter_GRNs', 'LC_4s', 'Or56a', 'all_JOs'):
    print(f'          {k:12s} {len(nbc.get(k, []))}')

neu = load_neurons()
fly2i = {int(f): i for i, f in enumerate(neu.flywire_id.to_numpy())}

def idx(flyids):
    return sorted({fly2i[int(f)] for f in np.atleast_1d(flyids) if int(f) in fly2i})

exps, seen_key, seen_id = [], set(), set()

def slug(label):
    """Stable id derived from the label, so re-running selection keeps finished runs."""
    s = re.sub(r'[^a-z0-9]+', '-', label.lower()).strip('-')
    base, k = s, 2
    while s in seen_id:
        s = f'{base}-{k}'; k += 1
    seen_id.add(s)
    return s

def add(label, group, seeds, rate=200, seeds2=None, rate2=0, note=''):
    si = idx(seeds)
    if len(si) < 1:
        print(f'          ! skip {label}: no seeds resolve'); return
    key = (tuple(si), rate, tuple(idx(seeds2 or [])), rate2)
    if key in seen_key:
        return
    seen_key.add(key)
    exps.append({'exp_id': slug(label), 'label': label, 'group': group,
                 'seed_idx': si, 'rate_hz': rate,
                 'seed2_idx': idx(seeds2 or []), 'rate2_hz': rate2, 'note': note})

# --------------------------------------------------------- A. canonical pathways
add('Sugar GRNs', 'taste', nbc['sugar_GRNs'], 200,
    note='Labellar sugar-sensing gustatory receptor neurons. Shiu et al. report that '
         'driving these makes the MN9 proboscis motor neurons fire - the fly sticks out its tongue.')
add('Bitter GRNs', 'taste', nbc['bitter_GRNs'], 200,
    note='Bitter-sensing gustatory receptor neurons: aversive taste, suppresses feeding.')
add('Sugar + bitter GRNs', 'taste', nbc['sugar_GRNs'], 200, nbc['bitter_GRNs'], 200,
    note='Both taste channels at once. Bitter input gates the sugar-driven proboscis response.')
add('LC4 looming detectors', 'vision', nbc['LC_4s'], 200,
    note='Lobula columnar type 4 cells, the looming-sensitive visual projection neurons '
         'that feed the Giant Fiber escape pathway.')
add('Or56a olfactory (geosmin)', 'olfaction', nbc['Or56a'], 250,
    note='Or56a receptor neurons detect geosmin, a mould marker. Aversive: drives avoidance.')
add('Johnston organ (all)', 'mechanosensory', nbc['all_JOs'], 300,
    note="Johnston's organ neurons in the antenna: vibration and touch, trigger grooming.")
for sub in ('JO_EV', 'JO_EDM', 'JO_CA', 'JO_EVP'):
    if sub in nbc:
        add(f'Johnston organ {sub[3:]}', 'mechanosensory', nbc[sub], 300,
            note=f'{sub} subtype of Johnston organ mechanosensory neurons.')

named = {
    'P9 (forward walking)': (['P9_left', 'P9_right'], 100, 'locomotion',
                             'P9 descending neurons command forward walking.'),
    'P9-oDN1': (['P9_oDN1_left', 'P9_oDN1_right'], 100, 'locomotion', 'Forward velocity descending pair.'),
    'DNa01 (turning)': (['DNa01_left', 'DNa01_right'], 200, 'locomotion', 'Steering descending neurons.'),
    'DNa02 (turning)': (['DNa02_left', 'DNa02_right'], 200, 'locomotion', 'Steering descending neurons.'),
    'MDN (backward walking)': (['MDN_1', 'MDN_2', 'MDN_3', 'MDN_4'], 200, 'locomotion',
                               'Moonwalker descending neurons: backward walking and escape.'),
    'Giant Fiber (escape)': (['Giant_Fiber_1', 'Giant_Fiber_2'], 200, 'escape',
                             'The Giant Fibers trigger the fly’s fastest escape takeoff.'),
    'MN9 (proboscis motor)': (['MN9_left', 'MN9_right'], 200, 'feeding',
                              'Motor neuron 9 extends the proboscis - the output of the feeding circuit.'),
    'aDN1 (antennal grooming)': (['aDN1_left', 'aDN1_right'], 200, 'grooming',
                                 'Descending neurons for antennal grooming.'),
}
for label, (names, rate, grp, note) in named.items():
    ids = [nbc[n] for n in names if n in nbc]
    if ids:
        add(label, grp, ids, rate, note=note)

n_curated = len(exps)
print(f'[select] {n_curated} curated experiments from the paper notebook')

# ----------------------------------------------------------- B. named SEZ cell types
sez = pickle.load(open(PATH_SEZ, 'rb'))
out_deg = neu.out_deg.to_numpy()
sez_rank = sorted(((sum(out_deg[i] for i in idx(v)), k, v) for k, v in sez.items()), reverse=True)
for tot, name, ids in sez_rank[:14]:
    add(f'SEZ {name}', 'sez', ids, 200,
        note=f'{name}: a subesophageal-zone cell type from the feeding circuit '
             f'({len(idx(ids))} neurons, {tot} downstream partners).')
print(f'[select] +{len(exps)-n_curated} SEZ cell types')

# ------------------------------------------- C. high-fanout annotated types, region spread
n_sez = len(exps)
used = {i for e in exps for i in e['seed_idx']}
typed = neu[neu.cell_type != '']
grp = typed.groupby('cell_type')
cand = pd.DataFrame({'n': grp.size(), 'out': grp.out_deg.sum(),
                     'region': grp.region_name.agg(lambda s: s.mode().iat[0]),
                     'ach': grp.nt.agg(lambda s: (s == 'acetylcholine').mean())})
cand = cand[(cand.n >= 2) & (cand.n <= 250)]
n_all = len(cand)
cand = cand[cand.ach >= 0.6].sort_values('out', ascending=False)
print(f'[select] {len(cand)}/{n_all} candidate types are predominantly cholinergic '
      f'(excitatory); GABA/glutamate types only silence their targets')

QUOTA = {'optic': 4, 'visual_projection': 4, 'central': 8, 'mushroom_body': 2,
         'central_complex': 3, 'olfactory': 3, 'gustatory': 2, 'mechanosensory': 3,
         'ascending': 3, 'descending': 3}
type_members = {t: g.index.to_list() for t, g in neu[neu.cell_type != ''].groupby('cell_type')}
for ctype, row in cand.iterrows():
    if QUOTA.get(row.region, 0) <= 0:
        continue
    mem = type_members[ctype]
    if len(used.intersection(mem)) > len(mem) * .5:        # already covered by a curated group
        continue
    QUOTA[row.region] -= 1
    used.update(mem)
    add(f'{ctype}', row.region, neu.flywire_id.to_numpy()[mem], 200,
        note=f'Cell type {ctype} ({row.region.replace("_", " ")}, {row.n} neurons, '
             f'{int(row.out)} downstream partners).')
print(f'[select] +{len(exps)-n_sez} high-fanout annotated cell types')

for e in exps:
    e['n_seed'] = len(e['seed_idx']) + len(e['seed2_idx'])
sz = write_json(CACHE / 'experiments_todo.json', exps, indent=1)
print(f'[select] {len(exps)} experiments -> {CACHE/"experiments_todo.json"} ({sz/1024:.0f} KB)')
print(f'[select] {len({i for e in exps for i in e["seed_idx"]+e["seed2_idx"]})} neurons become clickable')
for g in sorted({e['group'] for e in exps}):
    print(f'          {g:18s} {sum(1 for e in exps if e["group"]==g)}')
