import { engine } from '@dcl/sdk/ecs'
import { BevyApi } from './bevy-api'
import { state } from './state'

// null until the first sync, so the first tick always sends (even for an empty selection).
let lastSent: string | null = null

// A pending re-tag. When a collider overlay reloads a gltf (mesh-select), its new child meshes lose
// the outline — the engine's highlight diff is root-level, so re-sending the same ids is a no-op. We
// instead clear then re-send a frame later (forcing the diff), after a short settle for the async
// reload. Counts down in frames; -1 = idle, 0 = clear this frame and re-send next.
// [Stopgap — the real fix is engine-side: don't reload a gltf on a collision-mask-only change.]
const REFRESH_SETTLE = 6
let refreshIn = -1
let justCleared = false

// Ask the highlight to re-tag itself (after a reload wiped it). Idempotent — coalesces within a tick.
export function refreshHighlight(): void {
  refreshIn = REFRESH_SETTLE
}

// Forget what was last sent so the next tick re-pushes the highlight — used on scene reload, when
// the engine's outline tags are wiped with the old scene (and the selection may be unchanged).
export function resetHighlightSync(): void {
  lastSent = null
  refreshIn = -1
  justCleared = false
}

// Keep the engine's editor-highlight outline in sync with the current selection: whenever the
// selected set changes, push /highlight with its ids (empty clears it). The engine side is
// render-only — it never writes to the scene's components, so the highlight never enters the
// snapshot or the save and never clobbers a scene-authored PointerEvents.
export function startHighlightSync(): void {
  engine.addSystem(() => {
    // Refresh sequence: settle, then clear this frame and fall through to a re-send next frame.
    if (refreshIn > 0) {
      refreshIn -= 1
    } else if (refreshIn === 0) {
      refreshIn = -1
      justCleared = true
      BevyApi.consoleCommand('highlight', []).catch(console.error)
      return
    }

    const ids = [...state.selected].sort()
    const key = ids.join(',')
    if (key === lastSent && !justCleared) return
    justCleared = false
    lastSent = key
    BevyApi.consoleCommand('highlight', ids).catch(console.error)
  })
}
