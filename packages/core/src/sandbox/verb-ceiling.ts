/**
 * The verb ceiling (R2-1): terminal actions that are NEVER auto-approvable —
 * grant or no grant, watched or unattended, every one of these queues for an
 * explicit human tap. Hardcoded by design: the ceiling is a floor of human
 * judgment, not a policy knob.
 *
 *   - financial transfers
 *   - account deletion / deactivation
 *   - purchases or payments over a threshold (v1 default: ALL payments —
 *     the threshold knob arrives later, raising it is a product decision)
 *   - password / security-setting changes
 *   - mass-delete
 *
 * Matched against every scrap of context a send carries: the declared
 * description, the target's accessible label, and the block contract's
 * terminal-verb descriptions.
 */

const CEILING_PATTERNS: ReadonlyArray<{ reason: string; pattern: RegExp }> = [
  {
    reason: 'financial_transfer',
    pattern: /\b(wire|transfer(?:ring)? (?:funds|money)|money transfer|send (?:funds|money|payment)|bank transfer|payout|withdraw(?:al)?)\b/i,
  },
  {
    reason: 'account_deletion',
    pattern: /\b(delete|deactivate|close|terminate) (?:my |the |this )?account\b|\baccount (?:deletion|deactivation|closure)\b/i,
  },
  {
    reason: 'payment',
    pattern: /\b(pay|payment|purchase|buy|checkout|place (?:the |this )?order|subscribe|billing)\b/i,
  },
  {
    reason: 'security_settings',
    pattern: /\b(change|reset|update) (?:the |my )?(password|passcode)\b|\bpassword (?:change|reset)\b|\b(two-?factor|2fa|mfa|security question|recovery (?:email|phone)|api key)\b/i,
  },
  {
    reason: 'mass_delete',
    pattern: /\b(delete|remove) all\b|\bmass[- ]delete\b|\bbulk delete\b|\bdelete (?:everything|\d{2,})\b/i,
  },
]

export type VerbCeilingHit = { reason: string }

/**
 * Scan one terminal send's context. A hit means the send can NEVER be
 * satisfied by a grant — it always parks for a human (R2-1).
 */
export function checkVerbCeiling(context: {
  description?: string | null
  label?: string | null
  contractDescriptions?: ReadonlyArray<string | null | undefined>
}): VerbCeilingHit | null {
  const texts = [
    context.description ?? '',
    context.label ?? '',
    ...(context.contractDescriptions ?? []).map((d) => d ?? ''),
  ].filter((t) => t.length > 0)
  for (const text of texts) {
    for (const { reason, pattern } of CEILING_PATTERNS) {
      if (pattern.test(text)) return { reason }
    }
  }
  return null
}
