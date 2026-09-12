"""Does the browser's JavaScript engine reproduce Brian2?

Two tests:
  1. Deterministic - one suprathreshold kick, no Poisson, no RNG anywhere.  The two
     engines must agree spike for spike, on neuron *and* time.
  2. Stochastic - the Poisson drives the pet actually uses.  The RNG streams differ,
     so this compares totals and populations against the Brian2 subnet reference.

Two differences were found and fixed this way, both invisible until measured:
  * Brian2 applies on_pre in its `synapses` slot, after the state update, so the ring
    buffer needs delay/dt + 1 slots.
  * Brian2 discards synaptic input to a refractory neuron - `g` carries the
    (unless refractory) flag.  Without that gate the engine ran 76% hot in avalanches.
"""
import json, subprocess, sys
import numpy as np
from pathlib import Path
from common import CACHE, WEBDATA, ROOT

HERE = Path(__file__).parent
SCRATCH = CACHE / 'engine_val'
SCRATCH.mkdir(exist_ok=True)
PY_ = str(ROOT / '.venv' / 'bin' / 'python')

# Always rebundle from web/src/pet/sim.ts.  Validating a stale bundle would report
# success for code that is not the code the browser runs.
_b = subprocess.run(['npx', 'esbuild', 'src/pet/sim.ts', '--bundle', '--format=esm',
                     f'--outfile={HERE / "_sim_engine.mjs"}', '--log-level=warning'],
                    cwd=str(ROOT / 'web'), capture_output=True, text=True)
if _b.returncode:
    sys.exit(f'could not bundle the engine:\n{_b.stderr[-800:]}')
print(f'[engine] bundled from web/src/pet/sim.ts '
      f'({(HERE / "_sim_engine.mjs").stat().st_size} bytes)\n')


def js(spec, ms, out):
    r = subprocess.run(['node', '_js_engine_probe.mjs', str(WEBDATA / 'subnet.bin'),
                        str(WEBDATA / 'pet.json'), spec, str(ms), str(out)],
                       cwd=str(HERE), capture_output=True, text=True)
    if r.returncode:
        sys.exit(f'js probe failed:\n{r.stderr[-1500:]}')
    i = np.fromfile(f'{out}.i.bin', np.uint16).astype(np.int64)
    t = np.fromfile(f'{out}.t.bin', np.float32)
    return i, t, json.loads(r.stdout.strip().splitlines()[-1])


def b2_deterministic(sensor, ms, out):
    """One kick on a sensor group, no Poisson - fully deterministic in Brian2 too."""
    if Path(f'{out}.npz').exists():
        d = np.load(f'{out}.npz')
        return d['i'].astype(np.int64), d['t']
    script = HERE / '_det_b2.py'
    script.write_text(f"""
import numpy as np, sys, json
sys.path.insert(0, {str(HERE)!r})
from brian2 import *
from common import CACHE, WEBDATA
sys.path.insert(0, str(CACHE.parent.parent / 'upstream' / 'code' / 'paper-phil-drosophila'))
from model import default_params as P
prefs.devices.cpp_standalone.openmp_threads = 0
set_device('cpp_standalone', directory=str(CACHE / 'b2_engine_val'))
sub = np.load(CACHE / 'subnet.npz')
row, tgt, wg = sub['row'], sub['tgt'], sub['w']
N = len(sub['members'])
pet = json.load(open(WEBDATA / 'pet.json'))
s = next(x for x in pet['sensors'] if x['id'] == {sensor!r})
seeds = np.array(sorted(s['sides']['left'] + s['sides']['right'] + s['sides']['other']))
neu = NeuronGroup(N, P['eqs'], method='linear', threshold=P['eq_th'],
                  reset=P['eq_rst'], refractory='rfc', namespace=P)
neu.g = 0; neu.rfc = P['t_rfc']
syn = Synapses(neu, neu, 'w : volt', on_pre='g += w', delay=P['t_dly'])
syn.connect(i=np.repeat(np.arange(N), np.diff(row)).astype(np.int64), j=tgt.astype(np.int64))
syn.w = wg.astype(np.float64) * P['w_syn']
v0 = np.full(N, float(P['v_0'])); v0[seeds] = float(P['v_th']) + 1e-3   # +1 mV in volts
neu.v = v0 * volt
mon = SpikeMonitor(neu)
run({ms} * ms)
np.savez({str(out) + '.npz'!r}, i=np.asarray(mon.i, np.int32), t=np.asarray(mon.t / ms, np.float64))
""")
    r = subprocess.run([PY_, str(script)], cwd=str(HERE), capture_output=True, text=True)
    script.unlink(missing_ok=True)
    if r.returncode:
        sys.exit(f'brian2 reference failed:\n{r.stderr[-1500:]}')
    d = np.load(f'{out}.npz')
    return d['i'].astype(np.int64), d['t']


print('=== 1. deterministic: one kick, no RNG - must agree exactly ===')
ok = True
for sensor, ms in (('sugar', 60), ('looming', 60)):
    bi, bt = b2_deterministic(sensor, ms, SCRATCH / f'det-{sensor}')
    ji, jt, _ = js(f'kick:{sensor}', ms, SCRATCH / f'det-{sensor}-js')
    sb = {(int(a), round(float(t), 4)) for a, t in zip(bi, bt)}
    sj = {(int(a), round(float(t), 4)) for a, t in zip(ji, jt)}
    same = sb == sj
    ok &= same
    print(f'  {sensor:9s} brian2 {len(sb):5d} spikes | js {len(sj):5d} | identical {len(sb & sj):5d}'
          f'  -> {"EXACT MATCH" if same else "MISMATCH: " + str(sorted(sb ^ sj)[:4])}')

print('\n=== 2. stochastic: the drives the pet uses (RNG streams differ) ===')
REF = {'sugar': 'probe-sugar-full', 'touch': 'probe-touch-full', 'looming': 'probe-looming-full'}
print(f'  {"stimulus":10s} {"brian2 spikes":>14s} {"js spikes":>11s} {"ratio":>7s} '
      f'{"brian2 active":>14s} {"js active":>10s} {"ratio":>7s}')
for sensor, ref in REF.items():
    f = CACHE / 'val' / f'{ref}.sub12345.npz'
    if not f.exists():
        print(f'  {sensor:10s} (no subnet reference - run 12_validate_subnet.py)')
        continue
    d = np.load(f)
    bi = d['i']
    ji, _, meta = js(f'{sensor}:1.0', 500, SCRATCH / f'sto-{sensor}-js')
    ra = meta['spikes'] / max(bi.size, 1)
    rb = meta['active'] / max(np.unique(bi).size, 1)
    print(f'  {sensor:10s} {bi.size:>14,} {meta["spikes"]:>11,} {ra:>7.3f} '
          f'{np.unique(bi).size:>14,} {meta["active"]:>10,} {rb:>7.3f}')

print('\nOK' if ok else '\nFAILED: the deterministic test must match exactly')
sys.exit(0 if ok else 1)
