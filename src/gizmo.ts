import {
  engine,
  Transform,
  MeshRenderer,
  Material,
  VisibilityComponent,
  TextureCamera,
  CameraLayer,
  CameraLayers,
  PrimaryPointerInfo,
  UiCanvasInformation,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { state } from './state'
import { worldTransformOf, worldToLocalPosition, worldToLocalRotation } from './world-pos'
import { rotateVec3ByQuat } from './perspective-to-screen'
import { cameraFovY } from './camera-projection'
import { fireTransform, syncAfterDrag } from './inspector'

// A render layer that only the gizmo camera draws, so gizmo meshes render
// isolated from (and composited on top of) the world.
export const GIZMO_LAYER = 4

type Axis = 'x' | 'y' | 'z'
type HandleId = 'x' | 'y' | 'z' | 'xy' | 'xz' | 'yz' | 'rx' | 'ry' | 'rz'
type Mode = 'translate' | 'rotate'
type Kind = 'arrow' | 'plane' | 'ring'

const AXIS_COLOR: Record<Axis, Color4> = {
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

let gizmoCamera: Entity | null = null
let gizmoRoot: Entity | null = null
let translateGroup: Entity | null = null
let rotateGroup: Entity | null = null
let lastHover: string | null = '__init__'
let lastMode: Mode | null = null

// handle id -> its meshes (each tagged with how to material it) + base colour
type Part = { e: Entity; kind: Kind }
const handles = new Map<HandleId, { parts: Part[]; color: Color4 }>()

export function gizmoCameraEntity(): Entity | null {
  return gizmoCamera
}

// Which transform mode the gizmo is in (translate/rotate), or null when no
// transform action is active or nothing is selected.
function activeMode(): Mode | null {
  if (state.selectedEntity === null) return null
  if (state.activeAction === 'translate') return 'translate'
  if (state.activeAction === 'rotate') return 'rotate'
  return null
}

function gizmoActive(): boolean {
  return activeMode() !== null
}

// --- materials ---

function setHandleMaterial(e: Entity, color: Color4, kind: Kind, highlighted: boolean): void {
  const rgb = { r: color.r, g: color.g, b: color.b }
  if (kind === 'plane') {
    Material.setPbrMaterial(e, {
      albedoColor: { ...rgb, a: highlighted ? 0.6 : 0.4 },
      emissiveColor: rgb,
      emissiveIntensity: highlighted ? 1.1 : 0.3,
      roughness: 1
    })
  } else {
    Material.setPbrMaterial(e, {
      albedoColor: color,
      emissiveColor: rgb,
      emissiveIntensity: highlighted ? 1.4 : 0.35,
      roughness: 1,
      metallic: 0
    })
  }
}

function applyHighlight(hover: string | null): void {
  if (hover === lastHover) return
  lastHover = hover
  for (const [id, h] of handles) {
    const hl = id === hover
    for (const p of h.parts) setHandleMaterial(p.e, h.color, p.kind, hl)
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
const RING_R = 0.8 // rotation-ring radius, in gizmo-local units

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

  handles.set(axis, {
    parts: [
      { e: shaft, kind: 'arrow' },
      { e: head, kind: 'arrow' }
    ],
    color
  })
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
  handles.set(plane, { parts: [{ e: quad, kind: 'plane' }], color: PLANE_COLOR[plane] })
}

// Orientation taking the ring's local +Z (its plane normal) onto `axis`.
function ringOrientation(axis: Axis): Quaternion {
  return axis === 'x'
    ? Quaternion.fromEulerDegrees(0, 90, 0)
    : axis === 'y'
      ? Quaternion.fromEulerDegrees(-90, 0, 0)
      : Quaternion.Identity()
}

// In-plane basis (gizmo-local) of each ring's drawn quarter: the first quadrant
// of its local XY frame after ringOrientation. Used to gate picking to the arc.
const RING_UV: Record<Axis, { u: Vector3; v: Vector3 }> = {
  x: { u: Vector3.create(0, 0, -1), v: Vector3.create(0, 1, 0) },
  y: { u: Vector3.create(1, 0, 0), v: Vector3.create(0, 0, -1) },
  z: { u: Vector3.create(1, 0, 0), v: Vector3.create(0, 1, 0) }
}

const ARC_START = -10 // local degrees; arc overshoots the quadrant a little so
const ARC_SPAN = 110 //  adjacent axes' rims don't look joined at the axis lines
const DISC_FRAC = 0.34 // fill disc radius as a fraction of the rim radius (66% inset)

// A rotation handle around `axis`: an arc of thin box segments (the bright
// pickable rim) backed by a translucent disc (a single flat cylinder, inset
// from the rim), the whole thing oriented so its normal points along the axis.
// A solid disc avoids the z-fighting/gaps a quad-tessellated sector would have
// (there is no triangle primitive to fill a true sector cleanly).
function makeArc(parent: Entity, axis: Axis): void {
  const ring = engine.addEntity()
  Transform.create(ring, { parent, rotation: ringOrientation(axis) })
  const color = AXIS_COLOR[axis]
  const parts: Part[] = []

  // arc rim: box segments spanning ARC_SPAN degrees
  const segs = 12
  const segLen = (((ARC_SPAN * Math.PI) / 180) * RING_R) / segs / 0.84
  const thick = 0.045
  for (let i = 0; i < segs; i++) {
    const deg = ARC_START + (ARC_SPAN / segs) * (i + 0.5)
    const rad = (deg * Math.PI) / 180
    const seg = engine.addEntity()
    Transform.create(seg, {
      parent: ring,
      position: Vector3.create(RING_R * Math.cos(rad), RING_R * Math.sin(rad), 0),
      rotation: Quaternion.fromEulerDegrees(0, 0, deg + 90),
      scale: Vector3.create(segLen, thick, thick)
    })
    MeshRenderer.setBox(seg)
    parts.push({ e: seg, kind: 'ring' })
  }

  // fill: a flat disc inset from the rim. A unit cylinder's axis is +Y, so
  // rotate it onto the ring's local +Z to lay the disc in the ring plane.
  const disc = engine.addEntity()
  const d = 2 * DISC_FRAC * RING_R
  Transform.create(disc, {
    parent: ring,
    rotation: Quaternion.fromEulerDegrees(90, 0, 0),
    scale: Vector3.create(d, 0.004, d)
  })
  MeshRenderer.setCylinder(disc, 0.5, 0.5)
  parts.push({ e: disc, kind: 'plane' })

  handles.set(`r${axis}` as HandleId, { parts, color })
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

  const tg = engine.addEntity()
  Transform.create(tg, { parent: root })
  VisibilityComponent.create(tg, { visible: true, propagateToChildren: true })
  makeArrow(tg, 'x')
  makeArrow(tg, 'y')
  makeArrow(tg, 'z')
  makePlane(tg, 'xy')
  makePlane(tg, 'xz')
  makePlane(tg, 'yz')
  translateGroup = tg

  const rg = engine.addEntity()
  Transform.create(rg, { parent: root })
  VisibilityComponent.create(rg, { visible: false, propagateToChildren: true })
  makeArc(rg, 'x')
  makeArc(rg, 'y')
  makeArc(rg, 'z')
  rotateGroup = rg

  gizmoRoot = root
  applyHighlight(null) // all dim to start

  engine.addSystem(updateGizmo)
}

// Show the handle group for `mode`, hide the other (only on change).
function showGroup(mode: Mode): void {
  if (mode === lastMode || translateGroup === null || rotateGroup === null) return
  lastMode = mode
  VisibilityComponent.getMutable(translateGroup).visible = mode === 'translate'
  VisibilityComponent.getMutable(rotateGroup).visible = mode === 'rotate'
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

function axisDirs(rotation: Quaternion): Record<Axis, Vector3> {
  return {
    x: Vector3.normalize(rotateVec3ByQuat(unit('x'), rotation)),
    y: Vector3.normalize(rotateVec3ByQuat(unit('y'), rotation)),
    z: Vector3.normalize(rotateVec3ByQuat(unit('z'), rotation))
  }
}

// Pick the translate handle nearest the pointer ray (planes first when the ray
// passes through their quad, then the nearest axis within a threshold).
function pickTranslate(
  origin: Vector3,
  rotation: Quaternion,
  s: number,
  rayO: Vector3,
  rayD: Vector3
): HandleId | null {
  const dir = axisDirs(rotation)

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

// Pick the rotation ring whose circle the pointer ray crosses (nearest by
// camera depth when more than one is within the band).
function pickRotate(
  origin: Vector3,
  rotation: Quaternion,
  s: number,
  rayO: Vector3,
  rayD: Vector3
): HandleId | null {
  const dir = axisDirs(rotation)
  const R = RING_R * s
  const band = 0.14 * s
  let best: HandleId | null = null
  let bestT = Infinity
  for (const axis of ['x', 'y', 'z'] as Axis[]) {
    const n = dir[axis]
    const denom = Vector3.dot(rayD, n)
    if (Math.abs(denom) < 1e-4) continue
    const t = Vector3.dot(Vector3.subtract(origin, rayO), n) / denom
    if (t < 0 || t >= bestT) continue
    const hit = Vector3.add(rayO, Vector3.scale(rayD, t))
    const rel = Vector3.subtract(hit, origin)
    if (Math.abs(Vector3.length(rel) - R) > band) continue
    // only the drawn quarter is pickable: first quadrant of the ring's u/v frame
    const uWorld = Vector3.normalize(rotateVec3ByQuat(RING_UV[axis].u, rotation))
    const vWorld = Vector3.normalize(rotateVec3ByQuat(RING_UV[axis].v, rotation))
    if (Vector3.dot(rel, uWorld) < -0.02 * s || Vector3.dot(rel, vWorld) < -0.02 * s) continue
    bestT = t
    best = `r${axis}` as HandleId
  }
  return best
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

function rayPlaneHit(o: Vector3, d: Vector3, p: Vector3, n: Vector3): Vector3 | null {
  const denom = Vector3.dot(d, n)
  if (Math.abs(denom) < 1e-5) return null
  const t = Vector3.dot(Vector3.subtract(p, o), n) / denom
  if (t < 0) return null
  return Vector3.add(o, Vector3.scale(d, t))
}

// An orthonormal (u, v) basis spanning the plane with normal n.
function planeBasis(n: Vector3): { u: Vector3; v: Vector3 } {
  const ref = Math.abs(n.y) < 0.99 ? Vector3.create(0, 1, 0) : Vector3.create(1, 0, 0)
  const u = Vector3.normalize(Vector3.cross(ref, n))
  const v = Vector3.cross(n, u)
  return { u, v }
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

type Local = { x: number; y: number; z: number }
type LocalRot = { x: number; y: number; z: number; w: number }

type DragState = {
  kind: 'translate-axis' | 'translate-plane' | 'rotate'
  startWorld: Vector3
  startRot: Quaternion
  // held local fields (the ones this drag does not change)
  position: Local
  rotation: LocalRot
  scale: Local
  parent: number
  // translate-axis
  axisDir?: Vector3
  grabT?: number
  // translate-plane
  planeNormal?: Vector3
  grabHit?: Vector3
  // rotate
  rotNormal?: Vector3
  rotU?: Vector3
  rotV?: Vector3
  rotAngle0?: number
}

let drag: DragState | null = null
// Last committed drag pose, held briefly after release so the gizmo doesn't snap
// back to the (still-stale) snapshot pose during the settle window.
let lastDragWorld: Vector3 | null = null
let lastDragRot: Quaternion | null = null
let pendingWorld: Vector3 | null = null
let pendingRot: Quaternion | null = null
let pendingTime = 0

// Begin a drag on the currently-hovered handle (called from the panel's down).
export function startGizmoDrag(): void {
  if (state.gizmoHover === null || state.selectedEntity === null) return
  const wt = worldTransformOf(state.snapshot, state.selectedEntity)
  const ray = pointerRay()
  if (wt === null || ray === null) return

  const t = state.snapshot[state.selectedEntity]?.Transform as
    | { position?: Local; rotation?: LocalRot; scale?: Local; parent?: number }
    | undefined
  const base = {
    startWorld: { ...wt.position },
    startRot: { ...wt.rotation },
    position: t?.position ?? { x: 0, y: 0, z: 0 },
    rotation: t?.rotation ?? { x: 0, y: 0, z: 0, w: 1 },
    scale: t?.scale ?? { x: 1, y: 1, z: 1 },
    parent: t?.parent ?? 0
  }

  const handle = state.gizmoHover
  if (handle[0] === 'r') {
    const axis = handle[1] as Axis
    const n = Vector3.normalize(rotateVec3ByQuat(unit(axis), wt.rotation))
    const hit = rayPlaneHit(ray.o, ray.d, wt.position, n)
    if (hit === null) return
    const { u, v } = planeBasis(n)
    const rel = Vector3.subtract(hit, wt.position)
    drag = {
      ...base,
      kind: 'rotate',
      rotNormal: n,
      rotU: u,
      rotV: v,
      rotAngle0: Math.atan2(Vector3.dot(rel, v), Vector3.dot(rel, u))
    }
  } else if (handle.length === 1) {
    const axisDir = Vector3.normalize(rotateVec3ByQuat(unit(handle as Axis), wt.rotation))
    drag = {
      ...base,
      kind: 'translate-axis',
      axisDir,
      grabT: closestAxisParam(wt.position, axisDir, ray.o, ray.d)
    }
  } else {
    const p = PLANES.find((pl) => pl.id === handle)
    if (p === undefined) return
    const normal = Vector3.normalize(rotateVec3ByQuat(unit(p.n), wt.rotation))
    const grabHit = rayPlaneHit(ray.o, ray.d, wt.position, normal)
    if (grabHit === null) return
    drag = { ...base, kind: 'translate-plane', planeNormal: normal, grabHit }
  }
  state.gizmoDragging = true
}

export function endGizmoDrag(): void {
  if (drag === null) return
  drag = null
  state.gizmoDragging = false
  pendingWorld = lastDragWorld
  pendingRot = lastDragRot
  pendingTime = 0
  lastDragWorld = null
  lastDragRot = null
  syncAfterDrag().catch(console.error)
}

function updateDrag(camT: { position: Vector3 }): void {
  if (drag === null || state.selectedEntity === null) return
  const ray = pointerRay()
  if (ray === null) return
  const id = state.selectedEntity

  if (drag.kind === 'rotate') {
    const hit = rayPlaneHit(ray.o, ray.d, drag.startWorld, drag.rotNormal as Vector3)
    if (hit === null) return
    const rel = Vector3.subtract(hit, drag.startWorld)
    const angle = Math.atan2(
      Vector3.dot(rel, drag.rotV as Vector3),
      Vector3.dot(rel, drag.rotU as Vector3)
    )
    const deltaDeg = ((angle - (drag.rotAngle0 as number)) * 180) / Math.PI
    const rotDelta = Quaternion.fromAngleAxis(deltaDeg, drag.rotNormal as Vector3)
    const newWorldRot = Quaternion.multiply(rotDelta, drag.startRot)

    lastDragWorld = drag.startWorld
    lastDragRot = newWorldRot
    setGizmoTransform(drag.startWorld, newWorldRot, scaleFor(drag.startWorld, camT.position))
    const localRot = worldToLocalRotation(state.snapshot, id, newWorldRot)
    if (localRot !== null) {
      fireTransform(
        id,
        JSON.stringify({
          position: drag.position,
          rotation: localRot,
          scale: drag.scale,
          parent: drag.parent
        })
      )
    }
    return
  }

  let world: Vector3
  if (drag.kind === 'translate-axis') {
    const t = closestAxisParam(drag.startWorld, drag.axisDir as Vector3, ray.o, ray.d)
    world = Vector3.add(drag.startWorld, Vector3.scale(drag.axisDir as Vector3, t - (drag.grabT as number)))
  } else {
    const hit = rayPlaneHit(ray.o, ray.d, drag.startWorld, drag.planeNormal as Vector3)
    if (hit === null) return
    world = Vector3.add(drag.startWorld, Vector3.subtract(hit, drag.grabHit as Vector3))
  }

  lastDragWorld = world
  lastDragRot = drag.startRot
  setGizmoTransform(world, drag.startRot, scaleFor(world, camT.position))
  const local = worldToLocalPosition(state.snapshot, id, world)
  if (local !== null) {
    fireTransform(
      id,
      JSON.stringify({
        position: local,
        rotation: drag.rotation,
        scale: drag.scale,
        parent: drag.parent
      })
    )
  }
}

// Quaternions are close (same orientation) when |dot| ~ 1.
function quatClose(a: Quaternion, b: Quaternion): boolean {
  return Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w) > 0.9999
}

function updateGizmo(dt: number): void {
  if (gizmoCamera === null || gizmoRoot === null) return
  const dragging = drag !== null
  if (!dragging && (!gizmoActive() || state.selectedEntity === null)) {
    if (state.gizmoHover !== null) state.gizmoHover = null
    applyHighlight(null)
    pendingWorld = null
    pendingRot = null
    return
  }

  const camT = Transform.getOrNull(engine.CameraEntity)
  if (camT === null) return
  mirrorCamera(camT)

  const mode: Mode = dragging
    ? (drag as DragState).kind === 'rotate'
      ? 'rotate'
      : 'translate'
    : (activeMode() as Mode)
  showGroup(mode)

  if (dragging) {
    updateDrag(camT)
    return
  }

  // Position + orient on the target, then pick the hovered handle.
  const wt = worldTransformOf(state.snapshot, state.selectedEntity as string)
  if (wt === null) return

  // Hold at the just-dragged pose until the snapshot reflects it (or time out),
  // so the gizmo doesn't briefly snap back during the post-drag settle.
  let pos = wt.position
  let rot = wt.rotation
  if (pendingWorld !== null && pendingRot !== null) {
    pendingTime += dt
    const settled =
      Vector3.distance(wt.position, pendingWorld) < 0.02 && quatClose(wt.rotation, pendingRot)
    if (settled || pendingTime > 1.5) {
      pendingWorld = null
      pendingRot = null
    } else {
      pos = pendingWorld
      rot = pendingRot
    }
  }

  const s = scaleFor(pos, camT.position)
  setGizmoTransform(pos, rot, s)

  const ray = pointerRay()
  if (ray !== null) {
    const hover =
      mode === 'rotate'
        ? pickRotate(pos, rot, s, ray.o, ray.d)
        : pickTranslate(pos, rot, s, ray.o, ray.d)
    state.gizmoHover = hover
    applyHighlight(hover)
  }
}
