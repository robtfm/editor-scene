// Agent-side client library for the editor's command channel.
//
// The editor scene is a WebSocket *client* that dials a server WE spawn. So an agent script
// starts a channel, waits for the scene to connect (the user presses "Connect"), then drives the
// editor through its actions. Every action routes through the editor's GUI verbs, so edits are
// captured (undoable, saveable) — there is no raw console access.
//
// This is a *thin* library on purpose: it holds the privileged primitives (actions) and only the
// domain glue an agent can't trivially derive (world position depends on the editor's parent
// convention). Everything composable — "nearest of type X", "all entities within radius",
// batch edits — you write as code against these; don't expect a function for it here.
//
// Usage:
//   import { EditorChannel, worldPos, entitiesWith, nearest } from './editor-client.mjs'
//   const ch = await EditorChannel.serve()       // resolves once the scene connects
//   const snap = await ch.getSnapshot()
//   const gltfs = entitiesWith(snap, 'GltfContainer')
//   const e = nearest(snap, gltfs, '1')           // nearest gltf to the player (entity 1)
//   const t = snap[e].Transform; t.position.y += 1
//   await ch.setComponent(e, 'Transform', t)

import { WebSocketServer } from 'ws'

// --- the channel: primitives ---

export class EditorChannel {
  constructor() {
    this._wss = null
    this._sock = null
    this._id = 1
    this._pending = new Map() // id -> { resolve, reject }
    this._waiters = [] // resolve fns waiting for a connection
  }

  // Start the server. Returns a Promise that resolves to the channel once a scene connects.
  static serve({ port = 8787, host = '127.0.0.1' } = {}) {
    const ch = new EditorChannel()
    ch._wss = new WebSocketServer({ host, port })
    ch._wss.on('connection', (sock) => {
      ch._sock = sock
      sock.on('message', (d) => ch._onMessage(d.toString()))
      sock.on('close', () => {
        if (ch._sock === sock) ch._sock = null
      })
      const waiters = ch._waiters
      ch._waiters = []
      for (const r of waiters) r(ch)
    })
    return ch.ready().then(() => ch)
  }

  // Resolves when a scene is connected (immediately if one already is). Survives reconnects:
  // after a scene reload, the editor redials and the channel picks up the new socket.
  ready() {
    if (this._sock) return Promise.resolve(this)
    return new Promise((res) => this._waiters.push(res))
  }

  _onMessage(text) {
    let m
    try {
      m = JSON.parse(text)
    } catch {
      return
    }
    if (m.hello) return
    const p = this._pending.get(m.id)
    if (p) {
      this._pending.delete(m.id)
      if (m.ok) p.resolve(m.result)
      else p.reject(new Error(m.error || 'action failed'))
    }
  }

  // Send an action and await its reply.
  call(action, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this._sock) return reject(new Error('no scene connected'))
      const id = this._id++
      this._pending.set(id, { resolve, reject })
      this._sock.send(JSON.stringify({ id, action, params }))
      setTimeout(() => {
        if (this._pending.delete(id)) reject(new Error(`timeout: ${action}`))
      }, timeoutMs)
    })
  }

  // Privileged primitives (each needs the editor's authority — authoritative read, captured write).
  getSnapshot() {
    return this.call('getSnapshot')
  }
  setComponent(entity, component, value) {
    return this.call('setComponent', { entity: String(entity), component, value })
  }
  deleteComponent(entity, component) {
    return this.call('deleteComponent', { entity: String(entity), component })
  }
  addComponent(entity, component) {
    return this.call('addComponent', { entity: String(entity), component })
  }
  addEntity(name, parent = 0) {
    return this.call('addEntity', { name, parent })
  }
  deleteEntity(entity, mode) {
    return this.call('deleteEntity', { entity: String(entity), mode })
  }
  select(entities) {
    return this.call('select', { entities: entities.map(String) })
  }
  duplicate() {
    return this.call('duplicate')
  }
  undo() {
    return this.call('undo')
  }
  redo() {
    return this.call('redo')
  }

  close() {
    if (this._wss) this._wss.close()
  }
}

// --- domain glue (tier 2): not derivable without the editor's conventions ---

// World position of an entity, walking the Transform.parent chain to root (parent 0). Additive:
// it sums local positions and ignores parent rotation/scale — good enough for proximity, not for
// exact placement under a rotated parent.
export function worldPos(snap, id, guard = 0) {
  const t = snap[id] && snap[id].Transform
  if (!t || guard > 16) return { x: 0, y: 0, z: 0 }
  const p = t.position
  const par = t.parent
  if (par === undefined || par === 0 || !snap[par]) return { x: p.x, y: p.y, z: p.z }
  const w = worldPos(snap, par, guard + 1)
  return { x: w.x + p.x, y: w.y + p.y, z: w.z + p.z }
}

// Entity ids that have the given component.
export function entitiesWith(snap, component) {
  return Object.keys(snap).filter((e) => snap[e][component] !== undefined)
}

// The id in `candidates` whose world position is closest to entity `fromId`.
export function nearest(snap, candidates, fromId) {
  const o = worldPos(snap, fromId)
  let best = null
  let bestD = Infinity
  for (const e of candidates) {
    const w = worldPos(snap, e)
    const d = (w.x - o.x) ** 2 + (w.y - o.y) ** 2 + (w.z - o.z) ** 2
    if (d < bestD) {
      bestD = d
      best = e
    }
  }
  return best
}
