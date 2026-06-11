import {
  engine,
  Transform,
  Raycast,
  RaycastResult,
  RaycastQueryType,
  PrimaryPointerInfo,
  type Entity
} from '@dcl/sdk/ecs'
import {
  state,
  effectiveMode,
  selectionClick,
  selectEntityInTree,
  clearSelection,
  parentOf
} from './state'
import { gizmoActive } from './gizmo'
import { applyOverlay, clearOverlay, visibilityMode } from './overlay-actions'
import { originals, isOverlaid } from './overlays'
import { refreshHighlight } from './highlight'

// CL_RESERVED6 — an editor-only collider layer (scene authors use CL_CUSTOM1..8). We overlay it onto
// every gltf's visible meshes so they're raycast-pickable, and cast the pick ray on the same layer.
// Inert otherwise: a 128 collider only answers a 128-mask query (physics/pointer/scene casts ignore it).
const PICK_LAYER = 128
const CL_PHYSICS = 2 // ColliderLayer.CL_PHYSICS — stripped while editing so colliders can't shove the
// frozen player. The defaults below are the engine's when the mask is unset (so stripping is correct
// even for authors who never set a mask): visible meshes 0, invisible meshes + MeshCollider 1|2.
const DEFAULT_INVIS_MASK = 3 // CL_POINTER | CL_PHYSICS
const DEFAULT_COLLIDER_MASK = 3 // CL_POINTER | CL_PHYSICS
const GLTF = 'GltfContainer'
const MESH_RENDERER = 'MeshRenderer'
const MESH_COLLIDER = 'MeshCollider'

// Map a MeshRenderer's shape (engine-form oneof) to the matching MeshCollider shape, dropping the
// renderer-only fields (uvs). Used to give primitive renderers a pickable collider of the same shape.
function colliderMeshFromRenderer(mesh: unknown): Record<string, unknown> | undefined {
  if (typeof mesh !== 'object' || mesh === null) return undefined
  const m = mesh as Record<string, unknown>
  if ('box' in m) return { box: {} }
  if ('sphere' in m) return { sphere: {} }
  if ('cylinder' in m) return { cylinder: { ...(m.cylinder as object) } }
  if ('plane' in m) return { plane: {} }
  if ('gltf' in m) return { gltf: { ...(m.gltf as object) } }
  return undefined
}

let picker: Entity | null = null
let rayTs = 0
let pending: { ts: number; shift: boolean; ctrl: boolean } | null = null

export function setupMeshSelect(): void {
  picker = engine.addEntity()
  Transform.create(picker)
  engine.addSystem(() => {
    if (state.status === 'ready') syncPickColliders()
    handlePickResult()
  })
}

// While editing (not interacting), overlay every renderable entity's collider to add the editor pick
// layer 128 so it's raycast-pickable. Physics is left intact (you walk around to inspect) EXCEPT on
// the selected entities while a gizmo is active — those get CL_PHYSICS stripped so dragging them
// can't shove the held player. Restored to the real collider in interact mode; reverted for save.
//  - GltfContainer: visible meshes |= 128; physics stripped from both masks when `strip`.
//  - MeshRenderer (primitives): overlay a MeshCollider of the same shape; pick-only when the entity
//    had no collider, otherwise the real mask (physics stripped when `strip`). NB this replaces a
//    scene-authored MeshCollider of a *different* shape than its MeshRenderer in the editor (accepted).
function syncPickColliders(): void {
  const live = effectiveMode() === 'interact'
  const gizmo = gizmoActive()
  for (const [id, comps] of Object.entries(state.snapshot)) {
    const strip = gizmo && state.selected.has(id)
    const gltf = comps[GLTF] as
      | { visibleMeshesCollisionMask?: number; invisibleMeshesCollisionMask?: number }
      | undefined
    if (gltf !== undefined) {
      reconcileCollider(id, GLTF, live, strip, () => {
        const vis = gltf.visibleMeshesCollisionMask ?? 0
        const value: Record<string, unknown> = {
          ...gltf,
          visibleMeshesCollisionMask: (strip ? vis & ~CL_PHYSICS : vis) | PICK_LAYER
        }
        if (strip) {
          value.invisibleMeshesCollisionMask =
            (gltf.invisibleMeshesCollisionMask ?? DEFAULT_INVIS_MASK) & ~CL_PHYSICS
        }
        applyOverlay(id, GLTF, value)
        // The mask change reloads the gltf, dropping the outline off the new meshes — re-tag it.
        refreshHighlight()
      })
      continue
    }
    const renderer = comps[MESH_RENDERER] as { mesh?: unknown } | undefined
    if (renderer === undefined) continue
    reconcileCollider(id, MESH_COLLIDER, live, strip, () => {
      const existing = comps[MESH_COLLIDER] as { collisionMask?: number } | undefined
      // A synthesised collider (no real one) is pick-only — never add physics to a meshless renderer.
      const base = existing !== undefined ? existing.collisionMask ?? DEFAULT_COLLIDER_MASK : 0
      const value: Record<string, unknown> = {
        collisionMask: (strip ? base & ~CL_PHYSICS : base) | PICK_LAYER
      }
      // Map the renderer's shape when set; when it's unset/unmappable, omit mesh — the engine
      // defaults both a meshless MeshRenderer and a meshless MeshCollider to a box, so they match.
      const mesh = colliderMeshFromRenderer(renderer.mesh)
      if (mesh !== undefined) value.mesh = mesh
      applyOverlay(id, MESH_COLLIDER, value)
    })
  }
}

// Per (entity,component) physics-strip state currently applied, so we only re-apply (which reloads a
// gltf) when it flips selected-in-gizmo <-> not, rather than every frame.
const collStrip = new Map<string, boolean>()

// Apply the editing collider overlay while not live, restore the real collider while live (interact);
// re-apply when the strip state changes. Unlike interact's syncDisabled there's no present-guard — the
// MeshCollider overlay is *synthesised* onto MeshRenderer entities that have no collider of their own.
function reconcileCollider(
  id: string,
  name: string,
  live: boolean,
  strip: boolean,
  apply: () => void
): void {
  const key = `${id}:${name}`
  const overlaid = isOverlaid(originals, id, name)
  if (live) {
    if (overlaid) {
      clearOverlay(id, name)
      // Restoring the real gltf mask reloads it, dropping the outline off the new meshes — same as
      // the apply path. Re-tag, else the engine's root-level highlight diff (selection unchanged)
      // never re-applies it and the entity loses its outline *and* shadows the scene's hover
      // showHighlight (they share one MeshTag bit). [Real fix is engine-side — see refreshHighlight.]
      if (name === GLTF) refreshHighlight()
    }
    collStrip.delete(key)
    return
  }
  if (!overlaid || collStrip.get(key) !== strip) {
    apply()
    collStrip.set(key, strip)
  }
}

// Cast a pick ray under the cursor. The editor is a super-user scene, so a plain (non-include_world)
// raycast is routed by the engine to the active inspection scene and returns its entity ids.
export function requestMeshPick(shift: boolean, ctrl: boolean): void {
  if (picker === null) return
  const dir = PrimaryPointerInfo.getOrNull(engine.RootEntity)?.worldRayDirection
  const camT = Transform.getOrNull(engine.CameraEntity)
  if (dir === undefined || camT === null) return
  Transform.createOrReplace(picker, { position: { ...camT.position } })
  rayTs += 1
  Raycast.createOrReplace(picker, {
    timestamp: rayTs,
    maxDistance: 1000,
    // all hits, so we can skip force-hidden entities (whose pick collider is still present) and
    // select the nearest *visible* one behind them.
    queryType: RaycastQueryType.RQT_QUERY_ALL,
    continuous: false,
    collisionMask: PICK_LAYER,
    direction: { $case: 'globalDirection', globalDirection: { ...dir } }
  })
  pending = { ts: rayTs, shift, ctrl }
}

const VISIBILITY = 'VisibilityComponent'

// The scene's effective visibility for an entity, per the DCL propagation rules: an own
// VisibilityComponent wins; else the nearest ancestor with propagateToChildren; else visible.
function sceneVisible(id: string): boolean {
  const own = state.snapshot[id]?.[VISIBILITY] as { visible?: boolean } | undefined
  if (own !== undefined) return own.visible !== false
  let cur = parentOf(state.snapshot, id)
  while (cur !== null) {
    const vc = state.snapshot[cur]?.[VISIBILITY] as
      | { visible?: boolean; propagateToChildren?: boolean }
      | undefined
    if (vc?.propagateToChildren === true) return vc.visible !== false
    cur = parentOf(state.snapshot, cur)
  }
  return true
}

// Whether an entity should be mesh-pickable, i.e. effectively visible: a force-show overlay ('+')
// always picks; a force-hide ('-') never picks; otherwise honour the scene's resolved visibility.
// So you select what you can actually see.
function isPickable(id: string): boolean {
  const mode = visibilityMode(id)
  if (mode !== '=') return mode === '+'
  return sceneVisible(id)
}

// Apply the result of a requested pick once it arrives (matched by timestamp).
function handlePickResult(): void {
  if (pending === null || picker === null) return
  const result = RaycastResult.getOrNull(picker)
  if (result === null || result.timestamp !== pending.ts) return
  const p = pending
  pending = null
  // nearest hit on a pickable (effectively visible) entity — skip hidden ones and select whatever
  // visible thing is behind them.
  const hit = result.hits
    .filter((h) => h.entityId !== undefined && isPickable(String(h.entityId)))
    .sort((a, b) => a.length - b.length)[0]
  if (hit === undefined || hit.entityId === undefined) {
    // miss (or only hidden things) on a plain click -> clear the selection (modifiers leave it)
    if (!p.shift && !p.ctrl) clearSelection()
    return
  }
  const id = String(hit.entityId)
  selectionClick(id, p.shift, p.ctrl)
  if (state.selected.has(id)) selectEntityInTree(state.snapshot, id)
}
