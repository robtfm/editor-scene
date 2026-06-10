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
  ReactEcsRenderer.setUiRenderer(inspectorUi)

  startInspector().catch((e) => {
    console.error('fatal error during inspector init')
    console.error(e)
  })
}
