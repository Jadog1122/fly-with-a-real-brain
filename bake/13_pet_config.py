"""Emit web/public/data/pet.json: sensor and readout wiring in subnet-local indices."""
import numpy as np
from common import CACHE, WEBDATA, write_json
import pet_groups

sensors, readouts = pet_groups.build()
sub = np.load(CACHE / 'subnet.npz')
members = sub['members']
local = {int(m): k for k, m in enumerate(members)}


def to_local(sides):
    return {k: [local[i] for i in v if i in local] for k, v in sides.items()}


out_s = []
for s in sensors:
    sd = to_local(s['sides'])
    n = sum(len(v) for v in sd.values())
    out_s.append({'id': s['id'], 'label': s['label'], 'modality': s['modality'],
                  'rate_hz': s['rate_hz'], 'note': s['note'],
                  'cell_types': s['cell_types'], 'n': n, 'sides': sd})
    print(f"[pet] sensor  {s['id']:9s} {n:4d} in subnet  "
          f"L{len(sd['left']):3d} R{len(sd['right']):3d} C{len(sd['other']):2d}")

out_r = []
for r in readouts:
    sd = to_local(r['sides'])
    n = sum(len(v) for v in sd.values())
    names = {str(local[i]): nm for i, nm in r['names'].items() if i in local}
    out_r.append({'id': r['id'], 'label': r['label'], 'note': r['note'],
                  'n': n, 'sides': sd, 'names': names})
    print(f"[pet] readout {r['id']:10s} {n:2d} in subnet  L{len(sd['left'])} R{len(sd['right'])}")

# must match upstream model.py default_params - the JS engine integrates the same
# linear system exactly, so the constants travel with the data instead of being retyped
MODEL = {'dt_ms': 0.1, 'v_0': -52.0, 'v_rst': -52.0, 'v_th': -45.0,
         't_mbr_ms': 20.0, 'tau_ms': 5.0, 't_rfc_ms': 2.2, 'delay_ms': 1.8,
         'w_syn_mV': 0.275, 'f_poi': 250}

sz = write_json(WEBDATA / 'pet.json', {'n_subnet': int(len(members)), 'model': MODEL,
                                       'sensors': out_s, 'readouts': out_r})
print(f'[pet] wrote {WEBDATA/"pet.json"} ({sz/1024:.0f} KB)')
