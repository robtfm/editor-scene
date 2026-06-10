import {
  engine,
  Transform,
  Raycast,
  RaycastResult,
  RaycastQueryType,
  PrimaryPointerInfo,
  type Entity
} from '@dcl/sdk/ecs'
import { state, selectionClick, selectEntityInTree, clearSelection } from './state'
import { applyOverlay } from './overlay-actions'
import { originals, isOverlaid } from './overlays'

// CL_RESERVED6 — an editor-only collider layer (scene authors use CL_CUSTOM1..8). We overlay it onto
// every gltf's visible meshes so they're raycast-pickable, and cast the pick ray on the same layer.
// Inert otherwise: a 128 collider only answers a 128-mask query (physics/pointer/scene casts ignore it).
const PICK_LAYER = 128
const GLTF = 'GltfContainer'

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

// Apply the pick-collider overlay (visibleMeshesCollisionMask |= 128) to each GltfContainer entity
// not yet overlaid, so its visible meshes become pickable. Idempotent; the overlay core reverts it
// for display and save. NB: changing GltfContainer reloads the gltf, so this is a one-time reload
// per entity (the isOverlaid guard prevents re-applying).
function syncPickColliders(): void {
  for (const [id, comps] of Object.entries(state.snapshot)) {
    const gltf = comps[GLTF] as { visibleMeshesCollisionMask?: number } | undefined
    if (gltf === undefined || isOverlaid(originals, id, GLTF)) continue
    const mask = (gltf.visibleMeshesCollisionMask ?? 0) | PICK_LAYER
    applyOverlay(id, GLTF, { ...gltf, visibleMeshesCollisionMask: mask })
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
    queryType: RaycastQueryType.RQT_HIT_FIRST,
    continuous: false,
    collisionMask: PICK_LAYER,
    direction: { $case: 'globalDirection', globalDirection: { ...dir } }
  })
  pending = { ts: rayTs, shift, ctrl }
}

// Apply the result of a requested pick once it arrives (matched by timestamp).
function handlePickResult(): void {
  if (pending === null || picker === null) return
  const result = RaycastResult.getOrNull(picker)
  if (result === null || result.timestamp !== pending.ts) return
  const p = pending
  pending = null
  const hit = result.hits[0]
  if (hit === undefined || hit.entityId === undefined) {
    // miss on a plain click -> clear the selection (additive modifiers leave it)
    if (!p.shift && !p.ctrl) clearSelection()
    return
  }
  const id = String(hit.entityId)
  selectionClick(id, p.shift, p.ctrl)
  if (state.selected.has(id)) selectEntityInTree(state.snapshot, id)
}
