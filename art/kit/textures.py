"""
Textures for the refined scenery, generated rather than painted, so every one of them
is reproducible from this file.

The Quaternius kit is 512 px of hand-painted atlas, which is lovely at the scale it was
made for and falls apart at the scale this game shows it: a blade of grass here is taller
than the fly, and its whole texture was a four-colour stripe - which is why the grass read
as wooden slats. What is generated here:

  grass    a blade atlas, four variants side by side (fresh, deep green, dry straw,
           mixed): parallel venation and a midrib, a pale etiolated base where the
           blade leaves the sheath, streaking along the length, a drying tip on the dry
           ones - with a matching normal map.
  leaves   the kit's own leaf atlas re-rendered at four times the resolution: every
           sprite keeps its silhouette and its painted colour, and gains pinnate
           venation, a midrib, reticulation and a normal map.
  flowers  the same for the petal atlas, with veins radiating from each petal's base.
  stone    a tileable granite-and-sandstone surface for the pebbles and rocks, with grain,
           quartz flecks and a normal map; they are re-meshed round, so their old painted
           facets no longer fit them.
  litter   four fallen leaves the kit never had - oak, beech, birch, maple - dry and
           part-decayed, with the outline each mesh is built from (refine_kit.py).

Normal maps are in glTF's convention: OpenGL, +Y toward the top of the image.

Run:  python3 art/kit/textures.py <outdir> [which...]
"""
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

OUT = sys.argv[1] if len(sys.argv) > 1 else 'art/.cache/kit_tex'
SRC = os.path.join(os.path.dirname(__file__), '..', 'src', 'nature')
os.makedirs(OUT, exist_ok=True)


# --- building blocks ------------------------------------------------------------------

def hexrgb(h):
    return np.array([int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)], np.float32)


def value_noise(h, w, cells_y, cells_x, seed, wrap=False):
    """
    Smooth value noise on a (cells_y x cells_x) lattice, bicubically upsampled. With wrap,
    the lattice is one period and is upsampled as one (grid-mode wrap), so the result
    tiles exactly - an earlier version padded the lattice instead and left a seam eleven
    times the noise's own texel-to-texel variation.
    """
    rng = np.random.default_rng(seed)
    if wrap:
        g = rng.random((cells_y, cells_x)).astype(np.float32)
        return ndi.zoom(g, (h / cells_y, w / cells_x), order=3, mode='grid-wrap', grid_mode=True)[:h, :w]
    g = rng.random((cells_y + 3, cells_x + 3)).astype(np.float32)
    z = ndi.zoom(g, ((h + 3 * h / cells_y) / (cells_y + 3), (w + 3 * w / cells_x) / (cells_x + 3)),
                 order=3, mode='nearest')
    return z[:h, :w]


def fbm(h, w, base_y, base_x, octaves, seed, gain=0.5, wrap=False):
    """Fractal sum of value noise, normalised to [0, 1]."""
    out = np.zeros((h, w), np.float32)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        out += amp * value_noise(h, w, base_y * 2 ** o, base_x * 2 ** o, seed + o, wrap)
        total += amp
        amp *= gain
    out /= total
    return (out - out.min()) / (out.max() - out.min() + 1e-9)


def normal_map(height, strength):
    """Height field -> OpenGL tangent-space normal map (glTF): +Y is up the image."""
    gr, gc = np.gradient(height.astype(np.float32))       # d/drow, d/dcol
    n = np.stack([-gc * strength, gr * strength, np.ones_like(height)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return (np.clip(n * 0.5 + 0.5, 0, 1) * 255 + 0.5).astype(np.uint8)


def save_rgb(a, path):
    Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)).save(path)


def save_rgba(rgb, alpha, path):
    a = np.dstack([np.clip(rgb, 0, 1), np.clip(alpha, 0, 1)])
    Image.fromarray((a * 255 + 0.5).astype(np.uint8), 'RGBA').save(path)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def ramp(v, stops):
    """Piecewise-linear colour ramp: stops = [(position, rgb), ...] over v in [0,1]."""
    out = np.zeros(v.shape + (3,), np.float32)
    pos = [p for p, _ in stops]
    for ch in range(3):
        out[..., ch] = np.interp(v, pos, [c[ch] for _, c in stops])
    return out


# --- grass ------------------------------------------------------------------------------

GRASS_VARIANTS = [
    # base (where it leaves the sheath) -> lower -> middle -> tip. Saturated and a shade
    # dark on purpose: the game tone-maps with AgX, which pulls colour out, and the first
    # pass came back looking like dried hay.
    dict(stops=['#b8c46a', '#6ea23a', '#3f8424', '#5a9630'], dry=0.0, seed=11),   # fresh
    dict(stops=['#a9bb5f', '#4f8a2c', '#2b6a1c', '#3f7a26'], dry=0.0, seed=23),   # deep
    dict(stops=['#b0ac6a', '#c2aa6a', '#b09662', '#8e764a'], dry=1.0, seed=37),   # straw
    dict(stops=['#b6c26a', '#78a03c', '#6f9236', '#a88e48'], dry=0.55, seed=51),  # mixed
]
GRASS_COLUMNS = len(GRASS_VARIANTS)


def grass_atlas(size=1024):
    """
    Four blades side by side; within a column u runs across the blade and v along it.
    The blade's outline is its geometry, so the texture fills the column. In the image
    the TIP is at the top: glTF's v runs downward, and the blades are unwrapped with
    Blender's v = 0 at the base.
    """
    H, W = size, size
    cw = W // GRASS_COLUMNS
    albedo = np.zeros((H, W, 3), np.float32)
    height = np.zeros((H, W), np.float32)
    rows = np.arange(H, dtype=np.float32)[:, None]
    v = 1.0 - (rows + 0.5) / H                              # 0 at the base, 1 at the tip
    for i, var in enumerate(GRASS_VARIANTS):
        cols = np.arange(cw, dtype=np.float32)[None, :]
        u = (cols + 0.5) / cw                              # 0..1 across the blade
        vv = np.broadcast_to(v, (H, cw))
        uu = np.broadcast_to(u, (H, cw))
        stops = [hexrgb(s) for s in var['stops']]
        col = ramp(vv, [(0.0, stops[0]), (0.12, stops[1]), (0.55, stops[2]), (1.0, stops[3])])
        # Parallel venation: grass is a monocot, so its veins run the length of the blade.
        # Eleven across and a broader midrib; they read lighter against the lamina.
        veins = np.zeros((H, cw), np.float32)
        for k, uk in enumerate(np.linspace(0.07, 0.93, 13)):
            w = 0.011 if abs(uk - 0.5) > 0.01 else 0.03
            veins += np.exp(-((uu - uk) / w) ** 2) * (1.0 if abs(uk - 0.5) < 0.01 else 0.55)
        veins = np.clip(veins, 0, 1)
        # streaks: noise stretched hard along the length
        streak = fbm(H, cw, 6, 48, 4, var['seed'])
        mottle = fbm(H, cw, 24, 12, 4, var['seed'] + 5)
        speck = (fbm(H, cw, 256, 64, 1, var['seed'] + 9) > 0.93).astype(np.float32)
        light = 1.0 + 0.10 * veins - 0.10 * (streak - 0.5) - 0.06 * (mottle - 0.5) - 0.12 * speck
        # the margins are a shade darker: the blade is thinner there and edge-lit less
        edge = smoothstep(0.0, 0.10, uu) * smoothstep(0.0, 0.10, 1 - uu)
        light *= 0.86 + 0.14 * edge
        c = col * light[..., None]
        # veins also shift toward yellow-green, as the vascular bundles do
        c = c * (1 - 0.18 * veins[..., None]) + np.array([0.80, 0.84, 0.52]) * 0.18 * veins[..., None] * col.mean(-1, keepdims=True) * 1.6
        if var['dry'] > 0:
            # a drying blade browns from the tip back, unevenly
            dry = smoothstep(0.62, 1.0, vv + 0.18 * (streak - 0.5)) * var['dry']
            c = c * (1 - 0.55 * dry[..., None]) + hexrgb('#7a5a34') * 0.55 * dry[..., None]
        albedo[:, i * cw:(i + 1) * cw] = c
        height[:, i * cw:(i + 1) * cw] = 0.9 * veins - 0.4 * (streak - 0.5) + 0.15 * mottle
    save_rgb(albedo, os.path.join(OUT, 'GrassBlades.png'))
    Image.fromarray(normal_map(height, 3.0)).save(os.path.join(OUT, 'GrassBlades_n.png'))
    print('grass atlas', albedo.shape)


# --- shared sprite machinery -------------------------------------------------------------

def upscale_sprites(path, factor):
    """
    An alpha-cut atlas at `factor` times the resolution: colour upsampled premultiplied
    (so edges do not pick up the transparent pixels' colour as a dark fringe), alpha
    re-sharpened into a clean antialiased edge, and the colour then bled outward into
    the transparent area so mipmapping pulls in each sprite's own colour, not black.
    """
    im = Image.open(path).convert('RGBA')
    w, h = im.size
    W, H = w * factor, h * factor
    a = np.asarray(im).astype(np.float32) / 255
    pre = a[..., :3] * a[..., 3:4]
    pre_up = np.asarray(Image.fromarray((pre * 255).astype(np.uint8)).resize((W, H), Image.LANCZOS)).astype(np.float32) / 255
    al_up = np.asarray(Image.fromarray((a[..., 3] * 255).astype(np.uint8)).resize((W, H), Image.LANCZOS)).astype(np.float32) / 255
    rgb = pre_up / np.maximum(al_up[..., None], 1e-3)
    alpha = smoothstep(0.38, 0.62, al_up)
    inside = alpha > 0.5
    idx = ndi.distance_transform_edt(~inside, return_distances=False, return_indices=True)
    rgb = rgb[idx[0], idx[1]]
    rgb = ndi.gaussian_filter(rgb, sigma=(0.8, 0.8, 0))           # the painted source is soft
    return np.clip(rgb, 0, 1), alpha, inside


def worley_edges(H, W, cell, seed):
    """Cell boundaries (F2 - F1 of Worley noise), 1 on an edge, 0 in a cell's middle."""
    rng = np.random.default_rng(seed)
    gy, gx = H // cell + 2, W // cell + 2
    pts = (np.stack(np.meshgrid(np.arange(gy), np.arange(gx), indexing='ij'), -1) + rng.random((gy, gx, 2))) * cell
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    cy, cx = (yy // cell).astype(int), (xx // cell).astype(int)
    f1 = np.full((H, W), 1e9, np.float32)
    f2 = np.full((H, W), 1e9, np.float32)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            py = pts[np.clip(cy + dy, 0, gy - 1), np.clip(cx + dx, 0, gx - 1), 0]
            px = pts[np.clip(cy + dy, 0, gy - 1), np.clip(cx + dx, 0, gx - 1), 1]
            d = np.hypot(yy - py, xx - px)
            f2 = np.where(d < f1, f1, np.minimum(f2, d))
            f1 = np.minimum(f1, d)
    return np.clip(1 - (f2 - f1) / (cell * 0.18), 0, 1)


def pulse(x, width):
    """Narrow repeating ridge: 1 where x is near an integer."""
    f = np.abs(x - np.round(x))
    return np.clip(1 - f / width, 0, 1) ** 2


def pinnate(inside, box, spacing, angle, midrib, seed):
    """
    Veins of a pinnate leaf, base at the bottom of `box`: a midrib down each row's middle
    and secondaries leaving it at `angle`, thinning toward the margin. Returns
    (primary, secondary) intensities over the box, zero outside the leaf.
    """
    y0, y1, x0, x1 = box
    m = inside[y0:y1, x0:x1]
    h, w = m.shape
    rows = np.where(m.any(1))[0]
    top, bot = rows.min(), rows.max()
    xc = np.full(h, w / 2, np.float32)
    hw = np.ones(h, np.float32)
    for r in rows:
        cols = np.where(m[r])[0]
        xc[r] = (cols.min() + cols.max()) / 2
        hw[r] = max(1.0, (cols.max() - cols.min()) / 2)
    # The midrib is a smooth curve fitted through each row's middle, weighted by width:
    # following the rows directly made it snake, because a lobed outline is not
    # symmetric row by row. Widths are an envelope for the same reason.
    wts = hw[rows] ** 2
    fit = np.polyfit(rows.astype(np.float32), xc[rows], 2, w=np.sqrt(wts))
    xc = np.polyval(fit, np.arange(h, dtype=np.float32)).astype(np.float32)
    hw = ndi.gaussian_filter1d(hw, max(8.0, h / 10))
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    L = max(1.0, bot - top)
    s = (bot - yy) / L                                   # 0 at the base, 1 at the tip
    t = (xx - xc[:, None]) / hw[:, None]                 # -1..1 across
    lam = np.clip(1 - np.abs(t), 0, 1)
    rib_w = (0.028 + 0.035 * (1 - s)) * np.maximum(hw[:, None], 1) / max(w, 1) * 6
    primary = np.exp(-(t / np.maximum(rib_w, 0.02)) ** 2) * midrib * (0.55 + 0.45 * (1 - s))
    # secondaries: lines s - k|t| = const, angled toward the tip, curving near the margin
    k = np.tan(np.radians(angle)) * (hw[:, None] / L)
    phase = (s - k * np.abs(t) ** 0.85) / spacing
    secondary = pulse(phase, 0.09 + 0.05 * lam) * (0.25 + 0.75 * lam) * (np.abs(t) > 0.04)
    secondary *= smoothstep(0.02, 0.10, s) * smoothstep(0.0, 0.08, 1 - s)
    return primary * m, secondary * m


def radial(inside, box, center, n_lobes, phase0, seed):
    """Veins radiating from a centre, strongest along each lobe's axis."""
    y0, y1, x0, x1 = box
    m = inside[y0:y1, x0:x1]
    h, w = m.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    cy, cx = center
    ang = np.arctan2(yy - cy, xx - cx)
    r = np.hypot(yy - cy, xx - cx)
    rmax = max(1.0, r[m].max())
    rn = r / rmax
    lobe = pulse((ang - phase0) * n_lobes / (2 * np.pi), 0.10) * smoothstep(0.02, 0.2, rn)
    fine = pulse((ang - phase0) * n_lobes * 7 / (2 * np.pi), 0.16) * smoothstep(0.05, 0.3, rn) * (1 - rn) ** 0.6
    return lobe * m, fine * m, rn


def shade(rgb, alpha, primary, secondary, tertiary, vein_tint, vein_gain, rim):
    """Veins lighter and tinted over the lamina; a faint darker rim at the margin."""
    veins = np.clip(primary * 0.9 + secondary * 0.55 + tertiary * 0.14, 0, 1)
    out = rgb * (1 - 0.07 * tertiary[..., None])
    vc = np.clip(rgb * vein_gain + vein_tint, 0, 1)
    out = out * (1 - veins[..., None]) + vc * veins[..., None]
    out *= (1 - rim * 0.18)[..., None]
    return np.clip(out, 0, 1), veins


# --- leaves ---------------------------------------------------------------------------------

# Each sprite of the kit's Leaves.png by label (see the order ndi.label finds them in),
# and how it is veined. Every leaf in the atlas stands tip-up; the three radial ones are
# two clovers and a violet.
LEAF_SPRITES = {
    1: ('pinnate', dict(spacing=0.085, angle=52)), 2: ('pinnate', dict(spacing=0.085, angle=52)),
    3: ('pinnate', dict(spacing=0.12, angle=46)), 4: ('pinnate', dict(spacing=0.09, angle=50)),
    5: ('pinnate', dict(spacing=0.09, angle=50)), 6: ('pinnate', dict(spacing=0.11, angle=44)),
    7: ('pinnate', dict(spacing=0.055, angle=58)), 9: ('pinnate', dict(spacing=0.06, angle=56)),
    10: ('pinnate', dict(spacing=0.08, angle=48)), 11: ('pinnate', dict(spacing=0.08, angle=48)),
    8: ('radial', dict(lobes=3, clover=True)), 13: ('radial', dict(lobes=5, clover=True)),
    12: ('radial', dict(lobes=4, clover=False)),
}


def leaves_atlas(factor=4):
    src = os.path.join(SRC, 'Leaves.png')
    rgb, alpha, inside = upscale_sprites(src, factor)
    H, W = alpha.shape
    small = np.asarray(Image.open(src).convert('RGBA'))[..., 3] > 128
    lab, n = ndi.label(small)
    boxes = ndi.find_objects(lab)
    prim = np.zeros((H, W), np.float32)
    sec = np.zeros((H, W), np.float32)
    ter = worley_edges(H, W, 11 * factor // 4, seed=5) * inside
    chevron = np.zeros((H, W), np.float32)
    for label, (kind, p) in LEAF_SPRITES.items():
        sl = boxes[label - 1]
        pad = 2 * factor
        box = (max(0, sl[0].start * factor - pad), min(H, sl[0].stop * factor + pad),
               max(0, sl[1].start * factor - pad), min(W, sl[1].stop * factor + pad))
        y0, y1, x0, x1 = box
        if kind == 'pinnate':
            a, b = pinnate(inside, box, p['spacing'], p['angle'], 1.0, label)
        else:
            m = inside[y0:y1, x0:x1]
            cy, cx = ndi.center_of_mass(m)
            # lobes point where the outline reaches furthest from the centre
            yy, xx = np.nonzero(m)
            ang = np.arctan2(yy - cy, xx - cx)
            rr = np.hypot(yy - cy, xx - cx)
            hist, edges = np.histogram(ang, bins=180, range=(-np.pi, np.pi), weights=rr ** 4)
            phase0 = edges[np.argmax(hist)]
            a, b, rn = radial(inside, box, (cy, cx), p['lobes'], phase0, label)
            if p['clover']:
                # white clover's pale chevron, a band on each leaflet about halfway out
                chevron[y0:y1, x0:x1] = np.maximum(chevron[y0:y1, x0:x1],
                    np.exp(-((rn - 0.52) / 0.06) ** 2) * m * 0.9)
        prim[y0:y1, x0:x1] = np.maximum(prim[y0:y1, x0:x1], a)
        sec[y0:y1, x0:x1] = np.maximum(sec[y0:y1, x0:x1], b)
    # no darkened margin: on a real leaf there is none, and here it read as an outline
    out, veins = shade(rgb, alpha, prim, sec, ter, vein_tint=np.array([0.05, 0.06, 0.0]),
                       vein_gain=1.10, rim=np.zeros_like(alpha))
    out = out * (1 - 0.45 * chevron[..., None]) + np.array([0.86, 0.9, 0.78]) * 0.45 * chevron[..., None]
    mottle = fbm(H, W, 32, 32, 4, 17)
    out *= (0.94 + 0.12 * mottle)[..., None]
    save_rgba(out, alpha, os.path.join(OUT, 'Leaves.png'))
    height = (-0.8 * prim - 0.45 * sec - 0.12 * ter + 0.2 * mottle) * inside
    Image.fromarray(normal_map(ndi.gaussian_filter(height, 0.8), 4.0)).save(os.path.join(OUT, 'Leaves_n.png'))
    print('leaves atlas', out.shape)


# --- flowers --------------------------------------------------------------------------------

# Flowers.png by label: petal count, and whether its veins read darker (nectar guides,
# as on a pansy) or lighter. These five also dress the fallen "petals" the scene uses as
# leaf litter and the Dust token, so they are seen at macro range.
FLOWER_SPRITES = {
    1: dict(petals=5, dark=False),   # cream
    2: dict(petals=3, dark=True),    # pansy
    3: dict(petals=5, dark=False),   # pink
    4: dict(petals=6, dark=False),   # red
    5: dict(petals=6, dark=False),   # yellow
}


def flowers_atlas(factor=4):
    src = os.path.join(SRC, 'Flowers.png')
    rgb, alpha, inside = upscale_sprites(src, factor)
    H, W = alpha.shape
    small = np.asarray(Image.open(src).convert('RGBA'))[..., 3] > 128
    lab, n = ndi.label(small)
    boxes = ndi.find_objects(lab)
    prim = np.zeros((H, W), np.float32)
    fine = np.zeros((H, W), np.float32)
    guide = np.zeros((H, W), np.float32)
    disc = np.zeros((H, W), np.float32)
    for label, p in FLOWER_SPRITES.items():
        sl = boxes[label - 1]
        pad = 2 * factor
        box = (max(0, sl[0].start * factor - pad), min(H, sl[0].stop * factor + pad),
               max(0, sl[1].start * factor - pad), min(W, sl[1].stop * factor + pad))
        y0, y1, x0, x1 = box
        m = inside[y0:y1, x0:x1] & (lab[np.clip(np.arange(y0, y1) // factor, 0, lab.shape[0] - 1)][:, np.clip(np.arange(x0, x1) // factor, 0, lab.shape[1] - 1)] == label)
        cy, cx = ndi.center_of_mass(m)
        yy, xx = np.nonzero(m)
        ang = np.arctan2(yy - cy, xx - cx)
        rr = np.hypot(yy - cy, xx - cx)
        hist, edges = np.histogram(ang, bins=180, range=(-np.pi, np.pi), weights=rr ** 4)
        phase0 = edges[np.argmax(hist)]
        a, b, rn = radial(inside, box, (cy, cx), p['petals'], phase0, label)
        a, b = a * m, b * m
        # the disc: stamens as a stippled ring of pollen dots
        yy2, xx2 = np.mgrid[0:y1 - y0, 0:x1 - x0].astype(np.float32)
        dots = (fbm(y1 - y0, x1 - x0, 40, 40, 1, 60 + label) > 0.72).astype(np.float32)
        d = np.exp(-((rn - 0.10) / 0.07) ** 2) * dots * m
        if p['dark']:
            # A pansy's nectar guides are thin dark lines fanning out of the throat, not
            # creases along each petal - and it has no disc, so no pollen stipple.
            throat = 1 - smoothstep(0.12, 0.55, rn)
            guide[y0:y1, x0:x1] = np.maximum(guide[y0:y1, x0:x1], b * throat * m)
            fine[y0:y1, x0:x1] = np.maximum(fine[y0:y1, x0:x1], b * 0.5 * (1 - throat))
        else:
            prim[y0:y1, x0:x1] = np.maximum(prim[y0:y1, x0:x1], a * (1 - smoothstep(0.55, 0.95, rn)))
            fine[y0:y1, x0:x1] = np.maximum(fine[y0:y1, x0:x1], b)
            disc[y0:y1, x0:x1] = np.maximum(disc[y0:y1, x0:x1], d)
    out, _ = shade(rgb, alpha, prim, fine, np.zeros_like(alpha), vein_tint=np.array([0.04, 0.03, 0.02]),
                   vein_gain=1.08, rim=np.zeros_like(alpha))
    # nectar guides: darker, more saturated lines toward the throat
    gc = np.clip(rgb * 0.45, 0, 1)
    out = out * (1 - 0.6 * guide[..., None]) + gc * 0.6 * guide[..., None]
    out = out * (1 - 0.5 * disc[..., None]) + np.array([0.95, 0.78, 0.30]) * 0.5 * disc[..., None]
    velvet = fbm(H, W, 64, 64, 3, 29)
    out *= (0.95 + 0.10 * velvet)[..., None]
    save_rgba(out, alpha, os.path.join(OUT, 'Flowers.png'))
    height = (-0.35 * prim - 0.5 * fine - 0.3 * guide + 0.6 * disc + 0.15 * velvet) * inside
    Image.fromarray(normal_map(ndi.gaussian_filter(height, 0.8), 3.0)).save(os.path.join(OUT, 'Flowers_n.png'))
    print('flowers atlas', out.shape)


# --- stone --------------------------------------------------------------------------------

def stone_tile(size=1024, seed=71):
    """
    A tileable stone surface: a granite-like body with mineral grains (quartz, feldspar,
    mica) and faint veins, over low-frequency colour drift. Every term wraps at the
    edges, so the texture repeats without a seam across a re-meshed pebble.
    """
    H = W = size
    rng = np.random.default_rng(seed)
    drift = fbm(H, W, 4, 4, 5, seed, wrap=True)
    grain = fbm(H, W, 64, 64, 3, seed + 1, wrap=True)
    base = ramp(drift, [(0.0, hexrgb('#55524d')), (0.5, hexrgb('#716d66')), (1.0, hexrgb('#8a857c'))])
    base *= (0.9 + 0.2 * grain)[..., None]
    # mineral grains as soft dots placed with wrap-around
    def dots(n, radius, color, strength):
        img = np.zeros((H, W), np.float32)
        ys = rng.integers(0, H, n)
        xs = rng.integers(0, W, n)
        img[ys, xs] = 1.0
        img = ndi.gaussian_filter(img, radius, mode='wrap')
        img = np.clip(img / (img.max() + 1e-9) * 3.0, 0, 1) * strength
        return img, color
    layers = [dots(9000, 1.3, hexrgb('#c4bfb5'), 0.7),       # quartz
              dots(5000, 1.8, hexrgb('#b79f8c'), 0.55),      # feldspar
              dots(7000, 0.9, hexrgb('#2b2926'), 0.75)]      # mica
    out = base
    hgt = 0.6 * drift + 0.25 * grain
    for img, col in layers:
        out = out * (1 - img[..., None]) + col * img[..., None]
        hgt += 0.15 * img
    # faint veins, wrap-compatible: integer frequencies, noise-warped
    warp = fbm(H, W, 8, 8, 3, seed + 7, wrap=True)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    vein = pulse((xx / W * 3 + yy / H * 2 + warp * 1.6), 0.018)
    out = out * (1 - 0.35 * vein[..., None]) + hexrgb('#cfcac0') * 0.35 * vein[..., None]
    hgt += 0.1 * vein
    save_rgb(out, os.path.join(OUT, 'Stone.png'))
    Image.fromarray(normal_map(ndi.gaussian_filter(hgt, 0.7, mode='wrap'), 6.0)).save(os.path.join(OUT, 'Stone_n.png'))
    print('stone tile', out.shape)


# --- leaf litter ------------------------------------------------------------------------------

# The kit has no fallen leaves. The scene had been making its litter out of the petal
# models - which are whole little flowers - tinted brown, and a clover plant laid on its
# side; at macro range that is what they looked like. These are four dead leaves of real
# shapes, each drawn in leaf coordinates: t runs up the midrib from the petiole (0) to
# the tip (1), u across it, both in leaf lengths.

def frac(x):
    return x - np.floor(x)


def ridge(uu, tt, a, b, width, taper=0.6):
    """A vein along the segment a-b: 1 on the line, falling off over `width`, thinning
    toward b."""
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    s = np.clip(((uu - ax) * dx + (tt - ay) * dy) / (dx * dx + dy * dy + 1e-12), 0, 1)
    d = np.hypot(uu - (ax + s * dx), tt - (ay + s * dy))
    return np.exp(-(d / (width * (1 - taper * s))) ** 2)


def midrib(uu, tt, bend, width, top=0.97):
    """The midrib, bowed by `bend`, running on down the petiole."""
    um = bend * np.sin(np.pi * np.clip(tt, 0, 1))
    w = width * (1 - 0.6 * np.clip(tt, 0, 1))
    on = (tt > -0.10) & (tt < top)
    return np.exp(-((uu - um) / w) ** 2) * on, um


def oak(uu, tt):
    """Pedunculate oak: rounded lobes meeting in sharp sinuses, widest above the middle,
    small ears at the base, and a vein out to every lobe."""
    t = np.clip(tt, 0, 1)
    rib, um = midrib(uu, tt, 0.015, 0.0075)
    du = uu - um
    n = 4.6
    env = lambda t: (0.30 * np.maximum(np.sin(np.pi * t), 0) ** 0.6 * (0.62 + 0.5 * t)
                     + 0.035 * np.exp(-((t - 0.035) / 0.03) ** 2))
    phase = np.where(du >= 0, 0.0, 0.18)                    # lobes nearly opposite
    fc = frac(n * t + phase + 0.5) - 0.5                    # 0 at a lobe's middle
    lobe = np.sqrt(np.clip(1 - (2 * fc) ** 2, 0, 1))        # round, meeting at a point
    w = env(t) * (0.5 + 0.5 * lobe)
    inside = (np.abs(du) < w) & (tt >= 0) & (tt <= 1)
    sec = np.zeros_like(uu)
    for side, ph in ((1, 0.0), (-1, 0.18)):
        for k in range(1, 6):
            tk = (k - ph) / n
            if not 0.08 < tk < 0.97:
                continue
            s0 = max(0.0, tk - 0.08)
            sec = np.maximum(sec, ridge(uu, tt, (0.015 * np.sin(np.pi * s0), s0),
                                        (0.015 * np.sin(np.pi * tk) + side * env(tk) * 0.9, tk), 0.0042))
    return inside, rib, sec


def beech(uu, tt):
    """Beech: elliptic, straight parallel veins, each ending in a small tooth."""
    t = np.clip(tt, 0, 1)
    rib, um = midrib(uu, tt, -0.012, 0.0065)
    du = uu - um
    n = 9
    w0 = 0.23 * np.maximum(np.sin(np.pi * t), 0) ** 0.8 * (1.08 - 0.22 * t)
    phase = np.where(du >= 0, 0.0, 0.35)
    tooth = frac(n * t + phase)
    w = w0 * (1 - 0.06 * tooth ** 2)
    inside = (np.abs(du) < w) & (tt >= 0) & (tt <= 1)
    sec = np.zeros_like(uu)
    for side, ph in ((1, 0.0), (-1, 0.35)):
        for k in range(1, n + 1):
            te = (k - ph) / n
            if not 0.10 < te < 0.95:
                continue
            we = 0.23 * np.sin(np.pi * te) ** 0.8 * (1.08 - 0.22 * te)
            ts = te - 0.10
            sec = np.maximum(sec, ridge(uu, tt, (-0.012 * np.sin(np.pi * ts), ts),
                                        (-0.012 * np.sin(np.pi * te) + side * we * 0.96, te), 0.0036))
    return inside, rib, sec


def birch(uu, tt):
    """Birch: broad ovate-deltoid, doubly toothed, widest low down."""
    t = np.clip(tt, 0, 1)
    rib, um = midrib(uu, tt, 0.01, 0.0065)
    du = uu - um
    w0 = 0.33 * np.maximum(np.sin(np.pi * t ** 0.72), 0) ** 0.85
    w = w0 * (1 - 0.05 * frac(13 * t) ** 2 - 0.022 * frac(39 * t) ** 2)
    inside = (np.abs(du) < w) & (tt >= 0) & (tt <= 1)
    sec = np.zeros_like(uu)
    for side in (1, -1):
        for k in range(1, 8):
            te = k / 7.6
            if te > 0.93:
                continue
            we = 0.33 * np.sin(np.pi * te ** 0.72) ** 0.85
            ts = max(0.02, te - 0.13)
            sec = np.maximum(sec, ridge(uu, tt, (0.01 * np.sin(np.pi * ts), ts),
                                        (0.01 * np.sin(np.pi * te) + side * we * 0.95, te), 0.0038))
    return inside, rib, sec


MAPLE_LOBES = [(0.0, 0.70, 0.46), (0.95, 0.56, 0.44), (-0.95, 0.56, 0.44),
               (1.95, 0.30, 0.40), (-1.95, 0.30, 0.40)]    # (angle, reach, half-width)
MAPLE_C = 0.30                                             # where the petiole joins


def maple(uu, tt):
    """Maple: palmate, five pointed and toothed lobes, a main vein out to each tip."""
    x, y = uu, tt - MAPLE_C
    rho = np.hypot(x, y)
    th = np.arctan2(x, y)                                  # 0 toward the tip
    palm = 0.2
    r = np.full_like(rho, palm)
    for ang, reach, sig in MAPLE_LOBES:
        d = np.abs(np.angle(np.exp(1j * (th - ang))))
        prof = np.clip(1 - d / sig, 0, 1) ** 1.25
        teeth = 1 - 0.08 * frac(d / sig * 3.2) ** 2 * (prof > 0.08)
        r = np.maximum(r, (palm + (reach - palm) * prof) * teeth)
    inside = rho < r
    inside &= ~((np.abs(th) > 2.75) & (rho > 0.05))          # the notch at the petiole
    stalk = (np.abs(uu) < 0.009) & (tt > -0.10) & (tt < MAPLE_C)
    inside |= stalk
    rib = np.exp(-(uu / 0.0065) ** 2) * ((tt > -0.10) & (tt < MAPLE_C + 0.02))
    sec = np.zeros_like(uu)
    for ang, reach, _ in MAPLE_LOBES:
        tip = (reach * 0.96 * np.sin(ang), MAPLE_C + reach * 0.96 * np.cos(ang))
        sec = np.maximum(sec, ridge(uu, tt, (0.0, MAPLE_C), tip, 0.0070))
        # side veins off each main vein, toward the teeth
        for f in (0.35, 0.6):
            p = (tip[0] * f, MAPLE_C + (tip[1] - MAPLE_C) * f)
            for s in (-1, 1):
                a2 = ang + s * 0.75
                q = (p[0] + 0.12 * reach * np.sin(a2), p[1] + 0.12 * reach * np.cos(a2))
                sec = np.maximum(sec, 0.6 * ridge(uu, tt, p, q, 0.0034))
    return inside, rib, sec


# name, outline, colour (dark, mid, light), vein colour, damage
LITTER = [
    ('oak', oak, ('#5e3a1c', '#8a5a2c', '#a8793f'), '#b99160', dict(holes=3, spots=5, lace=0.0)),
    ('beech', beech, ('#7a3e1c', '#a45a26', '#c07a38'), '#cf9a5c', dict(holes=1, spots=2, lace=0.55)),
    ('birch', birch, ('#8c6a22', '#b8902f', '#d2ae48'), '#e0c572', dict(holes=2, spots=9, lace=0.0)),
    ('maple', maple, ('#6e2a18', '#a8452a', '#c8662e'), '#d08a52', dict(holes=2, spots=3, lace=0.0)),
]


def litter_atlas(size=2048):
    """
    Four dead leaves in a 2 x 2 atlas, with an alpha cut-out, a normal map, and a
    description of each (Litter.json) that refine_kit.py builds the matching mesh from.
    Each is dry and a little decayed: lighter veins standing out of a browner lamina,
    darker toward the margin where it dries first, fungal spots with pale haloes, holes
    eaten through it - and one beech leaf half skeletonised, the lamina gone from
    between the veins at one edge.
    """
    import json
    C = size // 2
    Lpx = 0.84 * C                          # a leaf's length in pixels
    base = 0.93 * C                         # where its petiole meets the blade, in the cell
    rgb = np.zeros((size, size, 3), np.float32)
    alpha = np.zeros((size, size), np.float32)
    height = np.zeros((size, size), np.float32)
    meta = []
    rr, cc = np.mgrid[0:C, 0:C].astype(np.float32)
    uu = (cc + 0.5 - C / 2) / Lpx
    tt = (base - (rr + 0.5)) / Lpx
    for i, (name, fn, stops, vein_hex, dmg) in enumerate(LITTER):
        rng = np.random.default_rng(101 + i)
        inside, rib, sec = fn(uu, tt)
        # petiole for the pinnate ones: a short stalk below the blade
        if name != 'maple':
            inside |= (np.abs(uu) < 0.0085) & (tt > -0.10) & (tt < 0.02)
        net = worley_edges(C, C, 13, seed=300 + i)            # the fine reticulate veins
        # damage: holes eaten through, bites out of the margin
        holes = np.zeros((C, C), bool)
        ragged = fbm(C, C, 70, 70, 3, 400 + i)                    # nothing eats in circles
        ys, xs = np.nonzero(inside & (np.abs(uu) > 0.04) & (tt > 0.15) & (tt < 0.85))
        for _ in range(dmg['holes']):
            j = rng.integers(len(ys))
            rad = rng.uniform(0.012, 0.03) * Lpx
            holes |= np.hypot(rr - ys[j], cc - xs[j]) / rad + 1.1 * (ragged - 0.5) < 1
        edge_d = ndi.distance_transform_edt(inside) / Lpx           # distance in from the margin
        bites = np.zeros((C, C), bool)
        ey, ex = np.nonzero(inside & (edge_d < 0.004) & (tt > 0.2))
        for _ in range(2):
            j = rng.integers(len(ey))
            rad = rng.uniform(0.015, 0.035) * Lpx
            bites |= np.hypot(rr - ey[j], cc - ex[j]) / rad + 1.1 * (ragged - 0.5) < 1
        solid = inside & ~holes & ~bites
        veins = np.clip(rib + 0.75 * sec, 0, 1)
        if dmg['lace']:
            # skeletonised: along one margin the soft tissue has rotted from between the
            # veins, leaving the network - the finest thing a fly could stand on
            # (on a coarser network than the painted one: strands a pixel wide would
            # vanish at the first mip level and take the whole edge with them)
            patch = fbm(C, C, 5, 5, 3, 500 + i)
            zone = (uu < 0) & (edge_d < 0.09 + 0.10 * patch) & (tt > 0.25) & (tt < 0.9)
            strands = worley_edges(C, C, 26, seed=350 + i) > 0.2
            solid &= ~(zone & ~(strands | (veins > 0.35)))
        # colour
        d_, m_, l_ = (hexrgb(h) for h in stops)
        tone = fbm(C, C, 6, 6, 5, 600 + i)
        col = ramp(tone, [(0.0, d_), (0.5, m_), (1.0, l_)])
        # drying runs in from the margin: darker, redder-brown there
        dry = 1 - smoothstep(0.0, 0.05 + 0.04 * tone, edge_d)
        col = col * (1 - 0.45 * dry[..., None]) + hexrgb('#4a2c14') * 0.45 * dry[..., None]
        # decay patches
        rot = smoothstep(0.62, 0.8, fbm(C, C, 10, 10, 4, 700 + i))
        col = col * (1 - 0.35 * rot[..., None])
        # fungal spots: dark centres, pale rings
        spots = np.zeros((C, C), np.float32)
        halo = np.zeros((C, C), np.float32)
        blot = fbm(C, C, 45, 45, 3, 450 + i)
        ys, xs = np.nonzero(inside & (tt > 0.1))
        for _ in range(dmg['spots']):
            j = rng.integers(len(ys))
            rad = rng.uniform(0.006, 0.022) * Lpx
            d = np.hypot(rr - ys[j], cc - xs[j]) / rad + 0.9 * (blot - 0.5)
            spots = np.maximum(spots, 1 - smoothstep(0.6, 1.0, d))
            halo = np.maximum(halo, smoothstep(0.8, 1.05, d) * (1 - smoothstep(1.1, 2.0, d)))
        col = col * (1 - 0.25 * halo[..., None]) + hexrgb('#d8b866') * 0.25 * halo[..., None]
        col = col * (1 - 0.75 * spots[..., None]) + hexrgb('#2e1c0c') * 0.75 * spots[..., None]
        # veins: paler than the lamina, as they are on a dead leaf; the network faintly
        vc = hexrgb(vein_hex)
        col = col * (1 - 0.7 * veins[..., None]) + vc * 0.7 * veins[..., None]
        col *= (1 - 0.10 * net * (1 - veins))[..., None]
        # the rim of a hole is dark and dry
        hole_d = ndi.distance_transform_edt(~(holes | bites)) / Lpx
        col *= (1 - 0.5 * (1 - smoothstep(0.0, 0.006, hole_d)))[..., None]
        col *= (0.93 + 0.12 * fbm(C, C, 90, 90, 2, 800 + i))[..., None]
        # alpha with an antialiased edge, colour bled outward for mipmapping
        sd = ndi.distance_transform_edt(solid) - ndi.distance_transform_edt(~solid)
        a = np.clip(sd + 0.5, 0, 1)
        idx = ndi.distance_transform_edt(~solid, return_distances=False, return_indices=True)
        col = col[idx[0], idx[1]]
        crinkle = fbm(C, C, 40, 40, 4, 900 + i)
        h = 1.0 * rib + 0.55 * sec - 0.12 * net + 0.35 * crinkle - 0.4 * dry
        r0, c0 = (i // 2) * C, (i % 2) * C
        rgb[r0:r0 + C, c0:c0 + C] = col
        alpha[r0:r0 + C, c0:c0 + C] = a
        height[r0:r0 + C, c0:c0 + C] = h * (solid | (sd > -3))
        rows = np.nonzero(solid.any(1))[0]
        cols = np.nonzero(solid.any(0))[0]
        # a coarse occupancy grid the mesh is trimmed against (dilated so no edge is cut)
        occ = ndi.binary_dilation(solid, iterations=int(0.02 * Lpx))
        occ_small = occ.reshape(64, C // 64, 64, C // 64).any(axis=(1, 3))
        meta.append(dict(name=name, cell=[r0, c0], size=C, atlas=size, base=base, length=Lpx,
                         rows=[int(rows.min()), int(rows.max())], cols=[int(cols.min()), int(cols.max())],
                         occupancy=occ_small.astype(int).tolist()))
        print('litter', name, 'coverage %.2f' % solid.mean())
    save_rgba(rgb, alpha, os.path.join(OUT, 'Litter.png'))
    Image.fromarray(normal_map(ndi.gaussian_filter(height, 0.9), 5.0)).save(os.path.join(OUT, 'Litter_n.png'))
    with open(os.path.join(OUT, 'Litter.json'), 'w') as f:
        json.dump(meta, f)


# --- mushrooms ------------------------------------------------------------------------------

def mushrooms_detail(factor=2, seed=83):
    """The kit's painted mushroom atlas at twice the resolution with fine surface grain."""
    src = Image.open(os.path.join(SRC, 'Mushrooms.png')).convert('RGB')
    W, H = src.width * factor, src.height * factor
    rgb = np.asarray(src.resize((W, H), Image.LANCZOS)).astype(np.float32) / 255
    fine = fbm(H, W, 96, 96, 3, seed)
    pores = (fbm(H, W, 220, 220, 1, seed + 3) > 0.8).astype(np.float32)
    out = rgb * (0.93 + 0.12 * fine)[..., None] * (1 - 0.08 * pores)[..., None]
    save_rgb(out, os.path.join(OUT, 'Mushrooms.png'))
    Image.fromarray(normal_map(0.5 * fine - 0.4 * pores, 2.5)).save(os.path.join(OUT, 'Mushrooms_n.png'))
    print('mushrooms', out.shape)


if __name__ == '__main__':
    # python3 textures.py <outdir> [grass leaves flowers stone mushrooms litter]
    ALL = dict(grass=grass_atlas, leaves=leaves_atlas, flowers=flowers_atlas,
               stone=stone_tile, mushrooms=mushrooms_detail, litter=litter_atlas)
    for key in (sys.argv[2:] or ALL):
        ALL[key]()
