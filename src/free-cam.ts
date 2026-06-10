import {
  engine,
  Transform,
  VirtualCamera,
  MainCamera,
  InputModifier,
  PointerLock,
  PrimaryPointerInfo,
  UiCanvasInformation,
  InputAction,
  inputSystem,
  type Entity
} from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import { state } from './state'
import { worldTransformOf, computeWorldPositions } from './world-pos'
import { cameraFovY } from './camera-projection'

const MOUSE_SENSITIVITY = 0.005
const MOVE_SPEED = 8 // fly units/s
const ORBIT_KEY_SPEED = 1.6 // keyboard orbit rad/s
const DOLLY_SPEED = 8 // target-mode dolly units/s
const MIN_DIST = 0.5
const PITCH_LIMIT = Math.PI / 2 - 0.01
const RAD_TO_DEG = 180 / Math.PI
const TWEEN_DURATION = 0.3

let camEntity: Entity | null = null
let yaw = 0
let pitch = 0
let distance = 5 // orbit radius (target mode)
let tween: {
  fromPos: Vector3
  toPos: Vector3
  fromYaw: number
  toYaw: number
  fromPitch: number
  toPitch: number
  elapsed: number
} | null = null

function clampPitch(p: number): number {
  return Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p))
}

// rotation (look direction) for the current yaw/pitch.
function lookRotation(): Quaternion {
  const yawQ = Quaternion.fromAngleAxis(yaw * RAD_TO_DEG, Vector3.Up())
  const pitchQ = Quaternion.fromAngleAxis(pitch * RAD_TO_DEG, Vector3.Right())
  return Quaternion.multiply(yawQ, pitchQ)
}

function aimAlong(dir: Vector3): void {
  const horiz = Math.sqrt(dir.x * dir.x + dir.z * dir.z)
  yaw = Math.atan2(dir.x, dir.z)
  pitch = clampPitch(Math.atan2(-dir.y, horiz))
}

// Begin an eased move to `toPos` aiming along `lookDir`, from the current pose.
function startTween(toPos: Vector3, lookDir: Vector3): void {
  if (camEntity === null) return
  const horiz = Math.sqrt(lookDir.x * lookDir.x + lookDir.z * lookDir.z)
  const rawYaw = Math.atan2(lookDir.x, lookDir.z)
  const dYaw = Math.atan2(Math.sin(rawYaw - yaw), Math.cos(rawYaw - yaw))
  tween = {
    fromPos: { ...Transform.get(camEntity).position },
    toPos: { ...toPos },
    fromYaw: yaw,
    toYaw: yaw + dYaw,
    fromPitch: pitch,
    toPitch: clampPitch(Math.atan2(-lookDir.y, horiz)),
    elapsed: 0
  }
}

function activeTarget(): Vector3 | null {
  if (state.activeEntity === null) return null
  return worldTransformOf(state.snapshot, state.activeEntity)?.position ?? null
}

// --- setup / mode switching ---

export function setupCamera(): void {
  if (camEntity !== null) return
  const cam = engine.addEntity()
  Transform.create(cam)
  VirtualCamera.create(cam, {})
  camEntity = cam
  engine.addSystem(cameraSystem)
}

// Cycle none -> free -> target -> none. Target is skipped when nothing is
// selected (it has nothing to orbit), so it goes none -> free -> none.
export function cycleCamMode(): void {
  if (state.camMode === 'none') setCamMode('free')
  else if (state.camMode === 'free') setCamMode(state.activeEntity !== null ? 'target' : 'none')
  else setCamMode('none')
}

function setCamMode(mode: 'none' | 'free' | 'target'): void {
  if (camEntity === null || mode === state.camMode) return
  const wasCam = state.camMode !== 'none'
  const isCam = mode !== 'none'

  if (!wasCam && isCam) {
    // First entry: seed the virtual camera at the live pose, take over, pin avatar.
    const camT = Transform.getOrNull(engine.CameraEntity)
    const t = Transform.getMutable(camEntity)
    if (camT !== null) {
      t.position = { ...camT.position }
      aimAlong(Vector3.rotate(Vector3.Forward(), camT.rotation as Quaternion))
    }
    t.rotation = lookRotation()
    MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: camEntity })
    // Pin the avatar's locomotion so WASD drives the camera, not the player — but disable each
    // movement granularly rather than `disableAll`, which also sets `block_emote` and so filters
    // the Emote system action (B) out of the super-user stream, breaking the B = cycle-cam hotkey
    // once we're in cam mode. Leaving emote enabled keeps that key flowing.
    InputModifier.createOrReplace(engine.PlayerEntity, {
      mode: {
        $case: 'standard',
        standard: {
          disableWalk: true,
          disableJog: true,
          disableRun: true,
          disableJump: true,
          disableDoubleJump: true,
          disableGliding: true
        }
      }
    })
  }
  if (wasCam && !isCam) {
    MainCamera.deleteFrom(engine.CameraEntity)
    InputModifier.deleteFrom(engine.PlayerEntity)
  }

  state.camMode = mode
  tween = null
  if (mode === 'free') initFree()
  else if (mode === 'target') initTarget()
}

// Re-frame the active selection from the current angle at the player-orbit
// distance: keep the camera direction, slide so the active sits centred.
function initFree(): void {
  if (camEntity === null) return
  const target = activeTarget()
  const camT = Transform.getOrNull(engine.CameraEntity)
  if (target === null || camT === null) return
  const forward = Vector3.rotate(Vector3.Forward(), lookRotation())
  const playerT = Transform.getOrNull(engine.PlayerEntity)
  const dist =
    playerT !== null
      ? Vector3.distance(camT.position, playerT.position)
      : Vector3.distance(Transform.get(camEntity).position, target)
  startTween(Vector3.subtract(target, Vector3.scale(forward, dist)), forward)
}

// Orbit the active selection from the current position: keep where the camera
// is, ease its aim onto the target; the orbit radius is that current distance.
function initTarget(): void {
  if (camEntity === null) return
  const target = activeTarget()
  if (target === null) return
  const pos = Transform.get(camEntity).position
  distance = Math.max(MIN_DIST, Vector3.distance(pos, target))
  startTween({ ...pos }, Vector3.subtract(target, pos))
}

// --- per-frame controller ---

function cameraSystem(dt: number): void {
  if (state.camMode === 'none' || camEntity === null) return

  const locked = PointerLock.getOrNull(engine.CameraEntity)?.isPointerLocked ?? false
  const ptr = PrimaryPointerInfo.getOrNull(engine.RootEntity)
  const lookDx = locked ? ptr?.screenDelta?.x ?? 0 : 0
  const lookDy = locked ? ptr?.screenDelta?.y ?? 0 : 0
  const anyKey =
    inputSystem.isPressed(InputAction.IA_FORWARD) ||
    inputSystem.isPressed(InputAction.IA_BACKWARD) ||
    inputSystem.isPressed(InputAction.IA_LEFT) ||
    inputSystem.isPressed(InputAction.IA_RIGHT) ||
    inputSystem.isPressed(InputAction.IA_SECONDARY) ||
    inputSystem.isPressed(InputAction.IA_PRIMARY)

  // Eased move to a target pose; any manual input cancels it.
  if (tween !== null) {
    if (anyKey || lookDx !== 0 || lookDy !== 0) {
      tween = null
    } else {
      tween.elapsed += dt
      const u = Math.min(1, tween.elapsed / TWEEN_DURATION)
      const e = u * u * (3 - 2 * u)
      yaw = tween.fromYaw + (tween.toYaw - tween.fromYaw) * e
      pitch = tween.fromPitch + (tween.toPitch - tween.fromPitch) * e
      const tw = Transform.getMutable(camEntity)
      tw.position = Vector3.add(
        tween.fromPos,
        Vector3.scale(Vector3.subtract(tween.toPos, tween.fromPos), e)
      )
      tw.rotation = lookRotation()
      if (u >= 1) tween = null
      return
    }
  }

  if (state.camMode === 'free') flyStep(dt, lookDx, lookDy)
  else orbitStep(dt, lookDx, lookDy)
}

function flyStep(dt: number, lookDx: number, lookDy: number): void {
  if (camEntity === null) return
  yaw += lookDx * MOUSE_SENSITIVITY
  pitch = clampPitch(pitch + lookDy * MOUSE_SENSITIVITY)

  const rotation = lookRotation()
  const forward = Vector3.rotate(Vector3.Forward(), rotation)
  const right = Vector3.rotate(Vector3.Right(), rotation)
  let move = Vector3.Zero()
  if (inputSystem.isPressed(InputAction.IA_FORWARD)) move = Vector3.add(move, forward)
  if (inputSystem.isPressed(InputAction.IA_BACKWARD)) move = Vector3.subtract(move, forward)
  if (inputSystem.isPressed(InputAction.IA_RIGHT)) move = Vector3.add(move, right)
  if (inputSystem.isPressed(InputAction.IA_LEFT)) move = Vector3.subtract(move, right)
  if (inputSystem.isPressed(InputAction.IA_SECONDARY)) move = Vector3.add(move, Vector3.Up())
  if (inputSystem.isPressed(InputAction.IA_PRIMARY)) move = Vector3.subtract(move, Vector3.Up())

  const t = Transform.getMutable(camEntity)
  if (Vector3.lengthSquared(move) > 1e-6) {
    t.position = Vector3.add(t.position, Vector3.scale(Vector3.normalize(move), MOVE_SPEED * dt))
  }
  t.rotation = rotation
}

// Orbit the active selection: mouse / left-right rotate around it, jump/walk
// tilt, forward/back dolly in/out.
function orbitStep(dt: number, lookDx: number, lookDy: number): void {
  if (camEntity === null) return
  const target = activeTarget()
  if (target === null) return

  yaw += lookDx * MOUSE_SENSITIVITY
  pitch = clampPitch(pitch + lookDy * MOUSE_SENSITIVITY)
  if (inputSystem.isPressed(InputAction.IA_LEFT)) yaw -= ORBIT_KEY_SPEED * dt
  if (inputSystem.isPressed(InputAction.IA_RIGHT)) yaw += ORBIT_KEY_SPEED * dt
  if (inputSystem.isPressed(InputAction.IA_SECONDARY)) pitch = clampPitch(pitch + ORBIT_KEY_SPEED * dt)
  if (inputSystem.isPressed(InputAction.IA_PRIMARY)) pitch = clampPitch(pitch - ORBIT_KEY_SPEED * dt)
  if (inputSystem.isPressed(InputAction.IA_FORWARD)) distance -= DOLLY_SPEED * dt
  if (inputSystem.isPressed(InputAction.IA_BACKWARD)) distance += DOLLY_SPEED * dt
  distance = Math.max(MIN_DIST, distance)

  const rotation = lookRotation()
  const forward = Vector3.rotate(Vector3.Forward(), rotation)
  const t = Transform.getMutable(camEntity)
  t.position = Vector3.subtract(target, Vector3.scale(forward, distance))
  t.rotation = rotation
}

// --- axis framing (works in both modes) ---

function fitDistance(radius: number): number {
  const fovY = cameraFovY() ?? Math.PI / 4
  const canvas = UiCanvasInformation.getOrNull(engine.RootEntity)
  const aspect = canvas !== null && canvas.height > 0 ? canvas.width / canvas.height : 16 / 9
  const fovX = 2 * Math.atan(Math.tan(fovY / 2) * aspect)
  const halfFov = Math.min(fovY, fovX) / 2
  const r = Math.max(radius, 1)
  return Math.max(4, (r / Math.sin(halfFov)) * 1.3)
}

function axisUnit(axis: 'x' | 'y' | 'z', sign: number): Vector3 {
  return axis === 'x'
    ? Vector3.create(sign, 0, 0)
    : axis === 'y'
      ? Vector3.create(0, sign, 0)
      : Vector3.create(0, 0, sign)
}

// Snap the camera onto a world axis looking at the active selection, framed to
// fit the whole selection. No-op with no selection.
export function orientToAxis(axis: 'x' | 'y' | 'z', sign: number): void {
  if (camEntity === null || state.camMode === 'none') return
  const target = activeTarget()
  if (target === null) return

  let radius = 0
  const world = computeWorldPositions(state.snapshot)
  if (world !== null) {
    for (const id of state.selected) {
      const p = world.get(id)
      if (p !== undefined) radius = Math.max(radius, Vector3.distance(p, target))
    }
  }

  const d = fitDistance(radius)
  if (state.camMode === 'target') distance = d
  const camPos = Vector3.add(target, Vector3.scale(axisUnit(axis, sign), d))
  startTween(camPos, Vector3.subtract(target, camPos))
}
