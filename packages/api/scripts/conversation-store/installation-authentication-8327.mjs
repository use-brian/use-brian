// [COMP:api/portable-restore] Authenticate the current retained graph owner.
import { currentGraphReleaseSource } from './build-conversation-graph-set.mjs'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'

export const currentInstallationAuthenticationSource = currentGraphReleaseSource

export async function authenticateConversationInstallation(owner, options) {
  return authenticateCrmSuccessor(owner, await currentGraphReleaseSource(options))
}
