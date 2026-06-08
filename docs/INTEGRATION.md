# Integration design — composite/CRDT round-trip for the editor

Goal: a **self-contained authoring loop** — import scene content, edit it with the
schema-driven editor, and export it as a runtime artifact any client can load — with an
optional bridge to the Creator Hub.

```
 (Creator Hub / asset-packs .composite)
              │  import
              ▼
   bevy editor (this project)  ──edit (while playing)──▶  scene CRDT
              │  Save  (diff vs initial → filter)
              ▼
   main.composite ──(sdk build)──▶ main.crdt ──load──▶ any client (bevy/unity/web)
        └──(opens directly; lossy for re-editing)──▶ Creator Hub
```

Save writes the **`main.composite`** source (rebuild-safe); the SDK build derives `main.crdt`
from it. This is intentionally **mostly SDK-reuse**: composite build/instancing happens in
**TypeScript** (the editor-scene already runs `@dcl/ecs`); the engine only provides a thin
**bridge** — sidecar capture, raw inject, an initial-state snapshot, and a file write.

---

## Established facts (the basis for the design)

**Editor vs runtime entities.** `addEntity()` allocates ≥512 for *both* the editor and
runtime code (0–511 are reserved renderer slots). So entity-ID range does **not**
distinguish authored from runtime. The authored set is "whatever the Creator Hub's engine
held," enumerated by `inspector::Nodes`.

**`main.crdt` vs `main.composite`.**
- `main.crdt` — a flat binary stream of CRDT `PutComponent` messages (entity, componentId,
  timestamp, bytes). The runtime artifact (the explorer preloads it). **Not** self-describing.
- `main.composite` — the editor source: structured, **self-describing** (embeds `jsonSchema`
  per component, so custom components load via `defineComponentFromSchema`), and
  **composable** (`composite::root` references to sub-composites with entity remapping —
  this is how smart items / reusable bundles are instanced). The Creator Hub edits this.
- The runtime loads `main.crdt` if preloaded, else instances `main.composite` — equivalent
  initial states. `main.crdt` **is the composite instanced and flattened** (the build runs
  `Composite.instance(engine, …)` then `dumpEngineToCrdtCommands(engine)`).
- Therefore `composite → crdt` is lossy-by-design (flatten); `crdt → composite` can only
  produce a *flat* composite and cannot recover the reference/instancing structure.

**Custom components are filtered before the snapshot store.** The scene send op
(`dcl/src/js/engine.rs`) runs `process_message_stream(…, filter_components = true)`, which
drops any component whose ID isn't in `CrdtComponentInterfaces` *before* it reaches the
`CrdtStore` that `GetCrdtSnapshot` clones. So `Name`, asset-packs, `inspector::*` are
invisible to us today. (Adding IDs to `CrdtComponentInterfaces` would push them through the
*real* renderer channel — undesirable; we use a sidecar instead.)
*(File/function names throughout are pointers, not pinned line numbers.)*

**Names are opaque on the wire.** Custom component IDs are `CRC32(name) + 2048` (hash over a
128-byte zero-padded name) — one-way. So names can't be recovered from the stream; only
**precomputed** for a known list.

**The known custom-component set** (all ship in `main.crdt` except `Selection` /
`editor::Toggle`, which `dumpEngineToComposite` excludes):
- `core-schema::*` — `Name` `{value:string}`, `Tags`, `Network-Entity`, `Network-Parent`,
  `Sync-Components`.
- `asset-packs::*` — `Actions`, `Triggers`, `States`, `Counter`, `CounterBar`, `ActionTypes`,
  `VideoScreen`, `VideoControlState`, `TextAnnouncements`, `Rewards`, `AdminTools`, `Script`,
  `Placeholder`. (Smart-item logic; runtime-executed.)
- `inspector::*` — `Nodes` `{value: Node[]}` (`Node = {entity, open?, children[]}`, on the
  root; the editor tree), `Scene`/`SceneMetadata`, `Config`, `TransformConfig`, `Hide`,
  `Lock`, `Ground`, `Tile`, `CustomAsset`, `UIState`, `Selection` (NOT shipped).

`Composite.instance` / `EntityMappingMode` are public `@dcl/ecs` API; `EMM_NEXT_AVAILABLE`
is the "add smart item / fresh entities" mode. `dumpEngineToCrdtCommands` lives in
`@dcl/inspector` (tooling, NOT scene-importable) but is ~15 lines over `@dcl/ecs` primitives
(`componentsIter` + `schema.serialize` + `PutComponentOperation.write`) — **replicate it in
the scene**.

---

## Architecture: two parallel component paths

Keep the engine's existing **JSON API for engine-managed (protocol) components** — unchanged,
and valuable for console/agentic use (a human or agent typing `/set_component <e> <Comp>
<json>` in the browser console); the editor also reads/writes protocol components through it.
Add a **parallel raw-`[u8]` path for non-engine-managed (custom) components**, interpreted in
the scene.

| | engine-managed (protocol) | non-engine-managed (custom) |
| --- | --- | --- |
| `/crdt_snapshot` | decoded **JSON** (registry inspect) — as today | **raw bytes** (sidecar; engine can't decode) |
| write | `/set_component` **JSON** — as today | `/set_component_raw <e> <id> <base64>` (engine force-updates bytes) |
| interpreter | engine (proto inspect/write) | **scene** (SDK definitions + byte conversions) |
| typed-editor schema | structure (SDK) + **scene-side curated overlay** | structure (SDK) + **scene-side curated overlay** |

**The curated data moves to the scene.** The semantic overlay (ranges, refs, content-file
flags, curated defaults — the typed-editor metadata) lives scene-side as data: hot-reloadable,
no engine rebuild. The scene builds the typed-editor schema from SDK-derived structure + this
overlay, for *both* protocol and custom components — so the editor no longer depends on the
engine's `/component_schema`. **Keep all existing engine JSON APIs for now**
(`/crdt_snapshot`, `/set_component`, `/component_names`, `/component_default`,
`/component_schema`, `/delete_component`): they stay for console/agentic use and as a
fallback, with the scene-side path added in parallel. (`/component_schema` + `build_schema`
thus become editor-unused, but aren't removed yet.)

**Scene import map (no `@dcl/inspector` dependency):**
| set | source |
| --- | --- |
| protocol + `core-schema::*` (Name, Tags, …) | `@dcl/ecs` (already in the scene) |
| `asset-packs::*` (the bulk) | import `@dcl/asset-packs` (scene-safe `definitions` entry; no `glob`/`fs`) |
| `inspector::*` (tiny) | **replicate** the ~20-line registry (needs only `@dcl/ecs` `Schemas` + asset-packs `createComponentFramework`) |
| IDs | `componentNumberFromName` (`@dcl/ecs`) |

The bytes the engine holds *are* SDK-serialized (the scene produced them with `@dcl/ecs`;
protocol components serialize to proto bytes), so the scene round-trips them with the matching
schema. Truly-unknown components (a scene's bespoke `defineComponent`) have no schema → shown
raw/opaque.

---

## Pieces to build

### 1. Sidecar capture (engine) — FOUNDATION
Without this, nothing custom is visible, and the **saved composite** would be incomplete.

- The sidecar holds **only the filtered-out (unrecognized) components** — no duplication of
  the recognized ones (avoids bloat). Thread an **optional `filtered: Option<&mut CrdtStore>`**
  through `process_message_stream` / `process_message` (`dcl/src/interface/mod.rs`): in the
  `filter_components` drop branch (where an unknown component currently `return`s), instead
  write the message into `filtered` using the default writer (LWW for Put/Delete, GO for
  Append) — Put / Append / DeleteComponent all routed; DeleteEntity also reaps the sidecar.
- The scene **send op** (`engine.rs`) owns a sidecar `CrdtStore` in op_state and passes it as
  `filtered`; the renderer→scene path passes `None`.
- **Merge the sidecar into `GetCrdtSnapshot`** (alongside the existing `RendererStore` merge).
  The renderer pipeline is untouched — nothing extra is pushed to or applied by the engine;
  only the inspector snapshot gains the (filtered-only) data.
- Result: `/crdt_snapshot` returns recognized components as JSON (as today) **plus** the
  sidecar's custom components as **raw bytes** (keyed by numeric ID), with no bloat.
- Callers to update: `process_message_stream` reborrows `filtered.as_deref_mut()` per message;
  all existing call sites (`engine.rs`, `dcl_wasm`, `dcl_deno_ipc`) pass `None` except the
  scene send op.

### 2. Custom-component interpretation (scene) + raw-write helper (engine)
Engine-managed components keep the JSON API unchanged (see Architecture). For custom
(non-engine-managed) components, a parallel raw path:
- **Engine**: the sidecar already surfaces them as **raw bytes** in `/crdt_snapshot`. Add
  **`/set_component_raw <entity> <componentId> <base64>`** — `force_update` the bytes into the
  pinned scene's store + forward (renderer→scene). No registry / no schema engine-side; it
  just routes bytes. (Same primitive `/inject_crdt` uses; the batched form for import.)
- **Scene**: build an `id → {name, schema}` map from the SDK (import map above; IDs via
  `componentNumberFromName`), **decode** the snapshot's raw bytes → values (via the SDK
  schema's `deserialize`) for the typed editor, and **encode** edits → bytes →
  `/set_component_raw`. Unknown IDs (no schema) → `Component <id>` + raw/hex, read-only.
- Entity tree gains the `Name` label and the authored-vs-runtime heuristic from this path.

### 3. Composite import (editor-scene TS + engine inject)
- Editor-scene: fetch the `.composite` content → `Composite.instance(throwawayEngine,
  composite, provider, { entityMapping: { type: EMM_NEXT_AVAILABLE, getNextAvailableEntity:
  allocFreeId } })`, allocating IDs above the target scene's used set (known from
  `/crdt_snapshot`) → serialize the result. Two ways to push it, both on the raw path (#2):
  - per `(entity, component)` → `/set_component_raw` (reuses the #2 helper), or
  - batch: a replicated `dumpEngineToCrdtCommands` (≈15 lines over `@dcl/ecs`) →
    **`/inject_crdt <base64>`** (force-update + forward the whole stream at once).
- Caveats: composite content must be fetched (scenes can't read fs); imported asset-packs
  logic only *executes* if the scene runs the asset-packs runtime (true for authoring-to-
  deploy; inert if injected into an arbitrary live scene).

### 4. Persistence / save — diff against initial (engine `/crdt_initial` + scene diff)
**Edit while the scene plays** (the whole point — far more productive/enjoyable than the Hub's
frozen-engine model). The catch: the live CRDT = authored-initial **+ your edits + runtime
mutations** (the asset-packs systems and tweens rewrite `Transform`s, increment counters, churn
`*State`/result components every tick). So we never dump live state — we persist a clean
*authored* source by diffing against the initial baseline and attributing changes to the editor.

- **Baseline (engine):** add **`/crdt_initial`** — same shape as `/crdt_snapshot`, but returns
  the **`main.crdt` the scene loaded**. The engine stashes it at load, before any tick, **for
  every scene** (the editor usually attaches *after* the scene has already run, so it can't be
  captured lazily). That's the authored baseline; scene-*startup-code* writes therefore count
  as runtime, not authored.
- **Attribution (scene):** the editor keeps a **session changelog** — per `(entity, component)`
  the editor's last-applied value, plus entities it created / deleted. This is the authoritative
  "this was us" record (more reliable than inferring authorship from the diff).
- **Save (scene):**
  1. `diff(live, initial)` → the full change set (editor + runtime), for display.
  2. Intersect with the changelog → **our changes**; everything else (runtime-mutated, not in
     our log) defaults **off**. `Nodes` reinforces it: entities not in `Nodes` (runtime-spawned)
     default off — so **the editor must add entities it creates to `Nodes`** to persist them.
  3. User filters the suggested set; apply the chosen changes onto the **initial baseline** →
     the new authored source. Deletions apply as removals.
- **Write mechanism:** the **scene** builds the composite (inline-JSON `$case` component data —
  no byte re-encoding — + embedded `jsonSchema` from the SDK defs) and hands the bytes to a thin
  engine **file-write** command that persists them to `assets/scene/main.composite`. (Scenes
  can't write fs; the engine is just the writer.) Result is a **flat composite**, rebuild-safe
  (see lifecycle).
- **Conflict** (editor *and* runtime both touched a component → live ≠ intended): offer a
  per-field three-way choice — **initial / edited / live** — defaulting to *edited*.
- **Deletions tracked separately** — an entity in `initial` but absent from `live` could be an
  editor delete *or* a runtime despawn; only editor deletes persist.
- **Repeated saves: reset the baseline.** After a save, the engine re-stashes `/crdt_initial`
  to the just-saved state and the changelog clears, so the next save diffs against what you
  last persisted.

### Note — Creator Hub fidelity (not a build step)
The saved flat `main.composite` (with embedded `jsonSchema`) **opens in the Creator Hub**, but
flattening drops `composite::root` references / multi-entity asset *instancing* and the
`CustomAsset` instance-of-X linkage (single-entity smart items survive). **Runtime behaviour is
identical** (a flat composite instances to the same state). Faithful Hub re-editing = preserve
references by editing the *existing* `.composite` source rather than regenerating — bigger,
deferred.

### Editor UX (scene)
- Entity **`Name`** as the tree label (from the sidecar).
- Authored-vs-runtime distinction from `Nodes` membership (drives the save-filter default).
- "Add smart item" → composite import (#3). **"Save"** → diff/filter → flat `main.composite` (#4).

---

## Scene scaffold & lifecycle

Unlike the Creator Hub (which wraps scene creation in its GUI), our flow is: **scaffold a
scene, run it, then run the editor `--ui` pointing at it** — the scaffolded scene *is* the
scene being authored.

**Making the scaffold runtime-capable (an "editor scene").** `sdk-commands` decides
`isEditorScene` by a single marker: whether **`assets/scene/main.composite`** exists
(`project-validations.ts`). When it does, the bundler auto-injects
`initAssetPacks(engine, { syncEntity }, players)` into the generated entrypoint (`bundle.ts`,
gated on `isEditorScene`) — so the Smart-Item runtime systems (Actions / Triggers / Timer /
CounterBar / …) ship and execute. So a runtime-capable scaffold is just a normal SDK7 project
plus:
1. an (even empty) **`assets/scene/main.composite`** — the marker, and
2. **`@dcl/asset-packs`** as a dependency (so the injected import resolves; the
   `sdk-commands` validations step can maintain `package.json` for us).

The scene's own `src/index.ts` can be an empty stub — `initAssetPacks` is added *around* it,
so no scene code is required. We own the scaffold (reuse the Hub's empty-scene template, or
emit the ~4 files directly).

**Save targets the composite, so rebuild is safe.** `sdk-commands build` treats
`main.composite` as the **source** (`Composite.instance(main.composite)` →
`dumpEngineToCrdtCommands` → `main.crdt`). Because the editor's **Save** (#4) writes the flat
`main.composite`, a rebuild **reproduces** the edits instead of stamping them — it works with
the normal `start`/watch flow. (Writing `main.crdt` directly would fight the build; we don't.)

---

## PoC build order
1. **Sidecar capture** (#1) — surface custom components as raw bytes. Foundational.
2. **Scene-side decode + `Name` tree label** (#2) — SDK import map + decode raw bytes; prove
   it end-to-end by labelling entities with `Name`.
3. Then the compelling demo — recommend **save first** (self-contained loop):
   - `/crdt_initial` + scene diff → filtered **Save** → flat `main.composite` → re-run/rebuild
     and confirm the edits persisted (and survive rebuild).
   - then **import**: `Composite.instance` → `/set_component_raw` / `/inject_crdt` → add a
     smart item.

## Open questions
- How the editor-scene obtains imported `.composite` bytes (content server / URL / engine).
- File-write permission/sandboxing for the engine's Save command.
- Confirm the exact `getLatestVersionName` suffix scheme (affects the hashed IDs).
- Confirm `inspector::Nodes` actually ships in a real deployed Hub scene (we believe so).
- Validate the byte round-trip (engine-stored bytes == `@dcl/ecs` deserialize/serialize).
- Entity version bits on inject (fresh IDs at version 0).

## Out of scope for now (component editor — accepted PoC state)
Curated-default completeness, data-file overlay + native runtime override, repeated
add/remove widget, `textureUnion`/`borderRect` widgets, content/entity/urn pickers. Revisit
after the integration PoC.
