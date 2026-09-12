"""Whole-brain probe runs that define what the live pet's network has to cover.

The pet drives sensors bilaterally *and* one side at a time (that asymmetry is what
makes it turn), and at every intensity between nothing and full.  Every one of those
states has to be inside the subnetwork, so we probe them on the whole brain first and
let 11_subnet.py build its basis from the result.
"""
import json, subprocess, sys, time
from pathlib import Path
from common import CACHE, RAW, ROOT
import pet_groups

sensors, _ = pet_groups.build()
S = {s['id']: s for s in sensors}
py = str(ROOT / '.venv' / 'bin' / 'python')
tmp = CACHE / '_probe.json'
jobs = []


def job(name, parts):
    """parts: list of (sensor_id, side|'both', rate_scale)"""
    a, b = [], []
    ra = rb = 0
    for k, (sid, side, scale) in enumerate(parts):
        s = S[sid]
        idx = (s['idx'] if side == 'both'
               else s['sides'][side] + s['sides']['other'])
        if k == 0:
            a, ra = idx, round(s['rate_hz'] * scale)
        else:
            b, rb = idx, round(s['rate_hz'] * scale)
    jobs.append({'exp_id': f'probe-{name}', 'label': f'probe {name}', 'group': 'probe',
                 'seed_idx': [int(i) for i in a], 'rate_hz': ra,
                 'seed2_idx': [int(i) for i in b], 'rate2_hz': rb, 'note': ''})


for sid in S:
    job(f'{sid}-full', [(sid, 'both', 1.0)])
    job(f'{sid}-weak', [(sid, 'both', 0.35)])
    job(f'{sid}-left', [(sid, 'left', 1.0)])
    job(f'{sid}-right', [(sid, 'right', 1.0)])
job('sugar-bitter', [('sugar', 'both', 1.0), ('bitter', 'both', 1.0)])
job('loom-touch', [('looming', 'both', 1.0), ('touch', 'both', 1.0)])
job('sugar-loom', [('sugar', 'both', 1.0), ('looming', 'both', 1.0)])

json.dump(jobs, open(CACHE / 'probe_jobs.json', 'w'))   # 12_validate_subnet.py reads these
todo = [j for j in jobs if not (RAW / f'{j["exp_id"]}.npz').exists()]
print(f'[probe] {len(jobs)} probe conditions, {len(jobs)-len(todo)} cached, {len(todo)} to run')
t0 = time.time()
for n, j in enumerate(todo, 1):
    json.dump(j, open(tmp, 'w'))
    r = subprocess.run([py, '_sim_worker.py', str(tmp), str(RAW / f'{j["exp_id"]}.npz'),
                        str(CACHE / 'b2_build'), 'full', '12345'],
                       cwd=str(Path(__file__).parent), capture_output=True, text=True)
    if r.returncode:
        sys.exit(f'{j["exp_id"]} failed:\n{r.stderr[-1200:]}')
    print(f'  [{n:2d}/{len(todo)}] {r.stdout.strip().splitlines()[-1]}', flush=True)
print(f'[probe] {(time.time()-t0)/60:.1f} min')
