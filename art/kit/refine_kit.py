"""
The scenery, refined to hold up at the scale this game shows it.

Source: Quaternius's Stylized Nature MegaKit (CC0), the originals kept untouched in
art/src/nature. At the kit's own scale they are lovely. Here a blade of grass is taller
than the fly and a pebble is a boulder, and what that exposes is not style but a lack
of resolution: a pebble is 78 flat triangles with its shading painted on, a petal is 13,
and a grass blade is a flat ribbon mapped onto a four-colour stripe - which is why the
grass read as wooden slats and the fallen leaves as red paper.

Each model keeps what it was - its layout, its silhouette, its palette - and gets the
form and surface it needs up close:

  grass    every blade rebuilt along its own measured centreline and width: a folded
           V section with a midrib groove, a sharp tapered tip, enough segments to bend
           smoothly in the wind, and a real blade texture (textures.py).
  leaves   every leaf and petal card subdivided and given form - cupped across, the
  flowers  long ones drooping toward the tip - so a leaf has a surface instead of being
  petals   a flat sticker; the atlases they sample are re-rendered with venation.
  stones   pebbles welded, subdivided round and displaced with 3-D noise, as water wears
           them; rocks bevelled first so they keep their planes with worn edges. New UVs
           onto a tileable granite, moss at the base and occlusion underneath in colour.
  mushroom smoothed, UVs preserved, on a finer atlas with a normal map.
  litter   new: four fallen leaves, which the kit does not have. The scene had been
           using the petal models - whole little flowers - tinted brown as leaf litter.

The foliage's vertex colours in the source run from pure black at the base to white at
the tip - that is where the black bases of every clump came from. They are replaced by
an occlusion ramp that darkens the base as a crowded clump really is, without going to
black.

Run:  blender --background --python art/kit/refine_kit.py -- <src> <tex> <out> [names...]
"""
import bpy
import bmesh
import math
import os
import sys
import zlib

import numpy as np
from mathutils import Vector, noise

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, TEX, OUT = argv[0], argv[1], argv[2]
ONLY = set(argv[3:])
os.makedirs(OUT, exist_ok=True)


def log(*a):
    print('[refine_kit]', *a, flush=True)


def smoothstep(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def islands(bm):
    """Connected face sets."""
    bm.faces.ensure_lookup_table()
    seen, out = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, comp = [f], []
        seen.add(f.index)
        while stack:
            g = stack.pop()
            comp.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        stack.append(h)
        out.append(comp)
    return out


def image(name, non_color=False):
    img = bpy.data.images.load(os.path.join(TEX, name + '.png'), check_existing=True)
    if non_color:
        img.colorspace_settings.name = 'Non-Color'
    return img


def textured_material(name, albedo, normal=None, rough=0.6, alpha_clip=False):
    """A Principled material the glTF exporter maps one to one."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Roughness'].default_value = rough
    t = nt.nodes.new('ShaderNodeTexImage')
    t.image = albedo
    nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
    if alpha_clip:
        nt.links.new(t.outputs['Alpha'], b.inputs['Alpha'])
        m.surface_render_method = 'DITHERED'
    if normal is not None:
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = normal
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(n.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    m.use_backface_culling = False
    return m


def write_mesh(o, verts, faces, uvs, colors):
    """Replace o's mesh: faces index verts; uvs and colors are per vertex."""
    me = bpy.data.meshes.new(o.data.name + '_refined')
    me.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    uvl = me.uv_layers.new(name='UVMap')
    col = me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
    for loop in me.loops:
        vi = loop.vertex_index
        uvl.data[loop.index].uv = uvs[vi]
        c = colors[vi]
        col.data[loop.index].color = (c, c, c, 1.0)
    me.color_attributes.active_color = col
    for p in me.polygons:
        p.use_smooth = True
    old = o.data
    o.data = me
    if old.users == 0:
        bpy.data.meshes.remove(old)
    return me


def apply_modifiers(o):
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    old = o.data
    o.modifiers.clear()
    o.data = me
    if old.users == 0:
        bpy.data.meshes.remove(old)


def set_colors(o, fn):
    """Per-corner colour attribute from fn(vertex) -> (r, g, b); made active for export."""
    me = o.data
    for a in list(me.color_attributes):
        me.color_attributes.remove(a)
    col = me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
    cache = {}
    for loop in me.loops:
        vi = loop.vertex_index
        if vi not in cache:
            cache[vi] = fn(me.vertices[vi])
        r, g, b = cache[vi]
        col.data[loop.index].color = (r, g, b, 1.0)
    me.color_attributes.active_color = col


def height_ramp(o, lo=0.45, reach=0.5):
    """Occlusion by height: darker where a clump crowds its own base, never black."""
    zs = [v.co.z for v in o.data.vertices]
    z0, z1 = min(zs), max(zs)
    span = max(z1 - z0, 1e-6)
    set_colors(o, lambda v: (lo + (1 - lo) * smoothstep(0.0, reach, (v.co.z - z0) / span),) * 3)


# --- cards: leaves, fronds, petals ----------------------------------------------------------

def refine_cards(o, cuts=2, cup=0.14, droop=0.0, only_mats=None):
    """
    Subdivide every card (UVs interpolate, so the sprite stays where it was) and shape it:
    edges lifted across the card, and a droop along it from the end nearest the plant's
    centre. Islands that are nearly one-dimensional are stems and are left alone.
    """
    bm = bmesh.new()
    bm.from_mesh(o.data)
    mats = [m.name for m in o.data.materials]

    def is_stem(comp):
        P = np.array([v.co[:] for v in {v for f in comp for v in f.verts}])
        sv = np.linalg.svd(P - P.mean(0), compute_uv=False)
        return len(sv) < 2 or sv[1] < 0.12 * sv[0]
    # Only cards are subdivided. Stems gain nothing from it, and some of these models are
    # scattered by the thousand as leaf litter: subdividing everything took Clover_2 from
    # 615 triangles to 5,535, which across the litter is over a million.
    card_edges = set()
    for comp in islands(bm):
        if is_stem(comp):
            continue
        if only_mats is not None and not any(mats[f.material_index] in only_mats for f in comp):
            continue
        for f in comp:
            card_edges.update(f.edges)
    bmesh.ops.subdivide_edges(bm, edges=list(card_edges), cuts=cuts, use_grid_fill=True)
    up = np.array([0.0, 0.0, 1.0])
    for comp in islands(bm):
        if only_mats is not None and not any(mats[f.material_index] in only_mats for f in comp):
            continue
        vs = list({v for f in comp for v in f.verts})
        P = np.array([v.co[:] for v in vs])
        c = P.mean(0)
        _, sv, vt = np.linalg.svd(P - c, full_matrices=False)
        if len(sv) < 2 or sv[1] < 0.12 * sv[0]:
            continue                                          # a stem
        a, b, n = vt[0], vt[1], vt[2]
        if n @ up < 0:
            n = -n
        A = (P - c) @ a
        B = (P - c) @ b
        La, Lb = max(np.abs(A).max(), 1e-6), max(np.abs(B).max(), 1e-6)
        # the base is the end of the long axis nearer the plant's centre (its origin)
        base_sign = -1.0 if np.linalg.norm(c - a * La) > np.linalg.norm(c + a * La) else 1.0
        along = (A * base_sign + La) / (2 * La)              # 0 at the base, 1 at the tip
        for v, pb, t in zip(vs, B, along):
            d = n * cup * Lb * (pb / Lb) ** 2 - up * droop * La * t ** 2
            v.co += Vector(d)
    bm.normal_update()
    bm.to_mesh(o.data)
    bm.free()
    for p in o.data.polygons:
        p.use_smooth = True


# --- stones ---------------------------------------------------------------------------------

def refine_stone(o, round_, target, lump, seed):
    me = o.data
    bm = bmesh.new()
    bm.from_mesh(me)
    # every painted facet was its own UV island, so the stone arrives in pieces
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-4)
    bm.to_mesh(me)
    bm.free()
    while me.uv_layers:
        me.uv_layers.remove(me.uv_layers[0])
    dims = o.dimensions.copy()
    size = max(dims)
    if not round_:
        bev = o.modifiers.new('bevel', 'BEVEL')
        bev.width = 0.05 * size
        bev.segments = 2
        bev.limit_method = 'ANGLE'
        apply_modifiers(o)
    sub = o.modifiers.new('sub', 'SUBSURF')
    sub.levels = 2 if round_ else 1
    apply_modifiers(o)
    me = o.data
    me.update()
    off = Vector((seed * 1.7, seed * 0.3, seed * 2.1))
    for v in me.vertices:
        p = v.co / size * 2.6 + off
        lumps = noise.fractal(p, 1.0, 2.0, 4, noise_basis='PERLIN_ORIGINAL')
        v.co += v.normal * lumps * lump * size
    # A few source pebbles carry a thin notch or lip that subdivision turns into a spike
    # and displacement then pushes further out. A light smoothing pass takes those off
    # without flattening the lumps.
    sm = o.modifiers.new('smooth', 'SMOOTH')
    sm.factor = 0.5
    sm.iterations = 4
    apply_modifiers(o)
    me = o.data
    dec = o.modifiers.new('dec', 'DECIMATE')
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    dec.ratio = min(1.0, target / max(tris, 1))
    dec.use_collapse_triangulate = True
    apply_modifiers(o)
    for p in o.data.polygons:
        p.use_smooth = True
    # UVs: a cube projection onto the tileable granite, a few repeats across the stone
    for x in bpy.context.view_layer.objects:
        x.select_set(x == o)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.cube_project(cube_size=size * 0.7, correct_aspect=True)
    bpy.ops.object.mode_set(mode='OBJECT')
    zs = [v.co.z for v in o.data.vertices]
    z0, z1 = min(zs), max(zs)
    moss = np.array([0.52, 0.66, 0.40])

    def color(v):
        h = (v.co.z - z0) / max(z1 - z0, 1e-6)
        under = smoothstep(0.1, -0.7, v.normal.z)            # facing the ground: in shadow
        m = (1 - smoothstep(0.0, 0.28, h)) * 0.75           # moss creeps up from the ground
        m *= 0.6 + 0.4 * (noise.noise(v.co / size * 5 + off) * 0.5 + 0.5)
        c = np.ones(3) * (1 - m) + moss * m
        return tuple(c * (1 - 0.35 * under))
    set_colors(o, color)
    mat = textured_material('Stone', image('Stone'), image('Stone_n', True), rough=0.5)
    o.data.materials.clear()
    o.data.materials.append(mat)


def refine_mushroom(o, target):
    sub = o.modifiers.new('sub', 'SUBSURF')
    sub.levels = 1
    sub.uv_smooth = 'PRESERVE_CORNERS'
    apply_modifiers(o)
    # smooth, then back down to a budget: collapse keeps the now-rounded silhouette
    dec = o.modifiers.new('dec', 'DECIMATE')
    dec.ratio = min(1.0, target / max(1, sum(len(p.vertices) - 2 for p in o.data.polygons)))
    dec.use_collapse_triangulate = True
    apply_modifiers(o)
    for p in o.data.polygons:
        p.use_smooth = True
    mat = textured_material('Mushrooms', image('Mushrooms'), image('Mushrooms_n', True), rough=0.55)
    o.data.materials.clear()
    o.data.materials.append(mat)


def retexture(o, table):
    """Point the kit's material slots at the refined atlases, keeping the slot order."""
    for i, m in enumerate(o.data.materials):
        key = m.name.split('.')[0].removesuffix('_src') if m else None
        if key in table:
            o.data.materials[i] = table[key]()


LEAVES = lambda: textured_material('Leaves', image('Leaves'), image('Leaves_n', True), rough=0.55, alpha_clip=True)
FLOWERS = lambda: textured_material('Flowers', image('Flowers'), image('Flowers_n', True), rough=0.5, alpha_clip=True)


# --- grass --------------------------------------------------------------------------------

GRASS_COLUMNS = 4       # textures.py: fresh, deep, straw, mixed


def rebuild_grass(o, columns, rings, seed, fold=0.22):
    """
    Each blade is an island whose UV v runs from base to tip, which is enough to recover
    its centreline, its width and the plane of its lamina by sampling along v - and to
    rebuild it as a real blade that follows exactly the same curve.
    """
    rng = np.random.default_rng(seed)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    uvl = bm.loops.layers.uv.active
    verts, faces, uvs, cols = [], [], [], []
    up = np.array([0.0, 0.0, 1.0])
    for comp in islands(bm):
        pv = {}
        for f in comp:
            for l in f.loops:
                pv[l.vert.index] = (np.array(l.vert.co[:]), l[uvl].uv[1])
        P = np.array([p for p, _ in pv.values()])
        vv = np.array([v for _, v in pv.values()])
        v0, v1 = vv.min(), vv.max()
        if v1 - v0 < 1e-4 or len(P) < 3:
            continue
        span = v1 - v0
        ts = np.linspace(v0, v1, rings)
        sig = span / (rings - 1) * 0.7
        C = np.zeros((rings, 3))
        for j, t in enumerate(ts):
            w = np.exp(-((vv - t) / sig) ** 2)
            C[j] = (P * w[:, None]).sum(0) / w.sum()
        # the ends are the blade's own extreme vertices, not a window's mean pulled inward
        C[0] = P[vv <= v0 + 0.03 * span].mean(0)
        C[-1] = P[vv >= v1 - 0.03 * span].mean(0)
        C[1:-1] = C[1:-1] * 0.5 + (C[:-2] + C[2:]) * 0.25        # lose the zig-zag, keep the curve
        T = np.gradient(C, axis=0)
        T /= np.linalg.norm(T, axis=1, keepdims=True) + 1e-12
        EW = np.zeros((rings, 3))
        HW = np.zeros(rings)
        for j, t in enumerate(ts):
            w = np.exp(-((vv - t) / sig) ** 2)
            d = P - C[j]
            d -= np.outer(d @ T[j], T[j])
            cov = (d * w[:, None]).T @ d / w.sum()
            vals, vecs = np.linalg.eigh(cov)
            e = vecs[:, -1]
            if j and e @ EW[j - 1] < 0:
                e = -e
            EW[j] = e
            HW[j] = math.sqrt(max(vals[-1], 1e-10)) * 1.25
        # a blade narrows to a point; the source's tips are blunt ribbons
        s = (ts - v0) / span
        HW *= np.array([1.0 - smoothstep(0.62, 1.0, x) ** 1.6 for x in s])
        HW = np.maximum(HW, 0.0)
        HW[0] = max(HW[0], HW[1] * 0.9)
        N = np.cross(T, EW)
        N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-12
        if N[rings // 2] @ up < 0:
            N = -N
        col_i = columns[int(rng.integers(len(columns)))]
        u0 = (col_i + 0.06) / GRASS_COLUMNS
        u1 = (col_i + 0.94) / GRASS_COLUMNS
        tint = float(rng.uniform(0.9, 1.08))
        base = len(verts)
        for j in range(rings - 1):
            hw, f = HW[j], fold * HW[j]
            for k, (off, mid) in enumerate(((-1, 0), (0, 1), (1, 0))):
                p = C[j] + EW[j] * hw * off - N[j] * f * mid
                verts.append(p)
                uvs.append((u0 + (u1 - u0) * (k / 2), s[j]))
                cols.append((0.35 + 0.65 * smoothstep(0.0, 0.45, s[j])) * tint)
        verts.append(C[-1])
        uvs.append(((u0 + u1) / 2, 1.0))
        cols.append(tint)
        tip = len(verts) - 1
        for j in range(rings - 2):
            a = base + 3 * j
            b = a + 3
            faces.append((a, a + 1, b + 1, b))
            faces.append((a + 1, a + 2, b + 2, b + 1))
        a = base + 3 * (rings - 2)
        faces.append((a, a + 1, tip))
        faces.append((a + 1, a + 2, tip))
    bm.free()
    write_mesh(o, verts, faces, uvs, [min(1.0, c) for c in cols])
    mat = textured_material('Grass', image('GrassBlades'), image('GrassBlades_n', True), rough=0.6)
    o.data.materials.clear()
    o.data.materials.append(mat)
    return len(faces)


CARDS = {
    # one level of subdivision on anything scattered in bulk (Clover_2 and the petals are
    # the leaf litter, ~1,000 instances); two on the plants that stand a few at a time
    'Clover_1': dict(cuts=1, cup=0.18), 'Clover_2': dict(cuts=1, cup=0.18),
    'Fern_1': dict(cuts=1, cup=0.22, droop=0.18),
    'Plant_1': dict(cuts=2, cup=0.30, droop=0.10), 'Plant_7': dict(cuts=2, cup=0.25),
    'Flower_3_Single': dict(cuts=1, cup=0.20), 'Flower_4_Single': dict(cuts=1, cup=0.18),
    'Petal_1': dict(cuts=1, cup=0.28), 'Petal_2': dict(cuts=1, cup=0.28), 'Petal_3': dict(cuts=1, cup=0.28),
}
STONES = {
    # name: (water-worn round, triangle budget, lump size as a fraction of the stone)
    'Pebble_Round_1': (True, 560, 0.05), 'Pebble_Round_2': (True, 560, 0.05),
    'Pebble_Round_3': (True, 560, 0.05), 'Pebble_Square_1': (False, 620, 0.035),
    'Pebble_Square_2': (False, 620, 0.035),
    'Rock_Medium_1': (False, 1600, 0.04), 'Rock_Medium_2': (False, 1600, 0.04),
}
GRASS = {
    # name: (texture columns to draw from, rings along each blade)
    'Grass_Common_Short': ([1, 0], 8),
    'Grass_Common_Tall': ([0, 3], 9),
    # dry straw is a quarter of the tall grass, not most of it: in the backlit frame
    # it glows orange, and two thirds of it made the meadow look burnt
    'Grass_Wispy_Tall': ([3, 0, 3, 2], 10),
}


# --- leaf litter ------------------------------------------------------------------------------

LITTER_LEN = 0.85        # a leaf's length in kit units, about what the petals it replaces spanned
LITTER_SHAPE = {
    # how a leaf of each kind dries: edges rolled up across it, the blade arched along the
    # midrib, the tip lifting off the ground, a ripple through the margin
    # - and one side always curls more than the other. A maple's lobes curl up like
    # fingers instead, so its lift is radial from the palm.
    'oak': dict(cup=0.30, twist=0.30, arch=0.05, tip=0.10, wave=0.020, palm=0.0),
    'beech': dict(cup=0.30, twist=-0.35, arch=0.06, tip=0.13, wave=0.012, palm=0.0),
    'birch': dict(cup=0.22, twist=0.25, arch=0.04, tip=0.08, wave=0.025, palm=0.0),
    'maple': dict(cup=0.06, twist=0.20, arch=0.02, tip=0.0, wave=0.020, palm=0.17),
}


def build_litter():
    """
    Fallen leaves, which the kit does not have (see textures.py). Each is a grid laid over
    its sprite in the atlas and trimmed to the outline textures.py recorded, so the mesh
    and the cut-out agree; then dried into shape. The origin is the middle of the leaf,
    at the ground, so the scene can spin it in place and it still lies on the dirt.
    """
    import json
    meta = json.load(open(os.path.join(TEX, 'Litter.json')))
    made = []
    for i, m in enumerate(meta):
        name = 'Litter_' + m['name'].capitalize()
        if ONLY and name not in ONLY:
            continue
        bpy.ops.wm.read_factory_settings(use_empty=True)
        C, A, base, L = m['size'], m['atlas'], m['base'], m['length']
        occ = np.array(m['occupancy'], bool)
        cell = C // occ.shape[0]
        step = L / 20
        r0, r1 = m['rows'][0] - step * 0.5, m['rows'][1] + step * 0.5
        c0, c1 = m['cols'][0] - step * 0.5, m['cols'][1] + step * 0.5
        nr = int(math.ceil((r1 - r0) / step)) + 1
        nc = int(math.ceil((c1 - c0) / step)) + 1
        rows = np.linspace(r0, r1, nr)
        cols = np.linspace(c0, c1, nc)
        keep = []
        for a in range(nr - 1):
            for b in range(nc - 1):
                ya0, ya1 = int(max(0, rows[a] // cell)), int(min(occ.shape[0] - 1, rows[a + 1] // cell))
                xb0, xb1 = int(max(0, cols[b] // cell)), int(min(occ.shape[1] - 1, cols[b + 1] // cell))
                if occ[ya0:ya1 + 1, xb0:xb1 + 1].any():
                    keep.append((a, b))
        used = sorted({(a + da, b + db) for a, b in keep for da in (0, 1) for db in (0, 1)})
        index = {k: n for n, k in enumerate(used)}
        sh = LITTER_SHAPE[m['name']]
        half = max(abs(cols[0] - C / 2), abs(cols[-1] - C / 2)) / L      # widest reach, leaf units
        verts, uvs = [], []
        for a, b in used:
            r, c = rows[a], cols[b]
            u = (c - C / 2) / L
            t = (base - r) / L
            tc = min(1.0, max(0.0, t))
            rho = math.hypot(u, t - 0.30)                      # from a maple's palm
            z = (sh['cup'] * half * (abs(u) / half) ** 1.8 * (1 + sh['twist'] * math.copysign(1, u))
                 + sh['palm'] * (rho / 0.7) ** 2
                 + sh['arch'] * math.sin(math.pi * tc)
                 + sh['tip'] * smoothstep(0.7, 1.0, t) ** 2
                 + sh['wave'] * math.sin(11 * t + 4 * u + i) * abs(u) / half
                 + 0.03 * smoothstep(0.0, -0.1, t))                     # the petiole lifts
            verts.append(np.array([u, t - 0.45, z]) * LITTER_LEN)
            uvs.append(((m['cell'][1] + c) / A, 1 - (m['cell'][0] + r) / A))
        V = np.array(verts)
        V[:, 2] -= V[:, 2].min()
        faces = [(index[(a, b)], index[(a, b + 1)], index[(a + 1, b + 1)], index[(a + 1, b)])
                 for a, b in keep]
        me = bpy.data.meshes.new(name)
        me.from_pydata([tuple(v) for v in V], [], faces)
        me.validate()
        uvl = me.uv_layers.new(name='UVMap')
        for loop in me.loops:
            uvl.data[loop.index].uv = uvs[loop.vertex_index]
        for p in me.polygons:
            p.use_smooth = True
        # a face's winding decides which way its normal points; make them all face up
        bm = bmesh.new()
        bm.from_mesh(me)
        for f in bm.faces:
            f.normal_update()
            if f.normal.z < 0:
                f.normal_flip()
        bm.to_mesh(me)
        bm.free()
        o = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(o)
        mat = textured_material('Litter', image('Litter'), image('Litter_n', True), rough=0.62, alpha_clip=True)
        me.materials.append(mat)
        for x in bpy.context.scene.objects:
            x.select_set(x == o)
        bpy.ops.export_scene.gltf(
            filepath=os.path.join(OUT, name + '.gltf'), export_format='GLTF_SEPARATE',
            use_selection=True, export_yup=True, export_apply=True,
            export_image_format='AUTO', export_texture_dir='', export_extras=False,
            export_animations=False,
        )
        log(f'{name}: {2 * len(faces)} tris, {len(V)} verts')
        made.append(name)
    return made


# --- driver -------------------------------------------------------------------------------

def refine(name):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(SRC, name + '.gltf'))
    obj = next(x for x in bpy.context.scene.objects if x.type == 'MESH')
    # the refined materials take the kit's own names ('Leaves', 'Grass', ...), so the
    # imported originals step aside rather than leaving the new ones as 'Leaves.001'
    for m in bpy.data.materials:
        m.name = m.name + '_src'
    before = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    seed = zlib.crc32(name.encode())                  # stable across runs, unlike hash()
    if name in GRASS:
        columns, rings = GRASS[name]
        rebuild_grass(obj, columns, rings, seed=seed)
    elif name in CARDS:
        refine_cards(obj, **CARDS[name])
        retexture(obj, {'Leaves': LEAVES, 'Flowers': FLOWERS})
        if not name.startswith('Petal'):          # petals lie flat: nothing to occlude
            height_ramp(obj)
    elif name in STONES:
        round_, target, lump = STONES[name]
        refine_stone(obj, round_, target, lump, seed % 97)
    elif name.startswith('Mushroom'):
        refine_mushroom(obj, 5200 if name == 'Mushroom_Laetiporus' else 2200)
    else:
        return None
    after = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    for o in bpy.context.scene.objects:
        o.select_set(o == obj)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(OUT, name + '.gltf'), export_format='GLTF_SEPARATE',
        use_selection=True, export_yup=True, export_apply=True,
        export_vertex_color='ACTIVE', export_image_format='AUTO',
        export_texture_dir='', export_extras=False, export_animations=False,
    )
    log(f'{name}: {before} -> {after} tris')
    return after


names = sorted(f[:-5] for f in os.listdir(SRC) if f.endswith('.gltf'))
for n in names:
    if ONLY and n not in ONLY:
        continue
    refine(n)
build_litter()
