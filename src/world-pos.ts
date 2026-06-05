import { Vector3, Quaternion } from '@dcl/sdk/math'
import { type Snapshot } from './state'
import { rotateVec3ByQuat } from './perspective-to-screen'

type Trs = { pos: Vector3; rot: Quaternion; scale: Vector3 }

type TransformValue = {
  position?: { x: number; y: number; z: number }
  rotation?: { x: number; y: number; z: number; w: number }
  scale?: { x: number; y: number; z: number }
  parent?: number
}

const IDENTITY: Trs = {
  pos: Vector3.Zero(),
  rot: Quaternion.Identity(),
  scale: Vector3.One()
}

function readTransform(snapshot: Snapshot, id: string): TransformValue {
  return (snapshot[id]?.Transform as TransformValue | undefined) ?? {}
}

function localTrs(t: TransformValue): Trs {
  const p = t.position
  const r = t.rotation
  const s = t.scale
  return {
    pos: p ? Vector3.create(p.x, p.y, p.z) : Vector3.Zero(),
    rot: r ? Quaternion.create(r.x, r.y, r.z, r.w) : Quaternion.Identity(),
    scale: s ? Vector3.create(s.x, s.y, s.z) : Vector3.One()
  }
}

// Compose an entity's transform up the parent chain to root, in scene-local
// space. Parent 0 (root) is treated as identity; a missing/absent parent stops
// the walk. `visiting` guards against malformed parent cycles.
function composed(
  snapshot: Snapshot,
  id: string,
  cache: Map<string, Trs>,
  visiting: Set<string>
): Trs {
  const cached = cache.get(id)
  if (cached !== undefined) return cached

  const t = readTransform(snapshot, id)
  const local = localTrs(t)
  const parent = t.parent ?? 0

  let result: Trs
  if (parent === 0 || visiting.has(String(parent)) || !(String(parent) in snapshot)) {
    result = local
  } else {
    visiting.add(id)
    const P = composed(snapshot, String(parent), cache, visiting)
    visiting.delete(id)
    // child-in-parent-frame: P.pos + P.rot * (P.scale ∘ local.pos)
    const scaled = Vector3.multiply(local.pos, P.scale)
    const rotated = rotateVec3ByQuat(scaled, P.rot)
    result = {
      pos: Vector3.add(P.pos, rotated),
      rot: Quaternion.multiply(P.rot, local.rot),
      scale: Vector3.multiply(P.scale, local.scale)
    }
  }

  cache.set(id, result)
  return result
}

// World position of every snapshot entity = composed-scene-local minus the
// world origin (reserved entity 5, WORLD_ORIGIN). Returns null when entity 5 is
// absent (can't establish the world frame).
export function computeWorldPositions(
  snapshot: Snapshot
): Map<string, Vector3> | null {
  if (!('5' in snapshot)) return null
  const cache = new Map<string, Trs>()
  const origin = composed(snapshot, '5', cache, new Set()).pos

  const out = new Map<string, Vector3>()
  for (const id of Object.keys(snapshot)) {
    const pos = composed(snapshot, id, cache, new Set()).pos
    out.set(id, Vector3.subtract(pos, origin))
  }
  return out
}

// World position + rotation of a single entity (for orienting a local-axis
// gizmo). World position = composed-to-root minus entity 5; world rotation =
// the composed rotation (the world origin's rotation is identity).
export function worldTransformOf(
  snapshot: Snapshot,
  id: string
): { position: Vector3; rotation: Quaternion } | null {
  if (!('5' in snapshot)) return null
  const cache = new Map<string, Trs>()
  const origin = composed(snapshot, '5', cache, new Set()).pos
  const trs = composed(snapshot, id, cache, new Set())
  return { position: Vector3.subtract(trs.pos, origin), rotation: trs.rot }
}

// Inverse of the world-position computation: the local Transform.position that
// places the entity at `world`. Used to write a gizmo-dragged world position
// back as a (parent-relative) local position. Parent transform is read from the
// snapshot (unchanged during a translate drag of the child).
export function worldToLocalPosition(
  snapshot: Snapshot,
  id: string,
  world: Vector3
): { x: number; y: number; z: number } | null {
  if (!('5' in snapshot)) return null
  const cache = new Map<string, Trs>()
  const t5 = composed(snapshot, '5', cache, new Set()).pos
  const parentId = String(readTransform(snapshot, id).parent ?? 0)
  const parent: Trs =
    parentId === '0' || !(parentId in snapshot)
      ? { pos: Vector3.Zero(), rot: Quaternion.Identity(), scale: Vector3.One() }
      : composed(snapshot, parentId, cache, new Set())

  const parentWorldPos = Vector3.subtract(parent.pos, t5)
  const rel = Vector3.subtract(world, parentWorldPos)
  const inv = Quaternion.create(
    -parent.rot.x,
    -parent.rot.y,
    -parent.rot.z,
    parent.rot.w
  )
  const unrot = rotateVec3ByQuat(rel, inv)
  return {
    x: unrot.x / (parent.scale.x || 1),
    y: unrot.y / (parent.scale.y || 1),
    z: unrot.z / (parent.scale.z || 1)
  }
}

// The local Transform.rotation that gives the entity world rotation `world`
// (inverse of the composed rotation): local = parentWorldRot⁻¹ · world.
export function worldToLocalRotation(
  snapshot: Snapshot,
  id: string,
  world: Quaternion
): Quaternion | null {
  if (!('5' in snapshot)) return null
  const cache = new Map<string, Trs>()
  const parentId = String(readTransform(snapshot, id).parent ?? 0)
  const parentRot =
    parentId === '0' || !(parentId in snapshot)
      ? Quaternion.Identity()
      : composed(snapshot, parentId, cache, new Set()).rot
  const inv = Quaternion.create(-parentRot.x, -parentRot.y, -parentRot.z, parentRot.w)
  return Quaternion.multiply(inv, world)
}

function isZeroOffset(t: TransformValue): boolean {
  const p = t.position
  if (p === undefined) return true
  return Math.abs(p.x) + Math.abs(p.y) + Math.abs(p.z) < 1e-5
}

// Whether to draw a marker for an entity: skip reserved entities (< 512) and
// skip nested entities that sit exactly on their parent (a non-root parent with
// no positional offset), whose marker would just overlap the parent's.
export function shouldMark(snapshot: Snapshot, id: string): boolean {
  if (Number(id) < 512) return false
  const t = readTransform(snapshot, id)
  const parent = t.parent ?? 0
  if (parent !== 0 && isZeroOffset(t)) return false
  return true
}
