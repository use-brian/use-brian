/**
 * Defense pipeline orchestration for a single inbound reply.
 *
 * Called from the threads webhook receiver *after* the 200 ack, so this
 * runs in the background. Each layer short-circuits on drop; every
 * decision point writes a `distribution_events` row for forensic audit.
 *
 *   L1 (cheap classifier)   → drop spam/injection/empty/length pre-LLM
 *   L2 (rate/reputation)    → drop blocked/throttled commenters + reply-storms
 *   L3 (structured classify)→ Gemini Flash with Zod-typed JSON output
 *   L4 (policy engine)      → ignore | hide | draft | escalate
 *
 * L5 (draft) and L6 (safety judge) are stubbed in this phase — anything
 * that reaches "draft" records a `classified` event and stops. 2C-pt2
 * adds the restricted reply-executor, draft generation, safety judge,
 * and the approval-token system.
 *
 * See docs/architecture/feed/defense-pipeline.md.
 */

import type { LLMProvider } from '../providers/types.js'
import { classifyCheap, classifyStructured } from './defense/classifier.js'
import { evaluatePolicy, isAutoReplyEligible, rateReputationGate, type ReplyPolicy, type TrustTier } from './defense/policy.js'
import { generateDraft } from './defense/draft.js'
import { judgeDraft } from './defense/safety.js'
import { mintApprovalToken } from './defense/approval-token.js'

// ── Dependency contracts (implemented by the API layer) ─────────

export type PipelineEventsStore = {
  append(params: {
    assistantId: string
    platform: string
    platformPostId?: string | null
    platformReplyId?: string | null
    entityId?: string | null
    eventType:
      | 'reply-received'
      | 'mention-received'
      | 'classified'
      | 'drafted'
      | 'approved'
      | 'posted-reply'
      | 'hidden'
      | 'escalated'
      | 'blocked'
    layer?: string | null
    decision?: string | null
    metadata?: Record<string, unknown> | null
  }): Promise<void>

  /**
   * Count reply-received events on a given post in the last N hours.
   * Backs the L2 reply-storm check.
   */
  countRepliesOnPostSystem(
    assistantId: string,
    platformPostId: string,
    hours: number,
  ): Promise<number>
}

export type PipelineEntityStore = {
  /** Read-only system-level trust tier lookup for L2. */
  getTrustTierSystem(entityId: string): Promise<TrustTier | null>
}

export type PipelineHider = {
  /** Hide a reply on the platform. System-level — runs without user context. */
  hideReplySystem(params: {
    assistantId: string
    replyId: string
  }): Promise<void>
}

export type PipelineReplyPoster = {
  /**
   * Post a reply via the platform API. System-level — the pipeline has
   * already minted a valid approval token at this point; the implementation
   * verifies the token before calling the underlying client.
   */
  replyToPostSystem(params: {
    assistantId: string
    replyToId: string
    text: string
    approvalToken: string
  }): Promise<{ replyId: string }>
}

// ── Input / output ──────────────────────────────────────────────

export type PipelineInput = {
  assistantId: string
  /** Distribution platform the inbound reply/mention came from. */
  platform: 'threads' | 'twitter'
  /** Post the reply is on (null for mentions that aren't replies). */
  platformPostId: string | null
  /** The reply's platform id. */
  platformReplyId: string
  /** Resolved external_entities row id for the commenter, or null if unknown. */
  entityId: string | null
  /** Commenter handle for context (untrusted). */
  commenterHandle?: string | null
  /** The reply body text. Will be spotlighted before any LLM call. */
  replyText: string
  /** The post body — trusted context for the classifier. */
  postContext: string
  /** Team-editable reply policy from distribution_profiles.reply_policy. */
  policy: ReplyPolicy
}

export type PipelineResult =
  | { outcome: 'dropped'; layer: 'L1' | 'L2'; reason: string }
  | { outcome: 'hidden'; layer: 'L4'; reason: string }
  | { outcome: 'ignored'; layer: 'L4'; reason: string }
  | { outcome: 'escalated'; layer: 'L4' | 'L5' | 'L6'; reason: string }
  | { outcome: 'draft-pending-approval'; layer: 'L7'; draftText: string }
  | { outcome: 'posted'; layer: 'L7'; replyId: string }

export type PipelineDeps = {
  provider: LLMProvider
  /** Model id for the L3 structured classifier. Use a cheap/fast model. */
  classifierModel: string
  /** Model for L5 draft generation. Can match classifierModel for cost. */
  draftModel?: string
  /** Model for L6 safety judge. Ideally a different instance than L5. */
  judgeModel?: string
  eventsStore: PipelineEventsStore
  entityStore: PipelineEntityStore
  /** Optional — when provided, L4 `hide` decisions are executed immediately. */
  hider?: PipelineHider
  /** Optional — when provided, L7 can auto-post whitelisted replies. */
  replyPoster?: PipelineReplyPoster
  /** HMAC secret used to mint approval tokens. Required when replyPoster is set. */
  approvalSecret?: string
  /** Team voice/tone guidance loaded from team-scope memory (trusted). */
  teamVoice?: string
}

const REPLY_STORM_WINDOW_HOURS = 1

// ── Orchestration ───────────────────────────────────────────────

export async function processReply(
  input: PipelineInput,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  // L1 — cheap classifier.
  const l1 = classifyCheap(input.replyText)
  if (l1.action === 'drop') {
    await deps.eventsStore.append({
      assistantId: input.assistantId,
      platform: input.platform,
      platformPostId: input.platformPostId,
      platformReplyId: input.platformReplyId,
      entityId: input.entityId,
      eventType: 'blocked',
      layer: 'L1',
      decision: l1.reason,
    })
    return { outcome: 'dropped', layer: 'L1', reason: l1.reason }
  }

  // L2 — rate/reputation gate.
  const trustTier = input.entityId
    ? await deps.entityStore.getTrustTierSystem(input.entityId)
    : null
  const repliesOnPost = input.platformPostId
    ? await deps.eventsStore.countRepliesOnPostSystem(
        input.assistantId,
        input.platformPostId,
        REPLY_STORM_WINDOW_HOURS,
      )
    : 0
  const l2 = rateReputationGate({ trustTier, repliesOnPostInWindow: repliesOnPost })
  if (l2.action === 'drop') {
    await deps.eventsStore.append({
      assistantId: input.assistantId,
      platform: input.platform,
      platformPostId: input.platformPostId,
      platformReplyId: input.platformReplyId,
      entityId: input.entityId,
      eventType: 'blocked',
      layer: 'L2',
      decision: l2.reason,
      metadata: { trustTier, repliesOnPost },
    })
    return { outcome: 'dropped', layer: 'L2', reason: l2.reason }
  }

  // L3 — structured classification via Gemini Flash.
  const l3 = await classifyStructured({
    provider: deps.provider,
    model: deps.classifierModel,
    postContext: input.postContext,
    replyText: input.replyText,
    commenterHandle: input.commenterHandle ?? undefined,
  })
  await deps.eventsStore.append({
    assistantId: input.assistantId,
    platform: input.platform,
    platformPostId: input.platformPostId,
    platformReplyId: input.platformReplyId,
    entityId: input.entityId,
    eventType: 'classified',
    layer: 'L3',
    decision: l3.classification.category,
    metadata: {
      category: l3.classification.category,
      sentiment: l3.classification.sentiment,
      topic: l3.classification.topic,
      isBindingAsk: l3.classification.is_binding_ask,
      confidence: l3.classification.confidence,
      tokensIn: l3.usage?.inputTokens ?? null,
      tokensOut: l3.usage?.outputTokens ?? null,
    },
  })

  // L4 — policy decision.
  const l4 = evaluatePolicy({
    policy: input.policy,
    classification: l3.classification,
  })

  if (l4.action === 'hide') {
    // Execute hide immediately if the hider dep is wired up; record either way.
    if (deps.hider) {
      try {
        await deps.hider.hideReplySystem({
          assistantId: input.assistantId,
          replyId: input.platformReplyId,
        })
      } catch (err) {
        console.error('[distribution/pipeline] hide failed:', err)
      }
    }
    await deps.eventsStore.append({
      assistantId: input.assistantId,
      platform: input.platform,
      platformPostId: input.platformPostId,
      platformReplyId: input.platformReplyId,
      entityId: input.entityId,
      eventType: 'hidden',
      layer: 'L4',
      decision: l4.reason,
    })
    return { outcome: 'hidden', layer: 'L4', reason: l4.reason }
  }

  if (l4.action === 'ignore') {
    await deps.eventsStore.append({
      assistantId: input.assistantId,
      platform: input.platform,
      platformPostId: input.platformPostId,
      platformReplyId: input.platformReplyId,
      entityId: input.entityId,
      eventType: 'blocked',
      layer: 'L4',
      decision: l4.reason,
    })
    return { outcome: 'ignored', layer: 'L4', reason: l4.reason }
  }

  if (l4.action === 'escalate') {
    await deps.eventsStore.append({
      assistantId: input.assistantId,
      platform: input.platform,
      platformPostId: input.platformPostId,
      platformReplyId: input.platformReplyId,
      entityId: input.entityId,
      eventType: 'escalated',
      layer: 'L4',
      decision: l4.reason,
    })
    return { outcome: 'escalated', layer: 'L4', reason: l4.reason }
  }

  // l4.action === 'draft' — run L5 draft → L6 judge → L7 approval gate.
  const draftModel = deps.draftModel ?? deps.classifierModel
  const judgeModel = deps.judgeModel ?? deps.classifierModel

  const l5 = await generateDraft({
    provider: deps.provider,
    model: draftModel,
    teamVoice: deps.teamVoice ?? '',
    postContext: input.postContext,
    replyText: input.replyText,
    commenterHandle: input.commenterHandle ?? undefined,
    classification: l3.classification,
  })

  if (l5.outcome === 'abstain') {
    await deps.eventsStore.append({
      assistantId: input.assistantId,
      platform: input.platform,
      platformPostId: input.platformPostId,
      platformReplyId: input.platformReplyId,
      entityId: input.entityId,
      eventType: 'escalated',
      layer: 'L5',
      decision: l5.reason,
      metadata: {
        tokensIn: l5.usage?.inputTokens ?? null,
        tokensOut: l5.usage?.outputTokens ?? null,
      },
    })
    return { outcome: 'escalated', layer: 'L5', reason: l5.reason }
  }

  const l6 = await judgeDraft({
    provider: deps.provider,
    model: judgeModel,
    postContext: input.postContext,
    replyText: input.replyText,
    draftText: l5.text,
  })

  await deps.eventsStore.append({
    assistantId: input.assistantId,
    platform: input.platform,
    platformPostId: input.platformPostId,
    platformReplyId: input.platformReplyId,
    entityId: input.entityId,
    eventType: 'drafted',
    layer: 'L5',
    decision: l6.judgement.pass ? 'safety-pass' : 'safety-fail',
    metadata: {
      draftText: l5.text,
      safetyConfidence: l6.judgement.confidence,
      safetyFailures: l6.judgement.failures,
      safetyNote: l6.judgement.note ?? null,
      classificationCategory: l3.classification.category,
      classificationConfidence: l3.classification.confidence,
    },
  })

  if (!l6.judgement.pass) {
    await deps.eventsStore.append({
      assistantId: input.assistantId,
      platform: input.platform,
      platformPostId: input.platformPostId,
      platformReplyId: input.platformReplyId,
      entityId: input.entityId,
      eventType: 'escalated',
      layer: 'L6',
      decision: 'safety-fail',
      metadata: {
        failures: l6.judgement.failures,
        note: l6.judgement.note ?? null,
      },
    })
    return { outcome: 'escalated', layer: 'L6', reason: 'safety-fail' }
  }

  // L7 — auto-post gate.
  const autoEligible = isAutoReplyEligible({
    policy: input.policy,
    classification: l3.classification,
    safetyConfidence: l6.judgement.confidence,
  })

  if (autoEligible && deps.replyPoster && deps.approvalSecret) {
    try {
      const approvalToken = mintApprovalToken({
        assistantId: input.assistantId,
        replyToId: input.platformReplyId,
        text: l5.text,
        source: 'auto',
        ttlMs: 60_000, // short TTL — auto-mint and use immediately
        secret: deps.approvalSecret,
      })
      const posted = await deps.replyPoster.replyToPostSystem({
        assistantId: input.assistantId,
        replyToId: input.platformReplyId,
        text: l5.text,
        approvalToken,
      })
      // replyPoster's implementation logs the 'posted-reply' event on success.
      return { outcome: 'posted', layer: 'L7', replyId: posted.replyId }
    } catch (err) {
      // Auto-post failed — downgrade to awaiting-approval so the team can
      // decide whether to try again manually.
      console.error('[distribution/pipeline] auto-post failed:', err)
      await deps.eventsStore.append({
        assistantId: input.assistantId,
        platform: input.platform,
        platformPostId: input.platformPostId,
        platformReplyId: input.platformReplyId,
        entityId: input.entityId,
        eventType: 'escalated',
        layer: 'L7',
        decision: 'auto-post-failed',
        metadata: {
          error: err instanceof Error ? err.message : String(err),
          draftText: l5.text,
        },
      })
      return { outcome: 'escalated', layer: 'L6', reason: 'auto-post-failed' }
    }
  }

  // Not auto-eligible — queue for human approval. The `drafted` event
  // above with metadata.draftText is the pending-approval row.
  return {
    outcome: 'draft-pending-approval',
    layer: 'L7',
    draftText: l5.text,
  }
}
