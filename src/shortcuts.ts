import { BevyApi } from './bevy-api'
import type { InputBindingAction } from './bevy-api/interface'

// Key hints shown on the toolbar buttons. Defaults are the engine's stock bindings; loadShortcuts()
// replaces them with the live bindings from getInputBindings() (so a rebind is reflected). The UI
// re-renders each frame, so the badges pick up the resolved values once the async fetch lands.
export const shortcutLabels: Record<string, string> = {
  select: 'Tab',
  interact: '1',
  translate: '2',
  rotate: '3',
  scale: '4',
  camera: 'B'
}

// Which engine action backs each button (the rest is keyboard binding, sourced below).
const BUTTON_ACTION: Record<string, InputBindingAction> = {
  select: { System: 'Map' },
  interact: { Scene: 'IaAction3' },
  translate: { Scene: 'IaAction4' },
  rotate: { Scene: 'IaAction5' },
  scale: { Scene: 'IaAction6' },
  camera: { System: 'Emote' }
}

function actionEq(a: InputBindingAction, b: InputBindingAction): boolean {
  return a.Scene === b.Scene && a.System === b.System
}

// A bevy KeyCode string as a short label: Digit1/Numpad1 -> 1, KeyB -> B, else as-is (Tab, Space…).
function keyLabel(code: string): string {
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return code.slice(6)
  if (code.startsWith('Key')) return code.slice(3)
  return code
}

// The label to show when an action has several keyboard bindings (Mouse/Gamepad forms contain a
// space and are skipped). Map is bound to both Tab and M — pick the latest alphabetically so Tab
// wins; a deliberate tie-break for that corner case.
function bestKeyLabel(keys: string[]): string | undefined {
  const labels = keys.filter((k) => !k.includes(' ')).map(keyLabel)
  return labels.length === 0 ? undefined : labels.sort()[labels.length - 1]
}

// Fetch the live bindings and update shortcutLabels in place. Best-effort — keeps the defaults on
// failure (e.g. a non-super-user context).
export async function loadShortcuts(): Promise<void> {
  let data: { bindings: Array<[InputBindingAction, string[]]> }
  try {
    data = await BevyApi.getInputBindings()
  } catch (e) {
    console.error('getInputBindings failed; using default shortcut labels', e)
    return
  }
  for (const [button, want] of Object.entries(BUTTON_ACTION)) {
    const entry = data.bindings.find(([action]) => actionEq(action, want))
    const label = entry !== undefined ? bestKeyLabel(entry[1]) : undefined
    if (label !== undefined) shortcutLabels[button] = label
  }
}
