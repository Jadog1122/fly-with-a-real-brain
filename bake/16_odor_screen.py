"""Drive every olfactory glomerulus in turn and see which motor commands it reaches.

The fly has 53 receptor channels in this connectome and we had wired up exactly one
(DA2, geosmin).  This activates each one on the whole brain and records what the named
descending neurons do, which is the map you need before you can ask whether any odour
can produce approach.

Resumable: finished runs are skipped.
"""
import json, subprocess, sys, time
import numpy as np
from pathlib import Path
from common import CACHE, RAW, ROOT, load_neurons, write_json
import pet_groups

# Rate matters more than anything else here: at 250 Hz every glomerulus drives the
# network into the same saturating avalanche and the odour's identity is washed out.
# Pass a rate on the command line to screen below that threshold.
RATE_HZ = int(sys.argv[1]) if len(sys.argv) > 1 else 250
ONLY = sys.argv[2].split(',') if len(sys.argv) > 2 else None
OUT = CACHE / f'odor_screen_{RATE_HZ}'
OUT.mkdir(exist_ok=True)

neu = load_neurons()
ctype = neu.cell_type.to_numpy()
_, readouts = pet_groups.build()
RO = {r['id']: (r['label'], np.array(r['idx'])) for r in readouts}

glom = sorted({t[4:] for t in ctype if isinstance(t, str) and t.startswith('ORN_')})
print(f'[odor] {len(glom)} glomeruli found')

py = str(ROOT / '.venv' / 'bin' / 'python')
tmp = OUT / '_e.json'
if ONLY:
    glom = [g for g in glom if g in ONLY]
todo = [g for g in glom if not (OUT / f'{g}.npz').exists()]
print(f'[odor] {len(glom) - len(todo)} cached, {len(todo)} to run @ {RATE_HZ} Hz\n')

t0 = time.time()
for n, g in enumerate(todo, 1):
    idx = [int(i) for i in np.flatnonzero(ctype == f'ORN_{g}')]
    job = {'exp_id': f'orn-{g}', 'label': f'ORN {g}', 'group': 'odor', 'note': '',
           'seed_idx': idx, 'rate_hz': RATE_HZ, 'seed2_idx': [], 'rate2_hz': 0}
    json.dump(job, open(tmp, 'w'))
    r = subprocess.run([py, '_sim_worker.py', str(tmp), str(OUT / f'{g}.npz'),
                        str(CACHE / 'b2_build'), 'full', '12345'],
                       cwd=str(Path(__file__).parent), capture_output=True, text=True)
    if r.returncode:
        print(f'  !! {g} failed: {r.stderr[-400:]}')
        continue
    eta = (time.time() - t0) / n * (len(todo) - n)
    print(f'  [{n:2d}/{len(todo)}] {r.stdout.strip().splitlines()[-1]}  eta {eta/60:.1f}m',
          flush=True)

# ------------------------------------------------------------------- the table
rows = []
for g in glom:
    f = OUT / f'{g}.npz'
    if not f.exists():
        continue
    d = np.load(f)
    i = d['i']
    cnt = np.bincount(i, minlength=len(neu))
    first = np.full(len(neu), np.inf, np.float32)
    np.minimum.at(first, i, d['t'])
    row = {'glomerulus': g, 'n_orn': int(d['seed'].size),
           'spikes': int(i.size), 'active': int(np.unique(i).size)}
    for rid, (_, ridx) in RO.items():
        row[rid] = int(cnt[ridx].sum())
        ft = first[ridx][np.isfinite(first[ridx])]
        row[rid + '_ms'] = round(float(ft.min() * 1000), 1) if ft.size else None
    rows.append(row)

write_json(CACHE / f'odor_screen_{RATE_HZ}.json', rows, indent=1)
ids = list(RO)
hdr = f'{"glom":8s} {"ORNs":>5s} {"active":>7s} ' + ' '.join(f'{k[:5]:>6s}' for k in ids)
print('\n' + hdr)
print('-' * len(hdr))
for r in sorted(rows, key=lambda r: -sum(r[k] for k in ids)):
    line = f'{r["glomerulus"]:8s} {r["n_orn"]:5d} {r["active"]:7,} '
    line += ' '.join(f'{r[k]:6d}' if r[k] else f'{"·":>6s}' for k in ids)
    print(line)
print(f'\n[odor] {len(rows)} glomeruli @ {RATE_HZ} Hz, {(time.time()-t0)/60:.1f} min')
print(f'[odor] readouts: {", ".join(f"{k}={v[0]}" for k, v in RO.items())}')
