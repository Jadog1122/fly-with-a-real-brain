"""
Filmstrip every clip: several frames of each from a fixed side and 3/4 camera, with the
IK constraints muted so what is photographed is exactly the baked rotations that ship.

  blender --background <work>/fly_anim.blend --python art/fly/render_clips.py -- <outdir>
"""
import bpy, math, sys
from mathutils import Vector

OUT = sys.argv[sys.argv.index('--') + 1]
arm = bpy.data.objects['Armature']
for pb in arm.pose.bones:
    for c in pb.constraints:
        c.mute = True
sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x, sc.render.resolution_y = 520, 400
w = bpy.data.worlds.new('w'); w.use_nodes = True
w.node_tree.nodes['Background'].inputs[0].default_value = (0.62, 0.66, 0.7, 1)
sc.world = w
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
sc.collection.objects.link(sun)
sun.data.energy = 4
sun.rotation_euler = (math.radians(40), math.radians(10), math.radians(-30))
# a ground line to judge foot contact against
bpy.ops.mesh.primitive_plane_add(size=12, location=(0.3, 0, 0))
g = bpy.context.active_object
gm = bpy.data.materials.new('g'); gm.use_nodes = True
gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.35, 0.3, 0.25, 1)
g.data.materials.append(gm)
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
sc.collection.objects.link(cam)
sc.camera = cam
VIEWS = {'side': ((0.0, -1.0, 0.12), 7.2), 'q': ((-0.8, -1.0, 0.55), 7.6), 'front': ((-1.0, -0.25, 0.3), 5.5)}
PLAN = {'walk': [0, 4, 8, 12, 16, 20], 'groom': [0, 5, 10, 15], 'flight': [0],
        'startle': [0], 'idle': [0], 'proboscis': [0, 12]}
for act in bpy.data.actions:
    arm.animation_data_create()
    arm.animation_data.action = act
    for view, (d, dist) in VIEWS.items():
        if act.name == 'walk' and view == 'front':
            continue
        if act.name == 'groom' and view == 'side':
            continue
        dd = Vector(d).normalized() * dist
        cam.location = Vector((0.2, 0, 0.7)) + dd
        cam.rotation_euler = (-dd).to_track_quat('-Z', 'Y').to_euler()
        for f in PLAN.get(act.name, [0]):
            sc.frame_set(f)
            sc.render.filepath = f'{OUT}/{act.name}_{view}_{f:02d}.png'
            bpy.ops.render.render(write_still=True)
print('rendered')
