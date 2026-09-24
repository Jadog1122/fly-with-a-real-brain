"""
Render a build stage from fixed cameras so a change is looked at, not assumed.

  blender --background <file.blend> --python art/fly/render_views.py -- <outdir> <prefix> [LOW|HIGH|ALL]
"""
import bpy, math, sys
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
OUT, PREFIX = argv[0], argv[1]
SHOW = argv[2] if len(argv) > 2 else 'LOW'

for c in bpy.data.collections:
    if c.name in ('HIGH', 'LOW'):
        c.hide_render = not (SHOW == 'ALL' or c.name == SHOW)
for o in bpy.data.objects:
    if o.type == 'MESH' and o.get('kind') == 'veins' and SHOW != 'HIGH':
        o.hide_render = True

sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x, sc.render.resolution_y = 900, 600
w = bpy.data.worlds.new('w'); w.use_nodes = True
w.node_tree.nodes['Background'].inputs[0].default_value = (0.62, 0.66, 0.7, 1)
sc.world = w
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
sc.collection.objects.link(sun)
sun.data.energy = 4
sun.rotation_euler = (math.radians(40), math.radians(10), math.radians(-30))
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
sc.collection.objects.link(cam)
sc.camera = cam


def shot(name, target, direction, dist, lens=50):
    d = Vector(direction).normalized() * dist
    cam.location = Vector(target) + d
    cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = lens
    sc.render.filepath = f'{OUT}/{PREFIX}_{name}.png'
    bpy.ops.render.render(write_still=True)


shot('34', (0.3, 0, 0.8), (-0.9, -1.2, 0.7), 7.5)
shot('head', (-0.75, 0, 1.15), (-1.0, -0.8, 0.35), 2.4, 60)
shot('side', (0.3, 0, 0.7), (0.0, -1.0, 0.05), 6.5)
