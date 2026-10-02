import { sanitize as sanitizeAnalytics, type AnalyticsLogger } from '@use-brian/core'
import { mergeShadowUser } from '../db/linked-accounts.js'

/**
 * Finish a link-code claim on a chat channel and compose the reply that
 * confirms it.
 *
 * The reply is a claim about state ("your earlier conversations moved with
 * you"), so the shadow merge that makes it true runs BEFORE the reply is
 * composed, never fire-and-forget after it. A merge failure leaves the link
 * itself intact (the next message already resolves link-first), so the reply
 * says exactly that: connected, history not moved. The failure is also an
 * analytics row, not only a console line, so it is reachable from the
 * id-keyed SQL triage path.
 *
 * The reply names the assistant that RECEIVED the code - the one the person
 * is talking to - not the assistant the code was minted against (the
 * minting user's first-owned assistant, often an auto-created personal one,
 * which reads as "linked to another workspace").
 *
 * Spec: docs/plans/channel-identity-binding.md §6 P0;
 * docs/architecture/platform/identity-healing.md.
 */
export type LinkClaimProvider = 'feishu' | 'slack' | 'telegram'

export type LinkClaimOutcome = 'merged' | 'nothing_to_merge' | 'merge_failed'

export async function completeLinkClaim(params: {
  provider: LinkClaimProvider
  realUserId: string
  providerId: string
  evidence: Record<string, unknown>
  receivingAssistant: { id: string; name: string | null } | null
  analytics?: AnalyticsLogger
}): Promise<{ outcome: LinkClaimOutcome; text: string }> {
  let outcome: LinkClaimOutcome
  try {
    const result = await mergeShadowUser(params.realUserId, params.providerId, params.provider, {
      reason: 'link-code',
      evidence: params.evidence,
    })
    outcome = result.merged ? 'merged' : 'nothing_to_merge'
  } catch (err) {
    outcome = 'merge_failed'
    console.error(`[${params.provider}] link-code merge failed:`, err)
    params.analytics?.logEvent({
      userId: params.realUserId,
      assistantId: params.receivingAssistant?.id,
      eventName: 'identity_merge_failed',
      channelType: params.provider,
      metadata: {
        reason: sanitizeAnalytics('link-code'),
        error_code: sanitizeAnalytics(String((err as { code?: string }).code ?? '')),
        error_type: sanitizeAnalytics((err as Error).name ?? 'Error'),
      },
    })
  }
  return { outcome, text: linkClaimReplyText(outcome, params.receivingAssistant?.name ?? null) }
}

export function linkClaimReplyText(outcome: LinkClaimOutcome, assistantName: string | null): string {
  const who = assistantName ? `"${assistantName}"` : 'Brian'
  const base = `Connected. You now talk to ${who} as your Use Brian account`
  switch (outcome) {
    case 'merged':
      return `${base}, and your earlier conversations here moved with you.`
    case 'nothing_to_merge':
      return `${base}.`
    case 'merge_failed':
      return `${base}. Your earlier conversations here could not be moved over; new messages are saved to your account.`
  }
}
