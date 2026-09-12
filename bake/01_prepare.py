"""Build the neuron table: coordinates, annotations, degrees -> parquet + web binary.

Writes
  data/cache/neurons.parquet    used by the rest of the bake pipeline
  web/public/data/neurons.bin   what the browser loads (positions/region/type/degree/id)
"""
import json, sys
import numpy as np, pandas as pd
from common import (PATH_COMP, PATH_ANN, NEURONS, WEBDATA, VOXEL_NM, load_edges, CACHE)

# ---------------------------------------------------------------- annotations
comp = pd.read_csv(PATH_COMP, index_col=0)
flyids = comp.index.to_numpy(np.int64)
N = len(flyids)
print(f'[prepare] {N} neurons in the simulated network')

ann = pd.read_csv(PATH_ANN, sep='\t', low_memory=False,
                  usecols=['root_id', 'pos_x', 'pos_y', 'pos_z', 'soma_x', 'soma_y', 'soma_z',
                           'super_class', 'cell_class', 'cell_type', 'hemibrain_type',
                           'side', 'top_nt'])
ann['root_id'] = ann['root_id'].astype(np.int64)
ann = ann.drop_duplicates('root_id').set_index('root_id')
ann = ann.reindex(flyids)
miss = ann['pos_x'].isna().sum()
print(f'[prepare] annotation match {N-miss}/{N}  ({miss} without coordinates)')

# prefer the soma when it is known, else the representative point on the arbour
xyz = np.stack([ann['pos_x'].to_numpy(float), ann['pos_y'].to_numpy(float),
                ann['pos_z'].to_numpy(float)], 1)
soma = np.stack([ann['soma_x'].to_numpy(float), ann['soma_y'].to_numpy(float),
                 ann['soma_z'].to_numpy(float)], 1)
has_soma = ~np.isnan(soma).any(1)
xyz[has_soma] = soma[has_soma]
print(f'[prepare] soma position for {has_soma.sum()} neurons, arbour point for the rest')

xyz *= VOXEL_NM                                        # -> nanometres
good = ~np.isnan(xyz).any(1)
xyz[~good] = np.nanmedian(xyz[good], 0)                # park the handful of unannotated ones

# centre, flip the dorso-ventral axis (image y grows ventrally) and scale to ~100 units wide
lo, hi = xyz[good].min(0), xyz[good].max(0)
centre = (lo + hi) / 2
scale = 100.0 / (hi - lo)[0]
pos = (xyz - centre) * scale
pos[:, 1] *= -1
print(f'[prepare] extent after scaling (x,y,z): {np.ptp(pos[good], 0).round(1)}')

# --------------------------------------------------------------------- region
# coarse display grouping: super_class, with a few cell_class overrides that are
# visually meaningful (mushroom body, central complex, sensory modalities)
REGIONS = ['optic', 'visual_projection', 'central', 'mushroom_body', 'central_complex',
           'olfactory', 'gustatory', 'mechanosensory', 'other_sensory',
           'ascending', 'descending', 'motor', 'endocrine', 'unknown']
RIDX = {r: i for i, r in enumerate(REGIONS)}

sup = ann['super_class'].fillna('').to_numpy()
cls = ann['cell_class'].fillna('').to_numpy()
region = np.full(N, RIDX['unknown'], np.uint8)
for name in ('optic', 'visual_projection', 'central', 'ascending', 'descending',
             'motor', 'endocrine'):
    region[sup == name] = RIDX[name]
region[sup == 'visual_centrifugal'] = RIDX['visual_projection']
region[sup == 'sensory_ascending'] = RIDX['ascending']
sens = np.isin(sup, ['sensory'])
region[sens] = RIDX['other_sensory']
region[sens & (cls == 'olfactory')] = RIDX['olfactory']
region[sens & (cls == 'gustatory')] = RIDX['gustatory']
region[sens & (cls == 'mechanosensory')] = RIDX['mechanosensory']
region[sens & (cls == 'visual')] = RIDX['visual_projection']
region[cls == 'Kenyon_Cell'] = RIDX['mushroom_body']
region[cls == 'CX'] = RIDX['central_complex']
for i, r in enumerate(REGIONS):
    n = int((region == i).sum())
    if n:
        print(f'          {r:20s} {n:7d}')

# -------------------------------------------------------------------- degrees
pre, post, w = load_edges()
out_deg = np.bincount(pre, minlength=N).astype(np.int64)
in_deg = np.bincount(post, minlength=N).astype(np.int64)
out_w = np.bincount(pre, weights=np.abs(w), minlength=N).astype(np.int64)
print(f'[prepare] edges={len(pre)}  max out-degree={out_deg.max()}  max in-degree={in_deg.max()}')
del pre, post, w

# ------------------------------------------------------------------- assemble
cell_type = ann['cell_type'].fillna(ann['hemibrain_type']).fillna('').astype(str).to_numpy()
df = pd.DataFrame({
    'flywire_id': flyids,
    'x': pos[:, 0].astype(np.float32), 'y': pos[:, 1].astype(np.float32), 'z': pos[:, 2].astype(np.float32),
    'region': region,
    'region_name': [REGIONS[r] for r in region],
    'super_class': ann['super_class'].fillna('').astype(str).to_numpy(),
    'cell_class': ann['cell_class'].fillna('').astype(str).to_numpy(),
    'cell_type': cell_type,
    'side': ann['side'].fillna('').astype(str).to_numpy(),
    'nt': ann['top_nt'].fillna('').astype(str).to_numpy(),
    'out_deg': out_deg, 'in_deg': in_deg, 'out_w': out_w,
})
df.index.name = 'i'
df.to_parquet(NEURONS)
print(f'[prepare] wrote {NEURONS} ({NEURONS.stat().st_size/1e6:.1f} MB)')

# --------------------------------------------------------------- web binary
# One request, no JSON parse.  Layout: b"FLYN" | uint32 header length | header
# JSON (8-byte padded) | concatenated typed arrays described by the header.
types = [''] + sorted({t for t in cell_type if t})
tidx = {t: i for i, t in enumerate(types)}
type_i = np.array([tidx[t] for t in cell_type], np.uint16)
assert len(types) < 65536, len(types)
deg_dtype = np.uint16 if max(out_deg.max(), in_deg.max()) < 65535 else np.uint32

arrays = [
    ('pos',    pos.astype(np.float32).ravel()),
    ('region', region),
    ('type',   type_i),
    ('outDeg', np.minimum(out_deg, np.iinfo(deg_dtype).max).astype(deg_dtype)),
    ('inDeg',  np.minimum(in_deg, np.iinfo(deg_dtype).max).astype(deg_dtype)),
    ('flyid',  flyids.astype(np.int64)),
]
DT = {'float32': 'f32', 'uint8': 'u8', 'uint16': 'u16', 'uint32': 'u32', 'int64': 'i64'}
blobs, meta, off = [], [], 0
for name, arr in arrays:
    pad = (-off) % 8
    if pad:
        blobs.append(b'\0' * pad); off += pad
    meta.append({'name': name, 'type': DT[arr.dtype.name], 'offset': off, 'length': int(arr.size)})
    b = arr.tobytes(); blobs.append(b); off += len(b)

header = json.dumps({'n': int(N), 'regions': REGIONS, 'types': types, 'arrays': meta,
                     'bounds': [float(v) for v in np.concatenate([pos[good].min(0), pos[good].max(0)])]},
                    separators=(',', ':')).encode()
header += b' ' * ((-(len(header) + 8)) % 8)
out = WEBDATA / 'neurons.bin'
with open(out, 'wb') as f:
    f.write(b'FLYN'); f.write(np.uint32(len(header)).tobytes()); f.write(header)
    for b in blobs:
        f.write(b)
print(f'[prepare] wrote {out} ({out.stat().st_size/1e6:.2f} MB, {len(types)} cell types)')
