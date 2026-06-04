# Component Inspector (super-user scene)

A minimal super-user SDK7 scene that displays — and (next) modifies — the
component state of the scene the player is currently standing in.

It drives the explorer's inspector console commands through the per-invocation
response channel via a generic `consoleCommand(cmd, args)` wrapper added to
`~system/BevyExplorerApi`.

## What it does

1. **Auto-login** — reuses an existing profile (`loginPrevious`) if one is
   present, otherwise logs in as a guest. Waits for the player to exist.
2. **Resolves the current scene** — finds the live, non-portable, non-system
   scene at the player's parcel via `liveSceneInfo()`, and pins it as the
   inspection target with `/set_scene <hash>`.
3. **Fetches state** — runs `/crdt_snapshot` and renders a collapsible
   entity → component → value tree.

Component display detail and modification build on top of this.

## Running

This is loaded as the explorer's `--ui` (super-user) scene, replacing the
default system UI scene.

```bash
# 1. serve this scene (Node 20)
nvm use 20
npm install
npm run start            # serves http://localhost:8000

# 2. run the explorer pointed at it (needs the `console` feature for the
#    inspector commands, and the consoleCommand wrapper from the
#    feat/console-command-response-channel branch)
cargo run --release --bin decentra-bevy --features="console" -- \
  --ui http://localhost:8000 --ui-preview \
  --scene_log_to_console \
  --server https://realm-provider-ea.decentraland.org/main \
  --location 0,0
```

Walk into a deployed (non-portable) scene and the tree populates; use
**Refresh** to re-pull after moving or after the scene mutates its own state.
