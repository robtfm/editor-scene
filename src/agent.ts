import { BevyApi } from './bevy-api'
import { state } from './state'

// Agent command channel (PoC). The editor scene is a WebSocket *client* that dials a local server
// the agent spawns — so the agent's endpoint is the stable side and the editor reconnects after a
// scene reload. For now this is a dumb relay: each received message is run straight through the
// explorer console and the result is sent back, to prove the transport works end to end. Capture
// through the editor's verbs (the real design) comes later.

const DEFAULT_URL = 'ws://127.0.0.1:8787'

// Inbound message envelope: { id?, cmd, args? }. `cmd` is a console command name without the
// leading slash; `args` are its string arguments. `id` (if present) is echoed back so the agent
// can correlate the reply.
type Incoming = { id?: number | string; cmd?: string; args?: string[] }

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
  if (!msg || typeof msg.cmd !== 'string') {
    reply(socket, msg?.id, false, 'message must be { id?, cmd, args? }')
    return
  }
  console.log('[agent] cmd', msg.cmd, msg.args ?? [])
  try {
    const result = await BevyApi.consoleCommand(msg.cmd, msg.args ?? [])
    reply(socket, msg.id, true, result)
  } catch (e) {
    reply(socket, msg.id, false, e instanceof Error ? e.message : String(e))
  }
}

function reply(
  socket: any,
  id: number | string | undefined,
  ok: boolean,
  payload: string
): void {
  const body = ok ? { id, ok, result: payload } : { id, ok, error: payload }
  try {
    socket.send(JSON.stringify(body))
  } catch (e) {
    console.error('[agent] reply send failed', e)
  }
}
