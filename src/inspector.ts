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
    await reloadSnapshot()
  } catch (e) {
    state.editStatus.set(key, String(e))
  }
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
