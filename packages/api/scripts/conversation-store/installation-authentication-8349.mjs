// [COMP:api/portable-restore] Verify the installed recipient proof before accepting the release.
import { knowledgeSearchClassification, searchCohortRelease, searchRelease } from './installation-authentication-8348.mjs'

export const telegramKnowledgeRelease = searchRelease(
  searchCohortRelease.currentInstallationAuthenticationSource,
  '8349_verified_telegram_knowledge_delivery.sql', '7127d4b9aa590241c0b2f5488e8d737e0cfb12a6325135c5f926f9f8fef49642',
  ['telegram_knowledge_group_bindings', 'capture_verified_telegram_knowledge_evidence',
    'read_native_group_knowledge_search'], '4a8625395e4eb199bcdc078ce6237ec5c9a355ef0126b83fb2f3efcb1e27b34e',
)

export function telegramKnowledgeClassification(classification) {
  const previous = knowledgeSearchClassification(classification)
  return { ...previous, ledgerCount: previous.ledgerCount + 1 }
}
