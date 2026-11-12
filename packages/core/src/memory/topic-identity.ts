import { createHash } from 'node:crypto'

/** Opaque grouping identity, never a human-readable label or an authority receipt. */
export function isTopicIdentity(value: string): boolean {
  return /^topic:v2:[a-f0-9]{64}$/.test(value)
}

/**
 * Canonical attended callers supply a message-specific run ID. Domain-separated,
 * framed hashing makes replay allocation stable without exposing raw selectors.
 * No topic content, model output, credential or permission result is encoded.
 * Existing identities are always reused verbatim, never recomputed or renamed.
 */
export function createTopicIdentity(input: { workspaceId?: string; runId: string }): string {
  return 'topic:v2:' + createHash('sha256')
    .update(JSON.stringify(['use-brian/session-topic/v2', input.workspaceId ?? null, input.runId]))
    .digest('hex')
}
