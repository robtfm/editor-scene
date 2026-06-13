import { BevyApi } from './bevy-api'

// The scene being edited, from the engine's /scene_target. `root` is the absolute on-disk project
// folder for a local `dcl start` scene (else null) — recovered engine-side from the scene's content
// hashes via the key-anchored decode the editor can't do itself (it can't see the content hashes,
// only their keys). The tree title shows it, and the agent gets it in the handshake to add
// textures/assets straight into the project.
export type SceneTarget = {
  hash: string | null
  root: string | null
  projectId: string | null
  parcels: string[]
  title: string | null
}

const EMPTY: SceneTarget = { hash: null, root: null, projectId: null, parcels: [], title: null }

export async function fetchSceneTarget(): Promise<SceneTarget> {
  try {
    const reply = await BevyApi.consoleCommand('scene_target')
    const t = JSON.parse(reply) as Partial<SceneTarget>
    return {
      hash: t.hash ?? null,
      root: t.root ?? null,
      projectId: t.projectId ?? null,
      parcels: Array.isArray(t.parcels) ? t.parcels : [],
      title: t.title ?? null
    }
  } catch (e) {
    console.error('[agent] scene_target failed', e)
    return EMPTY
  }
}
