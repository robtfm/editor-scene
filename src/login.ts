import { getPlayer } from '@dcl/sdk/players'
import { BevyApi } from './bevy-api'
import { waitFor } from './utils'

// Logs in automatically: reuses an existing profile if one is present, otherwise
// falls back to a guest session. Resolves once the player entity exists.
export async function autoLogin(): Promise<void> {
  const previous = await BevyApi.getPreviousLogin()

  if (previous?.userId !== null && previous?.userId !== undefined) {
    console.log('found previous login', previous.userId, '- logging in')
    // loginPrevious resolves on success and throws on failure (the host op returns void).
    try {
      await BevyApi.loginPrevious()
    } catch (e) {
      console.error('loginPrevious failed, falling back to guest:', e)
      BevyApi.loginGuest()
    }
  } else {
    console.log('no previous login - logging in as guest')
    BevyApi.loginGuest()
  }

  await waitFor(() => getPlayer() !== null)
  console.log('logged in, player present')
}
