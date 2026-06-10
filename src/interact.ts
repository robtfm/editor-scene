import { engine } from '@dcl/sdk/ecs'
import { state, effectiveMode } from './state'
import { applyOverlay, clearOverlay } from './overlay-actions'
import { originals, isOverlaid } from './overlays'

// Outside interact mode the scene's input is suppressed so editor clicks/movement don't fire scene
// logic: every PointerEvents is overlaid to empty, and every TriggerArea to collisionMask 0 (inert,
// CL_NONE). Interact mode clears those overlays so the live scene responds again. All reverted for
// display/save by the overlay core. Mirrors syncPickColliders — idempotent, reconciled each frame.
const POINTER_EVENTS = 'PointerEvents'
const TRIGGER_AREA = 'TriggerArea'

export function setupInteract(): void {
  engine.addSystem(() => {
    if (state.status !== 'ready') return
    const interacting = effectiveMode() === 'interact'
    for (const [id, comps] of Object.entries(state.snapshot)) {
      syncDisabled(id, comps, POINTER_EVENTS, interacting, () => ({ pointerEvents: [] }))
      syncDisabled(id, comps, TRIGGER_AREA, interacting, (existing) => ({
        ...(existing as object),
        collisionMask: 0
      }))
    }
  })
}

// Keep one component's "disabled" overlay in sync with interact mode: apply it (engine-disabled
// value) while not interacting, clear it (restore the original) while interacting.
function syncDisabled(
  id: string,
  comps: Record<string, unknown>,
  name: string,
  interacting: boolean,
  disabledValue: (existing: unknown) => unknown
): void {
  const present = comps[name] !== undefined
  const overlaid = isOverlaid(originals, id, name)
  if (!present && !overlaid) return // entity doesn't have this component
  if (interacting) {
    if (overlaid) clearOverlay(id, name)
  } else if (!overlaid) {
    applyOverlay(id, name, disabledValue(comps[name]))
  }
}
