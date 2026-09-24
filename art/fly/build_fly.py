"""
The pet's body: flybody's Drosophila, turned into a game asset.

Source: the Blender model behind `flybody`, the fruit fly body model built by Google
DeepMind and HHMI Janelia (Apache-2.0) - see NOTICE. It is anatomically exact and far
too heavy to ship: 272k triangles, most of them in two places. Each compound eye is
~30k triangles of individually modelled ommatidia, and 363 bristles are modelled as
tubes. Everything else is clean single-shell body segments, each rigidly parented to
its own bone of an 86-bone skeleton - an exoskeleton, rigged like one.

What this script does, in stages that each save a .blend so later ones can be rerun
without the slow ones:

  lod     every part copied twice: a HIGH reference for baking, and a LOW game mesh.
          Macrochaetae (the ~50 long bristles a fly is recognised by) are rebuilt as
          light tubes along their own fitted, curved centrelines. Microchaetae, the
          other 313, stay only in HIGH - they become baked detail. The eyes become a
          clean dome with the facets left to the normal map.
  bake    one UV atlas for the whole body; normal, occlusion and colour baked from
          HIGH onto LOW with Cycles.
  rig     every LOW part rigidly skinned to the bone it was parented to, joined per
          material, wings folded into the rest pose, clips authored with the model's
          own foot IK, exported as glb.

Run:  blender --background --python art/fly/build_fly.py -- <stage> <workdir>
"""
import bpy
import bmesh
import math
import os
import sys

import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
STAGE, WORK = argv[0], argv[1]
SRC = os.path.join(WORK, 'drosophila.blend')

# Bristles at least this long are macrochaetae and stay as geometry. Measured over all
# 363 bristle islands: 50 clear it, 24 on the head and 26 on the thorax - close to the
# real count of Drosophila macrochaetae. The median bristle is 0.082.
MACRO = 0.12

# Triangle budgets per part in the game mesh. Parts not listed get RATIO_DEFAULT of
# their source count. Eyes and bristles are handled separately.
BUDGET = {
    'head': 1700, 'thorax': 2800, 'rostrum': 420, 'haustellum': 360,
    'labrum_left': 120, 'labrum_right': 120,
    'antenna_left': 760, 'antenna_right': 760,
    'haltere_left': 150, 'haltere_right': 150,
    'abdomen_1': 380, 'abdomen_8': 380,
}
BUDGET_PREFIX = {
    'abdomen_': 300, 'coxa_': 260, 'femur_': 340, 'tibia_': 270,
    'tarsus_T1_1': 110, 'tarsus_T2_1': 120, 'tarsus_T3_1': 130,
    'tarsus_': 76, 'tarsal_claw_': 96,
}
EYE_TRIS = 1100          # per eye
OCELLUS_TRIS = 44        # per ocellus
BRISTLE = {'black', 'bristle-brown'}


def log(*a):
    print('[build_fly]', *a, flush=True)


# --- small, context-free helpers -----------------------------------------------------

def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def bake_transform(o):
    """Put the object's world transform into its vertices and clear its parenting."""
    mw = o.matrix_world.copy()
    o.parent = None
    o.data.transform(mw)
    o.matrix_world.identity()


def apply_modifiers(o):
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    old = o.data
    o.modifiers.clear()
    o.data = me
    if old.users == 0:
        bpy.data.meshes.remove(old)


def copy_object(o, name, coll):
    c = o.copy()
    c.data = o.data.copy()
    c.name = name
    coll.objects.link(c)
    return c


def split_by_material(o, coll):
    """One object per material slot actually used. Returns {material name: object}."""
    out = {}
    used = {p.material_index for p in o.data.polygons}
    for mi in sorted(used):
        mat = o.material_slots[mi].material
        name = mat.name if mat else 'none'
        me = o.data.copy()
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index != mi], context='FACES')
        bm.to_mesh(me)
        bm.free()
        # keep only the one material, as slot 0
        me.materials.clear()
        me.materials.append(mat)
        for p in me.polygons:
            p.material_index = 0
        part = bpy.data.objects.new(f'{o.name}:{name}', me)
        for k, v in o.items():
            part[k] = v
        coll.objects.link(part)
        out[name] = part
    return out


def islands(me):
    """Connected components as lists of face indices."""
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    seen, comps = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, comp = [f], []
        seen.add(f.index)
        while stack:
            g = stack.pop()
            comp.append(g.index)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        stack.append(h)
        comps.append(comp)
    bm.free()
    return comps


def decimate(o, target, symmetric=False):
    n = tris(o)
    if n <= target:
        return
    m = o.modifiers.new('dec', 'DECIMATE')
    m.decimate_type = 'COLLAPSE'
    m.ratio = max(0.001, target / n)
    m.use_collapse_triangulate = True
    if symmetric:
        m.use_symmetry = True
        m.symmetry_axis = 'Y'           # the fly's lateral axis in this file
    apply_modifiers(o)


def smooth_interior(o, iterations=6, factor=0.5):
    """Laplacian smoothing with the open boundary pinned, so a dome keeps its rim."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    rim = [v for v in bm.verts if v.is_boundary]
    inner = [v for v in bm.verts if not v.is_boundary]
    for _ in range(iterations):
        bmesh.ops.smooth_vert(bm, verts=inner, factor=factor,
                              use_axis_x=True, use_axis_y=True, use_axis_z=True)
    del rim
    bm.to_mesh(o.data)
    bm.free()


def shade_smooth(o):
    for p in o.data.polygons:
        p.use_smooth = True


# --- bristles --------------------------------------------------------------------------

def bristle_tubes(o, min_len, sides=3, rings=4):
    """
    Rebuild each long bristle as a light tube following its own curved centreline.

    Collapse-decimating a thin tube tends to fold it flat or eat it entirely, so each
    island is refitted instead: its vertices are binned along their principal axis,
    each bin's centroid becomes a point on the centreline (which keeps the bristle's
    curve) and each bin's spread becomes the radius there. The thick end is the socket.
    """
    me = o.data
    V = np.array([v.co[:] for v in me.vertices])
    comps = islands(me)
    verts, faces = [], []
    kept = 0
    for comp in comps:
        vid = sorted({i for fi in comp for i in me.polygons[fi].vertices})
        P = V[vid]
        c = P.mean(0)
        _, _, vt = np.linalg.svd(P - c, full_matrices=False)
        ax = vt[0]
        t = (P - c) @ ax
        if t.max() - t.min() < min_len:
            continue
        edges = np.linspace(t.min(), t.max(), rings + 1)
        centers, radii = [], []
        for i in range(rings):
            m = (t >= edges[i]) & (t <= edges[i + 1])
            pts = P[m] if m.any() else P[np.argsort(np.abs(t - (edges[i] + edges[i + 1]) / 2))[:3]]
            cc = pts.mean(0)
            d = pts - cc
            d -= np.outer(d @ ax, ax)
            centers.append(cc)
            radii.append(float(np.linalg.norm(d, axis=1).mean()) if len(pts) > 1 else 0.004)
        # the socket end is the thick one
        tip = P[np.argmax(t)] if radii[0] >= radii[-1] else P[np.argmin(t)]
        if radii[0] < radii[-1]:
            centers, radii = centers[::-1], radii[::-1]
        base = len(verts)
        for i, (cc, r) in enumerate(zip(centers, radii)):
            nxt = centers[i + 1] if i + 1 < len(centers) else tip
            prv = centers[i - 1] if i > 0 else cc - (nxt - cc)
            tan = np.asarray(nxt) - np.asarray(prv)
            tan /= np.linalg.norm(tan) + 1e-12
            ref = np.array([0.0, 0.0, 1.0]) if abs(tan[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
            u = np.cross(tan, ref)
            u /= np.linalg.norm(u)
            w = np.cross(tan, u)
            # taper: never thicker than the source, thinning to the tip
            rr = max(0.0025, r * (1 - 0.55 * i / rings))
            for k in range(sides):
                a = 2 * math.pi * k / sides
                verts.append(tuple(np.asarray(cc) + rr * (math.cos(a) * u + math.sin(a) * w)))
        verts.append(tuple(tip))
        tip_i = len(verts) - 1
        for i in range(rings - 1):
            for k in range(sides):
                a0 = base + i * sides + k
                a1 = base + i * sides + (k + 1) % sides
                b0 = a0 + sides
                b1 = a1 + sides
                faces.append((a0, a1, b1, b0))
        last = base + (rings - 1) * sides
        for k in range(sides):
            faces.append((last + k, last + (k + 1) % sides, tip_i))
        kept += 1
    new = bpy.data.meshes.new(me.name + '_tubes')
    new.from_pydata(verts, [], faces)
    new.materials.append(me.materials[0])
    o.data = new
    return kept, len(comps)


# --- stage: lod ------------------------------------------------------------------------

def stage_lod():
    bpy.ops.wm.open_mainfile(filepath=SRC)
    for o in list(bpy.data.objects):
        if o.type == 'MESH' and o.parent is None:
            bpy.data.objects.remove(o)              # the reference ground plane

    arm = bpy.data.objects['Armature']
    parts = [o for o in bpy.data.objects if o.type == 'MESH' and o.parent == arm]
    log('parts', len(parts), 'source tris', sum(tris(o) for o in parts))

    high = bpy.data.collections.new('HIGH')
    low = bpy.data.collections.new('LOW')
    bpy.context.scene.collection.children.link(high)
    bpy.context.scene.collection.children.link(low)

    for o in parts:
        bone = o.parent_bone
        o['bone'] = bone
        h = copy_object(o, f'{o.name}.high', high)
        apply_modifiers(h)
        bake_transform(h)
        h['bone'] = bone

        src = copy_object(o, f'{o.name}.src', low)
        apply_modifiers(src)
        bake_transform(src)
        pieces = split_by_material(src, low)
        bpy.data.objects.remove(src)

        body_like = {k: v for k, v in pieces.items() if k not in BRISTLE | {'red', 'ocelli'}}
        # wing veins become a texture on the membrane; the geometry is kept only for that
        if o.name.startswith('wing_') and 'brown' in body_like:
            veins = body_like.pop('brown')
            veins.name = f'{o.name}:veins'
            veins['kind'] = 'veins'
            low.objects.unlink(veins)
            high.objects.link(veins)

        budget = BUDGET.get(o.name)
        if budget is None:
            for pre, b in BUDGET_PREFIX.items():
                if o.name.startswith(pre):
                    budget = b
                    break
        total = sum(tris(p) for p in body_like.values()) or 1
        symmetric = o.name in ('head', 'thorax') or o.name.startswith('abdomen')
        for name, p in body_like.items():
            p['kind'] = 'membrane' if name == 'membrane' else ('claw' if name == 'brown' else 'cuticle')
            if name == 'membrane':
                # The source subdivides its 500-triangle wing once at export, to 2000.
                # It is flat, so collapsing back down loses nothing but the rounding of
                # the outline, which is what the budget is spent keeping.
                decimate(p, 760)
                shade_smooth(p)
                continue
            share = budget * tris(p) / total if budget else tris(p) * 0.12
            decimate(p, max(24, int(share)), symmetric=symmetric)
            shade_smooth(p)

        for name in BRISTLE & pieces.keys():
            p = pieces[name]
            kept, seen = bristle_tubes(p, MACRO)
            p['kind'] = 'bristle'
            if kept == 0:
                bpy.data.objects.remove(p)
            else:
                shade_smooth(p)
                log(f'  {o.name}: {kept}/{seen} bristles kept as geometry')

        if 'red' in pieces:
            eye = pieces['red']
            n_eyes = len(islands(eye.data))
            decimate(eye, EYE_TRIS * n_eyes)
            smooth_interior(eye, iterations=8, factor=0.5)
            shade_smooth(eye)
            eye['kind'] = 'eye'
        if 'ocelli' in pieces:
            oc = pieces['ocelli']
            decimate(oc, OCELLUS_TRIS * len(islands(oc.data)))
            shade_smooth(oc)
            oc['kind'] = 'ocellus'

    for o in parts:
        bpy.data.objects.remove(o)

    lows = [o for o in low.objects]
    log('LOW objects', len(lows), 'tris', sum(tris(o) for o in lows))
    by = {}
    for o in lows:
        by[o['kind']] = by.get(o['kind'], 0) + tris(o)
    log('LOW tris by kind', by)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(WORK, 'fly_lod.blend'))
    log('saved', os.path.join(WORK, 'fly_lod.blend'))


# --- stage: bake -----------------------------------------------------------------------

# Wild-type Drosophila melanogaster, female, read off macro photographs: a yellowish
# tan body, the thorax a shade darker and browner, the abdomen banded - each dorsal
# tergite dark along its hind margin, broad on the midline and thinning toward the
# flanks - pale underneath, pale legs, brick-red eyes, black bristles.
PALETTE = {
    # Pushed darker and warmer than a photograph reads, because the game tone-maps with
    # AgX, which compresses and desaturates: the first pass shipped a cream fly whose
    # tergite bands all but vanished on screen.
    'thorax': '#8a6236', 'head': '#9c7040', 'abdomen': '#b98d52', 'band': '#1f140b',
    'lower': '#cbb487', 'leg': '#c09656', 'antenna': '#a87a42', 'proboscis': '#bf9660',
    'labellum': '#c9ad7c', 'haltere': '#d0b98c', 'eye': '#a3150d', 'ocellus': '#4a2a14',
    'bristle': '#140d08', 'claw': '#2e1e12', 'membrane': '#9aa4ab', 'vein': '#5a3a22',
}
ATLAS = 2048
WING_TEX = 1024


def lin(hexstr):
    c = [int(hexstr[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c) + (1.0,)


def palette_key(part, mat):
    if mat in BRISTLE:
        return 'bristle'
    if mat == 'red':
        return 'eye'
    if mat == 'ocelli':
        return 'ocellus'
    if mat == 'brown':
        return 'vein' if part.startswith('wing') else 'claw'
    if mat == 'membrane':
        return 'membrane'
    if mat == 'lower':
        return 'labellum' if part.startswith('labrum') else 'lower'
    for pre, key in (('thorax', 'thorax'), ('head', 'head'), ('abdomen', 'abdomen'),
                     ('coxa', 'leg'), ('femur', 'leg'), ('tibia', 'leg'), ('tarsus', 'leg'),
                     ('antenna', 'antenna'), ('rostrum', 'proboscis'),
                     ('haustellum', 'proboscis'), ('haltere', 'haltere')):
        if part.startswith(pre):
            return key
    return 'head'


def flat_material(name, key):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    if key == 'abdomen':
        # the tergite bands come in as a per-vertex mask painted from each segment's bone
        attr = nt.nodes.new('ShaderNodeAttribute')
        attr.attribute_name = 'band'
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.inputs['A'].default_value = lin(PALETTE['abdomen'])
        mix.inputs['B'].default_value = lin(PALETTE['band'])
        nt.links.new(attr.outputs['Fac'], mix.inputs['Factor'])
        nt.links.new(mix.outputs['Result'], bsdf.inputs['Base Color'])
    else:
        bsdf.inputs['Base Color'].default_value = lin(PALETTE[key])
    return m


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def paint_bands(o, arm):
    """Dark hind margin on each dorsal tergite, from the segment's own bone axis."""
    part = o.name.split('.')[0]
    n = int(part.split('_')[1])
    b = arm.data.bones[part]
    h = arm.matrix_world @ b.head_local
    t = arm.matrix_world @ b.tail_local
    ax = t - h
    length = ax.length
    ax.normalize()
    ys = [abs(v.co.y) for v in o.data.vertices]
    half = max(ys) or 1.0
    attr = o.data.color_attributes.new('band', 'FLOAT_COLOR', 'POINT')
    for v in o.data.vertices:
        s = (v.co - h).dot(ax) / length          # 0 at the front edge, 1 at the back
        lat = abs(v.co.y) / half                 # 0 on the midline, 1 at the flank
        if n >= 7:
            d = 0.8                              # the tip is dark all over
        elif n >= 2:
            edge = 0.46 + 0.30 * lat             # band narrows toward the flanks
            # a real band has a crisp front edge: a narrow transition, nearly full dark
            d = smoothstep(edge - 0.025, edge + 0.025, s) * (1.0 - 0.35 * lat ** 2)
        else:
            d = 0.0
        attr.data[v.index].color = (d, d, d, 1.0)


# An exact colour no bake can produce: fully saturated magenta in the albedo, and a
# zero-length vector in the normal map.
SENTINEL = (1.0, 0.0, 1.0, 1.0)


def dilate(img, iterations=16):
    """
    Grow every baked island outward into the unbaked pixels around it, so mipmaps and
    texture filtering at island edges pull in the island's own colour rather than the
    sentinel. Done once over the whole atlas - see why in stage_bake.
    """
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    a = px.reshape(h, w, 4)
    empty = (np.abs(a[..., 0] - 1) < 1e-3) & (a[..., 1] < 1e-3) & (np.abs(a[..., 2] - 1) < 1e-3)
    for _ in range(iterations):
        if not empty.any():
            break
        acc = np.zeros((h, w, 4), np.float32)
        cnt = np.zeros((h, w), np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            src_full = ~np.roll(empty, (dy, dx), (0, 1))
            acc += np.roll(a, (dy, dx), (0, 1)) * src_full[..., None]
            cnt += src_full
        grow = empty & (cnt > 0)
        a[grow] = acc[grow] / cnt[grow][:, None]
        empty &= ~grow
    # whatever is still unreached is far from any island: a neutral value, not magenta
    a[empty] = (0.5, 0.5, 1.0, 1.0) if img.colorspace_settings.name == 'Non-Color' else (0.5, 0.4, 0.3, 1.0)
    img.pixels.foreach_set(a.ravel())
    img.update()


def select_only(objs, active):
    # Objects removed moments ago can linger in the view layer as None until it syncs.
    bpy.context.view_layer.update()
    for o in bpy.context.view_layer.objects:
        if o is not None:
            o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active


def join(objs, name):
    select_only(objs, objs[0])
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    return o


def new_image(name, size, non_color=False, alpha=False, fill=(0.5, 0.5, 1.0, 1.0)):
    w, h = size if isinstance(size, tuple) else (size, size)
    img = bpy.data.images.new(name, w, h, alpha=alpha, float_buffer=False)
    img.generated_color = fill
    if non_color:
        img.colorspace_settings.name = 'Non-Color'
    return img


def target_material(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    node = m.node_tree.nodes.new('ShaderNodeTexImage')
    node.name = 'BAKE_TARGET'
    m.node_tree.nodes.active = node
    return m


def set_target(obj, img):
    for slot in obj.material_slots:
        node = slot.material.node_tree.nodes['BAKE_TARGET']
        node.image = img
        slot.material.node_tree.nodes.active = node


def stage_bake():
    bpy.ops.wm.open_mainfile(filepath=os.path.join(WORK, 'fly_lod.blend'))
    high = bpy.data.collections['HIGH']
    low = bpy.data.collections['LOW']
    arm = bpy.data.objects['Armature']
    tex = os.path.join(WORK, 'tex')
    os.makedirs(tex, exist_ok=True)

    # Rigid skin, recorded now while each part still knows its bone. It survives joins.
    # The source carries its authors' own half-finished vertex groups ('Bone.073',
    # 'hastellum', 'R.LABRUM.003' ...) with live weights on 124 vertices; those go first,
    # so every vertex belongs to exactly one bone, as an exoskeleton plate should.
    for o in low.objects:
        o.vertex_groups.clear()
        vg = o.vertex_groups.new(name=o['bone'])
        vg.add(range(len(o.data.vertices)), 1.0, 'REPLACE')

    # --- colour sources: HIGH repainted with the palette, split by what it is ---------
    # Each LOW part bakes only from its own HIGH counterpart, and the eye only from the
    # eye. Baking everything against everything let the eye dome's rays land on the
    # head's cuticle and bristles - tan streaks across a red eye - and let a coxa's rays
    # reach up into the eye above it.
    sources = {}                                  # (part, role) -> [HIGH objects]
    for o in list(high.objects):
        part = o.name.split('.')[0].split(':')[0]
        if o.get('kind') == 'veins':
            sources.setdefault((part, 'veins'), []).append(o)
            continue
        if part.startswith('abdomen'):
            paint_bands(o, arm)
        for slot in o.material_slots:
            src = slot.material.name if slot.material else 'body'
            slot.material = flat_material(f'pal_{palette_key(part, src)}', palette_key(part, src))
        pieces = split_by_material(o, high)
        bpy.data.objects.remove(o)
        for mname, piece in pieces.items():
            role = {'pal_eye': 'eye', 'pal_bristle': 'bristle', 'pal_ocellus': 'ocellus',
                    'pal_membrane': 'membrane', 'pal_vein': 'veins'}.get(mname, 'cuticle')
            piece['role'] = role
            sources.setdefault((part, role), []).append(piece)

    # --- the atlas: every cuticle part and both eyes, sharing one UV space -------------
    # Unwrapped and packed as ONE object, because packing several objects in multi-edit
    # mode left 2.6% of the atlas overlapping - the eyes' islands sitting on top of the
    # abdomen's and the femur's, so whichever baked last won. Each face remembers which
    # part it came from, so the joined object can be split straight back for baking.
    cut = target_material('role_cuticle')
    eye = target_material('role_eye')
    atlas = [o for o in low.objects if o['kind'] in ('cuticle', 'eye')]
    names = []
    for i, o in enumerate(atlas):
        o.data.materials.clear()
        o.data.materials.append(eye if o['kind'] == 'eye' else cut)
        names.append((o.name.split(':')[0].split('.')[0], o['kind'], o['bone']))
        at = o.data.attributes.new('part_idx', 'INT', 'FACE')
        at.data.foreach_set('value', [i] * len(o.data.polygons))
    body = join(atlas, 'fly_body')
    select_only([body], body)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    # A wide angle limit: fewer, larger islands. At 62 degrees the decimated parts
    # shattered into thousands of slivers, each paying for its own margin, and only 27%
    # of the atlas ended up holding texels.
    bpy.ops.uv.smart_project(angle_limit=math.radians(78), island_margin=0.001,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.average_islands_scale()
    # The eyes carry ~800 facets each; give them more texels than their area earns.
    bm = bmesh.from_edit_mesh(body.data)
    uv = bm.loops.layers.uv.active
    eye_slot = [i for i, sl in enumerate(body.material_slots) if sl.material == eye][0]
    for comp in _uv_islands([f for f in bm.faces if f.material_index == eye_slot], uv):
        pts = [l[uv].uv.copy() for f in comp for l in f.loops]
        c = sum(pts, Vector((0, 0))) / len(pts)
        for f in comp:
            for l in f.loops:
                l[uv].uv = c + (l[uv].uv - c) * 2.3
    # pack_islands moves only UV-SELECTED islands, and UV selection is separate from
    # mesh selection - with some islands left unselected, the ones average_islands_scale
    # had just enlarged stayed where they were, overlapping the packed ones.
    bmesh.update_edit_mesh(body.data)
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin=0.0015, shape_method='CONCAVE')
    bpy.ops.object.mode_set(mode='OBJECT')
    # ...and back into parts, UVs and all
    idx = np.zeros(len(body.data.polygons), dtype=np.int32)
    body.data.attributes['part_idx'].data.foreach_get('value', idx)
    atlas = []
    for i, (part, kind, bone) in enumerate(names):
        me = body.data.copy()
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if idx[f.index] != i], context='FACES')
        bm.to_mesh(me)
        bm.free()
        o = bpy.data.objects.new(f'{part}:{kind}', me)
        o['kind'], o['bone'] = kind, bone
        low.objects.link(o)                 # vertex group names travel with the mesh
        atlas.append(o)
    bpy.data.objects.remove(body)

    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 1
    bk = sc.render.bake
    # No margin while baking part by part: each bake's margin dilates its own islands
    # over whatever neighbouring islands were baked before it, which painted the eye
    # tan and the head red. The images start as a sentinel colour instead, and the
    # gaps are filled once, globally, after every part is in (see dilate()).
    bk.margin = 0
    bk.use_clear = False
    bk.normal_space = 'TANGENT'
    bk.use_selected_to_active = True

    normal = new_image('fly_normal', ATLAS, non_color=True, fill=SENTINEL)
    albedo = new_image('fly_albedo', ATLAS, fill=SENTINEL)
    for o in atlas:
        part = o.name.split(':')[0].split('.')[0]
        roles = ('eye',) if o['kind'] == 'eye' else ('cuticle', 'bristle')
        src = [h for r in roles for h in sources.get((part, r), [])]
        if not src:
            log('  no source for', o.name)
            continue
        # a smoothed, decimated eye dome drifts further from the faceted original than a
        # decimated segment does from its source, so its rays have to reach further
        bk.cage_extrusion = 0.04 if o['kind'] == 'eye' else 0.025
        bk.max_ray_distance = 0.11 if o['kind'] == 'eye' else 0.07
        for h in high.objects:
            h.hide_render = h not in src
        for kind, img, extra in (('NORMAL', normal, {}),
                                 ('DIFFUSE', albedo, {'pass_filter': {'COLOR'}})):
            set_target(o, img)
            select_only(src + [o], o)
            bpy.ops.object.bake(type=kind, **extra)
    for img in (normal, albedo):
        dilate(img, iterations=16)
        img.filepath_raw = os.path.join(tex, img.name + '.png')
        img.file_format = 'PNG'
        img.save()
        log('baked', img.name)

    # Occlusion from the game mesh itself, every other part standing in as occluders -
    # the leg where it meets the thorax, one tergite under the next. Wings are
    # translucent in the game and would shadow the whole back, so they are left out.
    body = join(atlas, 'fly_body')
    for o in high.objects:
        o.hide_render = True
    for o in low.objects:
        o.hide_render = o.get('kind') == 'membrane'
    ao = new_image('fly_ao', ATLAS, non_color=True, fill=(1, 1, 1, 1))
    set_target(body, ao)
    sc.cycles.samples = 48
    bk.use_selected_to_active = False
    bk.use_clear = True
    bk.margin = 12
    select_only([body], body)
    bpy.ops.object.bake(type='AO')
    ao.filepath_raw = os.path.join(tex, 'fly_ao.png')
    ao.file_format = 'PNG'
    ao.save()
    log('baked fly_ao')

    # --- wings: veins baked onto the membrane as an alpha mask -------------------------
    wings = [o for o in low.objects if o['kind'] == 'membrane']
    wmat = target_material('role_wing')
    for w in wings:
        w.data.materials.clear()
        w.data.materials.append(wmat)
    wobj = join(wings, 'fly_wings')
    _planar_uv(wobj)
    vein_src = [h for (p, r), hs in sources.items() if r == 'veins' for h in hs]
    for o in high.objects:
        o.hide_render = o not in vein_src
    for o in low.objects:
        o.hide_render = o != wobj
    veins = new_image('fly_wing_veins', WING_TEX, alpha=True, fill=(0, 0, 0, 0))
    set_target(wobj, veins)
    sc.cycles.samples = 1
    bk.use_selected_to_active = True
    bk.cage_extrusion = 0.03
    bk.max_ray_distance = 0.06
    bk.margin = 2
    bk.use_clear = False                 # keep the transparent fill where no vein is hit
    select_only(vein_src + [wobj], wobj)
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'})
    veins.filepath_raw = os.path.join(tex, 'fly_wing_veins.png')
    veins.file_format = 'PNG'
    veins.save()
    log('baked fly_wing_veins')

    for o in list(bpy.data.objects):
        o.hide_render = False
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(WORK, 'fly_baked.blend'))
    log('saved', os.path.join(WORK, 'fly_baked.blend'))


def _uv_islands(faces, uv):
    """Group faces into islands connected through shared UV coordinates."""
    left = set(faces)
    out = []
    by_vert = {}
    for f in faces:
        for l in f.loops:
            by_vert.setdefault(l.vert.index, []).append((f, l))
    while left:
        seed = left.pop()
        comp, stack = [seed], [seed]
        while stack:
            f = stack.pop()
            for l in f.loops:
                for g, gl in by_vert[l.vert.index]:
                    if g in left and (gl[uv].uv - l[uv].uv).length < 1e-6:
                        left.discard(g)
                        comp.append(g)
                        stack.append(g)
        out.append(comp)
    return out


def _planar_uv(o):
    """Both wings flattened onto their best-fit plane, one wing per half of the texture."""
    me = o.data
    if not me.uv_layers:
        me.uv_layers.new(name='UVMap')
    uv = me.uv_layers.active.data
    V = np.array([v.co[:] for v in me.vertices])
    left = V[:, 1] < 0                       # the fly's left is -Y in this file
    coords = np.zeros((len(V), 2))
    for half, mask in ((0, left), (1, ~left)):
        P = V[mask]
        c = P.mean(0)
        _, _, vt = np.linalg.svd(P - c, full_matrices=False)
        q = (P - c) @ vt[:2].T
        lo, hi = q.min(0), q.max(0)
        span = (hi - lo)[0] * 1.04                      # the long axis fills the width
        q = (q - (lo + hi) / 2) / span                  # square texels: same scale on both
        q[:, 0] += 0.5
        q[:, 1] += 0.25 + 0.5 * half                    # left wing low half, right high
        assert (hi - lo)[1] / span < 0.5, 'a wing is too wide for its half'
        coords[mask] = q
    for loop in me.loops:
        uv[loop.index].uv = coords[loop.vertex_index]


# --- stage: rig ------------------------------------------------------------------------

# How the wings rest. A resting Drosophila folds them back over the abdomen, nearly flat
# and overlapping on the midline, one over the other. The source model holds them spread
# sideways. Angles are about the hinge, in the body's own frame (X back, Y left-to-right,
# Z up).
WING_FOLD = math.radians(102)          # sideways -> backwards, 12 degrees past, to overlap
WING_DROOP = math.radians(7)           # down along their length, to lie on the abdomen
WING_STACK = math.radians(1.2)         # the left wing a hair lower, so the two never z-fight

# glTF names three.js keeps; these are the bones the game drives by code rather than clips
CODE_BONES = ['head', 'antenna_left', 'antenna_right', 'wing_left', 'wing_right',
              'haltere_left', 'haltere_right']
HELPERS = ['tarsus_end_T1_left', 'tarsus_end_T1_right', 'tarsus_end_T2_left',
           'tarsus_end_T2_right', 'tarsus_end_T3_left', 'tarsus_end_T3_right', 'abdomen_end']


def image(name, non_color=False):
    img = bpy.data.images.load(os.path.join(WORK, 'tex', name + '.png'), check_existing=True)
    if non_color:
        img.colorspace_settings.name = 'Non-Color'
    return img


def gltf_output_group():
    """The node group Blender's glTF exporter reads an occlusion map from."""
    g = bpy.data.node_groups.get('glTF Material Output')
    if g:
        return g
    g = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
    g.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    g.interface.new_socket('Thickness', in_out='INPUT', socket_type='NodeSocketFloat')
    g.nodes.new('NodeGroupInput')
    return g


def game_material(name, *, albedo=None, normal=None, ao=None, color=None, rough=0.5,
                  coat=0.0, coat_rough=0.05, alpha_blend=False, film=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Roughness'].default_value = rough
    if color is not None:
        b.inputs['Base Color'].default_value = color
    if albedo is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = albedo
        nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
        if alpha_blend:
            nt.links.new(t.outputs['Alpha'], b.inputs['Alpha'])
    if normal is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = normal
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    if ao is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = ao
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        grp = nt.nodes.new('ShaderNodeGroup')
        grp.node_tree = gltf_output_group()
        nt.links.new(t.outputs['Color'], sep.inputs['Color'])
        nt.links.new(sep.outputs['Red'], grp.inputs['Occlusion'])
    if coat:
        b.inputs['Coat Weight'].default_value = coat
        b.inputs['Coat Roughness'].default_value = coat_rough
    if film:
        b.inputs['Thin Film Thickness'].default_value = film
        b.inputs['Thin Film IOR'].default_value = 1.33
    if alpha_blend:
        m.surface_render_method = 'BLENDED'
        m.use_backface_culling = False
    return m


def wing_texture():
    """
    Membrane and veins in one RGBA map. The bake gives veins at alpha 1 on a fully
    transparent membrane; a wing is not invisible, so the membrane gets a faint smoky
    tint at low alpha and the veins stay nearly opaque.
    """
    src = image('fly_wing_veins')
    w, h = src.size
    px = np.empty(w * h * 4, np.float32)
    src.pixels.foreach_get(px)
    a = px.reshape(h, w, 4)
    vein = a[..., 3:4]
    tint = np.array(lin(PALETTE['membrane'])[:3], np.float32)
    out = np.empty_like(a)
    out[..., :3] = a[..., :3] * vein + tint * (1 - vein)
    # the wing's own outline is geometry, so the membrane can be tinted everywhere
    out[..., 3] = vein[..., 0] * 0.92 + (1 - vein[..., 0]) * 0.12
    img = bpy.data.images.new('fly_wing', w, h, alpha=True)
    img.pixels.foreach_set(out.ravel())
    img.filepath_raw = os.path.join(WORK, 'tex', 'fly_wing.png')
    img.file_format = 'PNG'
    img.save()
    return img


def body_axes_in_bone(arm, name):
    """The body's own axes (back, left-to-right, up) written in a bone's local frame."""
    R = arm.data.bones[name].matrix_local.to_3x3().inverted()
    # Blender Z-up, fly facing -X. glTF export turns (x, y, z) into (x, z, -y), and a
    # bone's LOCAL frame is carried over unchanged, so these stay valid in three.js.
    return {k: list(R @ Vector(v)) for k, v in
            (('back', (1, 0, 0)), ('right', (0, 1, 0)), ('up', (0, 0, 1)))}


def rotate_about(arm, pb, axis_world, angle):
    """Rotate a pose bone about a body-frame axis through its own head."""
    from mathutils import Matrix
    M = pb.bone.matrix_local.copy() if pb.matrix is None else pb.matrix.copy()
    head = M.translation.copy()
    R = Matrix.Rotation(angle, 4, Vector(axis_world).normalized())
    pb.matrix = Matrix.Translation(head) @ R @ Matrix.Translation(-head) @ M
    bpy.context.view_layer.update()


def stage_rig():
    bpy.ops.wm.open_mainfile(filepath=os.path.join(WORK, 'fly_baked.blend'))
    arm = bpy.data.objects['Armature']
    for o in list(bpy.data.collections['HIGH'].objects):
        bpy.data.objects.remove(o)

    albedo, normal, ao = image('fly_albedo'), image('fly_normal', True), image('fly_ao', True)
    mats = {
        'cuticle': game_material('fly_cuticle', albedo=albedo, normal=normal, ao=ao, rough=0.52),
        # corneal lenses are glassy: a clear coat over the faceted red
        'eye': game_material('fly_eye', albedo=albedo, normal=normal, ao=ao, rough=0.34,
                             coat=1.0, coat_rough=0.06),
        'bristle': game_material('fly_bristle', color=lin(PALETTE['bristle']), rough=0.34),
        'claw': game_material('fly_claw', color=lin(PALETTE['claw']), rough=0.4),
        'ocellus': game_material('fly_ocellus', color=lin(PALETTE['ocellus']), rough=0.12, coat=1.0),
        # a real wing is a thin film: it shows interference colours
        'wing': game_material('fly_wing', albedo=wing_texture(), rough=0.18,
                              alpha_blend=True, film=320.0),
    }
    low = bpy.data.collections['LOW']
    parts = []
    for o in list(low.objects):
        kind = o.get('kind')
        role = {'cuticle': 'cuticle', 'eye': 'eye', 'bristle': 'bristle', 'claw': 'claw',
                'ocellus': 'ocellus', 'membrane': 'wing'}.get(kind)
        if o.name == 'fly_body':
            for slot in o.material_slots:
                slot.material = mats['eye' if slot.material.name.startswith('role_eye') else 'cuticle']
        elif o.name == 'fly_wings':
            o.data.materials.clear()
            o.data.materials.append(mats['wing'])
        elif role:
            o.data.materials.clear()
            o.data.materials.append(mats[role])
        else:
            continue
        parts.append(o)
    fly = join(parts, 'fly')
    for p in fly.data.polygons:
        p.use_smooth = True
    fly.parent = arm
    mod = fly.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm
    log('game mesh', tris(fly), 'tris,', len(fly.material_slots), 'materials,',
        len(fly.vertex_groups), 'bones used')

    # --- fold the wings, then make that the rest pose ---------------------------------
    # By the membrane's own geometry, not its bone: the source wings are swept back and
    # raised in a dihedral, so turning them about the bone left them pointing up and
    # back. Each wing's long axis and surface normal are measured, then rotated onto
    # "backwards, a little inward, a little down" and "normal straight up".
    from mathutils import Matrix
    select_only([arm], arm)
    bpy.ops.object.mode_set(mode='POSE')
    names = [g.name for g in fly.vertex_groups]
    for side, sign in (('left', 1), ('right', -1)):
        gi = names.index(f'wing_{side}')
        P = np.array([v.co[:] for v in fly.data.vertices
                      if any(g.group == gi and g.weight > 0 for g in v.groups)])
        hinge = arm.data.bones[f'wing_{side}'].head_local
        c = P.mean(0)
        _, _, vt = np.linalg.svd(P - c, full_matrices=False)
        along = Vector(vt[0])
        if along.dot(Vector(c) - hinge) < 0:
            along = -along
        up = Vector(vt[2])
        if up.z < 0:
            up = -up
        # where it should point: back, toward the midline, and down onto the abdomen
        inward = math.radians(12)
        droop = WING_DROOP + (WING_STACK if side == 'left' else 0.0)
        tgt_along = Vector((math.cos(inward), sign * math.sin(inward), 0.0))
        tgt_along = (tgt_along * math.cos(droop) - Vector((0, 0, 1)) * math.sin(droop)).normalized()
        tgt_up = (Vector((0, 0, 1)) - tgt_along * tgt_along.z).normalized()
        src = Matrix((along, up, along.cross(up))).transposed()
        dst = Matrix((tgt_along, tgt_up, tgt_along.cross(tgt_up))).transposed()
        R = (dst @ src.inverted()).to_4x4()
        pb = arm.pose.bones[f'wing_{side}']
        pb.matrix = Matrix.Translation(hinge) @ R @ Matrix.Translation(-hinge) @ pb.matrix
        bpy.context.view_layer.update()
    bpy.ops.object.mode_set(mode='OBJECT')
    select_only([fly], fly)
    bpy.ops.object.modifier_apply(modifier='Armature')
    select_only([arm], arm)
    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    mod = fly.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm

    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(WORK, 'fly_rig.blend'))
    log('saved', os.path.join(WORK, 'fly_rig.blend'))


# --- stage: clips ----------------------------------------------------------------------
#
# Poses the game cross-fades between. Legs are authored by where the FEET go - the
# flybody authors rigged every leg with IK from coxa to claw - and the joint angles the
# solver finds are baked down to plain rotations, since three.js has no IK.
#
# What stays out of clips, as before: the wingbeat and haltere beat (oscillators at rates
# no 24-frame clip could sample), where the head looks and how the antennae move (both
# driven from the brain every frame), and the walk's PHASE - the clip is the shape of a
# stride, the motor neurons decide where in it the fly is.

LEGS = [f'T{i}_{s}' for i in (1, 2, 3) for s in ('left', 'right')]
TRIPOD = {'T1_left': 0, 'T2_right': 0, 'T3_left': 0, 'T1_right': 1, 'T2_left': 1, 'T3_right': 1}
CHAIN = ['coxa', 'femur', 'tibia', 'tarsus_{}_1', 'tarsus_{}_2', 'tarsus_{}_3', 'tarsus_{}_4', 'tarsal_claw']


def leg_bones(leg):
    t, side = leg.split('_')
    out = []
    for c in CHAIN:
        out.append(c.format(t) + f'_{side}' if '{}' in c else f'{c}_{t}_{side}')
    return out


def record(arm, names):
    """The solved, visual pose of each bone, as the local transform a clip can key."""
    bpy.context.view_layer.update()
    out = {}
    for n in names:
        pb = arm.pose.bones[n]
        out[n] = arm.convert_space(pose_bone=pb, matrix=pb.matrix, from_space='POSE', to_space='LOCAL')
    return out


def ik_miss(arm, legs=LEGS):
    """Worst distance between an IK chain's tip and its target, after solving."""
    bpy.context.view_layer.update()
    worst = 0.0
    for leg in legs:
        tip = arm.pose.bones[f'tarsus_{leg.split("_")[0]}_4_{leg.split("_")[1]}'].tail
        tgt = arm.pose.bones[f'tarsus_end_{leg}'].head
        worst = max(worst, (tip - tgt).length)
    return worst


def free_limits(arm, legs, on=True):
    """
    The flybody legs carry joint limits sized for walking. Grooming folds a foreleg up
    over the head, far outside them, and with the limits on the solver fell 0.35-0.6
    units short of the face. Twist locks stay; only the range limits come off.
    """
    for leg in legs:
        for n in leg_bones(leg):
            pb = arm.pose.bones[n]
            pb.use_ik_limit_x = pb.use_ik_limit_y = pb.use_ik_limit_z = not on


def place_feet(arm, feet):
    """Move each leg's IK target to an absolute armature-space position."""
    from mathutils import Matrix
    for leg, pos in feet.items():
        pb = arm.pose.bones[f'tarsus_end_{leg}']
        rest = pb.bone.matrix_local
        pb.matrix = Matrix.Translation(Vector(pos)) @ rest.to_3x3().to_4x4()


def reset_pose(arm):
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)


def keyframes(arm, action_name, frames):
    """frames: list of (frame number, {bone: local matrix}) -> a clean action."""
    act = bpy.data.actions.new(action_name)
    act.use_fake_user = True
    arm.animation_data_create()
    arm.animation_data.action = act
    for f, pose in frames:
        for n, M in pose.items():
            pb = arm.pose.bones[n]
            loc, rot, _ = M.decompose()
            pb.rotation_quaternion = rot
            pb.keyframe_insert('rotation_quaternion', frame=f)
            if loc.length > 1e-5:
                pb.location = loc
                pb.keyframe_insert('location', frame=f)
    arm.animation_data.action = None
    return act


def body_rotation(arm, name, axis, angle):
    """A local matrix turning a bone about a body-frame axis through its head."""
    from mathutils import Matrix
    b = arm.data.bones[name]
    R = b.matrix_local.to_3x3().inverted() @ Matrix.Rotation(angle, 3, Vector(axis)) @ b.matrix_local.to_3x3()
    return R.to_4x4()


def stage_clips():
    bpy.ops.wm.open_mainfile(filepath=os.path.join(WORK, 'fly_rig.blend'))
    arm = bpy.data.objects['Armature']
    select_only([arm], arm)
    bpy.ops.object.mode_set(mode='POSE')
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    reset_pose(arm)
    rest_feet = {leg: arm.data.bones[f'tarsus_end_{leg}'].head_local.copy() for leg in LEGS}
    legs_all = [b for leg in LEGS for b in leg_bones(leg)]
    posed = legs_all + ['thorax']

    # --- walk: alternating tripod, 24 frames ---------------------------------------------
    # A real Drosophila stride is about half a body length (Wosnitza et al. 2013, J Exp
    # Biol). 0.9 units is 0.3 of this body - long enough that the legs cycle at a
    # believable rate for the game's walking speeds without the feet skating, short
    # enough that the walking joint limits still reach it (the log reports the miss).
    STRIDE, LIFT, N = 0.9, 0.16, 24
    frames = []
    for f in range(N + 1):
        t = f / N
        feet = {}
        for leg, grp in TRIPOD.items():
            p = (t + 0.5 * grp) % 1.0
            if p < 0.5:                       # stance: planted, the body passes over it
                u = p / 0.5
                dx, dz = -STRIDE / 2 + STRIDE * u, 0.0
            else:                             # swing: up and forward again
                u = (p - 0.5) / 0.5
                dx, dz = STRIDE / 2 - STRIDE * u, LIFT * math.sin(math.pi * u)
            r = rest_feet[leg]
            feet[leg] = (r.x + dx, r.y, r.z + dz)
        place_feet(arm, feet)
        # the body rides up and down once per tripod, and rolls onto the side in stance
        arm.pose.bones['thorax'].rotation_quaternion = body_rotation(
            arm, 'thorax', (1, 0, 0), 0.018 * math.sin(2 * math.pi * t)).to_quaternion()
        miss = max(locals().get('miss', 0.0), ik_miss(arm))
        frames.append((f, record(arm, posed)))
    log(f'  walk: worst foot miss {miss:.3f}')
    reset_pose(arm)
    for c in _ik(arm):
        c.mute = True
    keyframes(arm, 'walk', frames)
    for c in _ik(arm):
        c.mute = False

    # --- groom: forelegs up in front of the face, rubbing the antennae -------------------
    # Antennal grooming is what aDN1 commands. Both front tarsi sweep down over the
    # antennae and eyes in loops, out of phase; the other four legs stand.
    ant = arm.data.bones['antenna_left'].head_local
    G = 20
    frames = []
    free_limits(arm, ['T1_left', 'T1_right'])
    miss = 0.0
    for f in range(G + 1):
        t = f / G
        feet = dict(rest_feet)
        for side, sign, ph in (('left', -1, 0.0), ('right', 1, 0.5)):
            a = 2 * math.pi * (t + ph)
            feet[f'T1_{side}'] = (ant.x - 0.16 + 0.10 * math.cos(a), sign * (0.12 + 0.05 * math.sin(a)),
                                  ant.z - 0.10 + 0.13 * math.sin(a))
        place_feet(arm, feet)
        # head dipped into the working legs. About +Y a positive angle lifts the head.
        arm.pose.bones['thorax'].rotation_quaternion = body_rotation(arm, 'thorax', (0, 1, 0), -0.10).to_quaternion()
        miss = max(miss, ik_miss(arm, ['T1_left', 'T1_right']))
        frames.append((f, record(arm, posed)))
    log(f'  groom: worst foreleg miss {miss:.3f}')
    free_limits(arm, ['T1_left', 'T1_right'], on=False)
    reset_pose(arm)
    for c in _ik(arm):
        c.mute = True
    keyframes(arm, 'groom', frames)
    for c in _ik(arm):
        c.mute = False

    # --- flight: legs tucked, the body pitched into the direction of travel -------------
    tuck = {'T1': (0.25, 0.55, 0.50), 'T2': (0.05, 0.60, 0.62), 'T3': (-0.35, 0.55, 0.62)}
    feet = {}
    for leg in LEGS:
        t, side = leg.split('_')
        r = rest_feet[leg]
        dx, inward, up = tuck[t]
        feet[leg] = (r.x + dx, r.y * inward, r.z + up)
    free_limits(arm, LEGS)
    place_feet(arm, feet)
    # nose down into the direction of travel
    arm.pose.bones['thorax'].rotation_quaternion = body_rotation(arm, 'thorax', (0, 1, 0), -0.12).to_quaternion()
    log(f'  flight: worst foot miss {ik_miss(arm):.3f}')
    pose = record(arm, posed)
    free_limits(arm, LEGS, on=False)
    reset_pose(arm)
    for c in _ik(arm):
        c.mute = True
    keyframes(arm, 'flight', [(0, pose), (2, pose)])
    for c in _ik(arm):
        c.mute = False

    # --- startle: rearing back, front legs braced, middle legs loaded to jump ------------
    feet = dict(rest_feet)
    for side in ('left', 'right'):
        r = rest_feet[f'T1_{side}']
        feet[f'T1_{side}'] = (r.x - 0.10, r.y, r.z)
    place_feet(arm, feet)
    # rearing: the head comes up off the braced front legs
    arm.pose.bones['thorax'].rotation_quaternion = body_rotation(arm, 'thorax', (0, 1, 0), 0.22).to_quaternion()
    pose = record(arm, posed)
    reset_pose(arm)
    for c in _ik(arm):
        c.mute = True
    keyframes(arm, 'startle', [(0, pose), (2, pose)])
    for c in _ik(arm):
        c.mute = False

    # --- proboscis: retracted, then out and down onto the food ---------------------------
    # Proboscis extension is what MN9 commands, and the game scrubs this clip by that
    # readout rather than playing it. Retracted, the labellum is tucked up under the face;
    # extended, the rostrum drops, the haustellum points straight down and the two
    # labellar lobes open onto the surface. Angles chosen from close-up renders: turning
    # the haustellum the other way pokes the labellum forward at nothing.
    def proboscis_pose(rostrum, haustellum, lobes):
        return {
            'rostrum': body_rotation(arm, 'rostrum', (0, 1, 0), rostrum),
            'haustellum': body_rotation(arm, 'haustellum', (0, 1, 0), haustellum),
            'labrum_left': body_rotation(arm, 'labrum_left', (1, 0, 0), -lobes),
            'labrum_right': body_rotation(arm, 'labrum_right', (1, 0, 0), lobes),
        }
    keyframes(arm, 'proboscis', [(0, proboscis_pose(-0.25, 0.40, 0.0)),
                                 (12, proboscis_pose(0.45, -0.75, 0.42))])

    # No idle clip. three's mixer blends whatever weight is left over toward each bone's
    # bind pose, which here IS the standing pose - so a held rest clip adds nothing but
    # bytes, and recording one with the IK live nudged every leg a hair off the bind pose.

    # the game derives a no-slip step rate from this: one walk cycle moves the body
    # exactly one stride, so cycles = distance walked / stride
    arm['stride'] = STRIDE
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(WORK, 'fly_anim.blend'))
    log('clips', [a.name for a in bpy.data.actions])


def _ik(arm):
    return [c for pb in arm.pose.bones for c in pb.constraints if c.type == 'IK']


def stage_export():
    bpy.ops.wm.open_mainfile(filepath=os.path.join(WORK, 'fly_anim.blend'))
    out = os.path.join(WORK, 'drosophila_raw.glb')
    arm = bpy.data.objects['Armature']
    fly = bpy.data.objects['fly']
    # The clips are baked rotations now. Left in, the IK would be evaluated again at
    # export and drag every foot back to where its target rests.
    for pb in arm.pose.bones:
        for c in list(pb.constraints):
            pb.constraints.remove(c)
    select_only([arm], arm)
    bpy.ops.object.mode_set(mode='EDIT')
    for n in HELPERS:
        eb = arm.data.edit_bones.get(n)
        if eb:
            arm.data.edit_bones.remove(eb)
    bpy.ops.object.mode_set(mode='OBJECT')
    # every action on its own NLA track, or the exporter writes only the active one
    arm.animation_data_create()
    arm.animation_data.action = None
    for tr in list(arm.animation_data.nla_tracks):
        arm.animation_data.nla_tracks.remove(tr)
    for a in bpy.data.actions:
        tr = arm.animation_data.nla_tracks.new()
        tr.name = a.name
        tr.strips.new(a.name, int(a.frame_range[0]), a)
    select_only([arm, fly], arm)
    bpy.ops.export_scene.gltf(
        filepath=out, export_format='GLB', use_selection=True,
        export_animations=True, export_skins=True, export_apply=False,
        export_yup=True, export_extras=True, export_image_format='AUTO',
        export_animation_mode='NLA_TRACKS', export_force_sampling=True,
        export_optimize_animation_size=True,
    )
    log('exported', out, os.path.getsize(out), 'bytes')


if STAGE == 'lod':
    stage_lod()
elif STAGE == 'bake':
    stage_bake()
elif STAGE == 'rig':
    stage_rig()
elif STAGE == 'clips':
    stage_clips()
elif STAGE == 'export':
    stage_export()
else:
    raise SystemExit(f'unknown stage {STAGE}')
