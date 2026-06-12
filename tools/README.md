# Editor agent channel

Drive the editor scene from an external agent over a WebSocket. The editor scene is the WS
**client** — it dials a server you spawn — so your endpoint is the stable side and the editor
reconnects after a scene reload.

Every action routes through the editor's GUI verbs, so changes are **captured** (undoable,
saveable). There is no raw console access: an agent can only do what the editor allows.

## Quick start

```bash
nvm use 20
node tools/agent-server.mjs        # WS on :8787, HTTP control on :8788
```

Press **Connect** in the editor. Then either type actions on the harness's stdin, `curl` the
HTTP control endpoint, or — for real work — script against the library.

## Scripting (the intended path)

Write code against `editor-client.mjs`. Read state once, compute in your own runtime, write back —
don't round-trip per entity.

```js
import { EditorChannel, worldPos, entitiesWith, nearest } from './editor-client.mjs'

const ch = await EditorChannel.serve()          // resolves when the scene connects
const snap = await ch.getSnapshot()              // { entityId: { ComponentName: value } }
const e = nearest(snap, entitiesWith(snap, 'GltfContainer'), '1')  // nearest gltf to player (1)
const t = snap[e].Transform
t.position.y += 1
await ch.setComponent(e, 'Transform', t)         // captured → undoable
```

## Actions (privileged primitives)

These need the editor's authority; everything else (proximity, filtering, batch logic) you
compose as code.

| action | params | effect |
|---|---|---|
| `getSnapshot` | — | logical scene state (overlays reverted), `{ entityId: { Component: value } }` |
| `setComponent` | `{entity, component, value}` | set/create a component (`value` object or JSON string) |
| `deleteComponent` | `{entity, component}` | remove a component |
| `addComponent` | `{entity, component}` | add a component at its default value |
| `addEntity` | `{name?, parent?}` | create an entity (unparented spawns in front of the player) |
| `deleteEntity` | `{entity, mode?}` | `self` (default) / `recursive` (with children) / `reparent` (keep children) |
| `select` | `{entities: string[]}` | set the editor selection (what the panel + `duplicate` act on) |
| `duplicate` | — | duplicate the current selection (one undo step) |
| `undo` / `redo` | — | step editor history |

Wire protocol: `{ id?, action, params? }` → `{ id, ok: true, result }` or `{ id, ok: false, error }`.

## Conventions

- Entity ids are strings; the player is `1`, the scene root is `0`.
- Protocol components appear by name (`Transform`, `GltfContainer`, …); custom components by id.
- `Transform` is `{ parent, position{x,y,z}, rotation{x,y,z,w}, scale{x,y,z} }` — note `position`,
  not `translation`.
- `worldPos` walks `Transform.parent` to root, summing positions (ignores parent rotation/scale —
  fine for proximity, not exact placement under a rotated parent).
