import ReactEcs, { Input, UiEntity } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { inputSystem, InputAction } from '@dcl/sdk/ecs'
import {
  state,
  toggleEntity,
  toggleComponent,
  toggleRawMode,
  clearComponentEdits,
  setActiveAction,
  rowElementId,
  entityLabel,
  componentKey,
  getDraft,
  setDraft,
  revertDraft,
  valueJson,
  buildForest,
  type ComponentKey,
  type Forest
} from './state'
import { overlayUi } from './overlay'
import { gizmoCameraEntity, startGizmoDrag, endGizmoDrag } from './gizmo'
import {
  refresh,
  setComponentValue,
  applyStructuredEdits,
  pauseScene,
  stepScene,
  playScene,
  deleteEntity,
  deleteEntityRecursive,
  deleteEntityReparent,
  childIdsOf
} from './inspector'
import {
  isColor,
  isVector,
  isRecord,
  joinPath,
  fieldKey,
  currentNumber,
  currentNumberText,
  currentBool,
  currentString,
  setField
} from './fields'

const PANEL_BG = Color4.create(0.08, 0.08, 0.1, 0.94)
const HEADER_BG = Color4.create(0.14, 0.14, 0.18, 1)
const ENTITY_BG = Color4.create(1, 1, 1, 0.05)
const VALUE_BG = Color4.create(0, 0, 0, 0.35)
const TEXT = Color4.create(0.9, 0.9, 0.95, 1)
const MUTED = Color4.create(0.6, 0.6, 0.68, 1)
const ACCENT = Color4.create(0.55, 0.78, 1, 1)
const BUTTON_BG = Color4.create(0.25, 0.4, 0.6, 1)

const FS = 14
const ROW_H = FS + 8
const INDENT = 14

function chevron(expanded: boolean): string {
  return expanded ? '▼' : '▶'
}

function statusText(): string {
  switch (state.status) {
    case 'logging-in':
      return 'Logging in...'
    case 'loading-snapshot':
      return 'Loading scene state...'
    case 'no-scene':
      return 'Not standing in an inspectable (non-portable) scene.'
    case 'error':
      return `Error: ${state.error}`
    case 'ready':
      return state.scene !== undefined
        ? `${state.scene.title}  ·  ${state.scene.hash.slice(0, 10)}…${
            state.frozen ? '  ·  PAUSED' : ''
          }`
        : 'ready'
  }
}

// A transport-control button that greys out when disabled.
function pbButton(
  label: string,
  enabled: boolean,
  onClick: () => void
): ReactEcs.JSX.Element {
  return (
    <UiEntity
      key={`pb-${label}`}
      uiTransform={{
        width: 54,
        height: 22,
        margin: { left: 6 },
        alignItems: 'center',
        justifyContent: 'center'
      }}
      uiBackground={{
        color: enabled ? BUTTON_BG : Color4.create(0.2, 0.2, 0.24, 1)
      }}
      uiText={{ value: label, fontSize: FS - 2, color: enabled ? TEXT : MUTED }}
      onMouseDown={() => {
        if (enabled) onClick()
      }}
    />
  )
}

function smallButton(
  label: string,
  color: Color4,
  onClick: () => void
): ReactEcs.JSX.Element {
  return (
    <UiEntity
      uiTransform={{
        width: 64,
        height: 22,
        margin: { right: 6 },
        alignItems: 'center',
        justifyContent: 'center'
      }}
      uiBackground={{ color }}
      uiText={{ value: label, fontSize: FS - 2, color: TEXT }}
      onMouseDown={onClick}
    />
  )
}

const REVERT_BG = Color4.create(0.3, 0.3, 0.35, 1)
const TOGGLE_ON = Color4.create(0.28, 0.55, 0.34, 1)
const TOGGLE_OFF = Color4.create(0.45, 0.3, 0.3, 1)
const DANGER = Color4.create(0.55, 0.2, 0.22, 1)
const DANGER_HOVER = Color4.create(0.75, 0.25, 0.27, 1)

const DELETE_HINT =
  'Del: confirm    Shift+Del: reparent children    Ctrl+Del: recursive'

// Dispatch a delete from a row button, honouring held modifiers:
// Ctrl (IA_WALK) = recursive, Shift (IA_MODIFIER) = reparent, else confirm.
function onDeleteClick(entityId: string): void {
  if (inputSystem.isPressed(InputAction.IA_WALK)) {
    deleteEntityRecursive(entityId).catch(console.error)
  } else if (inputSystem.isPressed(InputAction.IA_MODIFIER)) {
    deleteEntityReparent(entityId).catch(console.error)
  } else {
    state.deleteConfirm = entityId
  }
}

function deleteButton(entityId: string): ReactEcs.JSX.Element {
  const hovered = state.hoveredDelete === entityId
  return (
    <UiEntity
      uiTransform={{
        width: 36,
        height: 20,
        positionType: 'absolute',
        position: { right: 18, top: 2 },
        alignItems: 'center',
        justifyContent: 'center'
      }}
      uiBackground={{ color: hovered ? DANGER_HOVER : DANGER }}
      uiText={{ value: 'Del', fontSize: FS - 3, color: TEXT }}
      onMouseEnter={() => {
        state.hoveredDelete = entityId
      }}
      onMouseLeave={() => {
        if (state.hoveredDelete === entityId) state.hoveredDelete = null
      }}
      onMouseDown={() => {
        onDeleteClick(entityId)
      }}
    />
  )
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function elementIdFor(key: string, path: string): string {
  return `inp-${key}-${path}`.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function fieldLabel(text: string, width: number): ReactEcs.JSX.Element {
  return (
    <UiEntity
      uiTransform={{ width, height: 22, alignItems: 'center' }}
      uiText={{
        value: text,
        fontSize: FS - 1,
        color: MUTED,
        textAlign: 'middle-left'
      }}
    />
  )
}

// A bare numeric Input bound to a leaf path (free-text; parsed at Apply).
function numberInput(
  key: ComponentKey,
  path: string,
  value: number,
  width: number
): ReactEcs.JSX.Element {
  return (
    <Input
      uiTransform={{
        elementId: elementIdFor(key, path),
        width,
        height: 22,
        padding: { left: 4, right: 4 }
      }}
      uiBackground={{ color: VALUE_BG }}
      value={currentNumberText(key, path, value)}
      fontSize={FS - 1}
      color={TEXT}
      textAlign="middle-left"
      font="monospace"
      onChange={(v) => {
        setField(key, path, v)
      }}
    />
  )
}

// A small "<letter> [input]" cell used inside colour/vector rows.
function letteredNumber(
  key: ComponentKey,
  path: string,
  value: number,
  letter: string
): ReactEcs.JSX.Element {
  return (
    <UiEntity
      key={path}
      uiTransform={{
        width: 86,
        height: 22,
        flexDirection: 'row',
        alignItems: 'center',
        margin: { right: 4 }
      }}
    >
      <UiEntity
        uiTransform={{ width: 12, height: 22, margin: { right: 6 }, alignItems: 'center' }}
        uiText={{
          value: letter,
          fontSize: FS - 1,
          color: MUTED,
          textAlign: 'middle-left'
        }}
      />
      {numberInput(key, path, value, 64)}
    </UiEntity>
  )
}

function numberField(
  key: ComponentKey,
  path: string,
  label: string,
  value: number
): ReactEcs.JSX.Element {
  return (
    <UiEntity
      key={path}
      uiTransform={{
        width: '100%',
        height: 24,
        flexDirection: 'row',
        alignItems: 'center',
        margin: { bottom: 2 }
      }}
    >
      {fieldLabel(label, 150)}
      {numberInput(key, path, value, 140)}
    </UiEntity>
  )
}

function stringField(
  key: ComponentKey,
  path: string,
  label: string,
  value: string
): ReactEcs.JSX.Element {
  return (
    <UiEntity
      key={path}
      uiTransform={{
        width: '100%',
        height: 24,
        flexDirection: 'row',
        alignItems: 'center',
        margin: { bottom: 2 }
      }}
    >
      {fieldLabel(label, 150)}
      <Input
        uiTransform={{
          elementId: elementIdFor(key, path),
          width: 200,
          height: 22,
          padding: { left: 4, right: 4 }
        }}
        uiBackground={{ color: VALUE_BG }}
        value={currentString(key, path, value)}
        fontSize={FS - 1}
        color={TEXT}
        textAlign="middle-left"
        onChange={(v) => {
          setField(key, path, v)
        }}
      />
    </UiEntity>
  )
}

function boolField(
  key: ComponentKey,
  path: string,
  label: string,
  value: boolean
): ReactEcs.JSX.Element {
  const v = currentBool(key, path, value)
  return (
    <UiEntity
      key={path}
      uiTransform={{
        width: '100%',
        height: 24,
        flexDirection: 'row',
        alignItems: 'center',
        margin: { bottom: 2 }
      }}
    >
      {fieldLabel(label, 150)}
      <UiEntity
        uiTransform={{
          width: 70,
          height: 22,
          alignItems: 'center',
          justifyContent: 'center'
        }}
        uiBackground={{ color: v ? TOGGLE_ON : TOGGLE_OFF }}
        uiText={{ value: v ? 'true' : 'false', fontSize: FS - 2, color: TEXT }}
        onMouseDown={() => {
          setField(key, path, !v)
        }}
      />
    </UiEntity>
  )
}

function colorField(
  key: ComponentKey,
  path: string,
  label: string,
  value: { r: number; g: number; b: number; a?: number }
): ReactEcs.JSX.Element {
  const r = currentNumber(key, joinPath(path, 'r'), value.r)
  const g = currentNumber(key, joinPath(path, 'g'), value.g)
  const b = currentNumber(key, joinPath(path, 'b'), value.b)
  const hasAlpha = value.a !== undefined
  const a = hasAlpha ? currentNumber(key, joinPath(path, 'a'), value.a as number) : 1

  return (
    <UiEntity
      key={path}
      uiTransform={{ width: '100%', flexDirection: 'column', margin: { bottom: 4 } }}
    >
      <UiEntity
        uiTransform={{ width: '100%', height: 22, flexDirection: 'row', alignItems: 'center' }}
      >
        {fieldLabel(label, 150)}
        <UiEntity
          uiTransform={{ width: 40, height: 18 }}
          uiBackground={{
            color: Color4.create(clamp01(r), clamp01(g), clamp01(b), clamp01(a))
          }}
        />
      </UiEntity>
      <UiEntity
        uiTransform={{
          width: '100%',
          height: 24,
          flexDirection: 'row',
          alignItems: 'center',
          margin: { top: 2 }
        }}
      >
        {letteredNumber(key, joinPath(path, 'r'), value.r, 'R')}
        {letteredNumber(key, joinPath(path, 'g'), value.g, 'G')}
        {letteredNumber(key, joinPath(path, 'b'), value.b, 'B')}
        {hasAlpha
          ? letteredNumber(key, joinPath(path, 'a'), value.a as number, 'A')
          : []}
      </UiEntity>
    </UiEntity>
  )
}

function vectorField(
  key: ComponentKey,
  path: string,
  label: string,
  value: Record<string, number>
): ReactEcs.JSX.Element {
  const axes = ['x', 'y', 'z', 'w'].filter((ax) => ax in value)
  return (
    <UiEntity
      key={path}
      uiTransform={{
        width: '100%',
        height: 24,
        flexDirection: 'row',
        alignItems: 'center',
        margin: { bottom: 2 }
      }}
    >
      {fieldLabel(label, 80)}
      {axes.map((ax) =>
        letteredNumber(key, joinPath(path, ax), value[ax], ax.toUpperCase())
      )}
    </UiEntity>
  )
}

function readonlyField(
  path: string,
  label: string,
  value: unknown
): ReactEcs.JSX.Element {
  return (
    <UiEntity
      key={path}
      uiTransform={{
        width: '100%',
        height: 24,
        flexDirection: 'row',
        alignItems: 'center',
        margin: { bottom: 2 }
      }}
    >
      {fieldLabel(label, 150)}
      {fieldLabel(JSON.stringify(value), 200)}
    </UiEntity>
  )
}

// A labelled, indented group for nested objects/arrays.
function group(
  path: string,
  label: string,
  children: ReactEcs.JSX.Element[]
): ReactEcs.JSX.Element {
  return (
    <UiEntity
      key={path === '' ? 'root' : path}
      uiTransform={{ width: '100%', flexDirection: 'column' }}
    >
      {label !== '' ? (
        <UiEntity
          uiTransform={{ width: '100%', height: 22, alignItems: 'center' }}
          uiText={{
            value: label,
            fontSize: FS - 1,
            color: ACCENT,
            textAlign: 'middle-left'
          }}
        />
      ) : (
        []
      )}
      <UiEntity
        uiTransform={{
          width: '100%',
          flexDirection: 'column',
          padding: { left: label !== '' ? 10 : 0 }
        }}
      >
        {children}
      </UiEntity>
    </UiEntity>
  )
}

// Recursively render a typed widget for `value`. Colour/vector objects get
// dedicated widgets; other objects/arrays nest; primitives get field editors.
function renderField(
  key: ComponentKey,
  path: string,
  label: string,
  value: unknown
): ReactEcs.JSX.Element {
  if (isColor(value)) return colorField(key, path, label, value)
  if (isVector(value)) {
    return vectorField(key, path, label, value as Record<string, number>)
  }
  if (Array.isArray(value)) {
    return group(
      path,
      `${label} [${value.length}]`,
      value.map((v, i) => renderField(key, joinPath(path, i), String(i), v))
    )
  }
  if (isRecord(value)) {
    return group(
      path,
      label,
      Object.keys(value).map((k) =>
        renderField(key, joinPath(path, k), k, value[k])
      )
    )
  }
  if (typeof value === 'number') return numberField(key, path, label, value)
  if (typeof value === 'boolean') return boolField(key, path, label, value)
  if (typeof value === 'string') return stringField(key, path, label, value)
  return readonlyField(path, label, value)
}

// Raw single-line JSON editor (escape hatch for structural edits).
function rawEditor(
  key: ComponentKey,
  entityId: string,
  name: string,
  value: unknown
): ReactEcs.JSX.Element {
  const draft = getDraft(key, value)
  const dirty = state.drafts.has(key) && draft !== valueJson(value)
  return (
    <Input
      uiTransform={{
        elementId: `raw-${elementIdFor(key, '')}`,
        width: '100%',
        height: 24,
        padding: { left: 4, right: 4 }
      }}
      uiBackground={{ color: VALUE_BG }}
      value={draft}
      fontSize={FS - 1}
      color={dirty ? Color4.create(1, 0.95, 0.6, 1) : TEXT}
      textAlign="middle-left"
      font="monospace"
      onChange={(v) => {
        setDraft(key, v)
      }}
      onSubmit={(v) => {
        setComponentValue(key, entityId, name, v).catch(console.error)
      }}
    />
  )
}

// Editor body for one component: toolbar (Apply / Revert / Raw-Fields / status)
// plus either the structured editor or the raw-JSON input.
function valueRow(
  entityId: string,
  name: string,
  value: unknown
): ReactEcs.JSX.Element {
  const key = componentKey(entityId, name)
  const raw = state.rawMode.has(key)
  const status = state.editStatus.get(key) ?? ''

  return (
    <UiEntity
      key={`${key}/editor`}
      uiTransform={{
        width: '100%',
        margin: { bottom: 6 },
        padding: { left: 10 },
        flexDirection: 'column'
      }}
    >
      <UiEntity
        uiTransform={{
          width: '100%',
          height: 26,
          flexDirection: 'row',
          alignItems: 'center',
          margin: { bottom: 4 }
        }}
      >
        {smallButton('Apply', BUTTON_BG, () => {
          if (raw) {
            setComponentValue(key, entityId, name, getDraft(key, value)).catch(
              console.error
            )
          } else {
            applyStructuredEdits(key, entityId, name, value).catch(console.error)
          }
        })}
        {smallButton('Revert', REVERT_BG, () => {
          revertDraft(key)
          clearComponentEdits(key)
        })}
        {smallButton(raw ? 'Fields' : 'Raw', REVERT_BG, () => {
          toggleRawMode(key)
        })}
        <UiEntity
          uiTransform={{ width: 180, height: 22, alignItems: 'center' }}
          uiText={{
            value: status,
            fontSize: FS - 2,
            color: status.startsWith('✓')
              ? Color4.create(0.5, 0.9, 0.5, 1)
              : MUTED,
            textAlign: 'middle-left'
          }}
        />
      </UiEntity>
      {raw ? rawEditor(key, entityId, name, value) : renderField(key, '', '', value)}
    </UiEntity>
  )
}

function componentNodes(
  entityId: string,
  components: Record<string, unknown>
): ReactEcs.JSX.Element[] {
  const rows: ReactEcs.JSX.Element[] = []
  for (const name of Object.keys(components).sort()) {
    const key = componentKey(entityId, name)
    const expanded = state.expandedComponents.has(key)
    rows.push(
      <UiEntity
        key={key}
        uiTransform={{
          width: '100%',
          height: ROW_H,
          margin: { bottom: 1 },
          padding: { left: 4 },
          alignItems: 'center'
        }}
        uiText={{
          value: `${chevron(expanded)} ${name}`,
          fontSize: FS,
          color: ACCENT,
          textAlign: 'middle-left'
        }}
        onMouseDown={() => {
          toggleComponent(key)
        }}
      />
    )
    if (expanded) {
      rows.push(valueRow(entityId, name, components[name]))
    }
  }
  return rows
}

// One entity and (when expanded) its components followed by its child entities,
// nested under an indented container. `path` guards against malformed parent
// cycles so rendering can't recurse forever.
function entityNode(
  forest: Forest,
  entityId: string,
  path: Set<string>
): ReactEcs.JSX.Element {
  const components = state.snapshot[entityId] ?? {}
  const childIds = (forest.children.get(entityId) ?? []).filter(
    (c) => !path.has(c)
  )
  const compCount = Object.keys(components).length
  const childCount = childIds.length
  const hasContent = compCount > 0 || childCount > 0
  const expanded = hasContent && state.expandedEntities.has(entityId)

  const childPath = new Set(path)
  childPath.add(entityId)

  const label =
    `${hasContent ? chevron(expanded) : '·'} ${entityLabel(entityId)}` +
    `   ${compCount}c${childCount > 0 ? ` · ${childCount}▼` : ''}`

  return (
    <UiEntity
      key={`entity-${entityId}`}
      uiTransform={{ width: '100%', flexDirection: 'column' }}
    >
      <UiEntity
        uiTransform={{
          elementId: rowElementId(entityId),
          width: '100%',
          height: ROW_H + 2,
          margin: { bottom: 2 },
          padding: { left: 4 }
        }}
        uiBackground={{
          color:
            state.hoveredOverlay === entityId
              ? Color4.create(0.3, 0.4, 0.5, 0.6)
              : ENTITY_BG
        }}
        uiText={{
          value: label,
          fontSize: FS,
          color: TEXT,
          textAlign: 'middle-left'
        }}
        onMouseDown={() => {
          if (hasContent) toggleEntity(entityId)
        }}
      >
        {Number(entityId) >= 512 ? deleteButton(entityId) : []}
      </UiEntity>
      {expanded && (
        <UiEntity
          uiTransform={{
            width: '100%',
            flexDirection: 'column',
            padding: { left: INDENT }
          }}
        >
          {componentNodes(entityId, components)}
          {childIds.map((c) => entityNode(forest, c, childPath))}
        </UiEntity>
      )}
    </UiEntity>
  )
}

// Reachable-from-roots set, computed independently of expansion so that the
// children of a collapsed entity aren't mistaken for orphans.
function reachable(forest: Forest): Set<string> {
  const seen = new Set<string>()
  const stack = [...forest.roots]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    for (const c of forest.children.get(id) ?? []) stack.push(c)
  }
  return seen
}

function treeBody(): ReactEcs.JSX.Element[] {
  const forest = buildForest(state.snapshot)
  const seen = reachable(forest)
  const orphans = Object.keys(state.snapshot)
    .filter((id) => !seen.has(id))
    .sort((a, b) => Number(a) - Number(b))
  return [...forest.roots, ...orphans].map((id) =>
    entityNode(forest, id, new Set())
  )
}

// Overlay actions. Extend this list to add more world-space tools.
const ACTIONS: Array<{ id: string; label: string }> = [
  { id: 'select', label: 'Select' },
  { id: 'translate', label: 'Translate' }
]

// Fullscreen panel showing the gizmo camera's render (composited on top of the
// world). Pointer-transparent for now; the drag handler comes with interaction.
function gizmoPanel(): ReactEcs.JSX.Element | null {
  if (state.activeAction !== 'translate' || state.selectedEntity === null) {
    return null
  }
  const cam = gizmoCameraEntity()
  if (cam === null) return null
  // Capture the pointer only when a handle is hovered or a drag is in progress,
  // so clicks pass through to the world otherwise.
  const capture = state.gizmoHover !== null || state.gizmoDragging
  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: '100%',
        positionType: 'absolute',
        position: { top: 0, left: 0 },
        pointerFilter: capture ? 'block' : 'none'
      }}
      uiBackground={{
        textureMode: 'stretch',
        videoTexture: { videoPlayerEntity: cam }
      }}
      onMouseDown={() => {
        startGizmoDrag()
      }}
      onMouseUp={() => {
        endGizmoDrag()
      }}
    />
  )
}

function actionButton(action: {
  id: string
  label: string
}): ReactEcs.JSX.Element {
  const active = state.activeAction === action.id
  return (
    <UiEntity
      key={`action-${action.id}`}
      uiTransform={{
        width: 86,
        height: 22,
        margin: { right: 6 },
        alignItems: 'center',
        justifyContent: 'center'
      }}
      uiBackground={{ color: active ? BUTTON_BG : REVERT_BG }}
      uiText={{
        value: action.label,
        fontSize: FS - 1,
        color: active ? Color4.create(1, 0.97, 0.7, 1) : TEXT
      }}
      onMouseDown={() => {
        setActiveAction(action.id)
      }}
    />
  )
}

function dialogButton(
  label: string,
  width: number,
  color: Color4,
  onClick: () => void
): ReactEcs.JSX.Element {
  return (
    <UiEntity
      key={`dlg-${label}`}
      uiTransform={{
        width,
        height: 28,
        margin: { right: 8 },
        alignItems: 'center',
        justifyContent: 'center'
      }}
      uiBackground={{ color }}
      uiText={{ value: label, fontSize: FS - 1, color: TEXT }}
      onMouseDown={onClick}
    />
  )
}

// Modal delete-confirm: backdrop (click to cancel) + a centred box showing the
// entity, its direct children, and the available delete modes.
function deleteDialog(): ReactEcs.JSX.Element | null {
  const id = state.deleteConfirm
  if (id === null) return null
  const children = childIdsOf(id)
  const hasChildren = children.length > 0
  const childList =
    children.slice(0, 12).join(', ') + (children.length > 12 ? ', …' : '')

  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: '100%',
        positionType: 'absolute',
        position: { top: 0, left: 0 },
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <UiEntity
        uiTransform={{
          width: '100%',
          height: '100%',
          positionType: 'absolute',
          position: { top: 0, left: 0 }
        }}
        uiBackground={{ color: Color4.create(0, 0, 0, 0.5) }}
        onMouseDown={() => {
          state.deleteConfirm = null
        }}
      />
      <UiEntity
        uiTransform={{ width: 420, flexDirection: 'column', padding: 16 }}
        uiBackground={{ color: HEADER_BG }}
      >
        <UiEntity
          uiTransform={{ width: '100%', height: 26, alignItems: 'center' }}
          uiText={{
            value: `Delete ${entityLabel(id)}?`,
            fontSize: FS + 2,
            color: TEXT,
            textAlign: 'middle-left'
          }}
        />
        <UiEntity
          uiTransform={{
            width: '100%',
            height: hasChildren ? 40 : 4,
            margin: { top: 4, bottom: 8 }
          }}
          uiText={
            hasChildren
              ? {
                  value: `${children.length} direct child${
                    children.length === 1 ? '' : 'ren'
                  }: ${childList}`,
                  fontSize: FS - 2,
                  color: MUTED,
                  textAlign: 'top-left'
                }
              : undefined
          }
        />
        <UiEntity
          uiTransform={{
            width: '100%',
            height: 30,
            flexDirection: 'row',
            alignItems: 'center'
          }}
        >
          {hasChildren
            ? [
                dialogButton('Reparent & delete', 150, BUTTON_BG, () => {
                  deleteEntityReparent(id).catch(console.error)
                }),
                dialogButton('Delete recursive', 130, DANGER, () => {
                  deleteEntityRecursive(id).catch(console.error)
                })
              ]
            : dialogButton('Delete', 90, DANGER, () => {
                deleteEntity(id).catch(console.error)
              })}
          {dialogButton('Cancel', 80, REVERT_BG, () => {
            state.deleteConfirm = null
          })}
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}

export function inspectorUi(): ReactEcs.JSX.Element {
  // Pending jump-to-row target (held briefly by selectEntityInTree, then
  // released so the user can scroll freely).
  const jump = state.jumpTarget ?? undefined

  // Full-screen, pointer-transparent container: the overlay markers sit under
  // the panel (panel is the later sibling, so it draws on top).
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
      {overlayUi() ?? []}
      {gizmoPanel() ?? []}
      <UiEntity
        uiTransform={{
          width: 480,
          height: '92%',
          positionType: 'absolute',
          position: { top: '4%', right: 12 },
          flexDirection: 'column'
        }}
        uiBackground={{ color: PANEL_BG }}
      >
      {/* Header */}
      <UiEntity
        uiTransform={{
          width: '100%',
          height: 92,
          flexDirection: 'column',
          justifyContent: 'center',
          padding: { left: 10, right: 10 }
        }}
        uiBackground={{ color: HEADER_BG }}
      >
        <UiEntity
          uiTransform={{ width: '100%', height: 22, alignItems: 'center' }}
          uiText={{
            value: 'Component Inspector',
            fontSize: FS + 3,
            color: TEXT,
            textAlign: 'middle-left'
          }}
        />
        <UiEntity
          uiTransform={{
            width: '100%',
            height: 22,
            alignItems: 'center',
            justifyContent: 'space-between',
            flexDirection: 'row'
          }}
        >
          <UiEntity
            uiTransform={{ width: 320, height: 20, alignItems: 'center' }}
            uiText={{
              value: statusText(),
              fontSize: FS - 2,
              color: MUTED,
              textAlign: 'middle-left'
            }}
          />
          <UiEntity
            uiTransform={{
              width: 80,
              height: 22,
              alignItems: 'center',
              justifyContent: 'center'
            }}
            uiBackground={{ color: BUTTON_BG }}
            uiText={{ value: 'Refresh', fontSize: FS - 1, color: TEXT }}
            onMouseDown={() => {
              refresh().catch(console.error)
            }}
          />
        </UiEntity>
        {/* Actions bar: overlay actions (left) + transport controls (right) */}
        <UiEntity
          uiTransform={{
            width: '100%',
            height: 24,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            margin: { top: 4 }
          }}
        >
          <UiEntity
            uiTransform={{ flexDirection: 'row', alignItems: 'center' }}
          >
            {ACTIONS.map((action) => actionButton(action))}
          </UiEntity>
          <UiEntity
            uiTransform={{ flexDirection: 'row', alignItems: 'center' }}
          >
            {pbButton('Pause', state.status === 'ready' && !state.frozen, () => {
              pauseScene().catch(console.error)
            })}
            {pbButton('Step', state.status === 'ready' && state.frozen, () => {
              stepScene().catch(console.error)
            })}
            {pbButton('Play', state.status === 'ready' && state.frozen, () => {
              playScene().catch(console.error)
            })}
          </UiEntity>
        </UiEntity>
      </UiEntity>

      {/* Tree body */}
      <UiEntity
        uiTransform={{
          width: '100%',
          height: '100%',
          flexDirection: 'column',
          padding: 6,
          overflow: 'scroll',
          scrollPosition: jump
        }}
      >
        {state.status === 'ready' ? treeBody() : []}
      </UiEntity>

      {/* Delete-button modifier hint (shown while a Del button is hovered) */}
      {state.hoveredDelete !== null ? (
        <UiEntity
          uiTransform={{
            width: '100%',
            height: 22,
            positionType: 'absolute',
            position: { bottom: 0, left: 0 },
            alignItems: 'center',
            padding: { left: 10 }
          }}
          uiBackground={{ color: HEADER_BG }}
          uiText={{
            value: DELETE_HINT,
            fontSize: FS - 3,
            color: MUTED,
            textAlign: 'middle-left'
          }}
        />
      ) : (
        []
      )}
      </UiEntity>

      {deleteDialog() ?? []}
    </UiEntity>
  )
}
