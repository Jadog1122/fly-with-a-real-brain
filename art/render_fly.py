"""
Render a fly glb from a fixed camera, optionally posed, so a rig change can be looked
at rather than assumed. Run headless.

  blender --background --python art/render_fly.py -- <in.glb> <out.png> [pose]

pose: rest | bend | wings | walk
"""
import bpy, sys, math
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT = argv[0], argv[1]
POSE = argv[2] if len(argv) > 2 else 'rest'

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)

arm = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
if arm and POSE != 'rest':
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='POSE')
    pb = arm.pose.bones
    def rot(name, x=0.0, y=0.0, z=0.0):
        if name in pb:
            pb[name].rotation_mode = 'XYZ'
            pb[name].rotation_euler = (x, y, z)
    if POSE == 'bend':
        for s in 'LR':
            for i in '123':
                rot(f'leg.{s}.{i}.upper', -0.5)
                rot(f'leg.{s}.{i}.lower', 1.15)
    elif POSE == 'wings':
        rot('wing.L', 0, 0, 1.15)
        rot('wing.R', 0, 0, -1.15)
    elif POSE == 'walk':
        # alternating tripod: L1,L3,R2 forward while L2,R1,R3 are back
        for s, i, ph in [('L','1',0), ('L','2',1), ('L','3',0),
                         ('R','1',1), ('R','2',0), ('R','3',1)]:
            swing = 0.45 if ph == 0 else -0.45
            rot(f'leg.{s}.{i}.upper', swing)
            rot(f'leg.{s}.{i}.lower', 0.8 if ph == 0 else 0.25)
    bpy.ops.object.mode_set(mode='OBJECT')

# frame everything
pts = []
for o in bpy.data.objects:
    if o.type == 'MESH':
        dg = bpy.context.evaluated_depsgraph_get()
        ev = o.evaluated_get(dg)
        pts += [ev.matrix_world @ v.co for v in ev.data.vertices]
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
mid = (lo + hi) / 2
span = max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z)

cam_data = bpy.data.cameras.new('cam')
cam = bpy.data.objects.new('cam', cam_data)
bpy.context.collection.objects.link(cam)
# three-quarter front view, slightly above - the angle the game's camera actually uses
d = span * 1.35
if len(argv) > 3 and argv[3] == 'side':
    cam.location = mid + Vector((d * 1.5, 0, d * 0.18))     # straight side: the legs
else:
    cam.location = mid + Vector((d * 0.95, -d * 1.1, d * 0.5))
direction = (mid - cam.location).normalized()
cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
bpy.context.scene.camera = cam

key = bpy.data.objects.new('key', bpy.data.lights.new('key', type='SUN'))
key.data.energy = 4.0
key.rotation_euler = (math.radians(52), 0, math.radians(38))
bpy.context.collection.objects.link(key)
bpy.context.scene.world = bpy.data.worlds.new('w')
bpy.context.scene.world.use_nodes = True
bpy.context.scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.35, .42, .5, 1)

sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x, sc.render.resolution_y = 1100, 620
sc.render.film_transparent = False
sc.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print('wrote', OUT)
