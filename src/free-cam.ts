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
const MOVE_SPEED = 8
const PITCH_LIMIT = Math.PI / 2 - 0.01
const RAD_TO_DEG = 180 / Math.PI

const TWEEN_DURATION = 0.3

let camEntity: Entity | null = null
let yaw = 0
let pitch = 0
// active eased move to a target pose; cancelled by any manual fly input.
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

// rotation that the fly system applies for the current yaw/pitch.
function lookRotation(): Quaternion {
  const yawQ = Quaternion.fromAngleAxis(yaw * RAD_TO_DEG, Vector3.Up())
  const pitchQ = Quaternion.fromAngleAxis(pitch * RAD_TO_DEG, Vector3.Right())
  return Quaternion.multiply(yawQ, pitchQ)
}

// Set yaw/pitch from a look direction (world space).
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
  // shortest angular path for yaw
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

// Create the virtual-camera entity (inactive) and register the fly system.
export function startFreeCam(): void {
  if (camEntity !== null) return
  const cam = engine.addEntity()
  Transform.create(cam)
  VirtualCamera.create(cam, {})
  camEntity = cam
  engine.addSystem(flyCameraSystem)
}

export function toggleFreeCam(): void {
  if (state.freeCam) disableFreeCam()
  else enableFreeCam()
}

function enableFreeCam(): void {
  if (camEntity === null) return
  // Start the virtual camera at the live camera pose so the view doesn't jump.
  const camT = Transform.getOrNull(engine.CameraEntity)
  const t = Transform.getMutable(camEntity)
  if (camT !== null) {
    t.position = { ...camT.position }
    aimAlong(Vector3.rotate(Vector3.Forward(), camT.rotation as Quaternion))
  }
  t.rotation = lookRotation()
  tween = null
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: camEntity })
  // Disable avatar locomotion while flying (scene still reads the keys).
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: { $case: 'standard', standard: { disableAll: true } }
  })
  state.freeCam = true

  // Re-frame the active selection from the current angle at the player-orbit
  // distance: keep the camera direction, slide so the active sits centred.
  if (camT !== null && state.activeEntity !== null) {
    const wt = worldTransformOf(state.snapshot, state.activeEntity)
    if (wt !== null) {
      const forward = Vector3.rotate(Vector3.Forward(), camT.rotation as Quaternion)
      const playerT = Transform.getOrNull(engine.PlayerEntity)
      const dist =
        playerT !== null
          ? Vector3.distance(camT.position, playerT.position)
          : Vector3.distance(camT.position, wt.position)
      startTween(Vector3.subtract(wt.position, Vector3.scale(forward, dist)), forward)
    }
  }
}

function disableFreeCam(): void {
  MainCamera.deleteFrom(engine.CameraEntity)
  InputModifier.deleteFrom(engine.PlayerEntity)
  state.freeCam = false
}

function flyCameraSystem(dt: number): void {
  if (!state.freeCam || camEntity === null) return

  const locked = PointerLock.getOrNull(engine.CameraEntity)?.isPointerLocked ?? false
  const ptr = PrimaryPointerInfo.getOrNull(engine.RootEntity)
  const lookDx = locked ? ptr?.screenDelta?.x ?? 0 : 0
  const lookDy = locked ? ptr?.screenDelta?.y ?? 0 : 0

  let move = Vector3.Zero()
  const rotation = lookRotation()
  const forward = Vector3.rotate(Vector3.Forward(), rotation)
  const right = Vector3.rotate(Vector3.Right(), rotation)
  if (inputSystem.isPressed(InputAction.IA_FORWARD)) move = Vector3.add(move, forward)
  if (inputSystem.isPressed(InputAction.IA_BACKWARD)) move = Vector3.subtract(move, forward)
  if (inputSystem.isPressed(InputAction.IA_RIGHT)) move = Vector3.add(move, right)
  if (inputSystem.isPressed(InputAction.IA_LEFT)) move = Vector3.subtract(move, right)
  if (inputSystem.isPressed(InputAction.IA_JUMP)) move = Vector3.add(move, Vector3.Up())
  if (inputSystem.isPressed(InputAction.IA_WALK)) move = Vector3.subtract(move, Vector3.Up())
  const moving = Vector3.lengthSquared(move) > 1e-6

  // Eased move to a target pose; any manual input cancels it.
  if (tween !== null) {
    if (moving || lookDx !== 0 || lookDy !== 0) {
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

  yaw += lookDx * MOUSE_SENSITIVITY
  pitch = clampPitch(pitch + lookDy * MOUSE_SENSITIVITY)

  const t = Transform.getMutable(camEntity)
  if (moving) {
    t.position = Vector3.add(t.position, Vector3.scale(Vector3.normalize(move), MOVE_SPEED * dt))
  }
  t.rotation = lookRotation()
}

// Camera distance that fits a sphere of `radius` (around the look target) within
// the frustum, from fov + screen aspect (the limiting half-angle of the two).
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

// Position the free camera on a world axis looking at the active selection, far
// enough back to frame the whole selection. With no selection it's a no-op (the
// camera keeps its current position).
export function orientToAxis(axis: 'x' | 'y' | 'z', sign: number): void {
  if (!state.freeCam || camEntity === null || state.activeEntity === null) return
  const wt = worldTransformOf(state.snapshot, state.activeEntity)
  if (wt === null) return
  const target = wt.position

  let radius = 0
  const world = computeWorldPositions(state.snapshot)
  if (world !== null) {
    for (const id of state.selected) {
      const p = world.get(id)
      if (p !== undefined) radius = Math.max(radius, Vector3.distance(p, target))
    }
  }

  const camPos = Vector3.add(target, Vector3.scale(axisUnit(axis, sign), fitDistance(radius)))
  startTween(camPos, Vector3.subtract(target, camPos))
}
