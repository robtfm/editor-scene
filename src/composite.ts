// Build an on-disk main.composite from authored component data. The format (CompositeDefinition
// JSON via Composite.toJson) is:
//   { version, components: [ { name, jsonSchema, data: { "<entityId>": { "json": <value> } } } ] }
// Every component embeds its jsonSchema (protocol and custom alike), so a name -> SDK definition
// map is needed to recover each component's composite name (e.g. "core::Transform") and schema.

import * as ecs from '@dcl/sdk/ecs'
import { Composite } from '@dcl/sdk/ecs'
import { customComponentDefs } from './custom-components'

type CompositeDef = { componentName: string; jsonSchema: unknown }

// snapshot component name -> { composite name, jsonSchema }. Protocol components are keyed by
// their SDK export name (which matches the engine registry / snapshot name); custom components by
// their namespaced componentName (which is the snapshot name after decode).
const DEFS = new Map<string, CompositeDef>()

function isComponentDef(
  v: unknown
): v is { componentId: number; componentName: string; schema: { jsonSchema: unknown } } {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  const schema = o.schema as Record<string, unknown> | undefined
  return (
    typeof o.componentId === 'number' &&
    typeof o.componentName === 'string' &&
    typeof schema === 'object' &&
    schema !== null &&
    'jsonSchema' in schema
  )
}

for (const [key, val] of Object.entries(ecs as Record<string, unknown>)) {
  if (isComponentDef(val)) {
    DEFS.set(key, { componentName: val.componentName, jsonSchema: val.schema.jsonSchema })
  }
}
for (const d of customComponentDefs()) {
  DEFS.set(d.componentName, d)
}

// Engine-managed / non-authored components that leak into the baseline or live snapshot but must
// not be written to an authored composite. (Expandable as more are observed.)
const EXCLUDE = new Set<string>(['RealmInfo', 'EngineInfo', 'MainCamera'])

type AuthoredData = Record<string, Record<string, unknown>>

// Entities 1..511 are reserved for the engine (player, camera, etc.) — they're referenced by
// scenes but never authored, and writing scene components onto them breaks composite instancing.
// The authored set is the root (0) plus scene entities (>=512).
function isAuthoredEntity(eid: number): boolean {
  return eid === 0 || eid >= 512
}

// Build the main.composite JSON string from authored {entityId: {componentName: value}} data.
// Components in EXCLUDE or without a known SDK definition are skipped.
export function buildComposite(authored: AuthoredData): string {
  type Comp = {
    name: string
    jsonSchema: unknown
    data: Map<number, { data: { $case: 'json'; json: unknown } }>
  }
  const byComponent = new Map<string, Comp>()

  for (const [entityId, comps] of Object.entries(authored)) {
    const eid = Number(entityId)
    if (!Number.isFinite(eid) || !isAuthoredEntity(eid)) continue
    for (const [name, value] of Object.entries(comps)) {
      if (EXCLUDE.has(name)) continue
      const def = DEFS.get(name)
      if (def === undefined) continue
      let comp = byComponent.get(def.componentName)
      if (comp === undefined) {
        comp = { name: def.componentName, jsonSchema: def.jsonSchema, data: new Map() }
        byComponent.set(def.componentName, comp)
      }
      comp.data.set(eid, { data: { $case: 'json', json: value } })
    }
  }

  const definition = {
    version: 1,
    components: [...byComponent.values()]
  } as unknown as Composite.Definition

  return JSON.stringify(Composite.toJson(definition))
}

// Names present in `authored` with no known SDK definition (so they're skipped) — surfaced so the
// editor can warn which components weren't persisted.
export function unknownComponentNames(authored: AuthoredData): string[] {
  const unknown = new Set<string>()
  for (const [entityId, comps] of Object.entries(authored)) {
    if (!isAuthoredEntity(Number(entityId))) continue
    for (const name of Object.keys(comps)) {
      if (!EXCLUDE.has(name) && !DEFS.has(name)) unknown.add(name)
    }
  }
  return [...unknown]
}
