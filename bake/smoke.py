"""Stage 1 smoke test: one real whole-brain run, save spikes, plot raster."""
import time, sys, pickle, json
from pathlib import Path
import numpy as np, pandas as pd
from brian2 import (NeuronGroup, Synapses, PoissonGroup, SpikeMonitor, Network,
                    prefs, set_device, device, mV, ms, Hz, second, defaultclock)

ROOT = Path(__file__).resolve().parent.parent
UP   = ROOT / 'upstream'
sys.path.insert(0, str(UP / 'code' / 'paper-phil-drosophila'))
from model import default_params as P            # noqa: E402  (upstream GPL-2.0 code)

MODE = sys.argv[1] if len(sys.argv) > 1 else 'standalone'
T_RUN = float(sys.argv[2]) if len(sys.argv) > 2 else 0.1      # seconds

if MODE == 'standalone':
    prefs.devices.cpp_standalone.openmp_threads = 0
    set_device('cpp_standalone', directory=str(ROOT / 'data' / 'cache' / 'b2_smoke'))

t0 = time.time()
df_comp = pd.read_csv(UP / 'data' / '2025_Completeness_783.csv', index_col=0)
con = pd.read_parquet(UP / 'data' / '2025_Connectivity_783.parquet',
                      columns=['Presynaptic_Index', 'Postsynaptic_Index', 'Excitatory x Connectivity'])
print(f'[load ] {time.time()-t0:6.1f}s  neurons={len(df_comp)}  edges={len(con)}')

N = len(df_comp)
flyid2i = {int(f): i for i, f in enumerate(df_comp.index)}

# --- sugar GRNs from the upstream example notebook (Shiu et al.) ---
sugar = [720575940616885538,720575940630233916,720575940639332736,720575940632889389,720575940617000768,
         720575940632425919,720575940637568838,720575940629176663,720575940621502051,720575940638202345,
         720575940612670570,720575940611875570,720575940621754367,720575940633143833,720575940613601698,
         720575940630797113,720575940639198653,720575940639259967,720575940624963786,720575940640649691,
         720575940610788069,720575940623172843,720575940628853239]
seed_idx = np.array([flyid2i[s] for s in sugar], dtype=np.int64)
print(f'[seed ] {len(seed_idx)} sugar GRNs mapped')

t1 = time.time()
P['t_run'] = T_RUN * second
neu = NeuronGroup(N, model=P['eqs'], method='linear', threshold=P['eq_th'], reset=P['eq_rst'],
                  refractory='rfc', name='neu', namespace=P)
neu.v, neu.g = P['v_0'], 0
# upstream poi() zeroes the refractory period of excited neurons; standalone mode
# cannot take an index-array assignment, so set the whole vector at once
rfc = np.full(N, float(P['t_rfc']))
rfc[seed_idx] = 0.0
neu.rfc = rfc * second

syn = Synapses(neu, neu, 'w : volt', on_pre='g += w', delay=P['t_dly'], name='syn')
syn.connect(i=con['Presynaptic_Index'].values, j=con['Postsynaptic_Index'].values)
syn.w = con['Excitatory x Connectivity'].values * P['w_syn']
print(f'[build] {time.time()-t1:6.1f}s  synapses={len(syn)}')

# equivalent of upstream per-neuron PoissonInput(N=1, target_var='v'), but as one
# fixed-structure group so the compiled network can be reused across experiments
rates = np.zeros(N)
rates[seed_idx] = 200.0                          # notebook uses 200 Hz for sugar
pg = PoissonGroup(N, rates=rates * Hz, name='pg')
psyn = Synapses(pg, neu, on_pre='v_post += w_poi', name='psyn',
                namespace={'w_poi': P['w_syn'] * P['f_poi']})
psyn.connect(j='i')

mon = SpikeMonitor(neu)
net = Network(neu, syn, pg, psyn, mon)

t2 = time.time()
net.run(T_RUN * second)
print(f'[run  ] {time.time()-t2:6.1f}s for {T_RUN}s biological time  ({MODE})')

ti, tt = np.asarray(mon.i), np.asarray(mon.t / second)
print(f'[spike] {len(ti)} spikes from {len(np.unique(ti))} distinct neurons')
out = ROOT / 'data' / 'cache' / 'smoke_spikes.npz'
np.savez_compressed(out, i=ti.astype(np.int32), t=tt.astype(np.float32),
                    seed=seed_idx.astype(np.int32))
print(f'[save ] {out}  ({out.stat().st_size/1e6:.2f} MB)')
print(f'[TOTAL] {time.time()-t0:6.1f}s')
