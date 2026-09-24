/**
 * Ship the refined scenery: every .gltf Blender wrote, compressed for the browser.
 *
 *   node art/kit/optimize.mjs <in dir> <out dir>
 *
 *  - Foliage keeps the kit's alpha MASK. Blender 5 exports a textured alpha as BLEND,
 *    which would sort hundreds of instanced leaves against each other every frame and
 *    break depth for the plants behind them; the kit's own files were MASK and the scene
 *    is built around that.
 *  - Textures go to WebP, sized per atlas. The atlases are shared between models by
 *    name, so writing them once per model into one folder leaves a single copy.
 *  - Geometry is meshopt-compressed but POSITIONS ARE NOT QUANTISED: quantisation moves
 *    each mesh into a normalised range with the base at -1, and scene3d's wind weights
 *    sway by geometry-space height from y = 0 - the lower half of every plant would
 *    stop moving.
 */
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, meshopt, prune, quantize, textureCompress } from '@gltf-transform/functions'
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer'
import sharp from 'sharp'
import { readdirSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const [IN, OUT] = process.argv.slice(2)
if (!IN || !OUT) throw new Error('usage: node optimize.mjs <in dir> <out dir>')
mkdirSync(OUT, { recursive: true })
await MeshoptEncoder.ready
await MeshoptDecoder.ready
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder })

// longest side each atlas ships at
const SIZE = { Leaves: 2048, Flowers: 2048, Litter: 2048, GrassBlades: 1024, Stone: 1024, Mushrooms: 1024 }

let total = 0
for (const f of readdirSync(IN).filter(f => f.endsWith('.gltf')).sort()) {
  const doc = await io.read(join(IN, f))
  const root = doc.getRoot()
  for (const m of root.listMaterials()) {
    if (/^(Leaves|Flowers|Litter)$/.test(m.getName())) m.setAlphaMode('MASK').setAlphaCutoff(0.4)
    // The re-meshed stones are closed (no open edge on any of them), so there is no
    // inside to draw; Blender exports everything double-sided unless told otherwise.
    // The mushrooms stay double-sided: their caps and shelves are open sheets.
    if (m.getName() === 'Stone') m.setDoubleSided(false)
  }
  // name each texture after its atlas so every model writes the same shared file
  for (const t of root.listTextures()) {
    const uri = t.getURI() || t.getName()
    const base = uri.replace(/\.[a-z]+$/i, '').split('/').pop()
    t.setName(base).setURI(base + '.png')
  }
  const passes = [dedup(), prune()]
  for (const [name, px] of Object.entries(SIZE)) {
    passes.push(textureCompress({
      encoder: sharp, targetFormat: 'webp', resize: [px, px],
      pattern: new RegExp(`^${name}(_n)?$`), quality: 86,
    }))
  }
  passes.push(
    quantize({ pattern: /^(NORMAL|TEXCOORD_0|COLOR_0)$/ }),       // not POSITION: see above
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  )
  await doc.transform(...passes)
  // after compression the URIs end in .webp; keep them shared by name
  for (const t of root.listTextures()) t.setURI(t.getName() + '.webp')
  await io.write(join(OUT, f), doc)
  const size = statSync(join(OUT, f)).size + statSync(join(OUT, f.replace('.gltf', '.bin'))).size
  total += size
  console.log(`${f.padEnd(26)} ${(size / 1024).toFixed(0).padStart(5)} KiB`)
}
let tex = 0
for (const f of readdirSync(OUT).filter(f => f.endsWith('.webp'))) {
  const b = statSync(join(OUT, f)).size
  tex += b
  console.log(`${f.padEnd(26)} ${(b / 1024).toFixed(0).padStart(5)} KiB`)
}
console.log(`geometry ${(total / 1024).toFixed(0)} KiB + textures ${(tex / 1024).toFixed(0)} KiB = ${((total + tex) / 1024).toFixed(0)} KiB`)
