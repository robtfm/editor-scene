import { engine } from '@dcl/sdk/ecs'
import { BevyApi } from './bevy-api'
import { state } from './state'

// null until the first sync, so the first tick always sends (even for an empty selection).
let lastSent: string | null = null

// Keep the engine's editor-highlight outline in sync with the current selection: whenever the
// selected set changes, push /highlight with its ids (empty clears it). The engine side is
// render-only — it never writes to the scene's components, so the highlight never enters the
// snapshot or the save and never clobbers a scene-authored PointerEvents.
export function startHighlightSync(): void {
  engine.addSystem(() => {
    const ids = [...state.selected].sort()
    const key = ids.join(',')
    if (key === lastSent) return
    lastSent = key
    BevyApi.consoleCommand('highlight', ids).catch(console.error)
  })
}
