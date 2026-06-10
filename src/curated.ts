// Curated semantic overlay — the editor-side equivalent of the engine's build_schema_overlay.rs.
// Carries what proto reflection can't: semantic kinds, ranges, curated (runtime) defaults, units,
// refs, and per-component placement/requires. Applied onto the RAW structural schema the engine
// returns (`/component_schema_raw`) to produce the combined schema the editor renders.
//
// Keyed by component name; fields by camelCase dotted path — oneof cases as `oneof.case.field`,
// repeated elements as `field[]` — matching the engine's apply_overlay path scheme.

import type { ComponentSchema, SchemaNode } from './schema'

type Placement = 'any' | 'root' | 'camera' | 'player' | 'uiEntity' | 'uiRoot'
type Locality = 'same' | 'ancestor' | 'descendant'

// [min|null, max|null, hard] — mirrors the engine's (Option<f64>, Option<f64>, bool).
type Range = [number | null, number | null, boolean]

type FieldOverlay = {
  semantic?: string
  range?: Range
  default?: unknown // already-parsed JSON (the engine stores a JSON fragment string)
  notes?: string
}

type ComponentOverlay = {
  placement: Placement
  requires?: Array<[string, Locality, boolean]> // [component, locality, hard]
  fields?: Record<string, FieldOverlay>
}

const CURATED: Record<string, ComponentOverlay> = {
  Tween: {
    placement: 'any',
    fields: {
      duration: {
        semantic: 'number:ms',
        range: [0, null, true],
        default: 1000,
        notes: 'set to 0 for continuous modes, else the tween terminates after this many ms'
      },
      currentTime: { semantic: 'number:unit01', range: [0, 1, true] },
      playing: { default: true },
      'mode.move.start': { default: '@transform.position' },
      'mode.move.end': { default: '@transform.position' },
      'mode.rotate.start': { default: '@transform.rotation' },
      'mode.rotate.end': { default: '@transform.rotation' },
      'mode.scale.start': { default: '@transform.scale' },
      'mode.scale.end': { default: '@transform.scale' },
      'mode.rotateContinuous.speed': {
        semantic: 'number:degrees',
        default: 90,
        notes: 'degrees per second'
      },
      'mode.moveContinuous.speed': { default: 1 },
      'mode.textureMoveContinuous.speed': { default: 1 }
    }
  },
  Material: {
    placement: 'any',
    requires: [
      ['MeshRenderer', 'same', false],
      ['GltfNode', 'same', false]
    ],
    fields: {
      'material.unlit.alphaTest': { semantic: 'number:unit01', range: [0, 1, true] },
      'material.pbr.alphaTest': { semantic: 'number:unit01', range: [0, 1, true] },
      'material.pbr.metallic': { semantic: 'number:unit01', range: [0, 1, false] },
      'material.pbr.roughness': { semantic: 'number:unit01', range: [0, 1, false] },
      'gltf.gltfSrc': { semantic: 'contentFile:gltf' }
    }
  },
  GltfContainer: {
    placement: 'any',
    fields: {
      src: { semantic: 'contentFile:gltf' },
      visibleMeshesCollisionMask: { semantic: 'bitmask:ColliderLayer' },
      invisibleMeshesCollisionMask: { semantic: 'bitmask:ColliderLayer' }
    }
  },
  MeshRenderer: {
    placement: 'any',
    fields: {
      'mesh.gltf.gltfSrc': { semantic: 'contentFile:gltf' },
      'mesh.box.uvs': { semantic: 'uvArray:48' },
      'mesh.plane.uvs': { semantic: 'uvArray:16' }
    }
  },
  MeshCollider: {
    placement: 'any',
    fields: {
      collisionMask: { semantic: 'bitmask:ColliderLayer' },
      'mesh.gltf.gltfSrc': { semantic: 'contentFile:gltf' }
    }
  },
  NftShape: { placement: 'any', fields: { urn: { semantic: 'urn:nft' } } },
  Animator: {
    placement: 'any',
    requires: [['GltfContainer', 'same', true]],
    fields: { 'states[].clip': { semantic: 'gltfAnimationName' } }
  },
  GltfNode: {
    placement: 'any',
    requires: [['GltfContainer', 'ancestor', true]],
    fields: { path: { semantic: 'gltfNodePath' } }
  },
  GltfNodeModifiers: {
    placement: 'any',
    requires: [['GltfContainer', 'same', true]],
    fields: { 'modifiers[].path': { semantic: 'gltfNodePath' } }
  },
  AssetLoad: { placement: 'any', fields: { 'assets[]': { semantic: 'contentFile:any' } } },
  MainCamera: {
    placement: 'camera',
    requires: [['VirtualCamera', 'same', false]],
    fields: { virtualCameraEntity: { semantic: 'entityRef:VirtualCamera' } }
  },
  VirtualCamera: { placement: 'any', fields: { lookAtEntity: { semantic: 'entityRef:any' } } },
  CameraLayer: { placement: 'any', fields: { layer: { semantic: 'cameraLayerId', range: [1, null, true] } } },
  CameraLayers: { placement: 'any', fields: { 'layers[]': { semantic: 'cameraLayerId' } } },
  TextureCamera: {
    placement: 'any',
    fields: {
      width: { semantic: 'uint:px', range: [16, 2048, true], default: 256 },
      height: { semantic: 'uint:px', range: [16, 2048, true], default: 256 },
      layer: { semantic: 'cameraLayerId' },
      farPlane: {
        semantic: 'number:meters',
        range: [0, null, false],
        default: 240,
        notes: 'runtime default 240m (proto comment says infinity)'
      },
      'mode.perspective.fieldOfView': { semantic: 'number:radians', range: [0, null, false] },
      'mode.orthographic.verticalRange': { semantic: 'number:meters', range: [0, null, false] }
    }
  },
  AudioSource: { placement: 'any', fields: { audioClipUrl: { semantic: 'urlOrContent:audio' } } },
  AudioStream: {
    placement: 'any',
    fields: {
      url: { semantic: 'url' },
      playing: { default: true, notes: 'runtime defaults unset->true' }
    }
  },
  VideoPlayer: { placement: 'any', fields: { src: { semantic: 'urlOrContent:video' } } },
  LightSource: {
    placement: 'any',
    fields: {
      active: { default: true },
      color: { default: { r: 1, g: 1, b: 1 } },
      intensity: {
        semantic: 'number:candela',
        range: [0, null, false],
        default: 16000,
        notes: 'runtime substitutes 16000 when unset (proto comment says 100)'
      },
      range: {
        semantic: 'number:meters',
        default: -1,
        notes:
          'negative (default -1) = auto pow(intensity,0.25); 0 = disabled (no reach); >0 = range (bevy caps at pow(intensity,0.25))'
      },
      'type.spot.innerAngle': { semantic: 'number:degrees', range: [0, 179, true], default: 21.8 },
      'type.spot.outerAngle': { semantic: 'number:degrees', range: [0, 179, true], default: 30 }
    }
  },
  Billboard: {
    placement: 'any',
    fields: {
      billboardMode: {
        semantic: 'bitmask:BillboardMode',
        notes: 'constrained: runtime only distinguishes {None, Y, X|Y, All}'
      }
    }
  },
  SkyboxTime: {
    placement: 'root',
    fields: {
      fixedTime: {
        semantic: 'number:seconds',
        range: [0, 86400, false],
        notes: 'seconds-of-day; time-of-day picker'
      }
    }
  },
  GlobalLight: { placement: 'root' },
  Raycast: {
    placement: 'any',
    fields: {
      maxDistance: { semantic: 'number:meters', range: [0, null, true] },
      collisionMask: { semantic: 'bitmask:ColliderLayer' },
      'direction.targetEntity': { semantic: 'entityRef:any' }
    }
  },
  PointerEvents: {
    placement: 'any',
    fields: {
      'pointerEvents[].eventInfo.maxDistance': { semantic: 'number:meters' },
      'pointerEvents[].eventInfo.maxPlayerDistance': { semantic: 'number:meters' }
    }
  },
  CameraModeArea: {
    placement: 'any',
    fields: {
      'cinematicSettings.cameraEntity': { semantic: 'entityRef:any' },
      'cinematicSettings.yawRange': { semantic: 'number:radians' },
      'cinematicSettings.pitchRange': { semantic: 'number:radians' },
      'cinematicSettings.rollRange': { semantic: 'number:radians' }
    }
  },
  TriggerArea: { placement: 'any', fields: { collisionMask: { semantic: 'bitmask:ColliderLayer' } } },
  AvatarAttach: { placement: 'any', fields: { avatarId: { semantic: 'userRef' } } },
  AvatarShape: {
    placement: 'any',
    fields: {
      id: { semantic: 'userRef' },
      bodyShape: { semantic: 'urn:wearable' },
      'wearables[]': { semantic: 'urn:wearable' },
      'emotes[]': { semantic: 'urn:emote' }
    }
  },
  AvatarModifierArea: { placement: 'any', fields: { 'excludeIds[]': { semantic: 'userRef' } } },
  AvatarMovement: {
    placement: 'any',
    fields: {
      orientation: { semantic: 'number:degrees', range: [0, 360, true] },
      'animation.src': { semantic: 'contentFile:gltf' },
      'animation.sounds[]': { semantic: 'contentFile:audio' }
    }
  },
  AvatarLocomotionSettings: { placement: 'player' },
  InputModifier: { placement: 'player' },
  PointerLock: { placement: 'camera' },
  TextShape: {
    placement: 'any',
    fields: {
      width: { semantic: 'number:meters', range: [0, null, false] },
      height: { semantic: 'number:meters', range: [0, null, false] },
      outlineWidth: { semantic: 'number:unit01', range: [0, 1, false] }
    }
  },
  UiCanvas: {
    placement: 'uiRoot',
    fields: { width: { semantic: 'uint:px' }, height: { semantic: 'uint:px' } }
  },
  UiTransform: {
    placement: 'uiEntity',
    requires: [['UiTransform', 'ancestor', false]],
    fields: {
      parent: { semantic: 'entityRef:UiTransform' },
      rightOf: { semantic: 'entityRef:UiTransform' }
    }
  },
  UiText: { placement: 'uiEntity', requires: [['UiTransform', 'same', true]] },
  UiInput: { placement: 'uiEntity', requires: [['UiTransform', 'same', true]] },
  UiDropdown: { placement: 'uiEntity', requires: [['UiTransform', 'same', true]] },
  UiBackground: {
    placement: 'uiEntity',
    requires: [['UiTransform', 'same', true]],
    fields: { uvs: { semantic: 'uvArray:8' } }
  }
}

// Transform is not a proto message — hand-authored in full (structure + semantics), so the scene
// owns it outright (the raw endpoint omits it). Mirrors the engine's transform_schema().
export const TRANSFORM_SCHEMA: ComponentSchema = {
  name: 'Transform',
  placement: 'any',
  readOnly: false,
  requires: [],
  root: {
    kind: 'message',
    fields: [
      { name: 'position', kind: 'leaf', semantic: 'vector3', optional: false, default: { x: 0, y: 0, z: 0 } },
      { name: 'rotation', kind: 'leaf', semantic: 'quaternion', optional: false, default: { x: 0, y: 0, z: 0, w: 1 } },
      { name: 'scale', kind: 'leaf', semantic: 'vector3', optional: false, default: { x: 1, y: 1, z: 1 } },
      { name: 'parent', kind: 'leaf', semantic: 'entityRef:any', optional: false, default: 0, notes: 'parent entity; 0 = scene root' }
    ]
  },
  enums: {}
}

// --- merge (mirrors the engine's apply_overlay / annotate, by dotted path) ---

type Obj = Record<string, unknown>

function annotate(node: Obj, fo: FieldOverlay): void {
  if (fo.semantic !== undefined) node.semantic = fo.semantic
  if (fo.range !== undefined) {
    const [min, max, hard] = fo.range
    const r: Obj = {}
    if (min !== null) r.min = min
    if (max !== null) r.max = max
    r.hard = hard
    node.range = r
  }
  if (fo.default !== undefined) node.default = fo.default
  if (fo.notes !== undefined) node.notes = fo.notes
}

function join(prefix: string, name: string): string {
  return prefix ? `${prefix}.${name}` : name
}

function applyNode(node: Obj, prefix: string, fields: Record<string, FieldOverlay>): void {
  const kind = node.kind as string
  if (kind === 'message') {
    const arr = node.fields as Obj[] | undefined
    if (arr) for (const child of arr) applyChild(child, prefix, fields)
  } else if (kind === 'oneof') {
    const cases = node.cases as Array<{ name: string; field: Obj }> | undefined
    if (cases) for (const c of cases) applyNode(c.field, join(prefix, c.name), fields)
  }
}

function applyChild(child: Obj, prefix: string, fields: Record<string, FieldOverlay>): void {
  const path = join(prefix, child.name as string)
  const fo = fields[path]
  if (fo) annotate(child, fo)
  const kind = child.kind as string
  if (kind === 'message' || kind === 'oneof') {
    applyNode(child, path, fields)
  } else if (kind === 'repeated') {
    const el = child.element as Obj | undefined
    if (el) {
      const p = `${path}[]`
      const efo = fields[p]
      if (efo) annotate(el, efo)
      applyNode(el, p, fields)
    }
  }
}

// Apply the curated overlay to a RAW component schema, returning the combined schema the editor
// renders (a deep clone — the raw is not mutated). No-op overlay for components without an entry.
export function applyCurated(raw: ComponentSchema): ComponentSchema {
  const schema = JSON.parse(JSON.stringify(raw)) as ComponentSchema
  const cur = CURATED[raw.name]
  if (cur) {
    schema.placement = cur.placement
    schema.requires = (cur.requires ?? []).map(([component, locality, hard]) => ({
      component,
      locality,
      hard
    }))
    if (cur.fields) applyNode(schema.root as unknown as Obj, '', cur.fields)
  }
  return schema
}
