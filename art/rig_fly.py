"""
Give the shy fly a real skeleton.

The asset ships as eleven loose rigid parts and no bones, so the game has been
rigging it at load time in TypeScript: pivots inferred from vertex statistics, each
part rotated about a point. That works, but a rigidly rotated part cannot bend - the
legs are sticks that swing from the hip, with no knee - and the poses live as numbers
in an update() function rather than as data.

This builds the skeleton once, here, and bakes it into the asset:

  thorax                  body, eyes and the wing bones hang off it
  leg.{L,R}.{1,2,3}       two bones each, so the leg bends at a knee
  wing.{L,R}              hinged at the inboard edge that meets the thorax
  proboscis               its own bone, so it no longer has to be a cloned leg

Bone positions are measured from the geometry the same way the TypeScript did, so the
rest pose is identical to what shipped and nothing downstream has to be re-tuned.

Run: blender --background --python art/rig_fly.py -- <in.glb> <out.glb>
"""
import bpy, sys, math
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, DST = argv[0], argv[1]

# Part names as the asset spells them. Blender keeps the dots; three.js strips them.
BODY = 'Sphere.001'
EYES = ['Sphere.008', 'Sphere.009']
WINGS = ['BezierCurve.001_Mesh.001', 'BezierCurve_Mesh']
# left front, mid, hind then right front, mid, hind - matching the game's own order
LEGS = ['Sphere.007', 'Sphere.006', 'Sphere.005',
        'Sphere.000', 'Sphere.003', 'Sphere.004']

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
# glTF import parents everything under an empty; the armature replaces that role
for o in bpy.data.objects:
    if o.type == 'MESH':
        o.matrix_world = o.matrix_world.copy()

obj = {o.name: o for o in bpy.data.objects if o.type == 'MESH'}
missing = [n for n in [BODY] + EYES + WINGS + LEGS if n not in obj]
if missing:
    raise SystemExit(f'asset is missing parts: {missing}')


def world_verts(o):
    m = o.matrix_world
    return [m @ v.co for v in o.data.vertices]


def extreme(o, key, frac=0.2, lowest=True):
    """Centroid of the `frac` of vertices scoring lowest (or highest) under `key`."""
    vs = world_verts(o)
    scored = sorted(vs, key=key, reverse=not lowest)
    take = scored[:max(1, math.ceil(len(scored) * frac))]
    return sum(take, Vector()) / len(take)


# --- measure the joints off the geometry -------------------------------------------
# Blender is Z-up after a glTF import, and this model faces +Y.
joints = {}
for i, name in enumerate(LEGS):
    leg = obj[name]
    hip = extreme(leg, lambda v: v.z, lowest=False)      # top of the leg: the hip
    foot = extreme(leg, lambda v: v.z, lowest=True)      # bottom: the foot
    # The knee sits where the leg is narrowest between the two. Nothing that precise
    # survives in a 132-vertex stylised leg, so it goes at 45% down the hip-foot line,
    # kicked backwards so the bend reads as a joint rather than a crease.
    knee = hip.lerp(foot, 0.45)
    back = Vector((0, -1, 0)) if hip.y > 0 else Vector((0, 1, 0))
    knee += back * (hip - foot).length * 0.16
    joints[name] = (hip, knee, foot)

for name in WINGS:
    w = obj[name]
    hinge = extreme(w, lambda v: abs(v.x), lowest=True)  # inboard edge, meets thorax
    tip = extreme(w, lambda v: abs(v.x), lowest=False)
    joints[name] = (hinge, tip)

body_vs = world_verts(obj[BODY])
body_lo = Vector((min(v.x for v in body_vs), min(v.y for v in body_vs), min(v.z for v in body_vs)))
body_hi = Vector((max(v.x for v in body_vs), max(v.y for v in body_vs), max(v.z for v in body_vs)))
# The thorax rears about the line the legs stand on, as it did before.
hips = sum((joints[n][0] for n in LEGS), Vector()) / len(LEGS)
# Snout: the centroid of the front few per cent of the body's own vertices, which is
# where the head actually ends. Deriving it from the bounding box instead put it below
# the nose and left the proboscis hanging in mid air, detached.
snout = extreme(obj[BODY], lambda v: v.y, frac=0.03, lowest=False)
snout.x = 0.0
snout.z -= (body_hi.z - body_lo.z) * 0.10        # mouthparts sit under the eyes

# --- build the armature -------------------------------------------------------------
arm_data = bpy.data.armatures.new('flyArmature')
arm = bpy.data.objects.new('fly', arm_data)
bpy.context.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
eb = arm_data.edit_bones


def bone(name, head, tail, parent=None, roll=0.0):
    b = eb.new(name)
    b.head, b.tail, b.roll = head, tail, roll
    if parent is not None:
        b.parent = parent
        b.use_connect = False
    return b


root = bone('root', hips + Vector((0, 0, -0.6)), hips)
thorax = bone('thorax', hips, hips + Vector((0, 2.2, 0)), root)

SIDE = ['L', 'L', 'L', 'R', 'R', 'R']
POS = ['1', '2', '3'] * 2
leg_bones = {}
for name, s, p in zip(LEGS, SIDE, POS):
    hip, knee, foot = joints[name]
    upper = bone(f'leg.{s}.{p}.upper', hip, knee, thorax)
    lower = bone(f'leg.{s}.{p}.lower', knee, foot, upper)
    lower.use_connect = True
    leg_bones[name] = (upper.name, lower.name)

wing_bones = {}
for name in WINGS:
    hinge, tip = joints[name]
    s = 'L' if hinge.x < 0 else 'R'
    b = bone(f'wing.{s}', hinge, tip, thorax)
    wing_bones[name] = b.name

prob = bone('proboscis', snout, snout + Vector((0, 0.78, -0.64)) * 2.4, thorax)
prob_name = prob.name
prob_head, prob_tail = prob.head.copy(), prob.tail.copy()
# Bone roll decides which way "rotate about local X" points, and Blender's default
# choice is arbitrary. Aligning each bone's local Z gives every joint an axis that
# means something: for a leg, local X ends up sideways, so rotating about it swings the
# leg fore and aft the way a leg swings. For a wing it becomes the flap axis.
for b in eb:
    if b.name.startswith('leg.'):
        b.align_roll(Vector((0, 1, 0)))       # local Z forward -> local X sideways
    elif b.name.startswith('wing.'):
        b.align_roll(Vector((0, 0, 1)))       # local Z up -> local X fore-aft
bpy.ops.object.mode_set(mode='OBJECT')

# --- skin ----------------------------------------------------------------------------
def bind(o, weights):
    """weights: list of (bone name, fn(world vertex) -> weight)."""
    for bn, _ in weights:
        if bn not in o.vertex_groups:
            o.vertex_groups.new(name=bn)
    m = o.matrix_world
    for i, v in enumerate(o.data.vertices):
        w = m @ v.co
        raw = [(bn, max(0.0, fn(w))) for bn, fn in weights]
        total = sum(x for _, x in raw) or 1.0
        for bn, x in raw:
            o.vertex_groups[bn].add([i], x / total, 'REPLACE')
    mod = o.modifiers.new(name='Armature', type='ARMATURE')
    mod.object = arm
    o.parent = arm
    o.matrix_parent_inverse = arm.matrix_world.inverted()


for name in [BODY] + EYES:
    bind(obj[name], [('thorax', lambda v: 1.0)])

for name in LEGS:
    hip, knee, foot = joints[name]
    upper, lower = leg_bones[name]
    span = (hip - foot).length or 1.0
    # A smooth handover across the knee is the whole point of skinning it: a hard
    # 0/1 split would just reproduce the rigid pivot this is replacing.
    blend = span * 0.22

    def w_upper(v, hip=hip, knee=knee, blend=blend):
        d = (v - knee).dot((hip - knee).normalized())
        return min(1.0, max(0.0, 0.5 + d / (2 * blend)))

    bind(obj[name], [(upper, w_upper), (lower, lambda v, f=w_upper: 1.0 - f(v))])

for name in WINGS:
    bind(obj[name], [(wing_bones[name], lambda v: 1.0)])

# The proboscis was a cloned hind leg because the mesh has no snout part. Keep that
# trick - it matches the model's facet density, where a built tube would not - but
# hang it off its own bone instead of off a scaled group.
donor = obj[LEGS[2]]
pro = donor.copy()
pro.data = donor.data.copy()
pro.name = 'proboscis'
for vg in list(pro.vertex_groups):
    pro.vertex_groups.remove(vg)
for mod in list(pro.modifiers):
    pro.modifiers.remove(mod)
bpy.context.collection.objects.link(pro)

# Place it by construction rather than by nudging an offset: rotate the donor leg's own
# axis onto the proboscis bone's axis, then move its hip onto the snout. Rigid skinning
# only ever applies the bone's delta from the bind pose, so the mesh has to be right
# here or it is wrong for ever.
hip, _, foot = joints[LEGS[2]]
leg_axis = (foot - hip).normalized()
bone_axis = (prob_tail - prob_head).normalized()
rot = leg_axis.rotation_difference(bone_axis).to_matrix().to_4x4()
from mathutils import Matrix
pro.matrix_world = (Matrix.Translation(snout) @ rot
                    @ Matrix.Diagonal((0.34, 0.5, 0.95, 1.0))
                    @ Matrix.Translation(-hip) @ pro.matrix_world)
bpy.context.view_layer.update()
bind(pro, [(prob_name, lambda v: 1.0)])


# --- animation --------------------------------------------------------------------
#
# These are the poses the game used to compute inside update(). They are clips now, so
# three's AnimationMixer can cross-fade between them and so anyone with Blender can
# change how the fly moves without touching TypeScript.
#
# What deliberately stays in code: the wingbeat. A fly beats its wings around 200 Hz
# and the game drives that from the brain's own escape signal - sampling that off a
# 24-frame clip would alias into a stutter. Clips are for poses; code is for
# oscillators. The same goes for the walk cycle's PHASE: the clip holds the shape of a
# stride, but the game still decides where in the stride the fly is, because that comes
# out of the motor neurons rather than off a clock.

bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='POSE')
for pb in arm.pose.bones:
    pb.rotation_mode = 'XYZ'
pose = arm.pose.bones

# The alternating tripod: front and hind of one side step with the middle of the other.
# Index order is L1 L2 L3 R1 R2 R3, so these are the two groups.
TRIPOD = {'leg.L.1': 0, 'leg.L.2': 1, 'leg.L.3': 0,
          'leg.R.1': 1, 'leg.R.2': 0, 'leg.R.3': 1}


def clear_pose():
    for pb in pose:
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)


def key(pb, frame, rot=None, scale=None):
    if rot is not None:
        pb.rotation_euler = rot
        pb.keyframe_insert('rotation_euler', frame=frame)
    if scale is not None:
        pb.scale = scale
        pb.keyframe_insert('scale', frame=frame)


def new_action(name):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data_create()
    arm.animation_data.action = act
    clear_pose()
    return act


import math as _m

# walk: 24 frames, looping. Stance drags the planted foot backwards, swing lifts it
# and carries it forward again.
WALK_FRAMES = 24
act = new_action('walk')
SWING = 0.42          # fore-aft at the hip
LIFT = 0.55           # how far the knee folds as the foot comes off the ground
for f in range(WALK_FRAMES + 1):
    t = f / WALK_FRAMES
    for leg, group in TRIPOD.items():
        p = (t + 0.5 * group) % 1.0
        if p < 0.5:                      # stance: foot planted, body drives past it
            swing = SWING * (1 - 4 * p)              # +SWING -> -SWING
            fold = 0.06
        else:                            # swing: lift, fold, carry forward
            q = (p - 0.5) * 2
            swing = -SWING + 2 * SWING * q
            fold = 0.06 + LIFT * _m.sin(q * _m.pi)
        key(pose[f'{leg}.upper'], f, rot=(swing, 0, 0))
        key(pose[f'{leg}.lower'], f, rot=(fold, 0, 0))
    # the body rides up and down twice per stride, once per tripod
    key(pose['thorax'], f, rot=(_m.sin(t * 4 * _m.pi) * 0.035, 0, 0))

# groom: the front legs come off the ground and rub the face, out of phase with
# each other. The other four keep standing.
GROOM_FRAMES = 20
act = new_action('groom')
for f in range(GROOM_FRAMES + 1):
    t = f / GROOM_FRAMES
    for i, leg in enumerate(['leg.L.1', 'leg.R.1']):
        r = _m.sin((t + i * 0.5) * 2 * _m.pi)
        key(pose[f'{leg}.upper'], f, rot=(1.05 + r * 0.30, 0, 0))
        key(pose[f'{leg}.lower'], f, rot=(1.30 - r * 0.35, 0, 0))
    key(pose['thorax'], f, rot=(0.10, 0, 0))

# flight: a single held pose the game blends in by weight - legs tucked back and up
# out of the way, thorax pitched down into the direction of travel.
act = new_action('flight')
for f in (0, 2):
    for leg, _g in TRIPOD.items():
        back = -0.75 if leg.endswith('1') else (-0.55 if leg.endswith('2') else -0.35)
        key(pose[f'{leg}.upper'], f, rot=(back, 0, 0))
        key(pose[f'{leg}.lower'], f, rot=(1.35, 0, 0))
    key(pose['thorax'], f, rot=(-0.16, 0, 0))

# proboscis: retracted into the head, then out onto the food. The game samples this
# one by its blend value rather than playing it.
act = new_action('proboscis')
key(pose['proboscis'], 0, scale=(1, 0.02, 1))
key(pose['proboscis'], 12, scale=(1, 1, 1))

# idle: the rest pose, held. This one exists for a mechanical reason. three's
# AnimationMixer takes a weighted AVERAGE of whatever is playing, so a walk clip alone
# at weight 0.1 does not come out as a tenth of a stride - it comes out as a whole
# stride, because it is the only thing in the average. A base clip at the rest pose
# gives the other weights something to blend against.
act = new_action('idle')
for f in (0, 2):
    key(pose['thorax'], f, rot=(0, 0, 0))
    for leg in TRIPOD:
        key(pose[f'{leg}.upper'], f, rot=(0, 0, 0))
        key(pose[f'{leg}.lower'], f, rot=(0, 0, 0))

# Every action has to sit on its own NLA track or the glTF exporter only writes
# whichever one happens to be assigned when it runs.
arm.animation_data.action = None
for a in bpy.data.actions:
    track = arm.animation_data.nla_tracks.new()
    track.name = a.name
    track.strips.new(a.name, int(a.frame_range[0]), a)
clear_pose()
bpy.ops.object.mode_set(mode='OBJECT')
print('clips:', [a.name for a in bpy.data.actions])

print('rigged:', len(arm_data.bones), 'bones')
for b in arm_data.bones:
    print('   ', b.name)

bpy.ops.export_scene.gltf(
    filepath=DST, export_format='GLB',
    export_animations=True, export_skins=True, export_apply=False,
    export_yup=True,
)
print('wrote', DST)
