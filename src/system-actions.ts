import { engine, PointerLock, PrimaryPointerInfo } from '@dcl/sdk/ecs'
import { BevyApi } from './bevy-api'
import { state, setActiveAction, clearSelection } from './state'
import { cancelSaveDialog } from './inspector'

// Close the topmost open popup, one layer per call (so Escape unwinds nested modals — e.g. the file
// picker over the component window). Returns true if something was closed.
function closeTopModal(): boolean {
  if (state.filePicker !== null) {
    state.filePicker = null
  } else if (state.assetPickerOpen) {
    state.assetPickerOpen = false
  } else if (state.contentViewerOpen) {
    state.contentViewerOpen = false
  } else if (state.newEntityOpen) {
    state.newEntityOpen = false
    state.newEntityName = ''
  } else if (state.parentConfirm) {
    state.parentConfirm = false
  } else if (state.deleteConfirm !== null) {
    state.deleteConfirm = null
  } else if (state.saveDialog !== null) {
    cancelSaveDialog()
  } else if (state.componentWindow !== null) {
    state.componentWindow = null
  } else {
    return false
  }
  return true
}

// Right-click maps to the CameraLock system action — observable only by
// super-user scenes via the system action stream (a normal scene can't see it).
// We repurpose a right-click *tap* (press + release without moving) as a hotkey
// to toggle Select mode; a right-click *drag* is camera-look and is ignored.
//
// While right-click is held the engine locks/pins the cursor, so screen
// coordinates don't move — we accumulate screenDelta (relative motion) instead
// to tell a tap from a drag.
//
// On a tap we force the camera unlocked so the cursor stays free for marker/UI
// interaction. PointerLock is 2-way (writing it on the camera entity drives the
// engine's lock), but the engine also writes that component every frame and
// toggles the lock itself on the right-click — so a single write races and is
// unreliable. We re-assert `isPointerLocked: false` for a short window to win.

const TAP_MOVE_THRESHOLD = 12 // accumulated px of motion; above this it's a drag
const UNLOCK_HOLD = 0.25 // seconds to keep asserting the unlock after a tap

let held = false
let movedPx = 0
let unlockFor = 0 // seconds remaining to keep forcing unlocked

export function startSystemActions(): void {
  engine.addSystem((dt: number) => {
    if (held) {
      const d = PrimaryPointerInfo.getOrNull(engine.RootEntity)?.screenDelta
      if (d !== undefined) movedPx += Math.abs(d.x) + Math.abs(d.y)
    }
    if (unlockFor > 0) {
      unlockFor -= dt
      PointerLock.createOrReplace(engine.CameraEntity, { isPointerLocked: false })
    }
  })
  listen().catch((e) => {
    console.error('system action stream ended', e)
  })
}

async function listen(): Promise<void> {
  const stream = await BevyApi.getSystemActionStream()
  for await (const ev of stream) {
    // Escape / gamepad-Select → close the topmost open popup, or clear the selection if none open.
    if (ev.action === 'Cancel') {
      if (ev.pressed && !closeTopModal()) clearSelection()
      continue
    }
    if (ev.action !== 'CameraLock') continue
    if (ev.pressed) {
      held = true
      movedPx = 0
    } else {
      const tap = held && movedPx < TAP_MOVE_THRESHOLD
      held = false
      if (tap) {
        unlockFor = UNLOCK_HOLD
        setActiveAction('select')
      }
    }
  }
}
