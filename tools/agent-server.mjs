// Minimal local WebSocket server for testing the editor scene's agent channel.
//
//   nvm use 20 && node tools/agent-server.mjs
//
// Then in the editor scene press "Connect". This server:
//   - logs the scene's `hello` and every reply,
//   - sends a probe command on connect (proves the round-trip),
//   - reads stdin lines you type and forwards them as commands.
//
// stdin protocol (one per line):
//   - a JSON envelope, sent as-is:   {"action":"setComponent","params":{"entity":"514","component":"Transform","value":{...}}}
//   - a bare action name (no params): getSnapshot
//
// Actions route through the editor's verbs (captured/undoable). See src/agent.ts for the set.

import { WebSocketServer } from 'ws'
import http from 'node:http'
import readline from 'node:readline'

const PORT = 8787
const HTTP_PORT = 8788
const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT })
let nextId = 1
let current = null // the most recently connected client
const pending = new Map() // id -> resolve fn, for awaiting HTTP-driven replies

console.log(`[server] listening on ws://127.0.0.1:${PORT} — press Connect in the editor`)

function send(ws, obj) {
  const body = { id: nextId++, ...obj }
  ws.send(JSON.stringify(body))
  console.log('[server] ->', JSON.stringify(body))
  return body.id
}

// Send a command and resolve with the matching reply (or time out).
function request(obj, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!current) return reject(new Error('no scene connected'))
    const id = nextId++
    pending.set(id, resolve)
    current.send(JSON.stringify({ id, ...obj }))
    console.log('[server] ->', JSON.stringify({ id, ...obj }))
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error('timeout'))
    }, timeoutMs)
  })
}

// HTTP control: POST / with {cmd,args} -> forwards to the scene, returns the reply JSON.
http
  .createServer((req, res) => {
    let buf = ''
    req.on('data', (c) => (buf += c))
    req.on('end', async () => {
      try {
        const obj = JSON.parse(buf || '{}')
        const reply = await request(obj)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(reply))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    })
  })
  .listen(HTTP_PORT, '127.0.0.1', () =>
    console.log(`[server] HTTP control on http://127.0.0.1:${HTTP_PORT} (POST {cmd,args})`)
  )

wss.on('connection', (ws) => {
  current = ws
  console.log('[server] scene connected')

  ws.on('message', (data) => {
    const text = data.toString()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      console.log('[server] <- (non-JSON)', text)
      return
    }
    if (parsed.hello) {
      console.log('[server] <- hello from', parsed.hello)
      return
    }
    const resolve = parsed.id !== undefined && pending.get(parsed.id)
    if (resolve) {
      pending.delete(parsed.id)
      resolve(parsed)
      const short = JSON.stringify(parsed)
      console.log('[server] <-', short.length > 200 ? short.slice(0, 200) + '…' : short)
      return
    }
    console.log('[server] <-', JSON.stringify(parsed))
  })

  ws.on('close', () => {
    console.log('[server] scene disconnected')
    if (current === ws) current = null
  })
  ws.on('error', (e) => console.log('[server] socket error', e.message))
})

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  if (!current) {
    console.log('[server] no scene connected yet')
    return
  }
  let obj
  if (trimmed.startsWith('{')) {
    try {
      obj = JSON.parse(trimmed)
    } catch (e) {
      console.log('[server] bad JSON:', e.message)
      return
    }
  } else {
    obj = { action: trimmed }
  }
  send(current, obj)
})
