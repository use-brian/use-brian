// [COMP:api/portable-restore] Authenticate the current Memory lineage owner.
import { memoryWriteReleaseSource } from './memory-query-write-contract.mjs'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'

export const currentInstallationAuthenticationSource = memoryWriteReleaseSource

export async function authenticateConversationInstallation(owner, options) {
  return authenticateCrmSuccessor(owner, await memoryWriteReleaseSource(options))
}
