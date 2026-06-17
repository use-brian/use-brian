/**
 * Defense-pipeline policy:
 *
 *   L2 (rateReputationGate): cheap, pre-LLM checks against commenter
 *        trust tier + per-post reply-storm thresholds. Runs in a few ms.
 *
 *   L4 (evaluatePolicy): pure-function policy engine that reads the
 *        team-configured `reply_policy` JSONB plus the L3 classification
 *        and decides `ignore` | `hide` | `draft` | `escalate`. No LLM,
 *        no DB.
 *
 * See docs/architecture/feed/defense-pipeline.md.
 */

import type { StructuredClassification } from './classifier.js'

// ── L2 — rate/reputation gate ────────────────────────────────────

export type TrustTier = 'trusted' | 'unknown' | 'throttled' | 'blocked'

export type RateGateDecision =
  | { action: 'pass' }
  | { action: 'drop'; reason: RateGateDropReason }

export type RateGateDropReason =
  | 'commenter-blocked'
  | 'commenter-throttled'
  | 'reply-storm'

export type RateGateInput = {
  /** Commenter's trust tier from external_entities. Null for first-time commenters (treated as 'unknown'). */
  trustTier: TrustTier | null
  /** Count of reply-received events on this post in the reply-storm window. */
  repliesOnPostInWindow: number
}

/** Default thresholds — override via reply_policy later. */
const REPLY_STORM_THRESHOLD = 200 // more than 200 replies in the window → storm
const THROTTLED_DROP_RATE = 1.0    // 'throttled' commenters drop 100% by default; tune later

export function rateReputationGate(input: RateGateInput): RateGateDecision {
  const tier = input.trustTier ?? 'unknown'

  if (tier === 'blocked') return { action: 'drop', reason: 'commenter-blocked' }
  if (tier === 'throttled' && THROTTLED_DROP_RATE >= 1.0) {
    return { action: 'drop', reason: 'commenter-throttled' }
  }
  if (input.repliesOnPostInWindow >= REPLY_STORM_THRESHOLD) {
    return { action: 'drop', reason: 'reply-storm' }
  }
  return { action: 'pass' }
}

// ── L4 — policy engine ───────────────────────────────────────────

export type PolicyDecision =
  | { action: 'ignore'; reason: PolicyReason }
  | { action: 'hide'; reason: PolicyReason }
  | { action: 'draft'; reason: PolicyReason }
  | { action: 'escalate'; reason: PolicyReason }

export type PolicyReason =
  // ignore paths
  | 'out-of-scope'
  | 'low-confidence'
  // hide paths
  | 'spam-category'
  | 'prompt-injection-category'
  | 'topic-in-blocklist'
  | 'auto-hide-rule'
  // draft paths (happy path — still goes to approval unless whitelisted)
  | 'whitelist-match'
  | 'in-scope'
  // escalate paths
  | 'binding-ask'
  | 'low-confidence-binding'
  | 'no-matching-rule'
  | 'off-topic-escalate'

/**
 * Team-editable policy stored as `distribution_profiles.reply_policy`
 * JSONB. Shape is intentionally permissive — we only read keys the
 * engine knows about and ignore the rest.
 */
export type ReplyPolicy = {
  /** Topics to completely ignore. Lowercase match against classification.topic. */
  topic_blocklist?: string[]
  /** Topics to hide (visible to nobody). Stronger than blocklist. */
  topic_hide?: string[]
  /** Categories whose positive-sentiment instances are eligible for auto-reply when confidence is high. */
  auto_reply_categories?: Array<
    'question' | 'compliment' | 'criticism' | 'other'
  >
  /** Only auto-reply when model confidence >= this. Default 0.9. */
  min_auto_reply_confidence?: number
  /** Minimum model confidence required for any draft to be generated. Default 0.4. */
  min_draft_confidence?: number
}

const DEFAULT_MIN_DRAFT_CONFIDENCE = 0.4

export type EvaluatePolicyInput = {
  policy: ReplyPolicy
  classification: StructuredClassification
}

export function evaluatePolicy(input: EvaluatePolicyInput): PolicyDecision {
  const { policy, classification } = input
  const { category, topic, is_binding_ask, confidence } = classification

  // Hide paths — highest priority since they address content the team
  // doesn't want visible regardless of context.
  if (category === 'spam') {
    return { action: 'hide', reason: 'spam-category' }
  }
  if (category === 'prompt-injection') {
    return { action: 'hide', reason: 'prompt-injection-category' }
  }
  if (policy.topic_hide?.some((t) => t.toLowerCase() === topic.toLowerCase())) {
    return { action: 'hide', reason: 'topic-in-blocklist' }
  }

  // Ignore paths — the assistant never touches these, but they're not
  // bad enough to warrant hiding.
  if (policy.topic_blocklist?.some((t) => t.toLowerCase() === topic.toLowerCase())) {
    return { action: 'ignore', reason: 'out-of-scope' }
  }
  if (confidence < (policy.min_draft_confidence ?? DEFAULT_MIN_DRAFT_CONFIDENCE)) {
    return { action: 'ignore', reason: 'low-confidence' }
  }

  // Binding-ask is a hard escalate regardless of category. The assistant
  // must never generate a price / commitment / agreement autonomously.
  if (is_binding_ask) {
    return { action: 'escalate', reason: 'binding-ask' }
  }

  // Off-topic with moderate confidence escalates — the team decides what
  // to do with the one-off weird interactions.
  if (category === 'off-topic') {
    return { action: 'escalate', reason: 'off-topic-escalate' }
  }

  // Draft path — the happy case. Everything that passes generates a draft
  // that goes through approval (handled in L5/L7 later).
  return { action: 'draft', reason: 'in-scope' }
}

/**
 * Post-draft check: is this classification+policy combination eligible
 * for auto-posting (skipping approval)? Called by L7 after L5 draft +
 * L6 safety pass. 2C-pt2 territory — sketched here so the policy shape
 * is stable for both 2C and 2C-pt2.
 */
export function isAutoReplyEligible(input: {
  policy: ReplyPolicy
  classification: StructuredClassification
  /** Safety judge confidence from L6. */
  safetyConfidence: number
}): boolean {
  const { policy, classification, safetyConfidence } = input
  const allowedCategories = policy.auto_reply_categories ?? []
  if (!allowedCategories.includes(classification.category as (typeof allowedCategories)[number])) return false
  if (classification.is_binding_ask) return false
  const minConf = policy.min_auto_reply_confidence ?? 0.9
  if (classification.confidence < minConf) return false
  if (safetyConfidence < minConf) return false
  return true
}
