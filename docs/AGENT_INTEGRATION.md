# Agent integration design — shadow components + tool channel

Goal: collapse the AI-authoring feedback loop. Today an agent's point of contact is the
scene *source* — edit code, reload, re-navigate to the working state, look. We want an
agent to drive the **live editor session** instead: read the scene, mutate it, and see the
result immediately, while every change is captured exactly as a GUI action would be (into the
changelog → undoable, saveable). Any agent-of-choice participates over plain
`/set_component` + `/crdt_snapshot`; no bespoke engine RPC is required for the common path.

```
   agent (any tool)                          editor scene (this project)
        │  read  /crdt_snapshot                        │
        ├───────────────────────────▶  Editor* shadow components  ──┐
        │  write /set_component Editor*                │            │ reconcile
        │                                              ▼            ▼
        │                              changelog (durable truth)   native components
        │  invoke (tool channel)                       │            │  (engine renders)
        └───────────────────────────▶  procedures: new entity,     │
                                        asset import, save, reload  │
                                                       │            ▼
                                                       └─▶ human sees it live, can undo
```

Two surfaces, split along **declarative state vs imperative procedure**:

1. **`Editor*` shadow components** — the entire per-component editing API, exposed as a
   parallel component namespace the agent reads and writes. Covers add / edit / delete of any
   component on any existing entity.
2. **Tool channel** — the procedural remainder that isn't expressible as a component value:
   entity creation (needs the explicit-id allocator), asset import (catalog extraction +
   content-map file writing), and global ops (save / reload / undo / duplicate / reparent).

*(File/function names are pointers, not pinned line numbers.)*

---

## The problem this solves: authored source vs engine projection

The editor edits **materialized CRDT state**. For world entities that state is
authoritative, so a write sticks. But several things that *look* like editable state are
actually **per-frame projections** of an authored source, re-derived every tick by some
system:

- **react-ecs UI** — entities carrying `UiTransform`/`UiBackground`/… are a projection of
  the scene's JS virtual tree. The reconciler reasserts them every frame.
- **Tween animation** — the moving `Transform` is a projection of the authored `Tween`
  (start, end, duration) through the engine's interpolation.
- **Editor overlays** — forced-visibility, paused-tween poses, etc. are projections the
  editor paints onto real components, recording the pre-overlay original for recovery.

Writing to a projection is futile (the system overwrites you) and *observing* one is
ambiguous (you can't tell a projection's churn from an authored edit — both land in the same
component slot). This is the single fact that defeats the naïve approaches:

- **Naïve write — agent `/set_component`s native components directly.** Engine systems and
  the overlay reconciler fight the write; on overlaid components a write equal to the current
  overlay value is *masked entirely* (the slot already holds that value, so nothing changes
  and the edit is undetectable).
- **Naïve capture — editor diffs the live native components.** On a live scene the engine is
  rewriting those slots every tick (tween, reconcilers), so the diff can't distinguish
  authored edits from engine churn. The component value carries no provenance.

Freezing the scene removes the churn and makes diff-capture sound — but it also stops the
scene *playing*, which is exactly the realtime feedback we're trying to keep. We need
capture that works on a **live** scene.

---

## Established facts (the basis for the design)

- **The editor scene is sandboxed.** It can issue console commands *out*
  (`BevyApi.consoleCommand`) and read snapshots (`/crdt_snapshot`), and the
  console-response channel returns per-invocation results. It has **no inbound socket** —
  an external agent can't call it directly. The CRDT is therefore the natural transport: the
  agent writes components the editor polls.
- **The durable authority is the in-memory changelog**
  (`editedComponents`/`editorValues`/`deletedComponents`/`deletedEntities`), not the live
  scene. Anything published into the *target* scene's CRDT dies on `/reload` (the scene is
  respawned from disk; editor chrome is not in `main.crdt`).
- **Overlays already are a real-vs-rendered split, done in-memory.** `originals` records the
  pre-overlay value; `logicalSnapshot` reverts overlays so the tree/editor/save never see
  them. The `overlays.ts` header already anticipates "engine-side overlay support … swapped
  without touching callers."
- **Custom components are LWW on `<ts>:<base64>`.** Two writers to one custom component
  collide on timestamp (the `noteCustomTimestamp` bug). Shadow components inherit this.
- **The engine writes tween-interpolated transforms back into the observable CRDT**
  (confirmed). So native `Transform` genuinely churns frame-to-frame in the snapshot the
  agent and editor read — diff-capture on the native slot is unsound on a live scene, not
  merely theoretically. This is the concrete case the namespace split exists to handle.
- **Engine systems and the scene worker only ever write *native* components.** They have no
  knowledge of an `Editor*` namespace and never write into it. This is the load-bearing fact
  for capture (below).

---

## Core mechanism: provenance by namespace

For each editable native component there is a shadow custom component carrying the
**authored** value: `EditorTransform`, `EditorVisibilityComponent`, `EditorTween`, … Native
`Transform` continues to hold the **rendered/projected** value the engine acts on; the shadow
holds what the user/agent *authored*.

The shadows live in two non-overlapping write domains:

- **`Editor*`** is written only by the **editor** and the **agent**. The engine and scene
  never touch it.
- **native** is written by the **engine/scene** (projections, churn) and the editor's
  reconciler (to render the authored value).

Because nothing but agent+editor writes `Editor*`, **every delta in the `Editor*` namespace
is authored by construction** — there is no churn to subtract and no source ambiguity to
resolve. This is the whole trick: we don't try to *recover* provenance from a value that
doesn't carry it (which is unsolvable on a live scene, and would otherwise demand engine-side
write-source tagging); we *choose a write channel the engine doesn't use*, so provenance is
free. Diff-capture, doomed on the native slots, is sound and precise on the shadow slots —
**on a live, playing scene, with no freeze.**

This simultaneously closes the overlay value-coincidence hole: the authored value lives in
`EditorTransform`, the overlay/rendered value in native `Transform` — separate slots, so a
real-write equal to the overlay value is still a distinct write to a distinct slot and is
always observed.

### The editor becomes a reconciler

`Editor*` is the authored source; native is the projection the editor maintains for the
engine. The relationship is the same shape as react-ecs's (source → rendered tree), run
bidirectionally each tick:

- **editor → `Editor*`** (publish): when the changelog changes by other means (a GUI edit,
  undo, post-reload re-emit), serialize the authored value into the shadow so the agent reads
  a consistent view.
- **`Editor*` → editor** (capture): a shadow value that changed *without the editor having
  written it* is an agent edit — fold it into the changelog via the existing verbs
  (`setComponentValue`/`deleteComponent`), then reconcile native so the engine renders it.

The existing `suppressUndo`/suppress idiom is exactly the loop-breaker that stops the editor
re-capturing its own publish — no new machinery.

### Presence encodes component CRUD

The shadow namespace expresses the full per-component lifecycle on existing entities:

- shadow **absent** → no authored override.
- shadow **present with value** → add/edit the component to that value.
- shadow **tombstone** (explicit absent marker) → delete the native component.

So add / edit / delete of any component is agent-addressable through `Editor*` alone. Only
*entity* lifecycle and non-CRDT side effects need the tool channel.

---

## Read model

The agent reads the **authored** state, never the projection. It parses the tree and merges
each entity's `Editor*` shadows over the native components (shadow wins where present) to
reconstruct the editor's logical view — the same view the tree and component editor show.
Critically, for a tweened entity it reads `EditorTween` + the authored base `Transform`, not
the interpolated `Transform` of the current frame (which exists for ~16 ms and would make the
agent edit relative to a transient pose).

Read-only / engine-driven components (e.g. `GltfContainerLoadingState`) get **no** shadow —
the agent can read them natively but cannot author them. This matches the editor's existing
`readOnly` gating.

---

## Schema reuse (ergonomics)

Each `Editor<Name>` shadow shares the **exact schema** of its native component. The agent
already "knows" `Transform`'s shape, and the build-time `/component_schema` output applies
1:1 to `EditorTransform`. Shadows are therefore **per-type** registered custom components,
not a single generic `EditorShadow` blob keyed by component name — the schema transfer (agent
ergonomics, validation, editor reuse) is the whole point, and the custom-component count is a
non-issue. The schema generation emits the shadow set automatically from the native set.

---

## The tool channel

Not everything is a component value. The tool channel handles **procedures** — verbs with
side effects beyond a single CRDT slot, or that need editor-internal sequencing:

- **entity creation** — allocate an id (the explicit-id allocator, engine PR #833), write its
  initial components, select it.
- **asset import** — `/asset_catalog` + `/init_asset`: catalog extraction and content-map
  file injection, then instancing via the `/new_entity` allocator.
- **global ops** — save (diff vs baseline → `main.crdt`), reload (+ lossless reapply), undo /
  redo, duplicate, reparent-with-allocation.

Transport rides the existing CRDT + console-response channel: a request component (or a
console command) carries the verb and args; the editor executes and returns a structured
result. This is where the agent's tools map to the editor's imperative command layer rather
than to component state.

---

## Durability and save

- **Changelog = durable truth.** `Editor*` is a live CRDT *projection* of it, re-emitted
  after every reload so the agent re-reads a consistent view across the respawn.
- **`Editor*` is chrome.** Like overlays and the reserved tree entity, it is stripped from
  the save and hidden from the tree. The save reads the authored values (which equal the
  shadows) and persists them as **native** components into `main.crdt` — shadows never reach
  the artifact.

---

## Sharp edges

- **Two writers, one LWW slot.** Both agent and editor write `EditorTransform`, and custom
  components are LWW on `<ts>:<base64>` — structurally the `noteCustomTimestamp` collision,
  now permanent. Needs a discipline: the agent writes monotonically; the editor bumps its own
  shadow writes past the last value it read. Without this, an edit-then-apply rejects as "not
  newer."
- **Optimistic native writes fight engine-driven components.** An agent may write *native*
  `Transform` directly for instant visual feedback, but a `Tween` overwrites it next tick. So
  treat the native write as a transient preview only; `EditorTransform` is the authoritative
  path and the editor's reconcile is what makes native consistent (coordinating with the
  tween the way the overlay reconciler already must). For non-engine-driven components the
  optimistic write is fine and immediate.
- **Live capture needs a quiescence rule per tick.** The editor must classify each shadow as
  "I published this" vs "the agent changed this." The suppress flag handles the former; the
  ordering (publish before capture, or tag published values) must be explicit to avoid a
  publish being re-captured as an edit.

---

## What this needs to build

**Editor-only (no engine change) — the whole common path:**
- Register the `Editor*` shadow custom-component set (schema-mirrored from native).
- Make the per-tick reconciler bidirectional: publish authored→shadow, capture
  shadow→changelog under suppress, reconcile changelog→native.
- Back the read model on shadow-merge; strip shadows from save; re-emit after reload.
- Tool channel: a request/result component pair (or console verbs) over the
  console-response channel, mapping to the existing imperative editor verbs.

**Optional engine follow-up — retire the overlay machinery:**
The `Editor*` split makes the authored value a first-class slot. The natural endgame is to
move **overlays** to their own engine-composited slot too (`OverlayValue<C>`, engine prefers
it at render/pick), leaving native pristine. Then `logicalSnapshot` collapses to identity and
the `originals`/recover-original/retarget machinery largely evaporates. This is the
"engine-side overlay support" `overlays.ts` already flags — now justified by the agent
requirement, but not a prerequisite for the shadow-component path above.

---

## Relationship to existing work

- **Explicit-id allocation (PR #833)** makes agent-created entities first-class on capture —
  recreatable at their ids on reload, undoable, saveable.
- **Lossless reapply (Reload → Reapply)** is what re-emits `Editor*` consistently after a
  reload.
- **Console-response channel** is the tool-channel transport for structured results.
- **The overlay system** is the in-memory precursor of the shadow split; the design
  generalizes it from a private `Map` into an in-band, agent-addressable namespace.
