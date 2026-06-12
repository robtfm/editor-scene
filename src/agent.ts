import { state, componentKey } from './state'
import { logicalSnapshot } from './overlays'
import { setComponentValue, deleteComponent, addComponent, addEntity } from './inspector'

// Agent command channel. The editor scene is a WebSocket *client* that dials a local server the
// agent spawns — so the agent's endpoint is the stable side and the editor reconnects after a scene
// reload. The agent drives the editor through a small set of *actions* that route through the same
// verbs the GUI uses, so every change is captured (changelog → undo/save) exactly as a click would
// be. Reads return the editor's logical snapshot (overlays reverted), not the raw CRDT.

const DEFAULT_URL = 'ws://127.0.0.1:8787'

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

  socket.onopen = () => {
    console.log('[agent] connected', url)
    state.agentStatus = 'connected'
    try {
      socket.send(JSON.stringify({ hello: 'component-inspector' }))
    } catch (e) {
      console.error('[agent] hello send failed', e)
    }
  }
  socket.onclose = () => {
    console.log('[agent] closed')
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
  try {
    const result = await dispatch(msg.action, msg.params ?? {})
    reply(socket, msg.id, true, result)
  } catch (e) {
    reply(socket, msg.id, false, e instanceof Error ? e.message : String(e))
  }
}

// The editor actions an agent can invoke. Each routes through the GUI's verbs, so the change is
// captured in the changelog (undoable, saveable) — never a raw console write.
async function dispatch(action: string, params: any): Promise<unknown> {
  switch (action) {
    // Read the editor's logical scene state: { entityId: { ComponentName: value } }, overlays
    // reverted. This is the same view the tree and component editor show.
    case 'getSnapshot':
      return logicalSnapshot(state.snapshot)

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
      await addEntity(name, parent)
      return { name, parent, status: 'created' }
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
