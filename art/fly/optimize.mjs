/**
 * Take the fly Blender exports and make it something a browser should download.
 *
 *   node art/fly/optimize.mjs <in.glb> <out.glb>
 *
 * What changes, and why:
 *
 *  - Clips keep only the channels that actually move. Blender's glTF exporter samples
 *    EVERY bone into EVERY action, so each clip arrived as 237 channels, almost all of
 *    them a bone held at rest. That is not just waste: three's mixer blends whatever a
 *    clip carries, so a rest-pose channel in the proboscis clip would drag the legs
 *    back toward rest every frame. A channel constant at its bone's bind pose is
 *    dropped - a bone no clip touches is simply left to three, which blends toward
 *    that same bind pose. The bones the game drives by code - head, antennae, wings,
 *    halteres - are stripped from every clip whatever they hold, so code and clips can
 *    never fight over one.
 *  - The wing gets thin-film iridescence. A fly's wing is a membrane a few hundred
 *    nanometres thick and shows interference colour; Blender's Thin Film does not reach
 *    the glTF exporter, so KHR_materials_iridescence is added here.
 *  - Textures dedup (the eye and cuticle materials share the body atlas), then go to
 *    WebP: 1024 for colour and normals, 512 for occlusion, which is low-frequency.
 *  - Geometry is welded, quantised and meshopt-compressed.
 */
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRMaterialsIridescence } from '@gltf-transform/extensions'
import { dedup, meshopt, prune, quantize, resample, textureCompress, weld } from '@gltf-transform/functions'
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer'
import sharp from 'sharp'
import { statSync } from 'node:fs'
import process from 'node:process'

const [SRC, DST] = process.argv.slice(2)
if (!SRC || !DST) throw new Error('usage: node optimize.mjs <in.glb> <out.glb>')

await MeshoptEncoder.ready
await MeshoptDecoder.ready
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder })
const doc = await io.read(SRC)
const root = doc.getRoot()

// --- clips: only what moves -------------------------------------------------------------
const CODE_BONES = new Set(['head', 'antenna_left', 'antenna_right', 'wing_left', 'wing_right',
                            'haltere_left', 'haltere_right'])
const EPS = 1e-4
function restOf(node, path) {
  if (path === 'rotation') return node.getRotation()
  if (path === 'translation') return node.getTranslation()
  return node.getScale()
}
function heldAt(out, rest) {
  const n = rest.length
  for (let i = 0; i < out.length; i += n) {
    let same = true, flipped = true      // q and -q are the same rotation
    for (let k = 0; k < n; k++) {
      if (Math.abs(out[i + k] - rest[k]) > EPS) same = false
      if (Math.abs(out[i + k] + rest[k]) > EPS) flipped = false
    }
    if (!same && !(n === 4 && flipped)) return false
  }
  return true
}
const report = {}
for (const anim of root.listAnimations()) {
  const kept = new Set()
  for (const ch of anim.listChannels()) {
    const node = ch.getTargetNode()
    const path = ch.getTargetPath()
    const out = ch.getSampler().getOutput().getArray()
    if (CODE_BONES.has(node.getName()) || heldAt(out, restOf(node, path))) {
      ch.dispose()
    } else {
      kept.add(node.getName())
    }
  }
  // a sampler no remaining channel reads is dead weight: its keyframes still ship
  const used = new Set(anim.listChannels().map(c => c.getSampler()))
  for (const smp of anim.listSamplers()) if (!used.has(smp)) smp.dispose()
  report[anim.getName()] = kept.size
  if (anim.listChannels().length === 0) anim.dispose()
}
console.log('bones each clip moves:', report)

// --- the wing is a thin film ----------------------------------------------------------------
const irid = doc.createExtension(KHRMaterialsIridescence)
for (const m of root.listMaterials()) {
  if (m.getName() !== 'fly_wing') continue
  // Higher-order thicknesses and a partial factor: first-order film (240-420 nm) gave
  // the whole wing a saturated purple-blue cast in the game. A real wing is mostly clear
  // and shows its interference colour as a sheen at glancing angles.
  m.setExtension('KHR_materials_iridescence', irid.createIridescence()
    .setIridescenceFactor(0.55)
    .setIridescenceIOR(1.33)
    .setIridescenceThicknessMinimum(420)
    .setIridescenceThicknessMaximum(780))
}

// --- geometry and textures ----------------------------------------------------------------
await doc.transform(
  dedup(),
  prune(),
  weld(),
  resample(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /occlusion/, resize: [512, 512], quality: 80 }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /normal/, resize: [1024, 1024], quality: 92 }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /baseColor/, resize: [1024, 1024], quality: 88 }),
  quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }),
  meshopt({ encoder: MeshoptEncoder, level: 'high' }),
)
await io.write(DST, doc)

const bytes = statSync(DST).size
const tex = root.listTextures().map(t => `${t.getName() || '?'} ${t.getSize()?.join('x')} ${t.getImage()?.byteLength ?? 0}B`)
console.log('textures:', tex)
console.log(`wrote ${DST}: ${bytes} bytes (${(bytes / 1024).toFixed(0)} KiB)`)
