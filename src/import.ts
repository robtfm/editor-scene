// Composite import: pull a catalog asset's construction data from the engine and instance it into
// the current scene. The engine (`/asset_catalog`, `/init_asset`) owns sourcing — it fetches the
// asset-packs catalog, copies the asset's files into the scene's content map (so GltfContainer.src
// resolves), and returns the composite with `{assetPath}` already substituted. This module does the
// scene-side instancing: allocate a fresh entity per composite entity, remap entity-id references
// (Transform.parent), translate composite component names to editor names, and write the values.

import { BevyApi } from './bevy-api'
import { state, selectEntityInTree } from './state'
import { editorNameForComposite } from './composite'
import { allocateNamedEntities, writeComponent, reloadSnapshot } from './inspector'
import { sleep } from './utils'

const COMPOSITE_NAME = 'core-schema::Name'
const TRANSFORM = 'core::Transform'

// asset-pack behaviour components carry entity/id reference tokens ({self:...}/{N:...}) and
// engine-generated action ids we don't yet remap — defer them so a bad reference can't be written.
// Visual/structural import (models, materials, hierarchy) is unaffected.
const DEFERRED = new Set([
  'asset-packs::Actions',
  'asset-packs::Triggers',
  'asset-packs::Counter',
  'asset-packs::CounterBar',
  'asset-packs::States'
])

type CompositeComponent = { name: string; data: Record<string, { json: unknown }> }
type Composite = { version?: number; components: CompositeComponent[] }
type Vec3 = { x: number; y: number; z: number }
type TransformJson = { parent?: number; position?: Vec3; rotation?: Vec3 & { w: number }; scale?: Vec3 }

export type CatalogEntry = {
  id: string
  name: string
  category: string
  tags: string[]
  pack: string
}

// Fetch (engine-side) the asset-packs catalog and return the slim asset index for a picker.
export async function fetchCatalog(): Promise<CatalogEntry[]> {
  const reply = await BevyApi.consoleCommand('asset_catalog')
  const parsed = JSON.parse(reply) as unknown
  return Array.isArray(parsed) ? (parsed as CatalogEntry[]) : []
}

// Import catalog asset `assetId` into the current scene, parented under `parent` (0 = scene root),
// and select its root. Requires fetchCatalog() to have run (so the engine cached the catalog).
export async function importAsset(assetId: string, parent = 0): Promise<void> {
  const reply = await BevyApi.consoleCommand('init_asset', [assetId])
  const parsed = JSON.parse(reply) as {
    baseDir: string
    composite: Composite
    written?: number
    errors?: string[]
  }
  const { composite } = parsed
  // The engine pushes the asset's files to the scene folder at import (so it renders without a
  // save/reload). Surface that outcome — especially failures (e.g. a denied directory pick).
  console.log(`[import ${assetId}] ${parsed.written ?? 0} file(s) written`)
  if (parsed.errors && parsed.errors.length > 0) {
    console.error(`[import ${assetId}] ${parsed.errors.join('; ')}`)
  }
  if (!composite || !Array.isArray(composite.components)) return

  // --- gather every composite entity, its Transform, Name, and (mapped) components ---
  const entityIds = new Set<number>()
  const transforms = new Map<number, TransformJson>()
  const names = new Map<number, string>()
  const comps = new Map<number, Map<string, unknown>>() // entity -> (editorName -> value)

  for (const comp of composite.components) {
    for (const [eidStr, cell] of Object.entries(comp.data)) {
      const eid = Number(eidStr)
      if (!Number.isFinite(eid)) continue
      entityIds.add(eid)
      const json = cell?.json

      if (comp.name === TRANSFORM) {
        const t = (json ?? {}) as TransformJson
        transforms.set(eid, t)
        if (typeof t.parent === 'number') entityIds.add(t.parent)
        continue
      }
      if (comp.name === COMPOSITE_NAME) {
        const v = json as { value?: string } | undefined
        if (v && typeof v.value === 'string') names.set(eid, v.value)
        continue
      }
      if (DEFERRED.has(comp.name)) {
        console.error(`import: ${comp.name} carries id references not yet remapped, skipped`)
        continue
      }
      const editorName = editorNameForComposite(comp.name)
      if (editorName === undefined) {
        console.error(`import: unknown component ${comp.name}, skipped`)
        continue
      }
      let m = comps.get(eid)
      if (!m) {
        m = new Map()
        comps.set(eid, m)
      }
      m.set(editorName, json)
    }
  }

  const ordered = [...entityIds].sort((a, b) => a - b)
  // A root has no Transform, or a parent that isn't itself part of the composite.
  const isRoot = (eid: number): boolean => {
    const p = transforms.get(eid)?.parent
    return typeof p !== 'number' || !entityIds.has(p)
  }

  // --- phase 1: allocate all entities (Name-seeded) so parent refs can be remapped ---
  const newIds = await allocateNamedEntities(
    ordered.map((eid) => ({ value: names.get(eid) ?? `Entity_${eid}` }))
  )
  const idMap = new Map<number, number>()
  ordered.forEach((eid, i) => {
    const n = newIds[i]
    if (n != null) idMap.set(eid, n)
  })

  // --- phase 2: write a (parent-remapped) Transform and the remaining components per entity ---
  let mainNew: number | null = null
  for (const eid of ordered) {
    const newId = idMap.get(eid)
    if (newId === undefined) continue
    const newIdStr = String(newId)

    // Remap parent: composite-local id -> its new id; roots (or refs outside the composite) attach
    // to the target parent. Fill identity defaults for any missing Transform fields (a partial
    // write would leave scale 0 -> invisible), matching the Hub's addChild.
    const t = transforms.get(eid)
    const parentNew = isRoot(eid) ? parent : idMap.get(t!.parent as number) ?? parent
    const transformValue = {
      position: t?.position ?? { x: 0, y: 0, z: 0 },
      rotation: t?.rotation ?? { x: 0, y: 0, z: 0, w: 1 },
      scale: t?.scale ?? { x: 1, y: 1, z: 1 },
      parent: parentNew
    }
    await writeComponent(newIdStr, 'Transform', JSON.stringify(transformValue))

    const m = comps.get(eid)
    if (m) {
      for (const [editorName, value] of m) {
        try {
          await writeComponent(newIdStr, editorName, JSON.stringify(value))
        } catch (e) {
          console.error(`import: failed to write ${editorName} on ${newIdStr}:`, e)
        }
      }
    }

    if (mainNew === null && isRoot(eid)) mainNew = newId
  }

  // Wait (bounded) for the scene to tick the imported entities in, then select the root.
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(150)
    await reloadSnapshot()
    if (mainNew === null || state.snapshot[String(mainNew)] !== undefined) break
  }
  if (mainNew !== null) {
    const eid = String(mainNew)
    state.selected.clear()
    state.selected.add(eid)
    state.activeEntity = eid
    selectEntityInTree(state.snapshot, eid)
  }
}
