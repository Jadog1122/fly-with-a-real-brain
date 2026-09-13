import { describe, it, expect } from 'vitest'
import { parsePacked } from '../src/pet/packed'
import { readArrayBuffer, subnet } from './helpers'

/** Build a well-formed payload the same way bake/common.py write_bin does. */
function pack(magic: string, header: object, arrays: Record<string, ArrayBufferView>) {
  let head = new TextEncoder().encode(JSON.stringify(header))
  // bake pads the header with spaces so the array region starts 8-byte aligned
  const padLen = (((-(head.length + 8)) % 8) + 8) % 8   // JS % keeps the sign
  if (padLen) {
    const p = new Uint8Array(head.length + padLen).fill(0x20)
    p.set(head); head = p
  }
  const body = Object.values(arrays)
  const size = body.reduce((n, a) => n + a.byteLength, 0)
  const buf = new ArrayBuffer(8 + head.length + size)
  const u8 = new Uint8Array(buf)
  for (let i = 0; i < 4; i++) u8[i] = magic.charCodeAt(i)
  new DataView(buf).setUint32(4, head.length, true)
  u8.set(head, 8)
  let off = 8 + head.length
  for (const a of body) { u8.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), off); off += a.byteLength }
  return buf
}

describe('packed payload format', () => {
  it('exposes header fields and typed-array views', () => {
    const xs = new Float32Array([1.5, -2.25, 3])
    const buf = pack('FLYT', { n: 3, arrays: [{ name: 'xs', type: 'f32', offset: 0, length: 3 }] }, { xs })
    const out = parsePacked<{ n: number; xs: Float32Array }>(buf, 'FLYT')
    expect(out.n).toBe(3)
    expect(out.xs).toBeInstanceOf(Float32Array)
    expect([...out.xs]).toEqual([1.5, -2.25, 3])
  })

  it('places each array at its declared offset', () => {
    const a = new Uint16Array([7, 8]), b = new Int16Array([-1, -2, -3])
    const buf = pack('FLYT', { arrays: [
      { name: 'a', type: 'u16', offset: 0, length: 2 },
      { name: 'b', type: 'i16', offset: 4, length: 3 },
    ] }, { a, b })
    const out = parsePacked<{ a: Uint16Array; b: Int16Array }>(buf, 'FLYT')
    expect([...out.a]).toEqual([7, 8])
    expect([...out.b]).toEqual([-1, -2, -3])
  })

  it('rejects a wrong magic rather than reading garbage', () => {
    const buf = pack('FLYE', { arrays: [] }, {})
    expect(() => parsePacked(buf, 'FLYS', 'x.bin')).toThrow(/expected FLYS, got FLYE/)
  })

  it('rejects a truncated buffer instead of producing a short view', () => {
    const buf = pack('FLYT', { arrays: [{ name: 'a', type: 'f32', offset: 0, length: 99 }] },
                     { a: new Float32Array(2) })
    expect(() => parsePacked(buf, 'FLYT', 'x.bin')).toThrow(/past the .* buffer/)
  })

  it('rejects an unknown array type', () => {
    const buf = pack('FLYT', { arrays: [{ name: 'a', type: 'f64', offset: 0, length: 1 }] }, {})
    expect(() => parsePacked(buf, 'FLYT', 'x.bin')).toThrow(/unknown type "f64"/)
  })

  it('parses the real subnet payload with a consistent CSR structure', () => {
    const s = subnet()
    expect(s.n).toBeGreaterThan(0)
    expect(s.members.length).toBe(s.n)
    expect(s.row.length).toBe(s.n + 1)          // CSR row starts, plus the end sentinel
    expect(s.row[0]).toBe(0)
    expect(s.row[s.n]).toBe(s.tgt.length)       // last row start == total edges
    expect(s.tgt.length).toBe(s.w.length)
    expect(s.n_syn).toBe(s.tgt.length)
  })

  it('keeps CSR row starts monotonic and targets in range', () => {
    const s = subnet()
    for (let i = 0; i < s.n; i++) expect(s.row[i + 1]).toBeGreaterThanOrEqual(s.row[i])
    let max = 0
    for (let k = 0; k < s.tgt.length; k++) if (s.tgt[k] > max) max = s.tgt[k]
    expect(max).toBeLessThan(s.n)
  })

  it('reads neurons.bin and keeps 18-digit flywire ids as BigInt64', () => {
    // an id that round-trips through float64 loses its last digits, so the view type
    // is the correctness property here, not just a parsing detail
    const out = parsePacked<{ n: number; flyid: BigInt64Array }>(
      readArrayBuffer('neurons.bin'), 'FLYN', 'neurons.bin')
    expect(out.flyid).toBeInstanceOf(BigInt64Array)
    expect(out.flyid.length).toBe(out.n)
    const id = out.flyid[0]
    expect(id).toBeGreaterThan(10n ** 17n)               // really is 18 digits
    expect(BigInt(Number(id))).not.toBe(id)              // and really would lose precision
  })

  it('rejects a misaligned array with a readable message', () => {
    // hand-build a header that is NOT padded, so f32 lands on an odd boundary
    const head = new TextEncoder().encode(
      JSON.stringify({ arrays: [{ name: 'a', type: 'f32', offset: 0, length: 1 }] }) + ' ')
    const buf = new ArrayBuffer(8 + head.length + 4)
    const u8 = new Uint8Array(buf)
    for (let i = 0; i < 4; i++) u8[i] = 'FLYT'.charCodeAt(i)
    new DataView(buf).setUint32(4, head.length, true)
    u8.set(head, 8)
    expect(() => parsePacked(buf, 'FLYT', 'x.bin')).toThrow(/not aligned to 4 bytes/)
  })
})
