import { ReactEcsRenderer } from '@dcl/sdk/react-ecs'
import { inspectorUi } from './ui'
import { startInspector } from './inspector'
import { startCameraProjection } from './camera-projection'
import { setupGizmo } from './gizmo'
import { startSelectBox } from './overlay'

export function main(): void {
  const _log = console.log
  console.log = (...args: any[]) => {
    _log('[Component Inspector]', ...args)
  }

  startCameraProjection()
  setupGizmo()
  startSelectBox()
  ReactEcsRenderer.setUiRenderer(inspectorUi)

  startInspector().catch((e) => {
    console.error('fatal error during inspector init')
    console.error(e)
  })
}
