"""
Render frames of a named animation clip from a glb, side on, into one strip.

  blender --background --python art/render_clip.py -- <in.glb> <outdir> <clip> <count>
"""
import bpy, sys, math
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUTDIR, CLIP, COUNT = argv[0], argv[1], argv[2], int(argv[3])

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
arm = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
if arm is None:
    raise SystemExit('no armature')
print('ACTIONS:', [a.name for a in bpy.data.actions])
act = next((a for a in bpy.data.actions if CLIP in a.name), None)
if act is None:
    raise SystemExit(f'no action matching {CLIP}: {[a.name for a in bpy.data.actions]}')

# glTF import parks each animation on an NLA track; clear them and drive one directly
arm.animation_data_create()
for tr in list(arm.animation_data.nla_tracks):
    arm.animation_data.nla_tracks.remove(tr)
arm.animation_data.action = act
lo, hi = act.frame_range
print('clip', act.name, 'frames', lo, hi)

pts = []
for o in bpy.data.objects:
    if o.type == 'MESH':
        pts += [o.matrix_world @ v.co for v in o.data.vertices]
mid = Vector((sum(p.x for p in pts), sum(p.y for p in pts), sum(p.z for p in pts))) / len(pts)
span = max(max(p[i] for p in pts) - min(p[i] for p in pts) for i in range(3))

cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
bpy.context.collection.objects.link(cam)
d = span * 1.35
cam.location = mid + Vector((d * 1.5, 0, d * 0.18))
cam.rotation_euler = (mid - cam.location).normalized().to_track_quat('-Z', 'Y').to_euler()
bpy.context.scene.camera = cam
key = bpy.data.objects.new('key', bpy.data.lights.new('key', type='SUN'))
key.data.energy = 4.0
key.rotation_euler = (math.radians(52), 0, math.radians(38))
bpy.context.collection.objects.link(key)
bpy.context.scene.world = bpy.data.worlds.new('w')
bpy.context.scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.35, .42, .5, 1)

sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x, sc.render.resolution_y = 640, 400
for i in range(COUNT):
    f = lo + (hi - lo) * i / max(1, COUNT - 1 if hi > lo + 1 else 1)
    sc.frame_set(int(round(f)))
    sc.render.filepath = f'{OUTDIR}/{CLIP}_{i:02d}.png'
    bpy.ops.render.render(write_still=True)
print('rendered', COUNT, 'frames of', act.name)
