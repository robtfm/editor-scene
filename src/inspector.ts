import { BevyApi } from './bevy-api'
import { autoLogin } from './login'
import { getCurrentInspectableScene } from './current-scene'
import {
  state,
  clearComponentEdits,
  componentKey,
  primeScroll,
  parentOf,
  topLevelSelected,
  markEdited,
  markComponentDeleted,
  markEntityDeleted,
  resetSaveChangelog,
  type ComponentKey,
  type Snapshot
} from './state'
import { buildEditedJson } from './fields'
import {
  decodeCustomComponents,
  isCustomComponent,
  customComponentId,
  customTimestamp,
  encodeCustomComponent,
  stringToBase64
} from './custom-components'
import { buildComposite, unknownComponentNames } from './composite'
import { getSchema, captureTransformDefaults, loadSchema, toSdkValue } from './schema'
import { localRelativeTo } from './world-pos'
import { sleep } from './utils'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { rotateVec3ByQuat } from './perspective-to-screen'

// Boot sequence: log in, then load the current scene's component state.
export async function startInspector(): Promise<void> {
  state.status = 'logging-in'
  await autoLogin()
  await refresh()
  // Best-effort, independent of the scene — populates the add-component picker.
  loadComponentNames().catch(console.error)
}

// Resolve the current non-portable scene, pin it as the inspection target, then
// pull a fresh CRDT snapshot.
export async function refresh(): Promise<void> {
  state.status = 'loading-snapshot'
  state.error = ''

  const scene = await getCurrentInspectableScene()
  if (scene === undefined) {
    state.scene = undefined
    state.status = 'no-scene'
    return
  }
  state.scene = scene

  // Pin the inspection target so subsequent snapshots/edits stay on this scene
  // even if the player wanders out of its parcels.
  try {
    await BevyApi.consoleCommand('set_scene', [scene.hash])
  } catch (e) {
    console.error('set_scene failed:', e)
  }

  await syncFrozenState()
  await reloadSnapshot()
}

// Sync the local frozen flag from the pinned scene's actual status (it may
// differ from our last action after a scene change or external freeze).
async function syncFrozenState(): Promise<void> {
  try {
    const stats = await BevyApi.consoleCommand('scene_stats')
    state.frozen = /status:\s*blocked/i.test(stats)
  } catch {
    // leave the flag as-is
  }
}

// --- transport controls (freeze / tick / unfreeze the pinned scene) ---

export async function pauseScene(): Promise<void> {
  try {
    await BevyApi.consoleCommand('freeze_scene')
    state.frozen = true
  } catch (e) {
    console.error('freeze_scene failed:', e)
  }
}

export async function playScene(): Promise<void> {
  try {
    await BevyApi.consoleCommand('unfreeze_scene')
    state.frozen = false
  } catch (e) {
    console.error('unfreeze_scene failed:', e)
  }
}

// Advance the frozen scene by `count` ticks, then re-pull the snapshot so the
// tree reflects the stepped frame. The scene re-freezes itself after the ticks.
export async function stepScene(count = 1): Promise<void> {
  try {
    await BevyApi.consoleCommand('tick_scene', [String(count)])
    state.frozen = true
    await sleep(150)
    await reloadSnapshot()
  } catch (e) {
    console.error('tick_scene failed:', e)
  }
}

// Re-pull the CRDT snapshot for the already-pinned scene (no re-resolve/re-pin).
export async function reloadSnapshot(): Promise<void> {
  try {
    const reply = await BevyApi.consoleCommand('crdt_snapshot')
    state.snapshot = JSON.parse(reply) as Snapshot
    decodeCustomComponents(state.snapshot)
    state.status = 'ready'
    primeScroll()
  } catch (e) {
    state.error = String(e)
    state.status = 'error'
  }
}

// Reload after a modification. /crdt_snapshot reads the scene's CRDT store, which
// only reflects our edits on the scene's next tick — so reload after a short
// settle. For deletes, retry until the removed ids actually disappear (bounded),
// so the tree can't keep showing a gone entity.
//
// A paused scene never ticks, so it never applies our inbound messages and
// /crdt_snapshot would return the pre-edit state. We instead keep the optimistic
// local snapshot (every edit updates it; see writeComponent/writeDelete) and
// skip the refetch entirely while frozen.
const SETTLE_MS = 150
async function reloadAfter(goneIds: string[] = []): Promise<void> {
  if (state.frozen) return
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(SETTLE_MS)
    await reloadSnapshot()
    if (goneIds.every((id) => !(id in state.snapshot))) return
  }
}

// Apply a component write to the local snapshot so the edit shows immediately,
// independent of whether/when the scene ticks it into its CRDT store. Merge into
// the existing value (rather than replace) so the field key order matches the
// CRDT snapshot — otherwise e.g. Transform.parent would jump in the editor list.
function applyLocalComponent(entityId: string, name: string, json: string): void {
  try {
    const value = JSON.parse(json) as unknown
    const entry = state.snapshot[entityId] ?? (state.snapshot[entityId] = {})
    const existing = entry[name]
    entry[name] = mergeKeepingOrder(existing, value)
  } catch {
    /* leave the snapshot unchanged on unparseable json */
  }
}

// `{ ...existing, ...value }` for plain objects (keeping existing's key order),
// else just `value`. Exported for the gizmo's optimistic writes.
export function mergeKeepingOrder(existing: unknown, value: unknown): unknown {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
  return isObj(existing) && isObj(value) ? { ...existing, ...value } : value
}

// Send a component write and reflect it locally (optimistic). Custom (non-engine-managed)
// components — which the engine can't address by name — are encoded with the SDK schema and
// written via /set_component_raw, carrying a timestamp newer than the snapshot's so the write
// wins LWW. Everything else goes through /set_component as JSON.
async function writeComponent(entityId: string, name: string, json: string): Promise<void> {
  applyLocalComponent(entityId, name, json)
  markEdited(entityId, name)
  if (isCustomComponent(name)) {
    const id = customComponentId(name)
    const b64 = encodeCustomComponent(name, JSON.parse(json))
    if (id === undefined || b64 === undefined) {
      throw new Error(`cannot encode custom component ${name}`)
    }
    const ts = customTimestamp(entityId, name) + 1
    await BevyApi.consoleCommand('set_component_raw', [entityId, String(id), String(ts), b64])
    return
  }
  await BevyApi.consoleCommand('set_component', [entityId, name, json])
}

// Remove an entity (and, recursively, its descendants) from the local snapshot.
function removeLocal(id: string, recursive: boolean): void {
  if (!recursive) {
    delete state.snapshot[id]
    markEntityDeleted(id)
    return
  }
  const all: string[] = []
  const stack = [id]
  while (stack.length > 0) {
    const cur = stack.pop() as string
    all.push(cur)
    for (const child of directChildren(cur)) stack.push(child)
  }
  for (const r of all) {
    delete state.snapshot[r]
    markEntityDeleted(r)
  }
  // Close the component window if its entity was removed.
  if (state.componentWindow !== null && !(state.componentWindow in state.snapshot)) {
    state.componentWindow = null
  }
}

// Send a delete and reflect it locally (optimistic).
async function writeDelete(id: string, recursive: boolean): Promise<void> {
  removeLocal(id, recursive)
  await BevyApi.consoleCommand('delete_entity', recursive ? [id, '-r'] : [id])
}

// --- add / delete component ---

// Fetch the catalog of editable component names (for the add-component picker).
// Best-effort: leaves the list empty (free-text fallback) on failure.
export async function loadComponentNames(): Promise<void> {
  try {
    const reply = await BevyApi.consoleCommand('component_names')
    const names = JSON.parse(reply) as unknown
    if (Array.isArray(names)) state.componentNames = names.filter((n) => typeof n === 'string')
  } catch (e) {
    console.error('component_names failed:', e)
  }
}

// Add a component, seeded with its full default shape. /component_default returns
// every field at its zero/default (serde emits the full tree — unset scalars 0/""/
// false, optional/message/oneof null, repeated []), so the field editor has all the
// fields to edit immediately, even while paused (the write itself still encodes the
// proto default). Falls back to `{}` if the default fetch fails. The new component is
// expanded so it's ready to edit. No-op if the entity already has it.
export async function addComponent(entityId: string, name: string): Promise<void> {
  if (state.snapshot[entityId]?.[name] !== undefined) return
  const key = componentKey(entityId, name)
  state.expandedComponents.add(key)

  let json = '{}'
  try {
    const reply = await BevyApi.consoleCommand('component_default', [name])
    JSON.parse(reply) // validate before adopting it
    json = reply
  } catch (e) {
    console.error('component_default failed (using {}):', name, e)
  }

  try {
    await writeComponent(entityId, name, json)
    await reloadAfter()
  } catch (e) {
    console.error('add_component failed:', name, e)
  }

  // Seed any `@transform.*` fields (e.g. a Tween's start/end) from the entity's current
  // Transform once, so they capture the placement at creation instead of live-tracking it.
  // Needs the schema; fetch it if it isn't cached yet.
  try {
    if (getSchema(name) === undefined) {
      const reply = await BevyApi.consoleCommand('component_schema', [name])
      state.schemas.set(name, JSON.parse(reply))
    }
    captureTransformDefaults(key)
  } catch {
    /* no schema → nothing to capture */
  }
}

// Remove a component from an entity (optimistic local removal + /delete_component).
export function deleteComponent(entityId: string, name: string): void {
  const entry = state.snapshot[entityId]
  if (entry !== undefined) delete entry[name]
  const key = componentKey(entityId, name)
  state.expandedComponents.delete(key)
  clearComponentEdits(key)
  markComponentDeleted(entityId, name)
  BevyApi.consoleCommand('delete_component', [entityId, name]).catch((e) => {
    console.error('delete_component failed:', name, e)
  })
}

// Write a component value via /set_component, then refresh so the tree reflects
// it. `json` is validated (and compacted) client-side first. Records the outcome
// in state.editStatus[key].
export async function setComponentValue(
  key: ComponentKey,
  entityId: string,
  name: string,
  json: string
): Promise<void> {
  let compact: string
  try {
    compact = JSON.stringify(JSON.parse(json))
  } catch (e) {
    state.editStatus.set(key, 'invalid JSON')
    return
  }

  try {
    await writeComponent(entityId, name, compact)
    state.editStatus.set(key, '✓ set')
    clearComponentEdits(key)
    await reloadAfter()
  } catch (e) {
    state.editStatus.set(key, String(e))
  }
}

// --- save ---

// Persist the authored scene as a flat main.composite: start from the loaded baseline
// (/crdt_initial), override each component the editor changed this session with its live value
// (so runtime churn isn't persisted), drop editor-deleted entities/components, build the
// composite, and ship it to /save_composite. A returned path is cached to skip the dialog next
// time; on success the changelog resets (the saved state becomes the new baseline).
export async function saveComposite(): Promise<void> {
  state.saveStatus = 'saving…'
  try {
    const initialReply = await BevyApi.consoleCommand('crdt_initial')
    const initial = JSON.parse(initialReply) as Snapshot
    decodeCustomComponents(initial)
    const live = state.snapshot

    const authored: Record<string, Record<string, unknown>> = {}
    const ensure = (eid: string): Record<string, unknown> => {
      if (authored[eid] === undefined) authored[eid] = {}
      return authored[eid]
    }
    const split = (key: string): [string, string] => {
      const i = key.indexOf('/')
      return [key.slice(0, i), key.slice(i + 1)]
    }

    // baseline (authored source), minus editor-deleted entities
    for (const [eid, comps] of Object.entries(initial)) {
      if (state.deletedEntities.has(eid)) continue
      for (const [name, value] of Object.entries(comps)) ensure(eid)[name] = value
    }
    // editor edits override the baseline with the live value (and add new components)
    for (const key of state.editedComponents) {
      const [eid, name] = split(key)
      if (state.deletedEntities.has(eid)) continue
      const v = live[eid]?.[name]
      if (v !== undefined) ensure(eid)[name] = v
    }
    // editor-removed components
    for (const key of state.deletedComponents) {
      const [eid, name] = split(key)
      if (authored[eid] !== undefined) delete authored[eid][name]
    }

    // Protocol components arrive in engine form (a protobuf oneof as `{case: val}` with no
    // `$case`), which the composite instancer drops on load. Convert them to SDK form using each
    // component's schema. Custom components are already SDK form (decoded via the SDK schema).
    const protoNames = new Set<string>()
    for (const comps of Object.values(authored)) {
      for (const name of Object.keys(comps)) {
        if (!isCustomComponent(name)) protoNames.add(name)
      }
    }
    await Promise.all([...protoNames].map(loadSchema))
    for (const comps of Object.values(authored)) {
      for (const name of Object.keys(comps)) {
        if (isCustomComponent(name)) continue
        const schema = getSchema(name)
        if (schema !== undefined) comps[name] = toSdkValue(comps[name], schema.root)
      }
    }

    const composite = buildComposite(authored)
    const skipped = unknownComponentNames(authored)
    // The engine derives the destination from the active scene (local path, else a dialog/picker)
    // and remembers it, so we just hand over the bytes.
    const path = await BevyApi.consoleCommand('save_composite', [stringToBase64(composite)])
    resetSaveChangelog()
    state.saveStatus =
      skipped.length > 0 ? `saved → ${path} (skipped: ${skipped.join(', ')})` : `saved → ${path}`
  } catch (e) {
    state.saveStatus = `save failed: ${String(e)}`
  }
}

// --- gizmo drag commits ---

// Fire a Transform write without awaiting/reloading — used per-frame during a
// gizmo drag (the engine applies it to the bevy entity immediately; the gizmo
// previews from its own computed position).
export function fireTransform(entityId: string, json: string): void {
  BevyApi.consoleCommand('set_component', [entityId, 'Transform', json]).catch(
    () => {}
  )
}

// Re-sync the snapshot after a drag ends (settle so the tree reflects the move).
export async function syncAfterDrag(): Promise<void> {
  await reloadAfter()
}

// --- delete / reparent ---

type V3 = { x: number; y: number; z: number }
type Q = { x: number; y: number; z: number; w: number }
type TransformValue = { position: V3; rotation: Q; scale: V3; parent: number }

function readTransform(id: string): TransformValue {
  const t = state.snapshot[id]?.Transform as Partial<TransformValue> | undefined
  return {
    position: t?.position ?? { x: 0, y: 0, z: 0 },
    rotation: t?.rotation ?? { x: 0, y: 0, z: 0, w: 1 },
    scale: t?.scale ?? { x: 1, y: 1, z: 1 },
    parent: t?.parent ?? 0
  }
}

function directChildren(id: string): string[] {
  const pid = Number(id)
  return Object.keys(state.snapshot).filter(
    (c) => (state.snapshot[c]?.Transform as TransformValue | undefined)?.parent === pid
  )
}

// Express `child` (currently local to `parent`) in `parent`'s parent frame, so
// it keeps its world placement when `parent` is removed: parent ∘ child.
function composeIntoGrandparent(
  parent: TransformValue,
  child: TransformValue,
  grandparent: number
): string {
  const pPos = Vector3.create(parent.position.x, parent.position.y, parent.position.z)
  const pRot = Quaternion.create(parent.rotation.x, parent.rotation.y, parent.rotation.z, parent.rotation.w)
  const pScale = Vector3.create(parent.scale.x, parent.scale.y, parent.scale.z)
  const cPos = Vector3.create(child.position.x, child.position.y, child.position.z)
  const cRot = Quaternion.create(child.rotation.x, child.rotation.y, child.rotation.z, child.rotation.w)
  const cScale = Vector3.create(child.scale.x, child.scale.y, child.scale.z)

  const pos = Vector3.add(pPos, rotateVec3ByQuat(Vector3.multiply(cPos, pScale), pRot))
  const rot = Quaternion.multiply(pRot, cRot)
  const scale = Vector3.multiply(pScale, cScale)

  return JSON.stringify({
    position: { x: pos.x, y: pos.y, z: pos.z },
    rotation: { x: rot.x, y: rot.y, z: rot.z, w: rot.w },
    scale: { x: scale.x, y: scale.y, z: scale.z },
    parent: grandparent
  })
}

// How many direct children an entity has (for the confirm dialog).
export function childCount(id: string): number {
  return directChildren(id).length
}

export function childIdsOf(id: string): string[] {
  return directChildren(id)
}

// Delete just the entity. Its children are left parented to the (now gone)
// entity — use deleteEntityReparent to keep them, or recursive to remove them.
export async function deleteEntity(id: string): Promise<void> {
  state.deleteConfirm = null
  try {
    await writeDelete(id, false)
  } catch (e) {
    console.error('delete_entity failed:', e)
  }
  await reloadAfter([id])
}

export async function deleteEntityRecursive(id: string): Promise<void> {
  state.deleteConfirm = null
  try {
    await writeDelete(id, true)
  } catch (e) {
    console.error('delete_entity -r failed:', e)
  }
  await reloadAfter([id])
}

// Reparent each direct child to the entity's parent (preserving world placement),
// then delete the entity.
export async function deleteEntityReparent(id: string): Promise<void> {
  state.deleteConfirm = null
  const parentT = readTransform(id)
  for (const childId of directChildren(id)) {
    const json = composeIntoGrandparent(parentT, readTransform(childId), parentT.parent)
    try {
      await writeComponent(childId, 'Transform', json)
    } catch (e) {
      console.error('reparent child failed:', childId, e)
    }
  }
  try {
    await writeDelete(id, false)
  } catch (e) {
    console.error('delete_entity failed:', e)
  }
  await reloadAfter([id])
}

// Whether `ancestor` is an ancestor of `node` in the snapshot hierarchy.
function isAncestorOf(snapshot: Snapshot, ancestor: string, node: string): boolean {
  let cur = parentOf(snapshot, node)
  while (cur !== null) {
    if (cur === ancestor) return true
    cur = parentOf(snapshot, cur)
  }
  return false
}

// Reparent the selection under the active entity, preserving each item's world
// placement. Only top-level selected entities move (a selected sub-tree stays
// intact); the active entity, its ancestors (would cycle), and entities already
// parented to it are skipped.
export async function reparentSelectionToActive(): Promise<void> {
  const active = state.activeEntity
  if (active === null || state.selected.size < 2) return
  const snap = state.snapshot

  const targets = topLevelSelected(snap).filter(
    (c) =>
      c !== active &&
      !isAncestorOf(snap, c, active) &&
      String(readTransform(c).parent) !== active
  )

  for (const c of targets) {
    const local = localRelativeTo(snap, c, active)
    const json = JSON.stringify({ ...local, parent: Number(active) })
    try {
      await writeComponent(c, 'Transform', json)
    } catch (e) {
      console.error('reparent failed:', c, e)
    }
  }
  await reloadAfter()
}

// Detach each selected entity to the scene root (parent 0), preserving world
// placement. Entities already at root are skipped. The new parent (root) is
// always uniform, so this is exact except for a child that was sheared under a
// non-uniformly-scaled parent — which can't keep its shape outside it anyway.
export async function clearParentOfSelection(): Promise<void> {
  const snap = state.snapshot
  const targets = [...state.selected].filter((id) => (readTransform(id).parent ?? 0) !== 0)
  for (const id of targets) {
    const local = localRelativeTo(snap, id, '0')
    const json = JSON.stringify({ ...local, parent: 0 })
    try {
      await writeComponent(id, 'Transform', json)
    } catch (e) {
      console.error('clear parent failed:', id, e)
    }
  }
  await reloadAfter()
}

// Whether any selected entity currently has a non-root parent.
export function selectionHasParented(): boolean {
  for (const id of state.selected) {
    if ((readTransform(id).parent ?? 0) !== 0) return true
  }
  return false
}

// Apply structured-editor edits: rebuild the JSON from the snapshot value shape
// + per-field edits, then write it.
export async function applyStructuredEdits(
  key: ComponentKey,
  entityId: string,
  name: string,
  value: unknown
): Promise<void> {
  const built = buildEditedJson(key, value)
  if (!built.ok) {
    state.editStatus.set(key, built.error)
    return
  }
  await setComponentValue(key, entityId, name, built.json)
}
