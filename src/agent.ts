import { state, componentKey, clearSelection, selectionClick } from './state'
import { logicalSnapshot } from './overlays'
import { isWorldScaleNonUniform } from './world-pos'
import { fetchCatalog, importAsset, fetchSceneContent } from './import'
import { fetchSceneTarget } from './scene-path'
import {
  setComponentValue,
  deleteComponent,
  addComponent,
  addEntity,
  deleteEntity,
  deleteEntityRecursive,
  deleteEntityReparent,
  reparentEntity,
  duplicateSelection,
  componentCatalog,
  componentDefault,
  reloadSnapshot,
  beginAgentTxn,
  endAgentTxn,
  isAgentTxnOpen,
  undo,
  redo
} from './inspector'

// Agent command channel. The editor scene is a WebSocket *client* that dials a local server the
// agent spawns — so the agent's endpoint is the stable side and the editor reconnects after a scene
// reload. The agent drives the editor through a small set of *actions* that route through the same
// verbs the GUI uses, so every change is captured (changelog → undo/save) exactly as a click would
// be. Reads return the editor's logical snapshot (overlays reverted), not the raw CRDT.

const DEFAULT_URL = 'ws://127.0.0.1:8787'

// Whether the engine asset catalog has been primed this session (so importAsset's /init_asset has a
// cache). The engine cache outlives reconnects, so once true it stays true.
let catalogLoaded = false

// Inbound message: { id?, action, params? }. `id` (if present) is echoed back so the agent can
// correlate the reply. Reply: { id, ok: true, result } or { id, ok: false, error }.
type Incoming = { id?: number | string; action?: string; params?: any }

export function connectAgent(url: string = DEFAULT_URL): void {
  disconnectAgent()
  const WS = (globalThis as any).WebSocket
  if (typeof WS !== 'function') {
    console.error('[agent] WebSocket not available in this runtime')
    state.agentStatus = 'error'
    return
  }
  state.agentStatus = 'connecting'
  state.agentUrl = url
  let socket: any
  try {
    socket = new WS(url)
  } catch (e) {
    console.error('[agent] failed to open WebSocket', e)
    state.agentStatus = 'error'
    return
  }
  state.agentSocket = socket

  socket.onopen = async () => {
    console.log('[agent] connected', url)
    state.agentStatus = 'connected'
    // Tell the agent which scene it's driving — including the on-disk project folder when it's a
    // local scene (so it can add textures/assets directly, then call reloadContent). null root =
    // deployed/remote scene, not locally editable.
    const scene = await fetchSceneTarget().catch((e) => {
      console.error('[agent] scene target fetch failed', e)
      return null
    })
    // the socket may have closed/changed while we awaited
    if (state.agentSocket !== socket) return
    try {
      socket.send(JSON.stringify({ hello: 'component-inspector', scene }))
    } catch (e) {
      console.error('[agent] hello send failed', e)
    }
  }
  socket.onclose = () => {
    console.log('[agent] closed')
    // Don't strand an open transaction (suppressUndo/deferReload stuck) if the agent drops mid-way:
    // commit what was done so far so it's consistent and undoable.
    if (isAgentTxnOpen()) endAgentTxn().catch((e) => console.error('[agent] txn auto-close failed', e))
    if (state.agentSocket === socket) {
      state.agentSocket = null
      state.agentStatus = 'disconnected'
    }
  }
  socket.onerror = (e: any) => {
    console.error('[agent] socket error', e)
    if (state.agentSocket === socket) state.agentStatus = 'error'
  }
  socket.onmessage = (ev: any) => {
    const data = typeof ev?.data === 'string' ? ev.data : String(ev?.data ?? '')
    handleMessage(socket, data).catch((e) => console.error('[agent] handler error', e))
  }
}

export function disconnectAgent(): void {
  const socket = state.agentSocket
  if (socket) {
    try {
      socket.close()
    } catch (e) {
      console.error('[agent] close failed', e)
    }
  }
  state.agentSocket = null
  state.agentStatus = 'disconnected'
}

async function handleMessage(socket: any, data: string): Promise<void> {
  let msg: Incoming
  try {
    msg = JSON.parse(data)
  } catch {
    reply(socket, undefined, false, `invalid JSON: ${data}`)
    return
  }
  if (!msg || typeof msg.action !== 'string') {
    reply(socket, msg?.id, false, 'message must be { id?, action, params? }')
    return
  }
  console.log('[agent] action', msg.action, msg.params ?? {})
  // Suppress the editor's human-focus side effects (tool switch, tree scroll/expand) for the duration
  // of the dispatch. Ref-counted so a burst of concurrent actions keeps it set until the last settles.
  agentDepth++
  state.agentDriving = true
  try {
    const result = await dispatch(msg.action, msg.params ?? {})
    reply(socket, msg.id, true, result)
  } catch (e) {
    reply(socket, msg.id, false, e instanceof Error ? e.message : String(e))
  } finally {
    if (--agentDepth === 0) state.agentDriving = false
  }
}

// In-flight agent-action count; while > 0, state.agentDriving suppresses human-focus side effects.
let agentDepth = 0

// The editor actions an agent can invoke. Each routes through the GUI's verbs, so the change is
// captured in the changelog (undoable, saveable) — never a raw console write.
async function dispatch(action: string, params: any): Promise<unknown> {
  switch (action) {
    // Read the editor's logical scene state: { entityId: { ComponentName: value } }, overlays
    // reverted. This is the same view the tree and component editor show.
    //
    // Live fetch: pull a fresh CRDT snapshot first so read-only/engine-written components
    // (e.g. GltfContainerLoadingState) reflect current state — the value is at most a tick or
    // two stale. Skip the refetch while frozen or inside a transaction: there the optimistic
    // local snapshot is the source of truth and a refetch would drop pending, un-ticked edits.
    case 'getSnapshot':
      if (!state.frozen && !state.deferReload) await reloadSnapshot()
      return logicalSnapshot(state.snapshot)

    // Read the current editor selection — so an agent can act on what the user clicked.
    case 'getSelection':
      return { selected: [...state.selected], active: state.activeEntity }

    // Discovery: the addable component catalog, { protocol: [...], custom: [...] }. Custom components
    // round-trip by name with decoded JSON through getSnapshot/setComponent like protocol ones.
    case 'getComponentNames':
      return await componentCatalog()

    // Discovery: a component's default value (shape reference), so an agent can author it correctly.
    case 'getComponentDefault': {
      const component = requireStr(params.component, 'component')
      return { component, default: await componentDefault(component) }
    }

    // Set (or create) a component's value. `value` may be an object or a JSON string.
    case 'setComponent': {
      const entity = requireStr(params.entity, 'entity')
      const component = requireStr(params.component, 'component')
      const json =
        typeof params.value === 'string' ? params.value : JSON.stringify(params.value)
      const key = componentKey(entity, component)
      await setComponentValue(key, entity, component, json)
      const status = state.editStatus.get(key) ?? ''
      if (status !== '✓ set') throw new Error(status || 'set failed')
      return { entity, component, status }
    }

    case 'deleteComponent': {
      const entity = requireStr(params.entity, 'entity')
      const component = requireStr(params.component, 'component')
      deleteComponent(entity, component)
      return { entity, component, status: 'deleted' }
    }

    case 'addComponent': {
      const entity = requireStr(params.entity, 'entity')
      const component = requireStr(params.component, 'component')
      await addComponent(entity, component)
      return { entity, component, status: 'added' }
    }

    // Create a new entity (optionally parented). Spawns in front of the player when unparented.
    case 'addEntity': {
      const name = typeof params.name === 'string' ? params.name : 'Entity'
      const parent = typeof params.parent === 'number' ? params.parent : 0
      // addEntity returns the allocated id (not from selection), so concurrent addEntity calls each
      // get their own id correctly.
      const id = await addEntity(name, parent)
      return { id, name, parent, status: 'created' }
    }

    // Delete an entity. mode: 'self' (default, orphans children), 'recursive' (with children),
    // 'reparent' (keep children, lift to this entity's parent).
    case 'deleteEntity': {
      const entity = requireStr(params.entity, 'entity')
      if (params.mode === 'recursive') await deleteEntityRecursive(entity)
      else if (params.mode === 'reparent') await deleteEntityReparent(entity)
      else await deleteEntity(entity)
      return { entity, mode: params.mode ?? 'self', status: 'deleted' }
    }

    // Reparent an entity under `parent` ('0' = root), preserving world placement. One undo step.
    // If the target parent has non-uniform world scale, placement (rotation/scale) can't be kept
    // (shear a TRS Transform can't store) — refuse unless params.force is true, mirroring the GUI's
    // confirm dialog, and report the caveat back when forced.
    case 'reparent': {
      const entity = requireStr(params.entity, 'entity')
      const parent = params.parent === undefined ? '0' : String(params.parent)
      const shear = parent !== '0' && isWorldScaleNonUniform(state.snapshot, parent)
      if (shear && params.force !== true) {
        throw new Error(
          `parent ${parent} has non-uniform world scale: world placement (rotation/scale) cannot ` +
            `be preserved on reparent (shear). Re-call with force: true to reparent anyway.`
        )
      }
      await reparentEntity(entity, parent)
      return {
        entity,
        parent,
        status: 'reparented',
        ...(shear ? { warning: 'world placement not preserved: non-uniform parent scale' } : {})
      }
    }

    // Set the editor selection (also what the component panel and duplicate act on).
    case 'select': {
      const entities = Array.isArray(params.entities) ? params.entities.map(String) : []
      clearSelection()
      for (const id of entities) selectionClick(id, true, false)
      // Selection highlights the rows; we deliberately don't scroll/expand the tree to them (the
      // agentDriving guard suppresses selectEntityInTree anyway) so the agent doesn't move the view.
      return { selected: entities }
    }

    // Duplicate the current selection (select first). One undo step.
    case 'duplicate': {
      await duplicateSelection()
      return { selected: [...state.selected], status: 'duplicated' }
    }

    // Open a transaction: subsequent actions collapse into one undo step with a single settle at
    // endTransaction. Lets an agent spawn/edit many entities efficiently and reversibly.
    case 'beginTransaction': {
      const label = typeof params.label === 'string' ? params.label : 'Agent transaction'
      beginAgentTxn(label)
      return { status: 'transaction open', label }
    }
    case 'endTransaction': {
      await endAgentTxn()
      return { status: 'transaction committed' }
    }

    // Force the engine to re-read the scene's content map from the dev server, picking up files
    // added on disk (textures, gltfs, …) outside the editor — the agent writes a file into the
    // project folder (see the handshake's scene.root), then calls this. Returns the refreshed list.
    case 'reloadContent': {
      const files = await fetchSceneContent()
      return { files, count: files.length }
    }

    // Read the scene being edited: its hash and (for a local scene) its on-disk project folder.
    case 'getSceneInfo':
      return await fetchSceneTarget()

    case 'undo': {
      await undo()
      return { status: 'undone' }
    }
    case 'redo': {
      await redo()
      return { status: 'redone' }
    }

    // The engine-provided asset-packs catalog: [{ id, name, category, tags, pack, thumbnail }].
    // Fetching it also primes the engine cache that importAsset's /init_asset needs.
    case 'getCatalog': {
      const catalog = await fetchCatalog()
      catalogLoaded = true
      return catalog
    }

    // Instantiate a catalog asset into the current scene under `parent` (0 = root; unparented spawns
    // in front of the player), selecting its root. The engine copies the asset's files into the
    // scene content map. One reload-undo step. Pass `name` (from the catalog entry) for a good label.
    case 'importAsset': {
      const assetId = requireStr(params.assetId, 'assetId')
      if (!catalogLoaded) {
        await fetchCatalog()
        catalogLoaded = true
      }
      const parent = typeof params.parent === 'number' ? params.parent : 0
      const name = typeof params.name === 'string' ? params.name : 'Asset'
      await importAsset(assetId, parent, name)
      // importAsset selects the imported asset's root — return its id (named `id` to match
      // addEntity) so the agent can configure/reparent it in follow-up actions.
      return { assetId, parent, id: state.activeEntity, status: 'imported' }
    }

    default:
      throw new Error(`unknown action: ${action}`)
  }
}

function requireStr(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new Error(`${name} must be a string`)
  return v
}

function reply(
  socket: any,
  id: number | string | undefined,
  ok: boolean,
  payload: unknown
): void {
  const body = ok ? { id, ok: true, result: payload } : { id, ok: false, error: String(payload) }
  try {
    socket.send(JSON.stringify(body))
  } catch (e) {
    console.error('[agent] reply send failed', e)
  }
}
