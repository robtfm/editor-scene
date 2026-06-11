// Pure value-comparison helpers shared by the save diff and the undo stack. Leaf module — no imports,
// so both state.ts and save-diff.ts can depend on it without a cycle.

// A value at one source, or absent (component not present / deleted).
export type Cell = { present: boolean; value?: unknown }

export const ABSENT: Cell = { present: false }
export const cell = (v: unknown): Cell => (v === undefined ? ABSENT : { present: true, value: v })

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  // Numbers compare modulo float32 rounding: the editor writes float64, but the engine stores
  // component floats (Transform position/rotation/scale, colours, …) as f32 and re-emits the
  // rounded value — so a just-saved value reloads ~1 ULP off its source. Real edits exceed f32 ULP.
  if (typeof a === 'number' && typeof b === 'number') return Math.fround(a) === Math.fround(b)
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const keys = Object.keys(ao)
  if (keys.length !== Object.keys(bo).length) return false
  return keys.every((k) => k in bo && deepEqual(ao[k], bo[k]))
}

export function cellsEqual(a: Cell, b: Cell): boolean {
  if (a.present !== b.present) return false
  return !a.present || deepEqual(a.value, b.value)
}
