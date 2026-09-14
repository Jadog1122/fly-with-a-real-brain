"""What is actually inside shy-fly.glb? Run headless; prints, changes nothing."""
import bpy, sys, os
from mathutils import Vector

src = sys.argv[sys.argv.index('--') + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

print("\n=== objects ===")
for o in bpy.data.objects:
    if o.type != 'MESH':
        print(f"{o.type:10} {o.name}")
        continue
    me = o.data
    bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
    lo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    hi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    mats = ','.join(m.name for m in me.materials) if me.materials else '-'
    print(f"MESH       {o.name:34} v={len(me.vertices):4} f={len(me.polygons):4} "
          f"size=({hi.x-lo.x:.3f},{hi.y-lo.y:.3f},{hi.z-lo.z:.3f}) "
          f"at=({(lo.x+hi.x)/2:+.3f},{(lo.y+hi.y)/2:+.3f},{(lo.z+hi.z)/2:+.3f}) mat={mats}")
print("\n=== totals ===")
print("meshes", len([o for o in bpy.data.objects if o.type == 'MESH']),
      " verts", sum(len(o.data.vertices) for o in bpy.data.objects if o.type == 'MESH'),
      " tris", sum(len(o.data.loop_triangles) for o in bpy.data.objects if o.type == 'MESH'))
print("armatures", [o.name for o in bpy.data.objects if o.type == 'ARMATURE'])
print("actions", [a.name for a in bpy.data.actions])
print("materials", [(m.name, m.blend_method) for m in bpy.data.materials])
