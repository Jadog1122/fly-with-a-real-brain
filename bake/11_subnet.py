"""Extract the simulable subnetwork the browser will run live.

Keeps every neuron that (a) fired in any baked whole-brain run, or (b) could ever be
an input or a readout: all sensory, ascending, descending, motor, endocrine and visual
projection cells.  Emits CSR in subnet-local indices plus the browser payload.

Fidelity of this reduction is not assumed - 12_validate_subnet.py measures it against
the whole-brain Brian2 reference runs.
"""
import numpy as np
from pathlib import Path
from common import CACHE, RAW, WEBDATA, load_neurons, load_edges, write_bin

KEEP_CLASSES = ['sensory', 'sensory_ascending', 'descending', 'motor',
                'ascending', 'endocrine', 'visual_projection']

neu = load_neurons()
N = len(neu)
sup = neu.super_class.to_numpy()

ever = np.zeros(N, bool)
runs = sorted(RAW.glob('*.npz'))
for f in runs:
    ever[np.load(f)['i']] = True
inS = ever | np.isin(sup, KEEP_CLASSES)
members = np.flatnonzero(inS)
M = len(members)
print(f'[subnet] {ever.sum():,} ever fired across {len(runs)} whole-brain runs')
print(f'[subnet] + {np.isin(sup, KEEP_CLASSES).sum():,} possible inputs/readouts '
      f'-> {M:,} neurons ({100*M/N:.1f}% of the brain)')
assert M < 65536, f'{M} neurons will not fit a uint16 target index'

local = np.full(N, -1, np.int32)
local[members] = np.arange(M, dtype=np.int32)

pre, post, w = load_edges()
m = inS[pre] & inS[post]
lp, lq, lw = local[pre[m]], local[post[m]], w[m]
del pre, post, w, m
print(f'[subnet] {len(lp):,} synapses, {100*(lw<0).mean():.1f}% inhibitory')

# CSR by presynaptic neuron - the order the simulator walks it
order = np.argsort(lp, kind='stable')
lp, lq, lw = lp[order], lq[order], lw[order]
row = np.searchsorted(lp, np.arange(M + 1)).astype(np.uint32)
assert np.abs(lw).max() < 32767

np.savez_compressed(CACHE / 'subnet.npz', members=members.astype(np.int32),
                    row=row, tgt=lq.astype(np.uint16), w=lw.astype(np.int16))
print(f'[subnet] cached {CACHE/"subnet.npz"} '
      f'({(CACHE/"subnet.npz").stat().st_size/1e6:.1f} MB compressed)')

sz = write_bin(WEBDATA / 'subnet.bin', b'FLYS', {
    'n': int(M), 'n_syn': int(len(lp)), 'n_full': int(N),
    'note': 'CSR by presynaptic neuron; indices are subnet-local, map through `members`',
}, [
    ('members', members.astype(np.uint32)),   # subnet index -> index in neurons.bin
    ('row', row),
    ('tgt', lq.astype(np.uint16)),
    ('w', lw.astype(np.int16)),
])
print(f'[subnet] wrote {WEBDATA/"subnet.bin"} ({sz/1e6:.1f} MB)')
import gzip
print(f'[subnet] ~{len(gzip.compress(open(WEBDATA/"subnet.bin","rb").read(), 6))/1e6:.1f} MB gzipped '
      f'(what the browser actually downloads)')
