import { ReactEcsRenderer } from '@dcl/sdk/react-ecs'
import { inspectorUi } from './ui'
import { startInspector } from './inspector'
import { startCameraProjection } from './camera-projection'
import { setupGizmo } from './gizmo'
import { setupRelations } from './relations'
import { setupCamera } from './free-cam'
import { startSelectBox } from './overlay'
import { startSystemActions } from './system-actions'
import { startHighlightSync } from './highlight'
import { setupMeshSelect } from './mesh-select'
import { setupInteract } from './interact'
import { loadShortcuts } from './shortcuts'
import { startBusySpinner } from './busy'
import { connectAgentBroadcast } from './agent'

export function main(): void {
  const _log = console.log
  console.log = (...args: any[]) => {
    _log('[Component Inspector]', ...args)
  }

  startCameraProjection()
  setupGizmo()
  setupRelations()
  setupCamera()
  startSelectBox()
  startSystemActions()
  startHighlightSync()
  setupMeshSelect()
  setupInteract()
  startBusySpinner()
  loadShortcuts().catch(console.error)
  // Open the in-page agent transport for a same-origin host page driving an embedded editor. No-op
  // (fails safe) where BroadcastChannel isn't available — native deno, or a non-super context.
  connectAgentBroadcast()
  ReactEcsRenderer.setUiRenderer(inspectorUi)

  startInspector().catch((e) => {
    console.error('fatal error during inspector init')
    console.error(e)
  })
}
