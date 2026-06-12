// Manual harness for the editor's agent channel, built on editor-client.mjs.
//
//   nvm use 20 && node tools/agent-server.mjs
//
// Then press "Connect" in the editor. This:
//   - logs replies,
//   - exposes an HTTP control endpoint so you can drive it from another process (curl/scripts),
//   - reads stdin lines you type and forwards them as actions.
//
// For real agent use, import EditorChannel from editor-client.mjs and script against it directly
// (see the usage example at the top of that file) — this harness is just for poking by hand.
//
// stdin protocol (one per line):
//   - a JSON envelope:  {"action":"setComponent","params":{"entity":"514","component":"Transform","value":{...}}}
//   - a bare action:    getSnapshot

import http from 'node:http'
import readline from 'node:readline'
import { EditorChannel } from './editor-client.mjs'

const HTTP_PORT = 8788

console.log('[harness] starting WS server on ws://127.0.0.1:8787 — press Connect in the editor')
const ch = await EditorChannel.serve()
console.log('[harness] scene connected')

async function run(obj) {
  const result = await ch.call(obj.action, obj.params ?? {})
  return { ok: true, result }
}

// HTTP control: POST / with {action,params} -> forwards to the scene, returns the reply.
http
  .createServer((req, res) => {
    let buf = ''
    req.on('data', (c) => (buf += c))
    req.on('end', async () => {
      try {
        const out = await run(JSON.parse(buf || '{}'))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(out))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: e.message }))
      }
    })
  })
  .listen(HTTP_PORT, '127.0.0.1', () =>
    console.log(`[harness] HTTP control on http://127.0.0.1:${HTTP_PORT} (POST {action,params})`)
  )

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  const t = line.trim()
  if (!t) return
  const obj = t.startsWith('{') ? JSON.parse(t) : { action: t }
  try {
    console.log('[harness] <-', JSON.stringify(await run(obj)))
  } catch (e) {
    console.log('[harness] error:', e.message)
  }
})
