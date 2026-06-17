/**
 * Async sensitivity classifier — final step of Pipeline B (Q3 resolution
 * 2026-05-14).
 *
 * A Flash-class classifier that reads an Episode's extraction-time summary
 * and freshly written memories, infers a sensitivity tier, and if the
 * inferred tier exceeds the Episode's current `sensitivity` (channel-rule
 * value, possibly already overridden via D.6), writes an
 * `analytics_events` row with `event_name='sensitivity_drift_flagged'`
 * for the admin misclassification queue.
 *
 * Two locked properties:
 *   - Flag-not-bump: never auto-changes Episode sensitivity. Operator
 *     decides via D.6 reclassification.
 *   - Non-blocking: any provider error / JSON parse failure / schema
 *     violation logs to console and returns null. Pipeline B continues.
 *
 * Spec: docs/plans/company-brain/ingest.md "Async sensitivity classifier"
 *       docs/plans/company-brain/permissions.md §"Async sensitivity classifier"
 *
 * Pattern reference: ../memory/topic-classifier.ts (same shape: Flash
 * model, JSON-only output, fallback-on-failure).
 *
 * [COMP:brain/sensitivity-classifier]
 */

import type { AnalyticsLogger } from '../analytics/logger.js'
import { sanitize } from '../analytics/logger.js'
import { collectStream } from '../providers/accumulator.js'
import type { LLMProvider, TokenUsage } from '../providers/types.js'
import type { Sensitivity } from '../security/sensitivity.js'
import { RANK, isSensitivity } from '../security/sensitivity.js'

// ── Public types ─────────────────────────────────────────────────────

export type ExtractedMemoryDigest = {
  /** Memory summary text. The classifier truncates internally. */
  summary: string
}

export type SensitivityClassifierInput = {
  episodeId: string
  workspaceId: string
  /** Episode.created_by_user_id — attribution for the analytics row. */
  userId: string
  /** Episode.created_by_assistant_id, when present. */
  assistantId?: string | null
  /**
   * Episode.sensitivity at the time Pipeline B ran (channel-rule baseline
   * + any prior operator D.6 override).
   */
  channelSensitivity: Sensitivity
  /** Episode.summary_text written by the extraction LLM. */
  summary: string
  /** Memory summaries Pipeline B just wrote. */
  memories: ExtractedMemoryDigest[]
}

export type SensitivityClassification = {
  inferredSensitivity: Sensitivity
  /** Short abstract reason — truncated to ≤200 chars before logging. */
  briefReason: string
  /** True iff `inferred > channel` (RANK comparison). */
  drifted: boolean
  /** Provider usage when the call reached the model; null on failure. */
  usage: TokenUsage | null
  /** Model name passed in; present iff the call reached the model. */
  model?: string
}

export type SensitivityClassifierOptions = {
  provider: LLMProvider
  /** Flash-class model id (e.g. 'gemini-flash'). */
  model: string
  /**
   * Optional analytics logger. When present and drift is detected, the
   * classifier emits `sensitivity_drift_flagged`. Absent in tests / one-off
   * callers that only want the inferred tier back.
   */
  analytics?: AnalyticsLogger
  input: SensitivityClassifierInput
}

// ── Prompt construction ──────────────────────────────────────────────

const SYSTEM_PROMPT =
  'You are a sensitivity classifier for a knowledge-management system. ' +
  'Respond with ONE JSON object and nothing else. No markdown fences, no commentary.'

/** Episode summary cap. Anything longer is rare; the tail rarely changes the verdict. */
const SUMMARY_CHAR_LIMIT = 2000
/** Per-memory cap; classifier reads gist, not detail. */
const MEMORY_CHAR_LIMIT = 200
const MAX_MEMORIES = 10
/** Brief-reason cap going into analytics metadata. */
const REASON_CHAR_LIMIT = 200

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + '…'
}

function buildPrompt(input: SensitivityClassifierInput): string {
  const memoriesBlock = input.memories.length > 0
    ? input.memories
        .slice(0, MAX_MEMORIES)
        .map((m, i) => `  ${i + 1}. ${truncate(m.summary, MEMORY_CHAR_LIMIT)}`)
        .join('\n')
    : '  (none)'

  return `Classify the sensitivity tier of an Episode based on its summary and the memories extracted from it.

The channel that delivered this Episode was rule-classified as: "${input.channelSensitivity}".

Episode summary:
  "${truncate(input.summary, SUMMARY_CHAR_LIMIT)}"

Extracted memories:
${memoriesBlock}

Output JSON only, matching this exact shape:
{
  "inferred_sensitivity": "public" | "internal" | "confidential",
  "brief_reason": "<one short abstract phrase, no PII, no quotes from content>"
}

Tier definitions:
- "public": safe for anyone, including external audiences.
- "internal": fine for workspace members; not for external sharing. Routine business.
- "confidential": HR, legal, security incidents, finances, M&A, performance feedback, individual compensation, customer complaints with PII, strategy not yet public.

Reasoning rules:
- Reason is metadata. Use an abstract category label (e.g. "discusses compensation", "mentions security incident"). Do NOT quote sentences. Do NOT include names, dollar amounts, or other content.
- If the content matches the channel-rule tier, repeat it (do not invent a higher tier to "be safe").
- If the content is mostly the same tier but a small portion is higher, return the higher tier.`
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Returns the classification when the call succeeded and parsed. Returns
 * `null` on any provider error or parse failure (non-blocking per Q3 spec).
 *
 * Side-effect: when `opts.analytics` is provided AND
 * `inferred > input.channelSensitivity`, logs a
 * `sensitivity_drift_flagged` analytics event. Flag-not-bump — the caller
 * never auto-updates Episode.sensitivity.
 */
export async function classifySensitivity(
  opts: SensitivityClassifierOptions,
): Promise<SensitivityClassification | null> {
  const { provider, model, analytics, input } = opts

  let usage: TokenUsage | null = null
  try {
    const response = await collectStream(
      provider.stream({
        model,
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildPrompt(input) }],
        maxTokens: 500,
        temperature: 0.1,
      }),
    )

    usage = response.usage

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')

    const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.warn('[sensitivity-classifier] skipped: no JSON object in model output')
      return null
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      inferred_sensitivity?: unknown
      brief_reason?: unknown
    }

    const inferredRaw = parsed.inferred_sensitivity
    if (!isSensitivity(inferredRaw)) {
      console.warn(
        `[sensitivity-classifier] skipped: invalid inferred_sensitivity=${JSON.stringify(inferredRaw)}`,
      )
      return null
    }
    const inferred: Sensitivity = inferredRaw

    const reasonRaw = typeof parsed.brief_reason === 'string' ? parsed.brief_reason.trim() : ''
    const briefReason = reasonRaw.slice(0, REASON_CHAR_LIMIT)

    const drifted = RANK[inferred] > RANK[input.channelSensitivity]

    if (drifted && analytics) {
      analytics.logEvent({
        userId: input.userId,
        assistantId: input.assistantId ?? undefined,
        eventName: 'sensitivity_drift_flagged',
        metadata: {
          episode_id: sanitize(input.episodeId),
          workspace_id: sanitize(input.workspaceId),
          channel_sensitivity: sanitize(input.channelSensitivity),
          inferred_sensitivity: sanitize(inferred),
          brief_reason: sanitize(briefReason),
        },
      })
    }

    return {
      inferredSensitivity: inferred,
      briefReason,
      drifted,
      usage,
      model,
    }
  } catch (err) {
    console.warn(
      `[sensitivity-classifier] skipped: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}
