import { BevyApi } from './bevy-api'
import { autoLogin } from './login'
import { getCurrentInspectableScene } from './current-scene'
import {
  state,
  clearComponentEdits,
  primeScroll,
  type ComponentKey,
  type Snapshot
} from './state'
import { buildEditedJson } from './fields'
import { sleep } from './utils'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { rotateVec3ByQuat } from './perspective-to-screen'

// Boot sequence: log in, then load the current scene's component state.
export async function startInspector(): Promise<void> {
  state.status = 'logging-in'
  await autoLogin()
  await refresh()
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
    state.status = 'ready'
    primeScroll()
  } catch (e) {
    state.error = String(e)
    state.status = 'error'
  }
}

// Reload after a modification. /crdt_snapshot reads the scene's CRDT store, which
// only reflects our engine-side edits on the scene's next tick — so reload after
// a short settle. For deletes, retry until the removed ids actually disappear
// (bounded), so the tree can't keep showing a gone entity.
const SETTLE_MS = 150
async function reloadAfter(goneIds: string[] = []): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(SETTLE_MS)
    await reloadSnapshot()
    // A frozen scene won't tick, so the change can't propagate to its store and
    // retrying is pointless — settle once and stop.
    if (state.frozen || goneIds.every((id) => !(id in state.snapshot))) return
  }
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
    await BevyApi.consoleCommand('set_component', [entityId, name, compact])
    state.editStatus.set(key, '✓ set')
    clearComponentEdits(key)
    await reloadAfter()
  } catch (e) {
    state.editStatus.set(key, String(e))
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
    await BevyApi.consoleCommand('delete_entity', [id])
  } catch (e) {
    console.error('delete_entity failed:', e)
  }
  await reloadAfter([id])
}

export async function deleteEntityRecursive(id: string): Promise<void> {
  state.deleteConfirm = null
  try {
    await BevyApi.consoleCommand('delete_entity', [id, '-r'])
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
      await BevyApi.consoleCommand('set_component', [childId, 'Transform', json])
    } catch (e) {
      console.error('reparent child failed:', childId, e)
    }
  }
  try {
    await BevyApi.consoleCommand('delete_entity', [id])
  } catch (e) {
    console.error('delete_entity failed:', e)
  }
  await reloadAfter([id])
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
