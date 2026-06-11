import { engine, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { rotateVec3ByQuat } from './perspective-to-screen'
import { worldToRootLocal } from './world-pos'
import { state } from './state'

// Where a freshly-spawned *unparented* entity/asset should sit: in front of and above the player, so
// it lands in view rather than at the scene origin. world = player + 2 up + 1 forward (horizontal,
// from the player's facing), converted to the scene-root-local frame the new (parent-0) Transform is
// written in. Null if the player or the world origin (snapshot entity 5) is unavailable — the caller
// then falls back to the scene origin.
export function playerSpawnPosition(): { x: number; y: number; z: number } | null {
  const t = Transform.getOrNull(engine.PlayerEntity)
  if (t === null) return null
  const f = rotateVec3ByQuat(Vector3.Forward(), t.rotation)
  const len = Math.hypot(f.x, f.z)
  const fwd = len > 1e-4 ? { x: f.x / len, z: f.z / len } : { x: 0, z: 0 }
  const world = Vector3.create(t.position.x + fwd.x, t.position.y + 2, t.position.z + fwd.z)
  return worldToRootLocal(state.snapshot, world)
}
