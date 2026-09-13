// The baked payload format written by bake/: a 4-byte magic, a little-endian uint32
// header length, a JSON header, then 8-byte-aligned typed arrays.
//
// Parsing is split from fetching so it can be tested without a network or a DOM.

// Must mirror bake/common.py's _DT exactly.  These were two divergent copies - the
// worker's was missing i64, so it could not have read neurons.bin, whose 18-digit
// flywire ids are int64 and must never be touched as Number.
const TYPED = {
  f32: Float32Array, u8: Uint8Array, u16: Uint16Array, u32: Uint32Array,
  i8: Int8Array, i16: Int16Array, i32: Int32Array, i64: BigInt64Array,
} as const

export type TypeTag = keyof typeof TYPED

export interface PackedArray { name: string; type: TypeTag; offset: number; length: number }
export interface PackedHeader { arrays: PackedArray[]; [k: string]: unknown }

/** Header fields, plus one typed-array view per entry in `header.arrays`. */
export function parsePacked<T = Record<string, unknown>>(
  buf: ArrayBuffer, magic: string, label = '<buffer>',
): T {
  if (buf.byteLength < 8) throw new Error(`${label}: too short to be ${magic}`)
  const dv = new DataView(buf)
  const got = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
  if (got !== magic) throw new Error(`${label}: expected ${magic}, got ${got}`)

  const hl = dv.getUint32(4, true)
  if (8 + hl > buf.byteLength) throw new Error(`${label}: header length ${hl} overruns the buffer`)
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl))) as PackedHeader

  const out = { ...head } as Record<string, unknown>
  delete out.arrays                       // layout metadata, not payload
  for (const a of head.arrays ?? []) {
    const Ctor = TYPED[a.type]
    if (!Ctor) throw new Error(`${label}: array "${a.name}" has unknown type "${a.type}"`)
    const start = 8 + hl + a.offset
    const end = start + a.length * Ctor.BYTES_PER_ELEMENT
    // bake pads the header so `start` lands on an 8-byte boundary; without this check
    // a malformed file surfaces as an opaque RangeError from the typed-array ctor
    if (start % Ctor.BYTES_PER_ELEMENT !== 0) {
      throw new Error(`${label}: array "${a.name}" starts at ${start}, not aligned to `
        + `${Ctor.BYTES_PER_ELEMENT} bytes`)
    }
    if (end > buf.byteLength) {
      throw new Error(`${label}: array "${a.name}" ends at ${end}, past the ${buf.byteLength}-byte buffer`)
    }
    out[a.name] = new Ctor(buf, start, a.length)
  }
  return out as T
}

export async function loadPacked<T = Record<string, unknown>>(url: string, magic: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return parsePacked<T>(await res.arrayBuffer(), magic, url)
}
