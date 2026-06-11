import { BevyApi } from './bevy-api'
import { autoLogin } from './login'
import { validateCurated } from './curated'
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
  selectEntityInTree,
  setActiveAction,
  beginTxn,
  commitTxn,
  recordOp,
  snapshotChangelog,
  restoreChangelog,
  pushReloadEntry,
  clearUndoHistory,
  type ComponentKey,
  type Snapshot,
  type UndoEntry
} from './state'
import { cell, ABSENT, type Cell } from './diff-util'
import { buildEditedJson } from './fields'
import { logicalSnapshot, resetOverlays } from './overlays'
import { resetHighlightSync } from './highlight'
import {
  decodeCustomComponents,
  isCustomComponent,
  customComponentId,
  customTimestamp,
  encodeCustomComponent,
  createCustomDefault,
  stringToBase64,
  NAME_COMPONENT
} from './custom-components'
import { buildComposite, unknownComponentNames } from './composite'
import {
  computeSaveDiff,
  buildAuthoredFromSelection,
  defaultSelection,
  addedAuthoredEntities,
  type DiffRow,
  type DiffSource
} from './save-diff'
import {
  getSchema,
  captureTransformDefaults,
  loadSchema,
  toSdkValue,
  preloadSchemas
} from './schema'
import { localRelativeTo } from './world-pos'
import { playerSpawnPosition } from './spawn'
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
  // Surface any invalid hand-edited curated.json entries at startup.
  for (const e of validateCurated()) console.error(`[curated] ${e}`)
}

// Resolve the current non-portable scene, pin it as the inspection target, then
// pull a fresh CRDT snapshot.
export async function refresh(): Promise<void> {
  state.status = 'loading-snapshot'
  state.error = ''

  // Once we've locked onto a scene, stay on it for the rest of the session — never re-derive from
  // the player's location. We only resolve the player's current parcel scene on the first run (when
  // nothing is pinned yet); 'no-scene' until the player has been inside an inspectable scene once.
  const scene = state.scene ?? (await getCurrentInspectableScene())
  if (scene === undefined) {
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
  // Resync re-pulls the live baseline the undo entries were captured against — clear them.
  clearUndoHistory()
}

// Open the reload confirm dialog (reapply local changes vs reset), or — with no local changes —
// reload straight away.
export async function openReloadDialog(): Promise<void> {
  if (state.scene === undefined) return
  const hasChanges =
    state.editedComponents.size > 0 ||
    state.deletedComponents.size > 0 ||
    state.deletedEntities.size > 0
  if (!hasChanges) {
    // nothing local to keep — reapply vs reset are identical, just reload.
    await reloadScene(false)
    return
  }
  state.reloadConfirm = true
}

// Reload the pinned scene from disk (so changed content files — textures, audio, glbs — are picked
// up without leaving the editor). With `reapply`, replay the editor's unsaved changes onto the fresh
// scene — including recreating editor-created entities at their original ids (lossless); otherwise
// discard local changes for a clean reset. The per-frame systems (overlays, pick colliders,
// highlight) re-apply themselves once the snapshot + selection are restored.
//
// Clears undo history by default (a manual reload is a fresh start); the undo/redo machinery passes
// `keepHistory` since it drives reload itself and must not wipe the stacks it's unwinding.
export async function reloadScene(
  reapply: boolean,
  opts: { keepHistory?: boolean } = {}
): Promise<void> {
  const scene = state.scene
  if (scene === undefined) return
  const wasFrozen = state.frozen
  const selected = [...state.selected]
  const active = state.activeEntity

  // The editor-created entities (not on disk) to recreate, from the changelog.
  const recreate = reapply ? addedAuthoredEntities(await saveBaseline()) : []

  // The old scene's engine-side overlays/highlight are wiped with it. Forget our bookkeeping so the
  // first post-reload snapshot isn't reverted against dead overlays and the reconcilers re-apply.
  resetOverlays()
  resetHighlightSync()

  state.status = 'loading-snapshot'
  state.saveStatus = 'reloading…'
  try {
    await BevyApi.consoleCommand('reload', [scene.hash])
  } catch (e) {
    console.error('reload failed:', e)
    state.saveStatus = `reload failed: ${String(e)}`
    return
  }

  // Wait for the scene to respawn (re-pin and poll until its root entity is back), then take the
  // fresh on-disk snapshot.
  await waitForSceneReady(scene.hash)
  await reloadSnapshot()

  let status: string
  if (reapply) {
    // Replay while the fresh scene is playing, so the writes tick in (a frozen scene never processes
    // inbound CRDT messages). Suppress recording — the replay isn't a user action.
    const prevSuppress = state.suppressUndo
    state.suppressUndo = true
    let failed: string[]
    try {
      failed = await reapplyChangelog(recreate)
    } finally {
      state.suppressUndo = prevSuppress
    }
    await sleep(SETTLE_MS)
    await reloadSnapshot()
    status =
      failed.length > 0
        ? `reloaded — ${failed.length} new ${failed.length === 1 ? 'entity' : 'entities'} couldn't be restored (id taken)`
        : 'reloaded'
  } else {
    resetSaveChangelog()
    status = 'reloaded — local changes discarded'
  }

  state.selected = new Set(selected.filter((id) => id in state.snapshot))
  state.activeEntity = active !== null && active in state.snapshot ? active : null

  if (wasFrozen) await pauseScene()
  if (!opts.keepHistory) clearUndoHistory()
  state.saveStatus = status
}

// Poll until the reloaded scene is back: re-pin the hash and check the snapshot has its root entity.
// Bounded so a failed respawn can't hang the editor.
async function waitForSceneReady(hash: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(SETTLE_MS)
    try {
      await BevyApi.consoleCommand('set_scene', [hash])
      const reply = await BevyApi.consoleCommand('crdt_snapshot')
      if ('0' in (JSON.parse(reply) as Snapshot)) return
    } catch {
      // scene not respawned yet — keep polling
    }
  }
}

// Re-apply the editor's recorded changes onto the freshly-reloaded scene: edited components are
// re-written, deleted components/entities re-deleted, and the editor-created entities in `recreate`
// (not on disk) are reinstantiated at their original ids via /new_entity --ids. Because ids are
// preserved, the recorded component values (which reference those ids for parent/self) resolve as-is
// — no remap. A recreated id that collides with a live one on the fresh scene is the runtime-
// divergence edge: it's dropped (and pruned from the changelog) and returned, rather than failing
// the whole reapply. Runs against state.snapshot, which reflects the on-disk state at call time.
async function reapplyChangelog(recreate: string[]): Promise<string[]> {
  // Re-delete entities the editor removed (they come back on reload).
  for (const id of state.deletedEntities) {
    if (id in state.snapshot) {
      await BevyApi.consoleCommand('delete_entity', [id, '-r']).catch((e) =>
        console.error('reapply delete_entity', id, e)
      )
    }
  }

  // Recreate the session-created entities at their original ids (instantiated with their Name),
  // before any components are written so parent refs to them resolve. A collision drops the entity.
  const failed = new Set<string>()
  if (recreate.length > 0) {
    const names = recreate.map(
      (id) =>
        (state.editorValues.get(`${id}/${NAME_COMPONENT}`) as { value: string } | undefined) ?? {
          value: 'Entity'
        }
    )
    const got = await allocateNamedEntities(names, recreate.map(Number))
    recreate.forEach((id, i) => {
      if (got[i] === null) {
        failed.add(id)
        console.error('reapply: could not recreate entity at original id', id)
      }
    })
  }

  // Re-write edited components on present entities (surviving on-disk + recreated).
  for (const ckey of state.editedComponents) {
    const slash = ckey.indexOf('/')
    const entityId = ckey.slice(0, slash)
    const name = ckey.slice(slash + 1)
    if (state.deletedEntities.has(entityId) || failed.has(entityId)) continue
    if (!(entityId in state.snapshot)) continue
    const value = state.editorValues.get(ckey)
    if (value === undefined) continue
    await writeComponent(entityId, name, JSON.stringify(value)).catch((e) =>
      console.error('reapply', ckey, e)
    )
  }

  // Re-delete components the editor removed (back on disk after reload).
  for (const ckey of state.deletedComponents) {
    const slash = ckey.indexOf('/')
    const entityId = ckey.slice(0, slash)
    const name = ckey.slice(slash + 1)
    if (state.snapshot[entityId]?.[name] !== undefined) {
      await BevyApi.consoleCommand('delete_component', [entityId, name]).catch((e) =>
        console.error('reapply delete_component', ckey, e)
      )
    }
  }

  // Prune changelog entries for entities that couldn't be recreated, so a later save stays consistent.
  for (const ckey of [...state.editedComponents]) {
    if (failed.has(ckey.slice(0, ckey.indexOf('/')))) {
      state.editedComponents.delete(ckey)
      state.editorValues.delete(ckey)
    }
  }
  return [...failed]
}

// --- undo / redo ---

export function canUndo(): boolean {
  return state.undoStack.length > 0
}

export function canRedo(): boolean {
  return state.redoStack.length > 0
}

// Re-apply one recorded component leaf (present → write, absent → delete). Caller runs it under
// suppressUndo so it records nothing.
async function applyCell(entityId: string, name: string, c: Cell): Promise<void> {
  if (c.present) {
    await writeComponent(entityId, name, JSON.stringify(c.value))
  } else {
    deleteComponent(entityId, name)
  }
}

// Apply one entry's target side: component entries replay leaves in place (fast); reload entries
// restore the target changelog snapshot and rebuild the scene via reload-reapply (now lossless, so
// it can resurrect entities at their original ids).
async function applyEntry(entry: UndoEntry, dir: 'undo' | 'redo'): Promise<void> {
  state.suppressUndo = true
  try {
    if (entry.kind === 'components') {
      // undo walks ops in reverse (so a repeated key unwinds correctly); redo forward.
      const ops = dir === 'undo' ? [...entry.ops].reverse() : entry.ops
      for (const op of ops) await applyCell(op.entityId, op.name, dir === 'undo' ? op.before : op.after)
      await reloadAfter()
    } else {
      restoreChangelog(dir === 'undo' ? entry.before : entry.after)
      await reloadScene(true, { keepHistory: true })
    }
  } finally {
    state.suppressUndo = false
  }
}

export async function undo(): Promise<void> {
  const entry = state.undoStack.pop()
  if (entry === undefined) return
  await applyEntry(entry, 'undo')
  state.redoStack.push(entry)
}

export async function redo(): Promise<void> {
  const entry = state.redoStack.pop()
  if (entry === undefined) return
  await applyEntry(entry, 'redo')
  state.undoStack.push(entry)
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
    const raw = JSON.parse(reply) as Snapshot
    decodeCustomComponents(raw)
    // Revert any editor overlays the engine echoed back, so the editor always works against the
    // true scene state (overlays are engine-only; see overlay-actions.ts).
    state.snapshot = logicalSnapshot(raw)
    state.status = 'ready'
    // warm component schemas now so the first expand of any component is already typed
    preloadSchemas(state.snapshot)
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
export async function writeComponent(entityId: string, name: string, json: string): Promise<void> {
  const before = cell(state.snapshot[entityId]?.[name]) // capture before applyLocalComponent mutates
  applyLocalComponent(entityId, name, json)
  markEdited(entityId, name, JSON.parse(json))
  recordOp(entityId, name, before, cell(state.snapshot[entityId]?.[name]))
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

  // Custom components aren't known to the engine — seed their default from the SDK schema locally.
  // Protocol components fetch the engine's full default shape (falls back to `{}` on failure).
  let json = '{}'
  if (isCustomComponent(name)) {
    json = JSON.stringify(createCustomDefault(name) ?? {})
  } else {
    try {
      const reply = await BevyApi.consoleCommand('component_default', [name])
      JSON.parse(reply) // validate before adopting it
      json = reply
    } catch (e) {
      console.error('component_default failed (using {}):', name, e)
    }
  }

  beginTxn(`Add ${name}`)
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
  commitTxn()
}

// --- add entity ---

// Allocate `count` fresh entity ids from the engine's authoritative allocator (collision-free,
// correctly generationed), each instantiated scene-side with the given component so @dcl/ecs adopts
// it. Returns the proto-u32 ids (matching the snapshot's keys). With `explicitId`, the engine
// instantiates that exact id instead of allocating (to recreate an entity at its original id on a
// freshly-reloaded scene); the reply is empty if that id collided with a live one.
async function newEntityIds(
  componentId: number,
  base64: string,
  count: number,
  explicitId?: number
): Promise<number[]> {
  const args = [String(componentId), base64, String(count)]
  if (explicitId !== undefined) args.push('--ids', String(explicitId))
  // An explicit-id request rejects (command-failed) when the id collides with a live one; surface
  // that as no ids so the caller records a per-entity failure rather than throwing.
  let reply: string
  try {
    reply = await BevyApi.consoleCommand('new_entity', args)
  } catch (e) {
    if (explicitId !== undefined) return []
    throw e
  }
  const ids = JSON.parse(reply) as unknown
  return Array.isArray(ids) ? ids.filter((n): n is number => typeof n === 'number') : []
}

// Create one or more authored entities, returning their ids. Each spec is a componentName -> value
// map (snapshot/decoded form).
//
// Each entity is allocated *and* instantiated by the engine via /new_entity: the engine's allocator
// hands out a collision-free, correctly-generationed id and writes the entity's Name scene-side, so
// the scene's @dcl/ecs adopts it on receive (before its next tick) — no scene freeze needed. The
// remaining components are then written normally; the Name write is recorded in the changelog so the
// new entity persists on save. inspector::Nodes is NOT touched here — it's regenerated from the
// Transform hierarchy at save time (see buildComposite), so it never shows as a session edit.
// Allocate `names.length` fresh entities, each instantiated engine-side with its Name (via
// /new_entity, so @dcl/ecs adopts it before the next tick) and the Name recorded as our edit so it
// persists on save. Returns the new ids 1:1 with `names` (null where allocation failed). Shared by
// single-entity creation and composite import (which needs all ids up front to remap parent refs).
// With `ids` (parallel to `names`), each entity is recreated at that exact original id instead of a
// fresh allocation — used by reapply to restore session-created entities on a reloaded scene. A
// requested id that collides with a live one yields null at that slot.
export async function allocateNamedEntities(
  names: Array<{ value: string }>,
  ids?: Array<number>
): Promise<Array<number | null>> {
  const nameId = customComponentId(NAME_COMPONENT)
  const out: Array<number | null> = []
  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    const nameBytes =
      nameId !== undefined ? encodeCustomComponent(NAME_COMPONENT, name) : undefined
    if (nameId === undefined || nameBytes === undefined) {
      console.error('allocateNamedEntities: cannot encode Name to instantiate entity')
      out.push(null)
      continue
    }
    const [id] = await newEntityIds(nameId, nameBytes, 1, ids?.[i])
    if (id === undefined) {
      out.push(null)
      continue
    }
    const eid = String(id)
    applyLocalComponent(eid, NAME_COMPONENT, JSON.stringify(name))
    markEdited(eid, NAME_COMPONENT, JSON.parse(JSON.stringify(name)))
    out.push(id)
  }
  return out
}

export async function createEntities(
  specs: Array<Record<string, unknown>>
): Promise<number[]> {
  if (specs.length === 0) return []
  const ids: number[] = []
  try {
    for (const components of specs) {
      const name = (components[NAME_COMPONENT] ?? { value: 'Entity' }) as { value: string }
      const [id] = await allocateNamedEntities([name])
      if (id === null || id === undefined) continue
      ids.push(id)
      const eid = String(id)

      for (const [n, value] of Object.entries(components)) {
        if (n === NAME_COMPONENT) continue // already instantiated above
        await writeComponent(eid, n, JSON.stringify(value))
      }
    }

    // Wait (bounded) for the running scene to tick the new entities in before refetching, so a
    // refetch doesn't briefly drop them (and strand a selection on them).
    const last = ids.length > 0 ? String(ids[ids.length - 1]) : null
    for (let attempt = 0; attempt < 6; attempt++) {
      await sleep(SETTLE_MS)
      await reloadSnapshot()
      if (last === null || state.snapshot[last] !== undefined) break
    }
  } catch (e) {
    console.error('create_entities failed:', e)
  }
  return ids
}

// Wrap an entity-lifecycle action (create/delete/import) as one 'reload' undo step: snapshot the
// changelog around it (component-op recording suppressed, so it's a single entry), and let undo/redo
// materialise it by restoring that snapshot + reload-reapply. Nested calls (already inside a wrapped
// action or undo apply) just run, so the outermost action owns the entry.
export async function recordEntityChange(label: string, op: () => Promise<void>): Promise<void> {
  if (state.suppressUndo) {
    await op()
    return
  }
  const before = snapshotChangelog()
  state.suppressUndo = true
  try {
    await op()
  } finally {
    state.suppressUndo = false
  }
  pushReloadEntry(label, before, snapshotChangelog())
}

// Create a single authored entity with a default Transform (parented under `parent`, 0 = scene
// root) and a Name, then select it. Mirrors the Hub's addChild operation. An unparented entity
// (parent 0) is then placed in front of the player and the translate tool auto-selected, so it
// spawns in view and ready to position; a child stays at its parent's origin.
export async function addEntity(name: string, parent: number): Promise<void> {
  await recordEntityChange('Add entity', async () => {
    const ids = await createEntities([
      {
        // Full default Transform (explicit scale 1 — a partial write would leave scale 0 → invisible).
        Transform: {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          parent
        },
        [NAME_COMPONENT]: { value: name || 'Entity' }
      }
    ])
    if (ids.length === 0) return
    const eid = String(ids[0])
    state.selected.clear()
    state.selected.add(eid)
    state.activeEntity = eid
    // expand ancestors and scroll the tree to the new row
    selectEntityInTree(state.snapshot, eid)
    // Place an unparented entity in front of the player. Routed through setComponentValue (the
    // editor's component-set path) rather than a raw create-time Transform: it writes optimistically
    // *and* re-pulls, so the snapshot reliably carries the Transform the gizmo reads — a raw
    // create-time write can be clobbered by createEntities' own settle reload before the engine ticks
    // it in (leaving the new entity Transform-less and the gizmo stranded at the origin).
    if (parent === 0) {
      const position = playerSpawnPosition() ?? { x: 0, y: 0, z: 0 }
      await setComponentValue(
        componentKey(eid, 'Transform'),
        eid,
        'Transform',
        JSON.stringify({
          position,
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
          parent
        })
      )
      setActiveAction('translate')
    }
  })
}

// Remove a component from an entity (optimistic local removal + /delete_component). A single user
// action — wraps itself as one undo step (inert while suppressed, e.g. during undo apply).
export function deleteComponent(entityId: string, name: string): void {
  beginTxn(`Delete ${name}`)
  const before = cell(state.snapshot[entityId]?.[name])
  const entry = state.snapshot[entityId]
  if (entry !== undefined) delete entry[name]
  const key = componentKey(entityId, name)
  state.expandedComponents.delete(key)
  clearComponentEdits(key)
  markComponentDeleted(entityId, name)
  recordOp(entityId, name, before, ABSENT)
  commitTxn()
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

  beginTxn(`Edit ${name}`)
  try {
    await writeComponent(entityId, name, compact)
    state.editStatus.set(key, '✓ set')
    clearComponentEdits(key)
    await reloadAfter()
  } catch (e) {
    state.editStatus.set(key, String(e))
  }
  commitTxn()
}

// --- save ---

// Save: diff the three sources (initial / editor / live) over the authored scope and, if anything
// differs, open the diff dialog for the user to choose per component. With no differences, write
// the baseline straight away.
// A local scene (served by `dcl start`) has a `b64-`-prefixed hash that decodes to its project path,
// so we can write its files back. A deployed/remote scene has a content hash — nowhere to save to.
export function isLocalScene(): boolean {
  return state.scene?.hash?.startsWith('b64-') ?? false
}

// The on-disk authored baseline to diff against: the last-saved set if we have one (so prior saves
// stick), else the engine's original /crdt_initial. Shared by save and the reload warning.
export async function saveBaseline(): Promise<Snapshot> {
  if (state.savedBaseline !== null) return state.savedBaseline
  const reply = await BevyApi.consoleCommand('crdt_initial')
  const initial = JSON.parse(reply) as Snapshot
  decodeCustomComponents(initial)
  return initial
}

export async function saveComposite(): Promise<void> {
  if (!isLocalScene()) {
    state.saveStatus = 'save needs a local scene (served by `dcl start`) — clone it locally to edit'
    return
  }
  state.saveStatus = 'preparing…'
  try {
    // isSavableComponent gates protocol components on the writable set; make sure it's loaded.
    if (state.componentNames.length === 0) await loadComponentNames()
    const initial = await saveBaseline()
    const rows = computeSaveDiff(initial, state.snapshot)
    if (rows.length === 0) {
      await writeComposite(initial, [], new Map())
      return
    }
    const selection = new Map<string, DiffSource>()
    for (const row of rows) {
      selection.set(`${row.entityId}/${row.component}`, defaultSelection(row))
    }
    state.saveDialog = { rows, selection, initial }
    state.saveStatus = `${rows.length} change${rows.length === 1 ? '' : 's'} — review & save`
  } catch (e) {
    state.saveStatus = `save failed: ${String(e)}`
  }
}

// Confirm the diff dialog: write the composite using the chosen sources.
export async function confirmSaveDialog(): Promise<void> {
  const dialog = state.saveDialog
  if (dialog === null) return
  await writeComposite(dialog.initial, dialog.rows, dialog.selection)
}

export function cancelSaveDialog(): void {
  state.saveDialog = null
  state.saveStatus = ''
}

// Build the composite from the baseline + the dialog's selections, convert protocol values to SDK
// form, and ship it to /save_composite (the engine owns the destination). Resets the changelog on
// success — the saved state becomes the new baseline.
async function writeComposite(
  initial: Snapshot,
  rows: DiffRow[],
  selection: Map<string, DiffSource>
): Promise<void> {
  state.saveStatus = 'saving…'
  try {
    const authored = buildAuthoredFromSelection(initial, rows, selection)
    // Cache the persisted authored set (snapshot form, before the SDK conversion below mutates it)
    // as the next baseline, so a follow-up save diffs against what we just wrote.
    const newBaseline = JSON.parse(JSON.stringify(authored)) as Snapshot

    // Protocol components are in engine form (a protobuf oneof as `{case: val}` with no `$case`),
    // which the composite loader drops. Convert them to SDK form via each component's schema;
    // custom components are already SDK form (decoded via the SDK schema).
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
    const path = await BevyApi.consoleCommand('save_composite', [stringToBase64(composite)])
    // Full (untruncated) save result, incl. the imported-asset export summary, to the browser console.
    console.log(`[save] ${path}`)
    state.savedBaseline = newBaseline
    resetSaveChangelog()
    clearUndoHistory() // the save becomes the new baseline; undoing across it would be inconsistent
    state.saveDialog = null
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
  // Gizmo drags write the Transform directly (not via writeComponent), so record the edit in the
  // changelog here too — otherwise the save diff treats a gizmo move as runtime churn. Fired every
  // frame of the drag; the last call holds the committed pose.
  const value = JSON.parse(json)
  // Record into the drag's undo transaction (opened in startGizmoDrag): recordOp keeps the first
  // frame's `before` (pre-drag) and the latest `after`, so the whole drag is one op per entity.
  recordOp(entityId, 'Transform', cell(state.snapshot[entityId]?.Transform), cell(value))
  markEdited(entityId, 'Transform', value)
  BevyApi.consoleCommand('set_component', [entityId, 'Transform', json]).catch(() => {})
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
  await recordEntityChange('Delete entity', async () => {
    try {
      await writeDelete(id, false)
    } catch (e) {
      console.error('delete_entity failed:', e)
    }
    await reloadAfter([id])
  })
}

export async function deleteEntityRecursive(id: string): Promise<void> {
  state.deleteConfirm = null
  await recordEntityChange('Delete entity (recursive)', async () => {
    try {
      await writeDelete(id, true)
    } catch (e) {
      console.error('delete_entity -r failed:', e)
    }
    await reloadAfter([id])
  })
}

// Reparent each direct child to the entity's parent (preserving world placement),
// then delete the entity.
export async function deleteEntityReparent(id: string): Promise<void> {
  state.deleteConfirm = null
  await recordEntityChange('Delete entity (reparent children)', async () => {
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
  })
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

  beginTxn('Reparent')
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
  commitTxn()
}

// Detach each selected entity to the scene root (parent 0), preserving world
// placement. Entities already at root are skipped. The new parent (root) is
// always uniform, so this is exact except for a child that was sheared under a
// non-uniformly-scaled parent — which can't keep its shape outside it anyway.
export async function clearParentOfSelection(): Promise<void> {
  const snap = state.snapshot
  const targets = [...state.selected].filter((id) => (readTransform(id).parent ?? 0) !== 0)
  beginTxn('Clear parent')
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
  commitTxn()
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
