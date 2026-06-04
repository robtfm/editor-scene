import { ReactEcsRenderer } from '@dcl/sdk/react-ecs'
import { inspectorUi } from './ui'
import { startInspector } from './inspector'
import { startCameraProjection } from './camera-projection'

export function main(): void {
  const _log = console.log
  console.log = (...args: any[]) => {
    _log('[Component Inspector]', ...args)
  }

  startCameraProjection()
  ReactEcsRenderer.setUiRenderer(inspectorUi)

  startInspector().catch((e) => {
    console.error('fatal error during inspector init')
    console.error(e)
  })
}
