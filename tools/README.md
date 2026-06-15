# Editor agent channel

Drive the editor scene programmatically through the same wire protocol —
`{ id?, action, params? }` → `{ id, ok, result }` / `{ id, ok, error }` — over either of two
transports:

- **WebSocket** (external agent / CLI) — the editor is the WS **client**; it dials a server you
  spawn, so your endpoint is the stable side and the editor reconnects after a scene reload. This is
  the rest of this doc unless noted.
- **BroadcastChannel** (same-origin host page) — when the engine is embedded in an iframe, a host
  page on the same origin drives the editor in-browser, no server or external process. See
  [Driving from a host page](#driving-from-a-same-origin-host-page).

Every action routes through the editor's GUI verbs, so changes are **captured** (undoable,
saveable). There is no raw console access: an agent can only do what the editor allows.

## Quick start

```bash
node tools/agent-server.mjs        # WS on :8787, HTTP control on :8788
```

Press **Connect** in the editor. Then either type actions on the harness's stdin, `curl` the
HTTP control endpoint, or — for a self-contained task — script against the library directly.

> Only one process can bind `:8787`. Run *either* the harness *or* a `serve()` script (below), not
> both. The scene connects to whichever server is up when you press Connect; if you restart the
> server (or it exits), press **Connect** again.

## Driving across a multi-turn session (recommended for an agent)

Keep the harness running in the **background** so the server is persistent and the scene stays
connected across turns, then drive it with `curl`. (A one-shot `serve()` script, by contrast, owns
the server and drops the connection when it exits — fine for a single task, not a session.)

```bash
node tools/agent-server.mjs &      # leave running; press Connect once

# each command is a POST to the HTTP control endpoint; reply is { ok, result } / { ok, error }
curl -s -X POST http://127.0.0.1:8788 -d '{"action":"getSnapshot"}'
curl -s -X POST http://127.0.0.1:8788 \
  -d '{"action":"setComponent","params":{"entity":"514","component":"Transform","value":{...}}}'
```

For heavy reads (the whole snapshot), save the reply to a file and compute over it with a `node`
script — don't paste it back through context.

## Scripting a one-shot task

Write code against `editor-client.mjs` (this script owns the server, so don't also run the
harness). Read state once, compute in your own runtime, write back — don't round-trip per entity.

```js
import { EditorChannel, worldPos, entitiesWith, nearest } from './editor-client.mjs'

const ch = await EditorChannel.serve()          // resolves when the scene connects
const snap = await ch.getSnapshot()              // { entityId: { ComponentName: value } }
const e = nearest(snap, entitiesWith(snap, 'GltfContainer'), '1')  // nearest gltf to player (1)
const t = snap[e].Transform
t.position.y += 1
await ch.setComponent(e, 'Transform', t)         // captured → undoable
```

## Driving from a same-origin host page

When the explorer is embedded in an `<iframe>` of your own page, the editor can be driven **in the
browser** with no server or external process. The editor (when run as the super-user `--ui` scene)
auto-joins a `BroadcastChannel` named **`dcl-inspector-agent`** on startup; your same-origin page
joins the same channel and posts the same action frames. `BroadcastChannel` spans windows, iframes,
and the scene's worker, so the host page and the scene are direct peers — the iframe boundary is
transparent.

```js
const ch = new BroadcastChannel('dcl-inspector-agent')
let _id = 1; const _pending = new Map()
ch.onmessage = (e) => {
  const m = e.data
  if (m.hello) return                                  // editor announced { hello, scene }
  const r = _pending.get(m.id); if (r) { _pending.delete(m.id); r(m) }
}
const call = (action, params = {}) => new Promise((res, rej) => {
  const id = _id++; _pending.set(id, (m) => (m.ok ? res(m.result) : rej(new Error(m.error))))
  ch.postMessage({ id, action, params })
})

await call('getSceneInfo')                             // { hash, root, projectId, parcels, title }
await call('getSnapshot')
```

Same protocol, same actions, same capture/undo guarantees as the WebSocket path (both share one
dispatch layer) — only the connection differs:

- **No connection handshake.** Both sides just join the named channel whenever they spin up; order
  doesn't matter and there's no reconnect logic. On a scene reload the editor rejoins and re-emits
  `hello`.
- **The initial `hello` isn't replayed.** The editor broadcasts `{ hello, scene }` once on open; a
  page that joins later misses it. Don't wait for it — call **`getSceneInfo`** to get the scene
  identity/folder on demand.
- **Super-user only, fail-safe.** The engine exposes `BroadcastChannel` to the super-user scene
  alone; in a non-super context or native (deno) it's absent, so the editor logs and skips it (the
  WebSocket transport is unaffected). Confirm it's live via the console line
  `[agent] BroadcastChannel transport open: dcl-inspector-agent`.
- **Single driver only.** The channel is a shared bus with no per-driver routing — replies are
  broadcast to everyone and aren't addressed, and each driver runs its own `id` counter. Two
  concurrent in-browser drivers would cross-talk (collide on ids, and see each other's frames). Keep
  one driver on the channel; if you need fan-out, orchestrate it in that single driver (or use the
  WebSocket harness, which arbitrates multiple clients centrally).

## Transactions

Wrap many actions into **one undo step** with a **single settle** (otherwise each mutation settles
and lands as its own history entry). Because each call still round-trips, you can use an entity id
returned by `addEntity` or `importAsset` (both reply with `{ id }`) in a later action within the
same transaction.

Pipeline the work — `await`ing each call in series pays a full frame (~16ms) of round-trip latency
*per command*, but the engine processes many per frame, so firing them concurrently is ~18× faster.
`addEntity` returns its `id` from allocation (not the selection), so concurrent calls are safe.
Compose the bulk operation in your own code — there's no bulk primitive:

```js
await ch.transaction('Spawn 100 cubes', async () => {
  // phase 1: create all, concurrently → ids
  const ids = await Promise.all(
    Array.from({ length: 100 }, () => ch.addEntity('Cube', 0).then((r) => r.id))
  )
  // phase 2: configure all, concurrently (disjoint writes, so no contention)
  await Promise.all(ids.flatMap((id, i) => [
    ch.setComponent(id, 'Transform', {
      position: { x: i % 10, y: 1, z: Math.floor(i / 10) },
      rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 }, parent: 0
    }),
    ch.setComponent(id, 'MeshRenderer', { mesh: { box: { uvs: [] } } })
  ]))
})
// one Undo removes all 100 cubes
```

If the agent disconnects mid-transaction, the channel auto-commits what was done (so it stays
consistent and undoable).

## Actions (privileged primitives)

These need the editor's authority; everything else (proximity, filtering, batch logic) you
compose as code.

| action | params | effect |
|---|---|---|
| `getSnapshot` | — | logical scene state (overlays reverted), `{ entityId: { Component: value } }` |
| `getSelection` | — | `{ selected: string[], active }` — what the user has selected in the editor |
| `getComponentNames` | — | addable component catalog: `{ protocol: string[], custom: string[] }` |
| `getComponentDefault` | `{component}` | a component's default value (shape reference), protocol or custom |
| `setComponent` | `{entity, component, value}` | set/create a component (`value` object or JSON string) |
| `deleteComponent` | `{entity, component}` | remove a component |
| `addComponent` | `{entity, component}` | add a component at its default value |
| `addEntity` | `{name?, parent?}` | create an entity (unparented spawns in front of the player); replies `{ id }` |
| `deleteEntity` | `{entity, mode?}` | `self` (default) / `recursive` (with children) / `reparent` (keep children) |
| `reparent` | `{entity, parent?, force?}` | reparent under `parent` (`0`/omitted = root), preserving world placement; refuses (error) if the parent has non-uniform world scale unless `force:true`, then replies with a `warning` |
| `getCatalog` | — | the engine asset-packs catalog: `[{ id, name, category, tags, pack, thumbnail }]` |
| `importAsset` | `{assetId, parent?, name?}` | instantiate a catalog asset into the scene (engine copies its files in); selects the root, replies `{ id }` |
| `select` | `{entities: string[]}` | set the editor selection (what the panel + `duplicate` act on) |
| `duplicate` | — | duplicate the current selection (one undo step) |
| `undo` / `redo` | — | step editor history |
| `beginTransaction` / `endTransaction` | `{label?}` / — | bracket many actions into one undo step + one settle |
| `reloadContent` | — | re-read the scene's content map from the dev server (picks up files added on disk); replies `{ files, count }` |
| `getSceneInfo` | — | the scene being driven: `{ hash, root, projectId, parcels, title }` (`root` = on-disk project folder, or null if deployed) |

Wire protocol: `{ id?, action, params? }` → `{ id, ok: true, result }` or `{ id, ok: false, error }`.

## Adding your own assets (textures, gltf, audio)

No "upload" action: add a file by writing it into the project folder, then referencing it by its
project-relative path. (`importAsset` is for the curated catalog, not your own files.) The handshake
gives you the folder as `ch.scene.root` — the absolute on-disk path, or `null` for a deployed scene
(no editable folder; check first). **After writing, call `reloadContent` before `setComponent`** —
the engine won't see the new file until it re-scans, so the `src` 404s otherwise.

```js
if (ch.scene?.root) {
  fs.writeFileSync(path.join(ch.scene.root, 'images/brick.png'), bytes)
  await ch.reloadContent()                                   // required: engine re-scans the folder
  await ch.setComponent(e, 'Material', { texture: { tex: { src: 'images/brick.png' } } })
}
```

## Conventions

- Entity ids are strings; the player is `1`, the scene root is `0`.
- Components appear by name — protocol (`Transform`, `GltfContainer`) and custom
  (`core-schema::Name`, `asset-packs::Actions`) alike, with decoded JSON values; `setComponent`
  encodes custom ones back automatically. Only a custom component with no SDK schema stays as a raw
  numeric-id `"ts:base64"` entry. Use `getComponentNames` to discover addable names.
- `Transform` is `{ parent, position{x,y,z}, rotation{x,y,z,w}, scale{x,y,z} }` — note `position`,
  not `translation`.
- `worldPos` walks `Transform.parent` to root, summing positions (ignores parent rotation/scale —
  fine for proximity, not exact placement under a rotated parent).
