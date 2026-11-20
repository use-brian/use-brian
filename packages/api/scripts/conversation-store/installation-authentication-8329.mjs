// [COMP:api/portable-restore] Authenticate the current Memory query candidate owner.
import { currentMemoryCandidatesReleaseSource } from './build-conversation-memory-query-candidates.mjs'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'

export const currentInstallationAuthenticationSource = currentMemoryCandidatesReleaseSource

export async function authenticateConversationInstallation(owner, options) {
  return authenticateCrmSuccessor(owner, await currentMemoryCandidatesReleaseSource(options))
}
