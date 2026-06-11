import type { Snapshot } from './state'

// Editor "overlays": the editor sets engine-facing values on real scene components (so picking,
// visibility, etc. work and selection hits the real entity), while recording each component's
// pre-overlay value here so the true scene state can be recovered for display and for the save.
//
// This is the pure core: the originals store + the recover-original substitution. The impure side
// (pushing the overlay values via /set_component, and routing snapshot consumers through the
// logical view) lives alongside it. The store/substitution are deliberately backing-agnostic so
// the implementation can later be swapped for engine-side overlay support without touching callers.

// The value of a component before the editor overlaid it. `present: false` means the component
// didn't exist, so recovery removes it (an overlay that *added* a component).
export type Original = { present: true; value: unknown } | { present: false }

// entity id -> component name -> recorded original
export type Originals = Map<string, Map<string, Original>>

// Record the pre-overlay value of (entity, component) from `snapshot` — but only the first time.
// Idempotent: updating an overlay (a second apply) must keep the *true* original, never capture an
// already-overlaid value. Records `absent` when the component isn't currently present.
export function recordOriginal(
  originals: Originals,
  entity: string,
  component: string,
  snapshot: Snapshot
): void {
  let perEntity = originals.get(entity)
  if (perEntity === undefined) {
    perEntity = new Map()
    originals.set(entity, perEntity)
  }
  if (perEntity.has(component)) return // keep the true original
  const comps = snapshot[entity]
  const present = comps !== undefined && component in comps
  perEntity.set(
    component,
    present ? { present: true, value: comps[component] } : { present: false }
  )
}

// Retarget a recorded original to `absent` — used when the user deletes an overlaid component: the
// overlay stays applied, but its recovery target becomes "deleted", so clearing the overlay (and the
// logical revert) drops the component instead of restoring the pre-delete value. No-op if not
// overlaid (the caller deletes outright in that case).
export function setOriginalAbsent(originals: Originals, entity: string, component: string): void {
  const perEntity = originals.get(entity)
  if (perEntity?.has(component)) perEntity.set(component, { present: false })
}

// Forget a recorded original — call after restoring it (clearing the overlay).
export function forgetOriginal(originals: Originals, entity: string, component: string): void {
  const perEntity = originals.get(entity)
  if (perEntity === undefined) return
  perEntity.delete(component)
  if (perEntity.size === 0) originals.delete(entity)
}

// True if (entity, component) currently has a recorded original (i.e. it's overlaid).
export function isOverlaid(originals: Originals, entity: string, component: string): boolean {
  return originals.get(entity)?.has(component) ?? false
}

// Produce the logical snapshot: each recorded original is substituted back over the (possibly
// overlaid) live value, or the component is dropped when the original was absent. Never mutates the
// input; entities without overlays are shared by reference.
export function applyOriginals(originals: Originals, snapshot: Snapshot): Snapshot {
  if (originals.size === 0) return snapshot
  const out: Snapshot = { ...snapshot }
  for (const [entity, perEntity] of originals) {
    const base = out[entity]
    if (base === undefined) {
      // entity not in the snapshot (e.g. deleted) — only present-originals reintroduce components
      const restored: Record<string, unknown> = {}
      for (const [component, original] of perEntity) {
        if (original.present) restored[component] = original.value
      }
      if (Object.keys(restored).length > 0) out[entity] = restored
      continue
    }
    const comps = { ...base }
    for (const [component, original] of perEntity) {
      if (original.present) comps[component] = original.value
      else delete comps[component]
    }
    out[entity] = comps
  }
  return out
}

// The editor's single overlay store. Consumers read the scene through `logicalSnapshot` so overlays
// never leak into display or the save.
export const originals: Originals = new Map()

// Forget all recorded overlays — used on scene reload, when the engine-side overlays are wiped with
// the old scene. The per-frame reconcilers then see "nothing overlaid" and re-apply from scratch.
export function resetOverlays(): void {
  originals.clear()
}

// The current scene state with all overlays reverted — what every snapshot consumer (tree, editor,
// diff, save) should read instead of the raw live snapshot.
export function logicalSnapshot(snapshot: Snapshot): Snapshot {
  return applyOriginals(originals, snapshot)
}
