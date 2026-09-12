"""Run one activation experiment and dump raw spikes.  Invoked by 03_run.py.

usage: _sim_worker.py <exp.json> <out.npz> <build_dir> [full|subnet] [rng_seed]

`subnet` runs the reduced network from 10_subnet.py instead of the whole brain, which
is what 11_validate_subnet.py compares against the whole-brain reference.
"""
import json, sys, time
from pathlib import Path
import numpy as np, pandas as pd
from brian2 import (NeuronGroup, Synapses, PoissonGroup, SpikeMonitor, Network,
                    prefs, set_device, seed as b2seed, mV, ms, Hz, second)
from common import PATH_COMP, PATH_CON, T_RUN_S, UPSTREAM, CACHE

sys.path.insert(0, str(UPSTREAM / 'code' / 'paper-phil-drosophila'))
from model import default_params as P          # upstream GPL-2.0 model constants

exp = json.load(open(sys.argv[1]))
out = Path(sys.argv[2])
build = sys.argv[3]
NET = sys.argv[4] if len(sys.argv) > 4 else 'full'
RNG = int(sys.argv[5]) if len(sys.argv) > 5 else 12345
# Scale the model's single global synaptic weight.  Shiu et al. tuned w_syn once, on a
# handful of pathways; this exists to test whether that one number is what makes the
# olfactory circuits run away.  1.0 is the published value.
WSCALE = float(sys.argv[6]) if len(sys.argv) > 6 else 1.0
# Optional: zero the outgoing synapses of a set of neurons, the same way the upstream
# model's silence() does.  Used to test whether the mushroom body is what ignites.
SILENCE = sys.argv[7] if len(sys.argv) > 7 else ''

prefs.devices.cpp_standalone.openmp_threads = 0     # macOS clang has no OpenMP
set_device('cpp_standalone', directory=build)
b2seed(RNG)

t0 = time.time()
if NET == 'subnet':
    sub = np.load(CACHE / 'subnet.npz')
    members, row, tgt, wgt = sub['members'], sub['row'], sub['tgt'], sub['w']
    N = len(members)
    local = np.full(len(pd.read_csv(PATH_COMP, index_col=0)), -1, np.int64)
    local[members] = np.arange(N)
    syn_i = np.repeat(np.arange(N, dtype=np.int64), np.diff(row))
    syn_j = tgt.astype(np.int64)
    syn_w = wgt.astype(np.float64)
    exp = {**exp,
           'seed_idx': [int(local[i]) for i in exp['seed_idx'] if local[i] >= 0],
           'seed2_idx': [int(local[i]) for i in exp['seed2_idx'] if local[i] >= 0]}
else:
    comp = pd.read_csv(PATH_COMP, index_col=0)
    con = pd.read_parquet(PATH_CON, columns=['Presynaptic_Index', 'Postsynaptic_Index',
                                             'Excitatory x Connectivity'])
    N = len(comp)
    syn_i = con['Presynaptic_Index'].to_numpy()
    syn_j = con['Postsynaptic_Index'].to_numpy()
    syn_w = con['Excitatory x Connectivity'].to_numpy()
    del con

neu = NeuronGroup(N, model=P['eqs'], method='linear', threshold=P['eq_th'],
                  reset=P['eq_rst'], refractory='rfc', name='neu', namespace=P)
neu.v, neu.g = P['v_0'], 0

# upstream poi() zeroes the refractory period of every externally driven neuron
seeds = np.array(exp['seed_idx'] + exp['seed2_idx'], np.int64)
rfc = np.full(N, float(P['t_rfc']))
rfc[seeds] = 0.0
neu.rfc = rfc * second

syn = Synapses(neu, neu, 'w : volt', on_pre='g += w', delay=P['t_dly'], name='syn')
syn.connect(i=syn_i, j=syn_j)
if SILENCE:
    import pandas as _pd
    _n = _pd.read_parquet(CACHE / 'neurons.parquet')
    _mask = _n.cell_class.fillna('').str.contains(SILENCE).to_numpy()
    if NET == 'subnet':
        _mask = _mask[members]
    syn_w = np.where(_mask[syn_i], 0.0, syn_w)
    print(f'  silenced {_mask.sum()} neurons matching "{SILENCE}"')
syn.w = syn_w * (P['w_syn'] * WSCALE)

# Equivalent of the upstream per-neuron PoissonInput(N=1, target_var='v'): a Poisson
# process adding w_syn*f_poi straight to v.  Expressed as one fixed-size group so the
# network topology is identical for every experiment.
rates = np.zeros(N)
rates[exp['seed_idx']] = exp['rate_hz']
rates[exp['seed2_idx']] = exp['rate2_hz']
pg = PoissonGroup(N, rates=rates * Hz, name='pg')
psyn = Synapses(pg, neu, on_pre='v_post += w_poi', name='psyn',
                namespace={'w_poi': P['w_syn'] * P['f_poi']})
psyn.connect(j='i')

mon = SpikeMonitor(neu)
net = Network(neu, syn, pg, psyn, mon)
t_build = time.time() - t0
net.run(T_RUN_S * second)

i = np.asarray(mon.i, np.int32)
t = np.asarray(mon.t / second, np.float32)
out.parent.mkdir(parents=True, exist_ok=True)
np.savez_compressed(out, i=i, t=t, seed=seeds.astype(np.int32),
                    meta=np.frombuffer(json.dumps(
                        {**{k: exp[k] for k in ('exp_id', 'label', 'group', 'rate_hz', 'rate2_hz')},
                         't_run': T_RUN_S, 'n_spikes': int(i.size), 'net': NET, 'rng': RNG,
                         'w_scale': WSCALE,
                         'n_active': int(np.unique(i).size)}).encode(), np.uint8))
print(f'  {exp["exp_id"]} {exp["label"][:34]:34s} build={t_build:4.1f}s '
      f'total={time.time()-t0:5.1f}s spikes={i.size:7d} active={np.unique(i).size:6d}')
