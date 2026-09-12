"""Downsample raw spike dumps into the small JSON files the browser plays.

Per experiment: time-binned frames of neuron indices, plus the slice of the
connectome that actually carried the cascade.
"""
import json
import numpy as np, pandas as pd
from common import (CACHE, RAW, WEBDATA, FRAME_MS, MAX_FRAMES, MAX_EDGES, T_RUN_S,
                    load_neurons, load_edges, write_json, write_bin, notebook_named_ids)

MIN_DOWNSTREAM = 8      # below this the cascade is invisible; not worth a click

neu = load_neurons()
fly = neu.flywire_id.to_numpy()
ctype = neu.cell_type.to_numpy()
N = len(fly)
exps = json.load(open(CACHE / 'experiments_todo.json'))

fly2i = {int(f): i for i, f in enumerate(fly)}
NAMED = {fly2i[f]: n for f, n in notebook_named_ids().items() if f in fly2i}
print(f'[export] {len(NAMED)} named readout neurons (MN9, MDN, Giant Fiber, ...)')

pre_all, post_all, w_all = load_edges()
absw = np.abs(w_all)
wmax = int(absw.max())

manifest, skipped = [], []
for e in exps:
    f = RAW / f'{e["exp_id"]}.npz'
    if not f.exists():
        skipped.append(e['exp_id'])
        continue
    d = np.load(f)
    si, st = d['i'], d['t']
    seeds = set(int(x) for x in d['seed'])
    if si.size == 0:
        skipped.append(f'{e["exp_id"]}(no spikes)')
        continue

    # ---- time bins -> frames holding the neurons that fired in that bin
    nf = min(MAX_FRAMES, int(np.ceil(T_RUN_S * 1000 / FRAME_MS)))
    fr = np.clip((st * 1000 / FRAME_MS).astype(np.int32), 0, nf - 1)
    order = np.argsort(fr, kind='stable')
    bounds = np.searchsorted(fr[order], np.arange(nf + 1))
    frames = [np.unique(si[order[bounds[k]:bounds[k + 1]]]) for k in range(nf)]

    active = np.unique(si)
    amask = np.zeros(N, bool)
    amask[active] = True
    first = np.full(N, np.inf, np.float32)
    np.minimum.at(first, si, st)

    # ---- the part of the connectome that lit up: both endpoints active, causal
    # edges (presynaptic neuron fired first) kept ahead of the rest, then by weight
    sel = np.flatnonzero(amask[pre_all] & amask[post_all])
    if sel.size > MAX_EDGES:
        causal = first[pre_all[sel]] <= first[post_all[sel]]
        rank = absw[sel].astype(np.int64) + causal * (wmax + 1)
        sel = sel[np.argpartition(-rank, MAX_EDGES)[:MAX_EDGES]]
    e_pre, e_post, e_w = pre_all[sel], post_all[sel], w_all[sel]

    # ---- callouts: the named readout neurons, then the busiest downstream cells
    cnt = pd.Series(si).value_counts()
    hi = [{'i': int(i), 'name': NAMED[i], 'first_ms': round(float(first[i]) * 1000, 1),
           'spikes': int(cnt.get(i, 0)), 'named': True}
          for i in active if i in NAMED and i not in seeds]
    for i in [int(i) for i in cnt.index[:80] if i not in seeds and i not in NAMED][:6]:
        hi.append({'i': i, 'name': str(ctype[i]) or f'neuron {i}',
                   'first_ms': round(float(first[i]) * 1000, 1), 'spikes': int(cnt[i]), 'named': False})
    hi.sort(key=lambda h: (not h['named'], h['first_ms']))

    # an experiment whose cascade dies immediately makes for a dead click: drop it
    n_down = int(active.size - len(seeds & set(active.tolist())))
    if n_down < MIN_DOWNSTREAM:
        skipped.append(f'{e["exp_id"]}({e["label"]}: only {n_down} downstream)')
        continue

    # frames go out as one flat index array plus per-frame offsets: a JSON array of
    # arrays costs ~7 bytes per spike in text, this costs 4 and needs no parsing
    counts = np.array([f.size for f in frames], np.uint32)
    head = {'exp_id': e['exp_id'], 'label': e['label'], 'group': e['group'], 'note': e['note'],
            'seed_idx': e['seed_idx'], 'seed2_idx': e['seed2_idx'],
            'rate_hz': e['rate_hz'], 'rate2_hz': e['rate2_hz'],
            'frame_ms': FRAME_MS, 'n_frames': nf, 'n_edges': int(e_pre.size),
            'highlights': hi[:12],
            'stats': {'n_spikes': int(si.size), 'n_active': int(active.size),
                      'n_downstream': n_down, 'peak_frame': int(counts.argmax())}}
    sz = write_bin(WEBDATA / 'exp' / f'{e["exp_id"]}.bin', b'FLYE', head, [
        ('frameOff', np.concatenate([[0], np.cumsum(counts)]).astype(np.uint32)),
        ('frameIdx', (np.concatenate(frames) if counts.sum() else np.zeros(0)).astype(np.uint32)),
        ('edgePre', e_pre.astype(np.uint32)),
        ('edgePost', e_post.astype(np.uint32)),
        ('edgeW', e_w.astype(np.int32)),
    ])
    manifest.append({'exp_id': e['exp_id'], 'label': e['label'], 'group': e['group'],
                     'note': e['note'], 'n_seed': len(e['seed_idx']) + len(e['seed2_idx']),
                     'n_active': int(active.size), 'n_downstream': n_down, 'n_spikes': int(si.size),
                     'n_frames': nf, 'rate_hz': e['rate_hz'], 'kb': round(sz / 1024)})
    print(f'  {e["exp_id"]} {e["label"][:30]:30s} active={active.size:6d} '
          f'edges={e_pre.size:5d} {sz/1024:6.0f} KB')

# click routing: clickable neuron index -> experiment id, as parallel arrays
by_id = {e['exp_id']: e for e in exps}
sidx, sexp = [], []
for m in manifest:
    for i in by_id[m['exp_id']]['seed_idx'] + by_id[m['exp_id']]['seed2_idx']:
        sidx.append(int(i))
        sexp.append(m['exp_id'])

top = write_json(WEBDATA / 'experiments.json', {
    'frame_ms': FRAME_MS, 't_run_s': T_RUN_S, 'n_neurons': int(N),
    'source': 'FlyWire 783 connectome; Brian2 LIF model of Shiu et al.',
    'experiments': manifest, 'seed_map': {'idx': sidx, 'exp': sexp}})
tot = sum(m['kb'] for m in manifest)
print(f'[export] {len(manifest)} experiments, {len(sidx)} clickable neurons, manifest {top/1024:.0f} KB')
print(f'[export] payload {tot/1024:.1f} MB total, largest single file {max(m["kb"] for m in manifest)} KB')
if skipped:
    print(f'[export] skipped: {skipped}')
