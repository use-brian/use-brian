// [COMP:api/portable-restore] Authenticate the active retained frontier.
import { currentFrontierReleaseSource } from './build-conversation-frontier.mjs'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'

export const currentInstallationAuthenticationSource = currentFrontierReleaseSource

export async function authenticateConversationInstallation(owner, options) {
  return authenticateCrmSuccessor(owner, await currentFrontierReleaseSource(options))
}
