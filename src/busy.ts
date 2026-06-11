import { engine } from '@dcl/sdk/ecs'
import { state } from './state'

// Spinner frames, advanced while a long op (reload/settle) is in flight. ASCII so it renders in any
// font.
const FRAMES = ['|', '/', '-', '\\']
const FRAME_TIME = 0.1 // seconds per frame
let acc = 0
let idx = 0

export function startBusySpinner(): void {
  engine.addSystem((dt) => {
    if (!state.busy) {
      acc = 0
      return
    }
    acc += dt
    while (acc >= FRAME_TIME) {
      acc -= FRAME_TIME
      idx = (idx + 1) % FRAMES.length
    }
  })
}

// Current spinner glyph (call only when state.busy; the index holds between bursts).
export function spinnerGlyph(): string {
  return FRAMES[idx]
}
