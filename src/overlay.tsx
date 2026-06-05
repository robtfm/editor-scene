import ReactEcs, { UiEntity } from '@dcl/sdk/react-ecs'
import { inputSystem, InputAction } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import { state, selectEntityInTree, selectionClick, entityLabel } from './state'
import { computeWorldPositions, shouldMark } from './world-pos'
import { projectWorldToScreen } from './camera-projection'

const CIRCLE_D = 16
const MARKER = Color4.create(0.4, 0.85, 1, 1)
const MARKER_HOVER = Color4.create(1, 0.85, 0.3, 1)
const MARKER_SELECTED = Color4.create(0.35, 0.9, 0.45, 1)
const MARKER_ACTIVE = Color4.create(1, 0.6, 0.2, 1)
const TIP_BG = Color4.create(0, 0, 0, 0.8)

// In the scene, IaModifier is shift and IaWalk is ctrl.
function clickModifiers(): { shift: boolean; ctrl: boolean } {
  return {
    shift: inputSystem.isPressed(InputAction.IA_MODIFIER),
    ctrl: inputSystem.isPressed(InputAction.IA_WALK)
  }
}

// Tooltip rendered as a top-level overlay child (not a child of the tiny
// circle, which would constrain its text box to ~1 char and wrap per-letter).
function tooltip(id: string, left: number, top: number): ReactEcs.JSX.Element {
  const text = entityLabel(id)
  const width = Math.max(56, text.length * 9 + 16)
  return (
    <UiEntity
      key="overlay-tooltip"
      uiTransform={{
        positionType: 'absolute',
        position: { left: left + CIRCLE_D / 2 + 4, top: top - 22 },
        width,
        height: 20,
        padding: { left: 6, right: 6 },
        alignItems: 'center'
      }}
      uiBackground={{ color: TIP_BG }}
      uiText={{
        value: text,
        fontSize: 13,
        color: Color4.White(),
        textAlign: 'middle-left'
      }}
    />
  )
}

function markerColor(id: string, hovered: boolean): Color4 {
  if (hovered) return MARKER_HOVER
  if (state.activeEntity === id) return MARKER_ACTIVE
  if (state.selected.has(id)) return MARKER_SELECTED
  return MARKER
}

function marker(
  id: string,
  left: number,
  top: number,
  hovered: boolean
): ReactEcs.JSX.Element {
  const color = markerColor(id, hovered)
  const selected = state.selected.has(id)
  return (
    <UiEntity
      key={`marker-${id}`}
      uiTransform={{
        width: CIRCLE_D,
        height: CIRCLE_D,
        positionType: 'absolute',
        position: { left: left - CIRCLE_D / 2, top: top - CIRCLE_D / 2 },
        borderRadius: 999,
        borderWidth: 2,
        borderColor: color
      }}
      uiBackground={{ color: { ...color, a: selected ? 0.6 : 0.35 } }}
      onMouseEnter={() => {
        state.hoveredOverlay = id
      }}
      onMouseLeave={() => {
        if (state.hoveredOverlay === id) state.hoveredOverlay = null
      }}
      onMouseDown={() => {
        const { shift, ctrl } = clickModifiers()
        selectionClick(id, shift, ctrl)
        if (state.selected.has(id)) selectEntityInTree(state.snapshot, id)
      }}
    />
  )
}

// World-space markers for the 'select' action: a circle at each qualifying
// entity's origin, projected to screen. The container passes the pointer
// through (`pointerFilter: 'none'`); only the circles capture hover/click.
export function overlayUi(): ReactEcs.JSX.Element | null {
  if (state.activeAction !== 'select' || state.status !== 'ready') return null
  const worldPositions = computeWorldPositions(state.snapshot)
  if (worldPositions === null) return null

  const markers: ReactEcs.JSX.Element[] = []
  let hoveredTip: ReactEcs.JSX.Element | null = null
  for (const [id, world] of worldPositions) {
    if (!shouldMark(state.snapshot, id)) continue
    const screen = projectWorldToScreen(world)
    if (screen === null || !screen.onScreen) continue
    const hovered = state.hoveredOverlay === id
    markers.push(marker(id, screen.left, screen.top, hovered))
    if (hovered) hoveredTip = tooltip(id, screen.left, screen.top)
  }

  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: '100%',
        positionType: 'absolute',
        position: { top: 0, left: 0 },
        pointerFilter: 'none'
      }}
    >
      {markers}
      {hoveredTip ?? []}
    </UiEntity>
  )
}
