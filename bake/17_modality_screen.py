"""Screen the sensory modalities we have never driven.

The olfactory screen (16_odor_screen.py) found that odour cannot reach a behaviour in
this model at any drive or any synaptic weight.  This asks the same question of
everything else: photoreceptors, body bristles, foot and pharyngeal taste, humidity,
temperature, gut.  These are short reflex arcs, which is where the model is strong.

usage: 17_modality_screen.py [rate_hz]
"""
import json, subprocess, sys, time
import numpy as np
from pathlib import Path
from common import CACHE, ROOT, load_neurons, write_json
import pet_groups

RATE = int(sys.argv[1]) if len(sys.argv) > 1 else 200
OUT = CACHE / f'modality_screen_{RATE}'
OUT.mkdir(exist_ok=True)

neu = load_neurons()
ct = neu.cell_type.fillna('').to_numpy()
cls = neu.cell_class.fillna('').to_numpy()
_, readouts = pet_groups.build()
RO = {r['id']: np.array(r['idx']) for r in readouts}

def by_type(*names):
    return np.flatnonzero(np.isin(ct, names))

def by_prefix(*pre):
    return np.flatnonzero([any(t.startswith(p) for p in pre) for t in ct])

GROUPS = [
    ('R1-6 photoreceptors',  'vision',   by_type('R1-6')),
    ('R7 photoreceptors',    'vision',   by_type('R7')),
    ('R8 photoreceptors',    'vision',   by_type('R8')),
    ('Body bristles (BM)',   'touch',    by_prefix('BM')),
    ('Foot taste (claw)',    'taste',    by_type('claw_tpGRN')),
    ('Foot taste (dorsal)',  'taste',    by_type('dorsal_tpGRN')),
    ('Taste peg mechano',    'touch',    by_prefix('TPMN')),
    ('Labellar LB2',         'taste',    by_prefix('LB2')),
    ('Labellar LB4',         'taste',    by_prefix('LB4')),
    ('Pharyngeal taste',     'taste',    by_prefix('PhG')),
    ('Pharyngeal mechano',   'touch',    by_prefix('aPhM')),
    ('Leg/body ascending',   'body',     by_prefix('SA_')),
    ('Humidity dry (VP4)',   'hygro',    by_type('HRN_VP4')),
    ('Humidity moist',       'hygro',    by_type('HRN_VP1d', 'HRN_VP1l', 'HRN_VP5')),
    ('Cold (VP1m)',          'thermo',   by_type('TRN_VP1m')),
    ('Hot (VP2/VP3)',        'thermo',   by_type('TRN_VP2', 'TRN_VP3a', 'TRN_VP3b')),
    ('Gut (ENS)',            'enteric',  by_prefix('ENS')),
]
GROUPS = [(n, m, i) for n, m, i in GROUPS if len(i)]
print(f'[modality] {len(GROUPS)} groups @ {RATE} Hz\n')

py = str(ROOT / '.venv' / 'bin' / 'python')
tmp = OUT / '_e.json'
t0 = time.time()
rows = []
for k, (name, modality, idx) in enumerate(GROUPS, 1):
    slug = name.lower().replace(' ', '-').replace('/', '-').replace('(', '').replace(')', '')
    f = OUT / f'{slug}.npz'
    if not f.exists():
        json.dump({'exp_id': slug, 'label': name, 'group': modality, 'note': '',
                   'seed_idx': [int(i) for i in idx], 'rate_hz': RATE,
                   'seed2_idx': [], 'rate2_hz': 0}, open(tmp, 'w'))
        r = subprocess.run([py, '_sim_worker.py', str(tmp), str(f),
                            str(CACHE / 'b2_build'), 'full', '12345'],
                           cwd=str(Path(__file__).parent), capture_output=True, text=True)
        if r.returncode:
            print(f'  !! {name}: {r.stderr[-400:]}'); continue
        print(f'  [{k:2d}/{len(GROUPS)}] {r.stdout.strip().splitlines()[-1]}', flush=True)
    d = np.load(f)
    i = d['i']
    cnt = np.bincount(i, minlength=len(neu))
    first = np.full(len(neu), np.inf, np.float32)
    np.minimum.at(first, i, d['t'])
    row = {'name': name, 'modality': modality, 'n': int(len(idx)),
           'spikes': int(i.size), 'active': int(np.unique(i).size)}
    for rid, ridx in RO.items():
        row[rid] = int(cnt[ridx].sum())
        ft = first[ridx][np.isfinite(first[ridx])]
        row[rid + '_ms'] = round(float(ft.min() * 1000), 1) if ft.size else None
    rows.append(row)

write_json(CACHE / f'modality_screen_{RATE}.json', rows, indent=1)
ids = list(RO)
hdr = f'{"group":22s} {"n":>5s} {"active":>7s}  ' + ' '.join(f'{k[:5]:>6s}' for k in ids)
print('\n' + hdr + '\n' + '-' * len(hdr))
for r in sorted(rows, key=lambda r: -sum(r[k] for k in ids)):
    line = f'{r["name"]:22s} {r["n"]:5d} {r["active"]:7,}  '
    line += ' '.join(f'{r[k]:6d}' if r[k] else f'{chr(183):>6s}' for k in ids)
    print(line)
print(f'\n[modality] {(time.time()-t0)/60:.1f} min. Avalanche (~8,300 active) means the '
      f'input saturated the network and its identity was lost.')
