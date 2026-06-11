import { engine, Transform } from '@dcl/sdk/ecs'
import { movePlayerTo } from '~system/RestrictedActions'
import { state, effectiveMode } from './state'
import { gizmoActive } from './gizmo'
import { applyOverlay, applyDeleteOverlay, clearOverlay } from './overlay-actions'
import { originals, isOverlaid } from './overlays'
import { playScene, pauseScene } from './inspector'

// The "live vs editing" lifecycle. Interact mode = the live scene: input fires, tweens/animations/
// billboards/media run (each gated by its toggle), real physics, free player. Everything else
// (select/transform tools) is the editing state: the scene's code is paused and every behavior is
// neutralised via the overlay core (reverted for display/save), so geometry holds still to edit.
//
// Entering/leaving interact is edge-triggered (play/pause); the per-component overlays are reconciled
// each frame (idempotent), mirroring syncPickColliders. Separately, entering a gizmo mode holds the
// player once (so a drag doesn't drag the avatar with it); the per-selection physics-strip that backs
// this up lives in mesh-select.

const POINTER_EVENTS = 'PointerEvents'
const TRIGGER_AREA = 'TriggerArea'
const TWEEN = 'Tween'
const ANIMATOR = 'Animator'
const BILLBOARD = 'Billboard'
const TRANSFORM = 'Transform'
const AUDIO_SOURCE = 'AudioSource'
const AUDIO_STREAM = 'AudioStream'
const VIDEO_PLAYER = 'VideoPlayer'

const BM_NONE = 0 // BillboardMode.BM_NONE — no auto-rotation

// movePlayerTo with a long duration holds the avatar in place (cancelled by the player's own input).
// One-shot on entering a gizmo mode — the ground keeps physics so they won't fall, and re-issuing
// would fight any attempt to walk away.
const FREEZE_DURATION = 1e6 // seconds — effectively "until the player moves"
let wasInteracting: boolean | null = null
let wasGizmo: boolean | null = null

export function setupInteract(): void {
  engine.addSystem(() => {
    if (state.status !== 'ready') return
    const interacting = effectiveMode() === 'interact'

    // Edge: entering interact plays the scene, leaving pauses it.
    if (interacting !== wasInteracting) {
      ;(interacting ? playScene() : pauseScene()).catch(console.error)
      wasInteracting = interacting
    }
    // Edge: hold the player once when entering a gizmo mode (not repeatedly).
    const gizmo = gizmoActive()
    if (gizmo !== wasGizmo) {
      if (gizmo) freezePlayer()
      wasGizmo = gizmo
    }

    const b = state.behaviors
    for (const [id, comps] of Object.entries(state.snapshot)) {
      // Always disabled outside interact (no toggle — these *are* interaction).
      syncDisabled(id, comps, POINTER_EVENTS, interacting, () =>
        applyOverlay(id, POINTER_EVENTS, { pointerEvents: [] })
      )
      syncDisabled(id, comps, TRIGGER_AREA, interacting, () =>
        applyOverlay(id, TRIGGER_AREA, { ...(comps[TRIGGER_AREA] as object), collisionMask: 0 })
      )

      // Toggleable behaviors: live only while interacting AND their toggle is on.
      const tweenLive = interacting && b.tween
      const billboardLive = interacting && b.billboard
      // A paused Tween still holds its pose, so disable by removing it (restored on re-enable).
      syncDisabled(id, comps, TWEEN, tweenLive, () => applyDeleteOverlay(id, TWEEN))
      syncDisabled(id, comps, BILLBOARD, billboardLive, () =>
        applyOverlay(id, BILLBOARD, { ...(comps[BILLBOARD] as object), billboardMode: BM_NONE })
      )
      syncDisabled(id, comps, ANIMATOR, interacting && b.animation, () =>
        applyOverlay(id, ANIMATOR, freezeAnimator(comps[ANIMATOR]))
      )
      const mediaLive = interacting && b.media
      syncDisabled(id, comps, AUDIO_SOURCE, mediaLive, () =>
        applyOverlay(id, AUDIO_SOURCE, { ...(comps[AUDIO_SOURCE] as object), playing: false })
      )
      syncDisabled(id, comps, AUDIO_STREAM, mediaLive, () =>
        applyOverlay(id, AUDIO_STREAM, { ...(comps[AUDIO_STREAM] as object), playing: false })
      )
      syncDisabled(id, comps, VIDEO_PLAYER, mediaLive, () =>
        applyOverlay(id, VIDEO_PLAYER, { ...(comps[VIDEO_PLAYER] as object), playing: false })
      )

      // Transform reset: a disabled tween/billboard would otherwise leave the entity at its mid-
      // animation pose, so force the Transform back to its logical (edited) value while either is off.
      const needsReset =
        (comps[TWEEN] !== undefined && !tweenLive) ||
        (comps[BILLBOARD] !== undefined && !billboardLive)
      syncDisabled(id, comps, TRANSFORM, !needsReset, () =>
        applyOverlay(id, TRANSFORM, comps[TRANSFORM])
      )
    }
  })
}

// Keep one component's "disabled" overlay in sync with whether it should be live: while it shouldn't
// be, run `disable` (engine-disabled value/removal) once; while it should, clear it (restore the
// original). Idempotent — reconciled every frame.
function syncDisabled(
  id: string,
  comps: Record<string, unknown>,
  name: string,
  live: boolean,
  disable: () => void
): void {
  const present = comps[name] !== undefined
  const overlaid = isOverlaid(originals, id, name)
  if (!present && !overlaid) return // entity doesn't have this component
  if (live) {
    if (overlaid) clearOverlay(id, name)
  } else if (!overlaid) {
    disable()
  }
}

// The Animator value with every state frozen (speed 0) — holds the current pose without advancing.
function freezeAnimator(value: unknown): unknown {
  const v = value as { states?: Array<Record<string, unknown>> }
  const states = Array.isArray(v?.states) ? v.states : []
  return { states: states.map((s) => ({ ...s, speed: 0 })) }
}

function freezePlayer(): void {
  const t = Transform.getOrNull(engine.PlayerEntity)
  if (t === null) return
  movePlayerTo({ newRelativePosition: { ...t.position }, duration: FREEZE_DURATION }).catch(() => {})
}
