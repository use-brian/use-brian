/**
 * Sensitivity classifier rules — deterministic pre-pass over the
 * existing LLM-driven `classifySensitivity` (kept unchanged).
 *
 * Spec: docs/architecture/brain/classification/sensitivity.md
 */

import { scrubCredentials } from '../../../ingest/credential-scrubber.js'
import type { Sensitivity } from '../../../security/sensitivity.js'

/**
 * Pre-LLM rule: if content matches any credential / secret regex from
 * the credential-scrubber, force `confidential`. No LLM call needed.
 *
 * Returns the forced sensitivity, or null when no rule fires (caller
 * falls back to the existing LLM classifier).
 */
export function applySensitivityRules(content: string): Sensitivity | null {
  if (!content) return null
  const result = scrubCredentials(content)
  if (result.redacted) {
    // Any credential-like pattern → confidential.
    return 'confidential'
  }
  return null
}
