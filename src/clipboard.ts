import { copyToClipboard } from '~system/RestrictedActions'
import { state, beginTxn, commitTxn } from './state'
import { writeComponent, reloadAfter } from './inspector'

// Copy the given components of `entityId` into the in-app clipboard, and best-effort export the same
// as pretty JSON to the OS clipboard (so it can be pasted into a text editor). The OS write needs a
// recent user gesture + permission — it's fired from a button click, so that's satisfied; failures
// (e.g. denied permission) are ignored, the in-app copy still works.
export function copyComponents(entityId: string, names: string[]): void {
  const comps = state.snapshot[entityId] ?? {}
  const map: Record<string, unknown> = {}
  for (const n of names) if (comps[n] !== undefined) map[n] = comps[n]
  state.clipboard = map
  copyToClipboard({ text: JSON.stringify(map, null, 2) }).catch(() => {})
}

// Write the clipboard's `names` (those present in the clipboard) onto each entity — replacing the
// component where it exists, adding it where it doesn't. One undo step for the whole paste.
export async function pasteComponents(entityIds: string[], names: string[]): Promise<void> {
  const clip = state.clipboard
  const apply = names.filter((n) => n in clip)
  if (apply.length === 0 || entityIds.length === 0) return
  const n = apply.length * entityIds.length
  beginTxn(`Paste ${n} component${n === 1 ? '' : 's'}`)
  for (const id of entityIds) {
    for (const name of apply) {
      await writeComponent(id, name, JSON.stringify(clip[name])).catch((e) =>
        console.error('paste failed:', name, id, e)
      )
    }
  }
  await reloadAfter()
  commitTxn()
}

// Parse pasted JSON (an object of component-name -> value) into the in-app clipboard. Returns false
// on invalid input (left unchanged).
export function importClipboard(text: string): boolean {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return false
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  state.clipboard = v as Record<string, unknown>
  return true
}

export function clearClipboard(): void {
  state.clipboard = {}
}

export function clipboardNames(): string[] {
  return Object.keys(state.clipboard)
}
