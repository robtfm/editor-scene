import { BevyApi } from './bevy-api'
import { state } from './state'
import { originals, recordOriginal, forgetOriginal } from './overlays'
import { childIdsOf } from './inspector'

// Impure overlay actions. An overlay sets an engine-facing value on a real scene component (so the
// engine renders/picks/behaves accordingly) while recordOriginal captures the pre-overlay value for
// recovery. The value is pushed straight to the engine via /set_component — NOT through the edit
// changelog, because overlays are editor chrome, not user edits, and must never reach the save. The
// editor reverts overlays via logicalSnapshot when it ingests the CRDT snapshot (see
// reloadSnapshot), so they stay invisible to the tree, component editor, and save.

// Set an overlay on (entity, component). recordOriginal reads the editor's logical snapshot, which
// equals the true original (overlays are reverted on ingest), and is idempotent — re-applying keeps
// the original captured the first time.
export function applyOverlay(entity: string, component: string, value: unknown): void {
  recordOriginal(originals, entity, component, state.snapshot)
  BevyApi.consoleCommand('set_component', [entity, component, JSON.stringify(value)]).catch((e) =>
    console.error('overlay set_component failed:', entity, component, e)
  )
}

// Clear an overlay: restore the recorded original (or delete the component if it was absent), then
// forget it.
export function clearOverlay(entity: string, component: string): void {
  const original = originals.get(entity)?.get(component)
  if (original === undefined) return
  if (original.present) {
    BevyApi.consoleCommand('set_component', [
      entity,
      component,
      JSON.stringify(original.value)
    ]).catch((e) => console.error('overlay restore failed:', entity, component, e))
  } else {
    BevyApi.consoleCommand('delete_component', [entity, component]).catch((e) =>
      console.error('overlay restore (delete) failed:', entity, component, e)
    )
  }
  forgetOriginal(originals, entity, component)
}

// --- visibility overlay (applied to an entity + its whole subtree) ---
// Cycles: '=' (scene setting) -> '+' (force visible) -> '-' (force invisible) -> '='.

const VIS = 'VisibilityComponent'
// per-entity mode: true = force visible, false = force invisible, absent = scene setting.
const visibilityOverlay = new Map<string, boolean>()

// The visibility-overlay mode shown on the entity's tree button.
export function visibilityMode(entity: string): '+' | '-' | '=' {
  const v = visibilityOverlay.get(entity)
  return v === undefined ? '=' : v ? '+' : '-'
}

function subtree(entity: string, out: string[] = []): string[] {
  out.push(entity)
  for (const child of childIdsOf(entity)) subtree(child, out)
  return out
}

// Advance the visibility overlay on `entity` and its whole subtree to the next mode.
export function cycleVisibilityOverlay(entity: string): void {
  const cur = visibilityMode(entity)
  const next: '+' | '-' | '=' = cur === '=' ? '+' : cur === '+' ? '-' : '='
  for (const e of subtree(entity)) {
    if (next === '=') {
      clearOverlay(e, VIS)
      visibilityOverlay.delete(e)
    } else {
      applyOverlay(e, VIS, { visible: next === '+' })
      visibilityOverlay.set(e, next === '+')
    }
  }
}
