"""Shared paths, constants and data loading for the bake pipeline."""
from pathlib import Path
import json, numpy as np, pandas as pd

ROOT     = Path(__file__).resolve().parent.parent
UPSTREAM = ROOT / 'upstream'
DATA     = ROOT / 'data'
CACHE    = DATA / 'cache'
RAW      = DATA / 'raw'                       # one .npz of spikes per experiment
WEBDATA  = ROOT / 'web' / 'public' / 'data'   # what the browser fetches

PATH_COMP = UPSTREAM / 'data' / '2025_Completeness_783.csv'
PATH_CON  = UPSTREAM / 'data' / '2025_Connectivity_783.parquet'
PATH_SEZ  = UPSTREAM / 'data' / 'sez_neurons.pickle'
PATH_ANN  = CACHE / 'flywire_annotations.tsv'     # fetched by 00_fetch_annotations.py
NEURONS   = CACHE / 'neurons.parquet'

# simulation / downsampling contract (see README)
T_RUN_S   = 0.5      # biological seconds per experiment
FRAME_MS  = 5        # downsample bin -> 100 frames per experiment
MAX_FRAMES = 400
MAX_EDGES = 5000

# FlyWire coordinates in Supplemental_file1 are voxels of 4 x 4 x 40 nm
VOXEL_NM = np.array([4.0, 4.0, 40.0])

for d in (CACHE, RAW, WEBDATA):
    d.mkdir(parents=True, exist_ok=True)


def load_neurons() -> pd.DataFrame:
    """Neuron table indexed by brian/row index: flywire_id, coords, annotations, degrees."""
    if not NEURONS.exists():
        raise SystemExit(f'{NEURONS} missing - run bake/01_prepare.py first')
    return pd.read_parquet(NEURONS)


def load_edges():
    """(pre_idx, post_idx, signed_weight) as int32/int32/int32 arrays."""
    con = pd.read_parquet(PATH_CON, columns=['Presynaptic_Index', 'Postsynaptic_Index',
                                             'Excitatory x Connectivity'])
    pre = con['Presynaptic_Index'].to_numpy(np.int32)
    post = con['Postsynaptic_Index'].to_numpy(np.int32)
    w = con['Excitatory x Connectivity'].to_numpy(np.int32)
    del con
    return pre, post, w


def write_json(path: Path, obj, indent=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w') as f:
        json.dump(obj, f, separators=(',', ':'), indent=indent)
    return path.stat().st_size


# ------------------------------------------------- upstream notebook constants
NB_PATH = UPSTREAM / 'code' / 'paper-phil-drosophila' / 'example.ipynb'


def _literal(node, ns):
    """Evaluate the int / list-of-int / list+list expressions the notebook uses."""
    import ast
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, (ast.List, ast.Tuple)):
        return [_literal(e, ns) for e in node.elts]
    if isinstance(node, ast.Name):
        return ns[node.id]
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return _literal(node.left, ns) + _literal(node.right, ns)
    raise ValueError('unsupported expression')


def notebook_constants(path=NB_PATH):
    """Neuron ID lists defined in the upstream example notebook (sugar_GRNs, LC_4s, ...)."""
    import ast, json as _json
    ns = {}
    for cell in _json.load(open(path))['cells']:
        if cell['cell_type'] != 'code':
            continue
        try:
            tree = ast.parse(''.join(cell['source']))
        except SyntaxError:
            continue
        for node in tree.body:
            if not isinstance(node, ast.Assign) or len(node.targets) != 1:
                continue
            tgt = node.targets[0]
            try:
                val = _literal(node.value, ns)
            except Exception:
                continue
            if isinstance(tgt, ast.Name):
                ns[tgt.id] = val
            elif isinstance(tgt, ast.Tuple) and isinstance(val, list):
                for t, v in zip(tgt.elts, val):
                    if isinstance(t, ast.Name):
                        ns[t.id] = v
    return ns


def notebook_named_ids(path=NB_PATH):
    """`flyid2name[X] = "..."` entries from the notebook -> {flywire_id: name}."""
    import ast, json as _json
    ns, out = notebook_constants(path), {}
    for cell in _json.load(open(path))['cells']:
        if cell['cell_type'] != 'code' or 'flyid2name[' not in ''.join(cell['source']):
            continue
        try:
            tree = ast.parse(''.join(cell['source']))
        except SyntaxError:
            continue
        for node in tree.body:
            if (isinstance(node, ast.Assign) and len(node.targets) == 1
                    and isinstance(node.targets[0], ast.Subscript)
                    and getattr(node.targets[0].value, 'id', '') == 'flyid2name'):
                try:
                    out[int(_literal(node.targets[0].slice, ns))] = _literal(node.value, ns)
                except Exception:
                    pass
    return out


# ------------------------------------------------------------- binary payloads
_DT = {'float32': 'f32', 'uint8': 'u8', 'uint16': 'u16', 'uint32': 'u32',
       'int8': 'i8', 'int16': 'i16', 'int32': 'i32', 'int64': 'i64'}


def write_bin(path, magic: bytes, header: dict, arrays: list) -> int:
    """`magic` | uint32 header length | JSON header | 8-byte-aligned typed arrays.

    `arrays` is a list of (name, numpy array); their offsets/dtypes are appended to
    the header as `header['arrays']` so the browser can build typed-array views
    straight onto the downloaded ArrayBuffer.
    """
    import json as _json
    import numpy as _np
    blobs, meta, off = [], [], 0
    for name, arr in arrays:
        pad = (-off) % 8
        if pad:
            blobs.append(b'\0' * pad)
            off += pad
        meta.append({'name': name, 'type': _DT[arr.dtype.name], 'offset': off, 'length': int(arr.size)})
        b = _np.ascontiguousarray(arr).tobytes()
        blobs.append(b)
        off += len(b)
    head = _json.dumps({**header, 'arrays': meta}, separators=(',', ':')).encode()
    head += b' ' * ((-(len(head) + len(magic) + 4)) % 8)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'wb') as f:
        f.write(magic)
        f.write(_np.uint32(len(head)).tobytes())
        f.write(head)
        for b in blobs:
            f.write(b)
    return path.stat().st_size
