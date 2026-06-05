import {
  engine,
  Transform,
  MeshRenderer,
  Material,
  TextureCamera,
  CameraLayer,
  CameraLayers,
  PrimaryPointerInfo,
  UiCanvasInformation,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { state } from './state'
import { worldTransformOf, worldToLocalPosition } from './world-pos'
import { rotateVec3ByQuat } from './perspective-to-screen'
import { cameraFovY } from './camera-projection'
import { fireTransform, syncAfterDrag } from './inspector'

// A render layer that only the gizmo camera draws, so gizmo meshes render
// isolated from (and composited on top of) the world.
export const GIZMO_LAYER = 4

type HandleId = 'x' | 'y' | 'z' | 'xy' | 'xz' | 'yz'

const AXIS_COLOR: Record<'x' | 'y' | 'z', Color4> = {
  x: Color4.create(0.92, 0.25, 0.25, 1),
  y: Color4.create(0.3, 0.85, 0.3, 1),
  z: Color4.create(0.3, 0.5, 1, 1)
}
const PLANE_COLOR: Record<'xy' | 'xz' | 'yz', Color4> = {
  xy: Color4.create(0.9, 0.85, 0.2, 1),
  xz: Color4.create(0.9, 0.3, 0.9, 1),
  yz: Color4.create(0.2, 0.85, 0.9, 1)
}

const PLANES: Array<{ id: 'xy' | 'xz' | 'yz'; a1: Axis; a2: Axis; n: Axis }> = [
  { id: 'xy', a1: 'x', a2: 'y', n: 'z' },
  { id: 'xz', a1: 'x', a2: 'z', n: 'y' },
  { id: 'yz', a1: 'y', a2: 'z', n: 'x' }
]
type Axis = 'x' | 'y' | 'z'

let gizmoCamera: Entity | null = null
let gizmoRoot: Entity | null = null
let lastHover: string | null = '__init__'

// handle id -> its meshes + base colour + kind (for re-materialing on hover)
const handles = new Map<
  HandleId,
  { entities: Entity[]; color: Color4; kind: 'arrow' | 'plane' }
>()

export function gizmoCameraEntity(): Entity | null {
  return gizmoCamera
}

function gizmoActive(): boolean {
  return state.activeAction === 'translate' && state.selectedEntity !== null
}

// --- materials ---

function setHandleMaterial(
  e: Entity,
  color: Color4,
  kind: 'arrow' | 'plane',
  highlighted: boolean
): void {
  const rgb = { r: color.r, g: color.g, b: color.b }
  if (kind === 'arrow') {
    Material.setPbrMaterial(e, {
      albedoColor: color,
      emissiveColor: rgb,
      emissiveIntensity: highlighted ? 1.4 : 0.35,
      roughness: 1,
      metallic: 0
    })
  } else {
    Material.setPbrMaterial(e, {
      albedoColor: { ...rgb, a: highlighted ? 0.6 : 0.4 },
      emissiveColor: rgb,
      emissiveIntensity: highlighted ? 1.1 : 0.3,
      roughness: 1
    })
  }
}

function applyHighlight(hover: string | null): void {
  if (hover === lastHover) return
  lastHover = hover
  for (const [id, h] of handles) {
    const hl = id === hover
    for (const e of h.entities) setHandleMaterial(e, h.color, h.kind, hl)
  }
}

// --- geometry ---

function axisRotation(axis: Axis): Quaternion {
  return axis === 'x'
    ? Quaternion.fromEulerDegrees(0, 0, -90)
    : axis === 'z'
      ? Quaternion.fromEulerDegrees(90, 0, 0)
      : Quaternion.Identity()
}

function along(axis: Axis, d: number): Vector3 {
  return axis === 'x'
    ? Vector3.create(d, 0, 0)
    : axis === 'y'
      ? Vector3.create(0, d, 0)
      : Vector3.create(0, 0, d)
}

function unit(axis: Axis): Vector3 {
  return along(axis, 1)
}

const ARM_LEN = 0.96 // shaft + head, in gizmo-local units

function makeArrow(parent: Entity, axis: Axis): void {
  const rot = axisRotation(axis)
  const len = 0.7
  const color = AXIS_COLOR[axis]

  const shaft = engine.addEntity()
  Transform.create(shaft, {
    parent,
    position: along(axis, len / 2),
    rotation: rot,
    scale: Vector3.create(0.06, len, 0.06)
  })
  MeshRenderer.setCylinder(shaft, 0.5, 0.5)

  const head = engine.addEntity()
  Transform.create(head, {
    parent,
    position: along(axis, len + 0.13),
    rotation: rot,
    scale: Vector3.create(0.22, 0.26, 0.22)
  })
  MeshRenderer.setCylinder(head, 0.5, 0) // cone: wide base, zero-radius tip

  handles.set(axis, { entities: [shaft, head], color, kind: 'arrow' })
}

function makePlane(parent: Entity, plane: 'xy' | 'xz' | 'yz'): void {
  const o = 0.3
  const cfg = {
    xy: { pos: Vector3.create(o, o, 0), rot: Quaternion.Identity() },
    xz: { pos: Vector3.create(o, 0, o), rot: Quaternion.fromEulerDegrees(90, 0, 0) },
    yz: { pos: Vector3.create(0, o, o), rot: Quaternion.fromEulerDegrees(0, 90, 0) }
  }[plane]

  const quad = engine.addEntity()
  Transform.create(quad, {
    parent,
    position: cfg.pos,
    rotation: cfg.rot,
    scale: Vector3.create(0.28, 0.28, 1)
  })
  MeshRenderer.setPlane(quad)
  handles.set(plane, { entities: [quad], color: PLANE_COLOR[plane], kind: 'plane' })
}

// Render resolution for the gizmo texture: track the canvas aspect, capped.
function textureSize(w: number, h: number): { width: number; height: number } {
  const scale = Math.min(1, 1600 / Math.max(w, h))
  const clamp = (n: number): number =>
    Math.max(16, Math.min(2048, Math.round(n * scale)))
  return { width: clamp(w), height: clamp(h) }
}

export function setupGizmo(): void {
  if (gizmoCamera !== null) return

  const canvas = UiCanvasInformation.getOrNull(engine.RootEntity)
  const size = textureSize(canvas?.width ?? 1280, canvas?.height ?? 720)
  const cam = engine.addEntity()
  Transform.create(cam)
  TextureCamera.create(cam, {
    width: size.width,
    height: size.height,
    layer: GIZMO_LAYER,
    clearColor: Color4.create(0, 0, 0, 0),
    mode: {
      $case: 'perspective',
      perspective: { fieldOfView: cameraFovY() ?? Math.PI / 4 }
    }
  })
  CameraLayer.create(cam, {
    layer: GIZMO_LAYER,
    directionalLight: false,
    showAvatars: false,
    showSkybox: false,
    showFog: false
  })
  gizmoCamera = cam

  const root = engine.addEntity()
  Transform.create(root)
  CameraLayers.create(root, { layers: [GIZMO_LAYER] })
  makeArrow(root, 'x')
  makeArrow(root, 'y')
  makeArrow(root, 'z')
  makePlane(root, 'xy')
  makePlane(root, 'xz')
  makePlane(root, 'yz')
  gizmoRoot = root
  applyHighlight(null) // all dim to start

  engine.addSystem(updateGizmo)
}

// --- ray pick ---

// Closest distance between a ray (origin o, unit dir d) and a segment a->b.
function rayToSegmentDist(o: Vector3, d: Vector3, a: Vector3, b: Vector3): number {
  const v = Vector3.subtract(b, a)
  const w0 = Vector3.subtract(o, a)
  const aa = Vector3.dot(d, d)
  const bb = Vector3.dot(d, v)
  const cc = Vector3.dot(v, v)
  const dd = Vector3.dot(d, w0)
  const ee = Vector3.dot(v, w0)
  const denom = aa * cc - bb * bb
  let sc: number
  let tc: number
  if (denom < 1e-6) {
    sc = 0
    tc = cc > 1e-6 ? ee / cc : 0
  } else {
    sc = (bb * ee - cc * dd) / denom
    tc = (aa * ee - bb * dd) / denom
  }
  sc = Math.max(0, sc)
  tc = Math.max(0, Math.min(1, tc))
  const pRay = Vector3.add(o, Vector3.scale(d, sc))
  const pSeg = Vector3.add(a, Vector3.scale(v, tc))
  return Vector3.distance(pRay, pSeg)
}

// Pick the handle nearest the pointer ray (planes first when the ray passes
// through their quad, then the nearest axis within a threshold).
function pickHandle(
  origin: Vector3,
  rotation: Quaternion,
  s: number,
  rayO: Vector3,
  rayD: Vector3
): HandleId | null {
  const dir: Record<Axis, Vector3> = {
    x: Vector3.normalize(rotateVec3ByQuat(unit('x'), rotation)),
    y: Vector3.normalize(rotateVec3ByQuat(unit('y'), rotation)),
    z: Vector3.normalize(rotateVec3ByQuat(unit('z'), rotation))
  }

  // planes (explicit 2D targets)
  const o = 0.3 * s
  const half = 0.18 * s
  let bestPlane: HandleId | null = null
  let bestT = Infinity
  for (const p of PLANES) {
    const n = dir[p.n]
    const denom = Vector3.dot(rayD, n)
    if (Math.abs(denom) < 1e-4) continue
    const t = Vector3.dot(Vector3.subtract(origin, rayO), n) / denom
    if (t < 0) continue
    const hit = Vector3.add(rayO, Vector3.scale(rayD, t))
    const local = Vector3.subtract(hit, origin)
    const c1 = Vector3.dot(local, dir[p.a1])
    const c2 = Vector3.dot(local, dir[p.a2])
    if (Math.abs(c1 - o) <= half && Math.abs(c2 - o) <= half && t < bestT) {
      bestT = t
      bestPlane = p.id
    }
  }
  if (bestPlane !== null) return bestPlane

  // axes
  const arm = ARM_LEN * s
  let bestAxis: HandleId | null = null
  let bestDist = 0.18 * s
  for (const axis of ['x', 'y', 'z'] as Axis[]) {
    const b = Vector3.add(origin, Vector3.scale(dir[axis], arm))
    const d = rayToSegmentDist(rayO, rayD, origin, b)
    if (d < bestDist) {
      bestDist = d
      bestAxis = axis
    }
  }
  return bestAxis
}

// The world-space pointer ray (origin = primary camera, dir = pointer info).
function pointerRay(): { o: Vector3; d: Vector3 } | null {
  const ptr = PrimaryPointerInfo.getOrNull(engine.RootEntity)
  const camT = Transform.getOrNull(engine.CameraEntity)
  const dir = ptr?.worldRayDirection
  if (dir === undefined || camT === null) return null
  return {
    o: { ...camT.position },
    d: Vector3.normalize(Vector3.create(dir.x, dir.y, dir.z))
  }
}

// Parameter t on the line a + t*u closest to the ray (u assumed unit).
function closestAxisParam(a: Vector3, u: Vector3, o: Vector3, d: Vector3): number {
  const w0 = Vector3.subtract(o, a)
  const b = Vector3.dot(d, u)
  const denom = 1 - b * b
  if (denom < 1e-6) return 0
  return (Vector3.dot(u, w0) - b * Vector3.dot(d, w0)) / denom
}

function rayPlaneHit(
  o: Vector3,
  d: Vector3,
  p: Vector3,
  n: Vector3
): Vector3 | null {
  const denom = Vector3.dot(d, n)
  if (Math.abs(denom) < 1e-5) return null
  const t = Vector3.dot(Vector3.subtract(p, o), n) / denom
  if (t < 0) return null
  return Vector3.add(o, Vector3.scale(d, t))
}

function scaleFor(world: Vector3, cam: Vector3): number {
  return Math.max(0.08, Vector3.distance(world, cam) * 0.1)
}

function mirrorCamera(camT: { position: Vector3; rotation: Quaternion }): void {
  if (gizmoCamera === null) return
  const g = Transform.getMutable(gizmoCamera)
  g.position = { ...camT.position }
  g.rotation = { ...camT.rotation }
  const fov = cameraFovY()
  if (fov !== null) {
    const tc = TextureCamera.getMutable(gizmoCamera)
    if (tc.mode?.$case === 'perspective') tc.mode.perspective.fieldOfView = fov
  }
}

function setGizmoTransform(pos: Vector3, rot: Quaternion, s: number): void {
  if (gizmoRoot === null) return
  const t = Transform.getMutable(gizmoRoot)
  t.position = { ...pos }
  t.rotation = { ...rot }
  t.scale = { x: s, y: s, z: s }
}

// --- drag ---

type DragState = {
  startWorld: Vector3
  startRot: Quaternion
  axisDir?: Vector3
  grabT?: number
  planeNormal?: Vector3
  grabHit?: Vector3
  rotation: { x: number; y: number; z: number; w: number }
  scale: { x: number; y: number; z: number }
  parent: number
}

let drag: DragState | null = null
// Last committed drag position, held briefly after release so the gizmo doesn't
// snap back to the (still-stale) snapshot position during the settle window.
let lastDragWorld: Vector3 | null = null
let pendingWorld: Vector3 | null = null
let pendingTime = 0

// Begin a drag on the currently-hovered handle (called from the panel's down).
export function startGizmoDrag(): void {
  if (state.gizmoHover === null || state.selectedEntity === null) return
  const wt = worldTransformOf(state.snapshot, state.selectedEntity)
  const ray = pointerRay()
  if (wt === null || ray === null) return

  const t = state.snapshot[state.selectedEntity]?.Transform as
    | { rotation?: DragState['rotation']; scale?: DragState['scale']; parent?: number }
    | undefined
  const base = {
    startWorld: { ...wt.position },
    startRot: { ...wt.rotation },
    rotation: t?.rotation ?? { x: 0, y: 0, z: 0, w: 1 },
    scale: t?.scale ?? { x: 1, y: 1, z: 1 },
    parent: t?.parent ?? 0
  }

  const handle = state.gizmoHover
  if (handle.length === 1) {
    const axisDir = Vector3.normalize(rotateVec3ByQuat(unit(handle as Axis), wt.rotation))
    drag = { ...base, axisDir, grabT: closestAxisParam(wt.position, axisDir, ray.o, ray.d) }
  } else {
    const p = PLANES.find((pl) => pl.id === handle)
    if (p === undefined) return
    const normal = Vector3.normalize(rotateVec3ByQuat(unit(p.n), wt.rotation))
    const grabHit = rayPlaneHit(ray.o, ray.d, wt.position, normal)
    if (grabHit === null) return
    drag = { ...base, planeNormal: normal, grabHit }
  }
  state.gizmoDragging = true
}

export function endGizmoDrag(): void {
  if (drag === null) return
  drag = null
  state.gizmoDragging = false
  pendingWorld = lastDragWorld
  pendingTime = 0
  lastDragWorld = null
  syncAfterDrag().catch(console.error)
}

function updateDrag(camT: { position: Vector3 }): void {
  if (drag === null || state.selectedEntity === null) return
  const ray = pointerRay()
  if (ray === null) return

  let world: Vector3
  if (drag.axisDir !== undefined && drag.grabT !== undefined) {
    const t = closestAxisParam(drag.startWorld, drag.axisDir, ray.o, ray.d)
    world = Vector3.add(drag.startWorld, Vector3.scale(drag.axisDir, t - drag.grabT))
  } else if (drag.planeNormal !== undefined && drag.grabHit !== undefined) {
    const hit = rayPlaneHit(ray.o, ray.d, drag.startWorld, drag.planeNormal)
    if (hit === null) return
    world = Vector3.add(drag.startWorld, Vector3.subtract(hit, drag.grabHit))
  } else {
    return
  }

  // Preview the gizmo at the dragged position, and commit the Transform.
  lastDragWorld = world
  setGizmoTransform(world, drag.startRot, scaleFor(world, camT.position))
  const local = worldToLocalPosition(state.snapshot, state.selectedEntity, world)
  if (local !== null) {
    fireTransform(
      state.selectedEntity,
      JSON.stringify({
        position: local,
        rotation: drag.rotation,
        scale: drag.scale,
        parent: drag.parent
      })
    )
  }
}

function updateGizmo(dt: number): void {
  if (gizmoCamera === null || gizmoRoot === null) return
  const dragging = drag !== null
  if (!dragging && (!gizmoActive() || state.selectedEntity === null)) {
    if (state.gizmoHover !== null) state.gizmoHover = null
    applyHighlight(null)
    pendingWorld = null
    return
  }

  const camT = Transform.getOrNull(engine.CameraEntity)
  if (camT === null) return
  mirrorCamera(camT)

  if (dragging) {
    updateDrag(camT)
    return
  }

  // Position + orient on the target, then pick the hovered handle.
  const wt = worldTransformOf(state.snapshot, state.selectedEntity as string)
  if (wt === null) return

  // Hold at the just-dragged position until the snapshot reflects it (or time
  // out), so the gizmo doesn't briefly snap back during the post-drag settle.
  let pos = wt.position
  if (pendingWorld !== null) {
    pendingTime += dt
    if (Vector3.distance(wt.position, pendingWorld) < 0.02 || pendingTime > 1.5) {
      pendingWorld = null
    } else {
      pos = pendingWorld
    }
  }

  const s = scaleFor(pos, camT.position)
  setGizmoTransform(pos, wt.rotation, s)

  const ray = pointerRay()
  if (ray !== null) {
    const hover = pickHandle(pos, wt.rotation, s, ray.o, ray.d)
    state.gizmoHover = hover
    applyHighlight(hover)
  }
}
