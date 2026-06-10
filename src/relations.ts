import {
  engine,
  Transform,
  MeshRenderer,
  Material,
  VisibilityComponent,
  CameraLayers,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { state, parentOf, buildForest } from './state'
import { computeWorldPositions } from './world-pos'
import { liveWorldPos, GIZMO_LAYER } from './gizmo'

// Parent/child link lines for the current selection, drawn on the shared overlay layer (rendered by
// the gizmo's TextureCamera and composited over the world). No separate camera — see gizmo.ts.
const TO_PARENT = Color4.create(0.2, 0.4, 1, 1) // blue
const TO_CHILD = Color4.create(0.7, 0.95, 0.15, 1) // lime
const BOTH = Color4.create(0.2, 0.85, 0.9, 1) // cyan
const MAX_LINES = 192

let relRoot: Entity | null = null
const lines: Entity[] = []
const lineShown: boolean[] = []

export function setupRelations(): void {
  if (relRoot !== null) return

  const root = engine.addEntity()
  Transform.create(root)
  CameraLayers.create(root, { layers: [GIZMO_LAYER] })
  for (let i = 0; i < MAX_LINES; i++) {
    const e = engine.addEntity()
    Transform.create(e, { parent: root })
    MeshRenderer.setBox(e)
    VisibilityComponent.create(e, { visible: false })
    lines.push(e)
    lineShown.push(false)
  }
  relRoot = root

  engine.addSystem(updateRelations)
}

// The colour + alpha for an edge from parent P to child C. The active endpoint's
// perspective wins (blue toward a parent, green toward a child); otherwise both-
// selected is cyan and a single selected endpoint uses its own direction colour.
function edgeStyle(p: string, c: string): { color: Color4; alpha: number } {
  if (state.activeEntity === c) return { color: TO_PARENT, alpha: 1 }
  if (state.activeEntity === p) return { color: TO_CHILD, alpha: 1 }
  if (state.selected.has(p) && state.selected.has(c)) return { color: BOTH, alpha: 0.5 }
  if (state.selected.has(c)) return { color: TO_PARENT, alpha: 0.5 }
  return { color: TO_CHILD, alpha: 0.5 }
}

function setLine(
  e: Entity,
  a: Vector3,
  b: Vector3,
  cam: Vector3,
  color: Color4,
  alpha: number
): void {
  const dir = Vector3.subtract(b, a)
  const len = Vector3.length(dir)
  const mid = Vector3.scale(Vector3.add(a, b), 0.5)
  const t = Transform.getMutable(e)
  t.position = mid
  t.rotation = Quaternion.fromToRotation(Vector3.Up(), dir)
  // Thickness tracks camera distance so the line keeps a roughly constant
  // on-screen width (reads as an annotation, not a 3D rod).
  const thick = Math.max(0.01, Vector3.distance(mid, cam) * 0.0045)
  t.scale = Vector3.create(thick, len, thick)
  Material.setPbrMaterial(e, {
    albedoColor: { r: color.r, g: color.g, b: color.b, a: alpha },
    emissiveColor: { r: color.r, g: color.g, b: color.b },
    emissiveIntensity: 1.2,
    roughness: 1
  })
}

function showLine(i: number, on: boolean): void {
  if (lineShown[i] === on) return
  lineShown[i] = on
  VisibilityComponent.getMutable(lines[i]).visible = on
}

function updateRelations(): void {
  if (relRoot === null) return

  if (!state.showLinks || state.selected.size === 0) {
    for (let i = 0; i < lines.length; i++) showLine(i, false)
    return
  }

  const camT = Transform.getOrNull(engine.CameraEntity)
  if (camT === null) return

  const world = computeWorldPositions(state.snapshot)
  if (world === null) return

  // During a gizmo drag the snapshot is stale; map endpoints to their live
  // in-drag positions so the lines follow.
  const livePos = (id: string): Vector3 => liveWorldPos(id, world.get(id) as Vector3)

  // Collect the unique parent->child edges incident to any selected entity.
  const forest = buildForest(state.snapshot)
  const seen = new Set<string>()
  const edges: Array<{ p: string; c: string }> = []
  const add = (p: string, c: string): void => {
    if (!world.has(p) || !world.has(c)) return
    const key = `${p}>${c}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ p, c })
  }
  for (const s of state.selected) {
    const par = parentOf(state.snapshot, s)
    // root (0) is every top-level entity's default parent — don't link to it.
    if (par !== null && par !== '0') add(par, s)
    for (const child of forest.children.get(s) ?? []) add(s, child)
  }

  let n = 0
  for (const { p, c } of edges) {
    if (n >= lines.length) break
    const a = livePos(p)
    const b = livePos(c)
    const { color, alpha } = edgeStyle(p, c)
    setLine(lines[n], a, b, camT.position, color, alpha)
    showLine(n, true)
    n++
  }
  for (let i = n; i < lines.length; i++) showLine(i, false)
}
