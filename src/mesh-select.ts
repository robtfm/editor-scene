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

// Make every renderable entity pickable on the editor layer (128), idempotently. The overlay core
// reverts these for display and save.
//  - GltfContainer: overlay visibleMeshesCollisionMask |= 128 (one-time gltf reload per entity).
//  - MeshRenderer (primitives): overlay a MeshCollider of the same shape with the 128 bit. NB this
//    replaces any scene-authored MeshCollider while editing, so a scene that uses a *different*
//    MeshCollider shape than its MeshRenderer loses that distinction in the editor (accepted).
function syncPickColliders(): void {
  for (const [id, comps] of Object.entries(state.snapshot)) {
    const gltf = comps[GLTF] as { visibleMeshesCollisionMask?: number } | undefined
    if (gltf !== undefined) {
      if (isOverlaid(originals, id, GLTF)) continue
      applyOverlay(id, GLTF, {
        ...gltf,
        visibleMeshesCollisionMask: (gltf.visibleMeshesCollisionMask ?? 0) | PICK_LAYER
      })
      continue
    }
    const renderer = comps[MESH_RENDERER] as { mesh?: unknown } | undefined
    if (renderer === undefined || isOverlaid(originals, id, MESH_COLLIDER)) continue
    const existing = comps[MESH_COLLIDER] as { collisionMask?: number } | undefined
    const value: Record<string, unknown> = {
      collisionMask: (existing?.collisionMask ?? 0) | PICK_LAYER
    }
    // Map the renderer's shape when set; when it's unset/unmappable, omit mesh — the engine defaults
    // both a meshless MeshRenderer and a meshless MeshCollider to a box, so they still match.
    const mesh = colliderMeshFromRenderer(renderer.mesh)
    if (mesh !== undefined) value.mesh = mesh
    applyOverlay(id, MESH_COLLIDER, value)
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
