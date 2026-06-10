// Migration harness: verify the scene-side curated overlay reproduces the engine's combined schema.
// Fetches both `/component_schema` (combined, engine applies the overlay) and `/component_schema_raw`
// (structural only), applies the scene's curated overlay to the raw, and deep-diffs the two per
// component — logging any mismatch. Once this reports 0 mismatched, the editor can switch to
// raw + scene-overlay and the engine overlay can be deleted. Remove this file after the migration.

import { BevyApi } from './bevy-api'
import { applyCurated, TRANSFORM_SCHEMA, validateCurated } from './curated'
import type { ComponentSchema } from './schema'

// First differing path between two parsed-JSON values, or null if deep-equal (key-order agnostic).
function firstDiff(a: unknown, b: unknown, path: string): string | null {
  if (a === b) return null
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return `${path || '<root>'}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: array vs non-array`
    if (a.length !== b.length) return `${path}: length ${a.length} != ${b.length}`
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`)
      if (d) return d
    }
    return null
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    const d = firstDiff(ao[k], bo[k], path ? `${path}.${k}` : k)
    if (d) return d
  }
  return null
}

export async function compareSchemas(): Promise<void> {
  const dataErrors = validateCurated()
  if (dataErrors.length > 0) {
    console.error(`[schema-compare] curated.json: ${dataErrors.length} invalid entr(ies)`)
    for (const e of dataErrors) console.error(`[schema-compare] DATA ${e}`)
  }
  let combined: Record<string, ComponentSchema>
  let raw: Record<string, ComponentSchema>
  try {
    combined = JSON.parse(await BevyApi.consoleCommand('component_schema')) as Record<string, ComponentSchema>
    raw = JSON.parse(await BevyApi.consoleCommand('component_schema_raw')) as Record<string, ComponentSchema>
  } catch (e) {
    console.error('[schema-compare] failed to fetch schemas:', e)
    return
  }
  const mismatches: string[] = []
  let ok = 0
  for (const name of Object.keys(combined)) {
    const expected = name === 'Transform' ? TRANSFORM_SCHEMA : raw[name] ? applyCurated(raw[name]) : undefined
    if (expected === undefined) {
      mismatches.push(`${name}: no raw schema`)
      continue
    }
    const diff = firstDiff(expected, combined[name], '')
    if (diff === null) ok++
    else mismatches.push(`${name} — ${diff}`)
  }
  console.log(
    `[schema-compare] ${Object.keys(combined).length} components: ${ok} ok, ${mismatches.length} mismatched`
  )
  for (const m of mismatches) console.error(`[schema-compare] MISMATCH ${m}`)
}
