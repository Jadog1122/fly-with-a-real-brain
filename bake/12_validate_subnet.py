"""Does the reduced network still behave like the whole brain?

For each test stimulus we run three extra simulations:
  full  / rng 999    - the noise floor, since the Poisson drive is stochastic
  subnet/ rng 12345  - the reduction, same seed as the stored reference
  subnet/ rng 999
and compare everything against the stored whole-brain reference (full / rng 12345).
A reduction is acceptable when it sits inside the run-to-run noise of the full model.
"""
import json, subprocess, sys, time
import numpy as np
from pathlib import Path
from common import CACHE, RAW, ROOT, load_neurons, notebook_named_ids

# the paper's own stimuli, plus the conditions the live pet actually drives
TESTS = ['sugar-grns', 'lc4-looming-detectors', 'johnston-organ-all',
         'probe-sugar-full', 'probe-sugar-left', 'probe-looming-left',
         'probe-odor-full', 'probe-touch-full', 'probe-sugar-loom']

VAL = CACHE / 'val'; VAL.mkdir(exist_ok=True)
py = str(ROOT / '.venv' / 'bin' / 'python')
todo = {e['exp_id']: e for e in json.load(open(CACHE / 'experiments_todo.json'))}
if (CACHE / 'probe_jobs.json').exists():
    todo.update({j['exp_id']: j for j in json.load(open(CACHE / 'probe_jobs.json'))})
sub = np.load(CACHE / 'subnet.npz')
members = sub['members']
neu = load_neurons()
N = len(neu)
local = np.full(N, -1, np.int64); local[members] = np.arange(len(members))
fly2i = {int(f): i for i, f in enumerate(neu.flywire_id.to_numpy())}
READOUT = {fly2i[f]: n for f, n in notebook_named_ids().items() if f in fly2i}


def run(exp, tag, net, rng):
    out = VAL / f'{exp["exp_id"]}.{tag}.npz'
    if out.exists():
        return out
    tmp = VAL / '_e.json'; json.dump(exp, open(tmp, 'w'))
    r = subprocess.run([py, '_sim_worker.py', str(tmp), str(out),
                        str(CACHE / ('b2_val_' + net)), net, str(rng)],
                       cwd=str(Path(__file__).parent), capture_output=True, text=True)
    if r.returncode:
        sys.exit(f'{exp["exp_id"]} {tag} failed:\n{r.stderr[-1500:]}')
    return out


def load(p, net):
    """Spike counts per neuron, in whole-brain index space."""
    d = np.load(p)
    i = d['i'].astype(np.int64)
    if net == 'subnet':
        i = members[i]
    c = np.bincount(i, minlength=N)
    first = np.full(N, np.inf)
    np.minimum.at(first, i, d['t'])
    return c, first, int(d['i'].size)


def compare(a, b):
    """(counts, first, total) pairs -> agreement metrics, restricted to subnet members."""
    ca, fa, ta = a; cb, fb, tb = b
    sa, sb = ca[members], cb[members]
    both = (sa > 0) & (sb > 0)
    either = (sa > 0) | (sb > 0)
    r = np.corrcoef(sa, sb)[0, 1] if sa.std() and sb.std() else float('nan')
    return {
        'spikes': f'{ta:,} vs {tb:,}',
        'spike_ratio': round(tb / max(ta, 1), 3),
        'active_jaccard': round(both.sum() / max(either.sum(), 1), 3),
        'rate_corr': round(float(r), 3),
    }


print(f'[validate] subnet = {len(members):,} neurons; testing {len(TESTS)} stimuli\n')
t0 = time.time()
rows = []
for eid in TESTS:
    exp = todo[eid]
    ref = load(RAW / f'{eid}.npz', 'full')
    noise = load(run(exp, 'full999', 'full', 999), 'full')
    s1 = load(run(exp, 'sub12345', 'subnet', 12345), 'subnet')
    s2 = load(run(exp, 'sub999', 'subnet', 999), 'subnet')
    rows.append((exp['label'], compare(ref, noise), compare(ref, s1), compare(ref, s2)))
    print(f'  {exp["label"]}')
    for tag, m in (('full, other seed (noise floor)', rows[-1][1]),
                   ('subnet, same seed          ', rows[-1][2]),
                   ('subnet, other seed         ', rows[-1][3])):
        print(f'    {tag}  spikes {m["spikes"]:>22s}  ratio {m["spike_ratio"]:<6} '
              f'jaccard {m["active_jaccard"]:<6} rate r {m["rate_corr"]}')

    # do the named readouts still fire, and when?
    ro = []
    for idx, nm in READOUT.items():
        cr, cs = ref[0][idx], s1[0][idx]
        if cr or cs:
            ro.append(f'{nm} {cr}->{cs} ({ref[1][idx]*1000:.0f}->{s1[1][idx]*1000:.0f}ms)'
                      if cr and cs else f'{nm} {cr}->{cs}')
    print(f'    readouts: {"; ".join(ro) if ro else "none fire in either"}\n')

print(f'[validate] {time.time()-t0:.0f}s')
