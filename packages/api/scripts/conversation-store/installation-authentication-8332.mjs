// [COMP:api/portable-restore] Authenticate the current conversation context cost owners.
import { currentConversationContextCostReleaseSource } from './build-conversation-context-cost.mjs'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'

export const currentInstallationAuthenticationSource = currentConversationContextCostReleaseSource

export async function authenticateConversationInstallation(owner, options) {
  return authenticateCrmSuccessor(owner, await currentConversationContextCostReleaseSource(options))
}
