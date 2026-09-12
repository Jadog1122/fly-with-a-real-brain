"""Sensor and readout populations for the live pet, in whole-brain indices.

The upstream notebook's ID lists are partly unilateral (its sugar set is 23 left-side
LB3 cells out of 122 in the brain).  A pet needs both sides - that asymmetry is what
makes it turn away from a threat - so each group is expanded to the full bilateral
population of the cell types the notebook used.
"""
import collections
import numpy as np
from common import load_neurons, notebook_constants, notebook_named_ids

# (id, label, modality, source, drive rate, blurb)
# `source` is either ('notebook', <list name>) - expanded to the full bilateral
# population of the cell types that list uses - or ('types', <cell type names>).
#
# Every group here was screened on the whole brain first (16_odor_screen.py,
# 17_modality_screen.py) and kept only if it drives a *specific* descending readout
# without tipping the network into its saturating ~8,300-neuron avalanche.  The one
# exception is `odor`, kept deliberately as a visible example of that failure.
SENSORS = [
    ('sugar',   'Sugar',      'taste',          ('notebook', 'sugar_GRNs'),  200,
     'Labellar sugar receptors (LB3). Drive them and the proboscis comes out.'),
    ('foot',    'Foot taste', 'taste',          ('types', ['dorsal_tpGRN']), 200,
     'Tarsal taste neurons. A fly tastes sugar with its feet first - touch sugar to a '
     'foot and the proboscis extends. 11 neurons, and they are enough.'),
    ('bitter',  'Bitter',     'taste',          ('notebook', 'bitter_GRNs'), 200,
     'Bitter receptors. Aversive - they shut feeding down.'),
    ('looming', 'Looming',    'vision',         ('notebook', 'LC_4s'),       200,
     'LC4 looming detectors. They feed the Giant Fiber escape pathway.'),
    ('touch',   'Vibration',  'mechanosensory', ('notebook', 'all_JOs'),     300,
     "Johnston's organ in the antenna. Vibration and touch; triggers grooming."),
    ('bristle', 'Dust',       'mechanosensory', ('types', ['BM']),           200,
     'Bristle mechanoreceptors all over the body. The strongest grooming signal '
     'anywhere in this model.'),
    ('odor',    'Geosmin',    'olfaction',      ('notebook', 'Or56a'),       250,
     'KEPT AS A KNOWN ARTIFACT. Any olfactory input tips this model into a whole-brain '
     'runaway whose fixed output is steering, so the turn you see is not a smell '
     'response. Screened across all 53 glomeruli at four drives and four synaptic '
     'weights: no setting produces odour-specific behaviour.'),
]

READOUTS = [
    ('forward',   'Forward walk',     'P9',          'P9 descending neurons: forward velocity.'),
    ('turn_a',    'Steering DNa01',   'DNa01',       'DNa01 steering pair.'),
    ('turn_b',    'Steering DNa02',   'DNa02',       'DNa02 steering pair.'),
    ('backward',  'Backward walk',    'MDN',         'Moonwalker descending neurons.'),
    ('escape',    'Escape jump',      'Giant_Fiber', 'The Giant Fibers: fastest escape takeoff.'),
    ('proboscis', 'Proboscis out',    'MN9',         'MN9 proboscis extension - eating.'),
    ('groom',     'Antennal groom',   'aDN1',        'aDN1 antennal grooming.'),
]


def build():
    """-> (sensors, readouts) with whole-brain indices, split left/right."""
    neu = load_neurons()
    fly = neu.flywire_id.to_numpy()
    ctype = neu.cell_type.to_numpy()
    side = neu.side.to_numpy()
    f2i = {int(f): i for i, f in enumerate(fly)}
    nbc = notebook_constants()
    named = notebook_named_ids()

    def split(idxs):
        out = {'left': [], 'right': [], 'other': []}
        for i in idxs:
            out[side[i] if side[i] in ('left', 'right') else 'other'].append(int(i))
        return out

    # A cell type belongs to a sensor if the notebook's list covers a real share of
    # that type's whole-brain population, or makes up a real share of the list itself.
    # Coverage is the discriminating test: the Or56a list contains one stray ORN_VA1d
    # out of 97 in the brain, and expanding on that would add a whole wrong glomerulus.
    MIN_COVERAGE, MIN_SHARE = 0.15, 0.10

    sensors = []
    for sid, label, modality, source, rate, note in SENSORS:
        kind, arg = source
        if kind == 'types':
            full = sorted(np.flatnonzero([any(t.startswith(a) for a in arg) for t in ctype]))
            sensors.append({'id': sid, 'label': label, 'modality': modality, 'rate_hz': rate,
                            'note': note, 'cell_types': sorted({ctype[i] for i in full}),
                            'idx': [int(i) for i in full], 'sides': split(full),
                            'n_notebook': len(full)})
            continue
        seed = [f2i[int(f)] for f in nbc[arg] if int(f) in f2i]
        hits = collections.Counter(t for t in (ctype[i] for i in seed) if t)
        types, dropped = [], []
        for t, c in hits.items():
            whole = int((ctype == t).sum())
            (types if (c / max(whole, 1) >= MIN_COVERAGE or c / len(seed) >= MIN_SHARE)
             else dropped).append((t, c, whole))
        if dropped:
            print(f'  [{sid}] dropped as contamination: ' +
                  ', '.join(f'{t} ({c}/{w} in brain)' for t, c, w in dropped))
        keep = sorted(t for t, _, _ in types)
        full = sorted(np.flatnonzero(np.isin(ctype, keep))) if keep else sorted(seed)
        sensors.append({'id': sid, 'label': label, 'modality': modality, 'rate_hz': rate,
                        'note': note, 'cell_types': keep,
                        'idx': [int(i) for i in full], 'sides': split(full),
                        'n_notebook': len(seed)})

    readouts = []
    for rid, label, prefix, note in READOUTS:
        idxs = sorted(f2i[f] for f, n in named.items() if n.startswith(prefix) and f in f2i)
        readouts.append({'id': rid, 'label': label, 'note': note,
                         'idx': idxs, 'sides': split(idxs),
                         'names': {int(i): named[int(fly[i])] for i in idxs}})
    return sensors, readouts


if __name__ == '__main__':
    s, r = build()
    print('sensor     notebook -> bilateral   L / R / C   cell types')
    for g in s:
        sd = g['sides']
        print(f"  {g['id']:9s} {g['n_notebook']:4d} -> {len(g['idx']):4d}   "
              f"{len(sd['left']):3d}/{len(sd['right']):3d}/{len(sd['other']):3d}   "
              f"{','.join(g['cell_types'][:4])}{'...' if len(g['cell_types'])>4 else ''}")
    print('\nreadout    neurons   L / R')
    for g in r:
        sd = g['sides']
        print(f"  {g['id']:10s} {len(g['idx']):4d}   {len(sd['left'])}/{len(sd['right'])}   "
              f"{','.join(sorted(g['names'].values()))[:60]}")
