"""
Put the baked maps onto the game mesh with simple preview materials and save a .blend
that render_views.py can shoot - so the bake is judged on the model, not in the atlas.

  blender --background <work>/fly_baked.blend --python art/fly/preview_baked.py -- <work>
"""
import bpy, os, sys
argv = sys.argv[sys.argv.index('--') + 1:]
WORK = argv[0]
T = os.path.join(WORK, 'tex')


def img(name, non_color=False):
    i = bpy.data.images.load(os.path.join(T, name + '.png'), check_existing=True)
    if non_color:
        i.colorspace_settings.name = 'Non-Color'
    return i


def pbr(name, rough, eye=False):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    a = nt.nodes.new('ShaderNodeTexImage'); a.image = img('fly_albedo')
    n = nt.nodes.new('ShaderNodeTexImage'); n.image = img('fly_normal', True)
    o = nt.nodes.new('ShaderNodeTexImage'); o.image = img('fly_ao', True)
    nm = nt.nodes.new('ShaderNodeNormalMap')
    mul = nt.nodes.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'
    mul.inputs['Factor'].default_value = 0.6
    nt.links.new(a.outputs['Color'], mul.inputs['A'])
    nt.links.new(o.outputs['Color'], mul.inputs['B'])
    nt.links.new(mul.outputs['Result'], b.inputs['Base Color'])
    nt.links.new(n.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    b.inputs['Roughness'].default_value = rough
    if eye:
        b.inputs['Coat Weight'].default_value = 1.0
        b.inputs['Coat Roughness'].default_value = 0.08
    return m


body = bpy.data.objects['fly_body']
for s in body.material_slots:
    s.material = pbr('prev_eye', 0.3, eye=True) if s.material.name.startswith('role_eye') else pbr('prev_cut', 0.5)

wings = bpy.data.objects['fly_wings']
m = bpy.data.materials.new('prev_wing'); m.use_nodes = True
nt = m.node_tree; b = nt.nodes['Principled BSDF']
t = nt.nodes.new('ShaderNodeTexImage'); t.image = img('fly_wing_veins')
mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'
mix.inputs['A'].default_value = (0.75, 0.8, 0.85, 1)
nt.links.new(t.outputs['Alpha'], mix.inputs['Factor'])
nt.links.new(t.outputs['Color'], mix.inputs['B'])
nt.links.new(mix.outputs['Result'], b.inputs['Base Color'])
mx = nt.nodes.new('ShaderNodeMath'); mx.operation = 'MAXIMUM'; mx.inputs[1].default_value = 0.22
nt.links.new(t.outputs['Alpha'], mx.inputs[0])
nt.links.new(mx.outputs[0], b.inputs['Alpha'])
b.inputs['Roughness'].default_value = 0.2
wings.data.materials.clear(); wings.data.materials.append(m)

for o in bpy.data.objects:
    if o.type == 'MESH' and o.get('kind') == 'bristle':
        for s in o.material_slots:
            mb = bpy.data.materials.new('prev_bristle'); mb.use_nodes = True
            mb.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.006, 0.004, 0.003, 1)
            mb.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.35
            s.material = mb
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(WORK, 'fly_preview.blend'))
print('preview saved')
