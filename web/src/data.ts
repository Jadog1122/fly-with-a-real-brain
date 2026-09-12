// Loading of the baked data set.

export interface NeuronData {
  n: number
  pos: Float32Array        // 3 per neuron, already centred and scaled
  region: Uint8Array
  type: Uint16Array        // index into `types`
  outDeg: Uint16Array | Uint32Array
  inDeg: Uint16Array | Uint32Array
  flyid: BigInt64Array     // 18-digit IDs: never touch these as Number
  regions: string[]
  types: string[]
  bounds: number[]         // [minx,miny,minz, maxx,maxy,maxz]
}

export interface ExpSummary {
  exp_id: string; label: string; group: string; note: string
  n_seed: number; n_active: number; n_spikes: number; n_frames: number
  rate_hz: number; kb: number
}

export interface Manifest {
  frame_ms: number; t_run_s: number; n_neurons: number; source: string
  experiments: ExpSummary[]
  seed_map: { idx: number[]; exp: string[] }
}

export interface Highlight {
  i: number; name: string; first_ms: number; spikes: number; named: boolean
}

export interface Experiment {
  exp_id: string; label: string; group: string; note: string
  seed_idx: number[]; seed2_idx: number[]
  rate_hz: number; rate2_hz: number
  frame_ms: number; n_frames: number; n_edges: number
  highlights: Highlight[]
  stats: { n_spikes: number; n_active: number; n_downstream: number; peak_frame: number }
  // flat frame storage: frameIdx[frameOff[k] .. frameOff[k+1]) fired during frame k
  frameOff: Uint32Array
  frameIdx: Uint32Array
  edgePre: Uint32Array
  edgePost: Uint32Array
  edgeW: Int32Array
  /** Neurons that fired in frame k, as a view with no copy. */
  frame(k: number): Uint32Array
}

const TYPED: Record<string, any> = {
  f32: Float32Array, u8: Uint8Array, u16: Uint16Array, u32: Uint32Array,
  i8: Int8Array, i16: Int16Array, i32: Int32Array, i64: BigInt64Array,
}

/** Read the `MAGIC | headerLen | JSON header | typed arrays` files the bake writes. */
async function loadPacked(url: string, magic: string): Promise<any> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  const buf = await res.arrayBuffer()
  const dv = new DataView(buf)
  const got = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
  if (got !== magic) throw new Error(`${url}: expected "${magic}", got "${got}"`)
  const headLen = dv.getUint32(4, true)
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headLen)))
  const base = 8 + headLen
  const out: any = { ...head }
  delete out.arrays
  for (const a of head.arrays) out[a.name] = new TYPED[a.type](buf, base + a.offset, a.length)
  return out
}

export async function loadNeurons(url: string): Promise<NeuronData> {
  return await loadPacked(url, 'FLYN') as NeuronData
}

export async function loadManifest(url: string): Promise<Manifest> {
  return (await fetch(url)).json()
}

export async function loadExperiment(url: string): Promise<Experiment> {
  const e = await loadPacked(url, 'FLYE') as Experiment
  e.frame = (k: number) => e.frameIdx.subarray(e.frameOff[k], e.frameOff[k + 1])
  return e
}

// Region palette, ordered to match REGIONS in bake/01_prepare.py.
export const REGION_COLORS: Record<string, string> = {
  optic: '#1f6f8f',
  visual_projection: '#37c0d0',
  central: '#6a74d8',
  mushroom_body: '#d05fb8',
  central_complex: '#a06ff0',
  olfactory: '#3fc27c',
  gustatory: '#f0923a',
  mechanosensory: '#c4d247',
  other_sensory: '#7fa596',
  ascending: '#57aef0',
  descending: '#f06a4a',
  motor: '#ff4459',
  endocrine: '#f08fb8',
  unknown: '#4a505e',
}

export const REGION_LABELS: Record<string, string> = {
  optic: 'Optic lobe',
  visual_projection: 'Visual projection',
  central: 'Central brain',
  mushroom_body: 'Mushroom body',
  central_complex: 'Central complex',
  olfactory: 'Olfactory sensory',
  gustatory: 'Gustatory sensory',
  mechanosensory: 'Mechanosensory',
  other_sensory: 'Other sensory',
  ascending: 'Ascending',
  descending: 'Descending',
  motor: 'Motor',
  endocrine: 'Endocrine',
  unknown: 'Unannotated',
}

export const GROUP_LABELS: Record<string, string> = {
  taste: 'Taste', vision: 'Vision', olfaction: 'Olfaction',
  mechanosensory: 'Mechanosensory', locomotion: 'Locomotion', escape: 'Escape',
  feeding: 'Feeding', grooming: 'Grooming', sez: 'SEZ cell types',
  optic: 'Optic lobe', visual_projection: 'Visual projection', central: 'Central brain',
  mushroom_body: 'Mushroom body', central_complex: 'Central complex',
  olfactory: 'Olfactory', gustatory: 'Gustatory', ascending: 'Ascending',
  descending: 'Descending', motor: 'Motor',
}
