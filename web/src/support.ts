// What this app needs from the browser, checked up front so an unsupported one gets a
// sentence instead of a blank page.
//
// Baselines, for reference: WebGL2 is Safari 15 / Chrome 56 / Firefox 51; ES-module
// workers are Safari 15 / Chrome 80 / Firefox 114; CanvasRenderingContext2D.roundRect
// is Safari 16.4 / Chrome 99 / Firefox 112.

export interface Missing { name: string; why: string }

export function webgl2(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!c.getContext('webgl2')
  } catch {
    return false
  }
}

export function moduleWorkers(): boolean {
  let ok = false
  try {
    // the option bag's `type` getter only runs if the browser reads it
    new Worker('data:application/javascript,', { get type() { ok = true; return 'module' } } as never)
  } catch {
    /* constructing from a data: URL may be blocked; the getter still tells us */
  }
  return ok
}

export function roundRect(): boolean {
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    return typeof ctx?.roundRect === 'function'
  } catch {
    return false
  }
}

/** Hard requirements only. Anything with a working fallback is not listed here. */
export function missingFeatures(): Missing[] {
  const out: Missing[] = []
  if (!webgl2()) {
    out.push({ name: 'WebGL 2', why: 'the brain and the world are both drawn on the GPU' })
  }
  if (!moduleWorkers()) {
    out.push({ name: 'ES-module Web Workers', why: 'the simulation runs off the main thread' })
  }
  if (typeof BigInt64Array === 'undefined') {
    out.push({ name: 'BigInt64Array', why: 'flywire neuron ids are 18 digits and will not fit a double' })
  }
  return out
}
