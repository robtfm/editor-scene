import { BevyApi } from './bevy-api'
import { state, setActiveAction, clearSelection } from './state'
import { cancelSaveDialog } from './inspector'
import { cycleCamMode } from './free-cam'

// Close the topmost open popup, one layer per call (so Escape unwinds nested modals — e.g. the file
// picker over the component window). Returns true if something was closed.
function closeTopModal(): boolean {
  if (state.filePicker !== null) {
    state.filePicker = null
  } else if (state.assetPickerOpen) {
    state.assetPickerOpen = false
  } else if (state.contentViewerOpen) {
    state.contentViewerOpen = false
  } else if (state.newEntityOpen) {
    state.newEntityOpen = false
    state.newEntityName = ''
  } else if (state.parentConfirm) {
    state.parentConfirm = false
  } else if (state.deleteConfirm !== null) {
    state.deleteConfirm = null
  } else if (state.saveDialog !== null) {
    cancelSaveDialog()
  } else if (state.componentWindow !== null) {
    state.componentWindow = null
  } else {
    return false
  }
  return true
}

// System actions are observable only by super-user scenes (a normal scene can't see them) via the
// system action stream. We bind two engine keys to editor behaviour:
//   - Tab (SystemAction::Map) → toggle Select / last tool.
//   - B (SystemAction::Emote) → cycle the camera mode.
//   - Escape (SystemAction::Cancel) → close the topmost popup, or clear the selection if none open.
// NB: we can't swallow these from the scene, so the engine still acts on them too (e.g. Map/Tab may
// also toggle the engine map; M shares the Map binding so it triggers the same toggle).
export function startSystemActions(): void {
  listen().catch((e) => {
    console.error('system action stream ended', e)
  })
}

async function listen(): Promise<void> {
  const stream = await BevyApi.getSystemActionStream()
  for await (const ev of stream) {
    if (!ev.pressed) continue
    if (ev.action === 'Map') {
      setActiveAction('select')
    } else if (ev.action === 'Emote') {
      cycleCamMode()
    } else if (ev.action === 'Cancel') {
      if (!closeTopModal()) clearSelection()
    }
  }
}
