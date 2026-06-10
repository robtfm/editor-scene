// Curated semantic overlay — the editor-side equivalent of the engine's build_schema_overlay.rs.
// Carries what proto reflection can't: semantic kinds, ranges, curated (runtime) defaults, units,
// refs, and per-component placement/requires. Applied onto the RAW structural schema the engine
// returns (`/component_schema_raw`) to produce the combined schema the editor renders.
//
// The data lives in `curated.json` (hand-editable). Keyed by component name; fields by camelCase
// dotted path — oneof cases as `oneof.case.field`, repeated elements as `field[]` — matching the
// engine's apply_overlay path scheme. The JSON is cast to the typed shape below (so consumers stay
// typed) and checked at runtime by validateCurated() (the value-level constraints JSON typing
// can't express, e.g. the placement set or range arity).

import type { ComponentSchema } from './schema'
import curatedData from './curated.json'

type Placement = 'any' | 'root' | 'camera' | 'player' | 'uiEntity' | 'uiRoot'
type Locality = 'same' | 'ancestor' | 'descendant'

// [min|null, max|null, hard] — mirrors the engine's (Option<f64>, Option<f64>, bool).
type Range = [number | null, number | null, boolean]

type FieldOverlay = {
  semantic?: string
  range?: Range
  default?: unknown // already-parsed JSON value
  notes?: string
}

type ComponentOverlay = {
  placement: Placement
  requires?: Array<[string, Locality, boolean]> // [component, locality, hard]
  fields?: Record<string, FieldOverlay>
}

const CURATED = curatedData as unknown as Record<string, ComponentOverlay>

// Transform is not a proto message — hand-authored in full (structure + semantics), so the scene
// owns it outright (the raw endpoint omits it). Mirrors the engine's transform_schema().
export const TRANSFORM_SCHEMA: ComponentSchema = {
  name: 'Transform',
  placement: 'any',
  readOnly: false,
  requires: [],
  root: {
    kind: 'message',
    fields: [
      { name: 'position', kind: 'leaf', semantic: 'vector3', optional: false, default: { x: 0, y: 0, z: 0 } },
      { name: 'rotation', kind: 'leaf', semantic: 'quaternion', optional: false, default: { x: 0, y: 0, z: 0, w: 1 } },
      { name: 'scale', kind: 'leaf', semantic: 'vector3', optional: false, default: { x: 1, y: 1, z: 1 } },
      { name: 'parent', kind: 'leaf', semantic: 'entityRef:any', optional: false, default: 0, notes: 'parent entity; 0 = scene root' }
    ]
  },
  enums: {}
}

// --- merge (mirrors the engine's apply_overlay / annotate, by dotted path) ---

type Obj = Record<string, unknown>

function annotate(node: Obj, fo: FieldOverlay): void {
  if (fo.semantic !== undefined) node.semantic = fo.semantic
  if (fo.range !== undefined) {
    const [min, max, hard] = fo.range
    const r: Obj = {}
    if (min !== null) r.min = min
    if (max !== null) r.max = max
    r.hard = hard
    node.range = r
  }
  if (fo.default !== undefined) node.default = fo.default
  if (fo.notes !== undefined) node.notes = fo.notes
}

function join(prefix: string, name: string): string {
  return prefix ? `${prefix}.${name}` : name
}

function applyNode(node: Obj, prefix: string, fields: Record<string, FieldOverlay>): void {
  const kind = node.kind as string
  if (kind === 'message') {
    const arr = node.fields as Obj[] | undefined
    if (arr) for (const child of arr) applyChild(child, prefix, fields)
  } else if (kind === 'oneof') {
    const cases = node.cases as Array<{ name: string; field: Obj }> | undefined
    if (cases) for (const c of cases) applyNode(c.field, join(prefix, c.name), fields)
  }
}

function applyChild(child: Obj, prefix: string, fields: Record<string, FieldOverlay>): void {
  const path = join(prefix, child.name as string)
  const fo = fields[path]
  if (fo) annotate(child, fo)
  const kind = child.kind as string
  if (kind === 'message' || kind === 'oneof') {
    applyNode(child, path, fields)
  } else if (kind === 'repeated') {
    const el = child.element as Obj | undefined
    if (el) {
      const p = `${path}[]`
      const efo = fields[p]
      if (efo) annotate(el, efo)
      applyNode(el, p, fields)
    }
  }
}

// Apply the curated overlay to a RAW component schema, returning the combined schema the editor
// renders (a deep clone — the raw is not mutated). No-op overlay for components without an entry.
export function applyCurated(raw: ComponentSchema): ComponentSchema {
  const schema = JSON.parse(JSON.stringify(raw)) as ComponentSchema
  const cur = CURATED[raw.name]
  if (cur) {
    schema.placement = cur.placement
    schema.requires = (cur.requires ?? []).map(([component, locality, hard]) => ({
      component,
      locality,
      hard
    }))
    if (cur.fields) applyNode(schema.root as unknown as Obj, '', cur.fields)
  }
  return schema
}

// --- runtime validation of curated.json (the cast above hides value-level errors from tsc) ---

const PLACEMENTS: ReadonlySet<string> = new Set(['any', 'root', 'camera', 'player', 'uiEntity', 'uiRoot'])
const LOCALITIES: ReadonlySet<string> = new Set(['same', 'ancestor', 'descendant'])

const isNumOrNull = (v: unknown): boolean => v === null || typeof v === 'number'

// Check the hand-edited curated.json against the value-level constraints. Returns a list of
// problems (empty = valid); the startup harness logs them.
export function validateCurated(): string[] {
  const errs: string[] = []
  for (const [name, c] of Object.entries(CURATED)) {
    if (!PLACEMENTS.has(c.placement)) errs.push(`${name}: invalid placement '${c.placement}'`)
    for (const r of c.requires ?? []) {
      if (
        !Array.isArray(r) ||
        r.length !== 3 ||
        typeof r[0] !== 'string' ||
        !LOCALITIES.has(r[1] as string) ||
        typeof r[2] !== 'boolean'
      ) {
        errs.push(`${name}: invalid requires ${JSON.stringify(r)}`)
      }
    }
    for (const [path, fo] of Object.entries(c.fields ?? {})) {
      if (fo.semantic !== undefined && typeof fo.semantic !== 'string') errs.push(`${name}.${path}: invalid semantic`)
      if (fo.notes !== undefined && typeof fo.notes !== 'string') errs.push(`${name}.${path}: invalid notes`)
      const r = fo.range
      if (r !== undefined && (!Array.isArray(r) || r.length !== 3 || !isNumOrNull(r[0]) || !isNumOrNull(r[1]) || typeof r[2] !== 'boolean')) {
        errs.push(`${name}.${path}: invalid range ${JSON.stringify(r)}`)
      }
    }
  }
  return errs
}
