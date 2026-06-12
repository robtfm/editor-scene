# Editor agent channel

Drive the editor scene from an external agent over a WebSocket. The editor scene is the WS
**client** — it dials a server you spawn — so your endpoint is the stable side and the editor
reconnects after a scene reload.

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

Wire protocol: `{ id?, action, params? }` → `{ id, ok: true, result }` or `{ id, ok: false, error }`.

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
