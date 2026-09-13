import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parsePacked } from '../src/pet/packed'
import type { ModelConstants, SubnetData } from '../src/pet/sim'

const DATA = resolve(__dirname, '../public/data')

/** Read a file as a standalone ArrayBuffer (Buffer views share a pooled backing store). */
export function readArrayBuffer(name: string): ArrayBuffer {
  const b = readFileSync(resolve(DATA, name))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

export interface PetConfig {
  n_subnet: number
  model: ModelConstants
  sensors: { id: string; label: string; rate_hz: number; n: number
             sides: { left: number[]; right: number[]; other: number[] } }[]
  readouts: { id: string; label: string; n: number
              sides: { left: number[]; right: number[]; other: number[] } }[]
}

export const petConfig = (): PetConfig =>
  JSON.parse(readFileSync(resolve(DATA, 'pet.json'), 'utf8'))

export const subnet = (): SubnetData =>
  parsePacked<SubnetData>(readArrayBuffer('subnet.bin'), 'FLYS', 'subnet.bin')
