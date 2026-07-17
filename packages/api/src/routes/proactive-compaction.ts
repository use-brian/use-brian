/**
 * Proactive compaction — shared across all channel routes.
 *
 * Checks whether the conversation history exceeds the token threshold
 * for the user's plan tier + channel class. If so, extracts memories
 * from the about-to-be-compacted portion (safety net), then compacts
 * the conversation down to a summary + recent turns. When the caller
 * passes `profile: 'multi-topic'`, each topic section emitted by the
 * LLM becomes an `episodic_memories` row.
 *
 * Used by: chat.ts (web), channel-pipeline.ts (Telegram BYO, Slack,
 * WhatsApp), telegram.ts (official bot), scheduling/executor.ts (cron,
 * which passes `unconditional: true` to force compaction every run).
 *
 * See docs/architecture/context-engine/compaction.md.
 */

import {
  needsCompaction, compactConversation, extractMemoriesBeforeCompaction,
  ensureToolResultPairing,
  createCompactionCircuitBreaker, estimateTokens,
  fitMessagesToBudget, resolveInputTokenLimit, MODEL_CONTEXT_FIT_RATIO,
  isContextOverflowError,
  sanitize as sanitizeAnalytics,
} from '@use-brian/core'
import type {
  Message, LLMProvider, MemoryStore, AnalyticsLogger,
  CompactionTier, CompactionProfile, ChannelClass, EpisodeSection,
  EpisodicStore, EpisodicMemoryRecord, UsageStore,
  SessionStateStore,
} from '@use-brian/core'
import {
  setCompactSummaryAndBoundary, toStampedMessages, findSessionById,
} from '../db/sessions.js'

/**
 * Retention for resolved/cancelled session_state rows. Dropped by
 * `sessionStateStore.purgeResolvedOlderThan()` when proactive compaction
 * runs. 24h keeps a full day's resolved commitments visible to the model
 * (so it knows "you already confirmed earlier today") without letting the
 * block grow unboundedly across idle sessions.
 */
const SESSION_STATE_RESOLVED_TTL_MS = 24 * 60 * 60 * 1000
import type { Session, SessionMessage } from '../db/sessions.js'
import { recordOverheadUsage } from './_overhead-usage.js'
import type { ChatEpisodeIngestor } from '../ingest-port.js'

/**
 * Hard cap on the persisted `sessions.compact_summary` text. Acts as a
 * backstop so a runaway summarizer can't grow the prepended system message
 * across turns until it dominates the context window. 8K chars ≈ 2K tokens
 * at the worst (CJK); real summaries today run 1–2K chars. If we blow past
 * this regularly, the summarizer needs tuning, not the cap.
 */
const COMPACT_SUMMARY_MAX_CHARS = 8_000

/**
 * How many compactions an episodic row must survive (neither evicted for
 * zero access nor already promoted) before it graduates to long-term
 * `memories`. Kept deliberately small — the signal is already gated by
 * access_count >= 1 at every survival check, so 3 means "accessed at
 * least once after each of three compactions". Tune down for shorter
 * runways, up for stricter promotion.
 */
const EPISODIC_PROMOTION_THRESHOLD = 3

/** How many recent messages to preserve verbatim after compaction. */
const KEEP_RECENT = 6

/**
 * Find an index that splits the conversation into a "compactable" head and a
 * "recent" tail such that the tail starts with a plain user TEXT message
 * (not a tool_result). Gemini rejects contents that don't start with a user
 * message once the `system` boundary marker is skipped by the provider.
 *
 * Walks backwards from `messages.length - KEEP_RECENT`. If the initial split
 * would start the tail on an assistant turn or a tool_result, it extends the
 * tail further back until a genuine user message anchors it.
 *
 * Invariant: the **current user turn** (the last plain user text message) is
 * always in `recent`, never in `compactable`. Otherwise the model would have
 * nothing to respond to after compaction replaces the head.
 *
 * Returns the index where the tail begins. Callers should treat this as:
 *   compactable = messages.slice(0, splitIdx)
 *   recent      = messages.slice(splitIdx)
 */
export function findRecentSplit(messages: Message[]): number {
  if (messages.length === 0) return 0

  // Locate the current user turn. Split must stay at or before this index.
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isPlainUserTextMessage(messages[i])) {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) return 0 // no user anchor — degenerate, keep all as recent

  let idx = Math.max(0, messages.length - KEEP_RECENT)
  while (idx > 0 && !isPlainUserTextMessage(messages[idx])) {
    idx--
  }

  // Short histories can walk all the way back to idx=0, leaving `compactable`
  // empty — which the caller's unconditional path used to collapse into a
  // lone boundary message, dropping the current user turn. Snap to the
  // current turn so prior messages flow into `compactable` and the current
  // turn alone stays verbatim in `recent`.
  if (idx === 0 && lastUserIdx > 0) {
    return lastUserIdx
  }
  return idx
}

function isPlainUserTextMessage(msg: Message): boolean {
  if (msg.role !== 'user') return false
  if (typeof msg.content === 'string') return true
  if (!Array.isArray(msg.content)) return false
  // A plain user turn has at least one text/image block and no tool_result.
  // A turn consisting solely of tool_result blocks is the "user" half of the
  // model's tool-calling round-trip and cannot anchor the tail.
  let hasText = false
  let hasToolResult = false
  for (const block of msg.content) {
    if (block.type === 'tool_result') hasToolResult = true
    else if (block.type === 'text' || block.type === 'image') hasText = true
  }
  return hasText && !hasToolResult
}

export type ProactiveCompactionParams = {
  /**
   * Raw `session_messages` rows loaded from the DB (post-compact-boundary,
   * with real sequence_nums). The function owns stamping and
   * tool-result-pairing internally so the boundary-cursor math can run
   * against a known mapping between paired `Message[]` indices and DB
   * rows.
   */
  sessionMessages: SessionMessage[]
  /** User's timezone for message-stamping. Callers should pass the channel user's tz (falling back to 'UTC'). */
  timezone: string
  /**
   * Session row, needed for `compactSummary` (prepended in-memory as a
   * system message) and `compactBoundarySequence` (used as the expected
   * value for the optimistic-concurrency guard).
   */
  session: Session
  tier: CompactionTier
  /**
   * Channel class — drives threshold multiplier via needsCompaction()
   * and is logged for analytics. Defaults to 'web' when omitted so
   * callers that haven't been updated still get the legacy behavior.
   */
  channelClass?: ChannelClass
  /**
   * Compaction prompt profile. 'linear' (default) uses the classic
   * 6-section summary. 'multi-topic' clusters the conversation by
   * topic and emits one episodic-memory row per topic.
   */
  profile?: CompactionProfile
  /**
   * When true, skip the `needsCompaction` check and always compact.
   * Used by the cron scheduler which compacts before every run
   * regardless of token count.
   */
  unconditional?: boolean
  provider: LLMProvider
  systemPrompt: string
  assistantId: string
  /** Channel user — owns memory, sessions, episodic rows. */
  userId: string
  /**
   * Assistant owner — pays for LLM usage. Overhead rows (compaction,
   * extraction) attribute cost against this ID so the owner's budget
   * absorbs the auxiliary calls rather than the (often shadow) channel
   * user. See docs/architecture/channels/channel-user-identity.md
   * → "Billing split".
   */
  ownerId: string
  channelType: string
  memoryStore: MemoryStore
  /**
   * Required when profile === 'multi-topic'. If omitted with a
   * multi-topic profile, episode sections are logged but not
   * persisted — caller is assumed to have opted out of the episodic
   * tier (e.g. cron sessions where only the active summary matters).
   */
  episodicStore?: EpisodicStore
  /**
   * Optional session-state store. When provided, proactive compaction
   * piggy-backs a cheap housekeeping pass that hard-deletes resolved/
   * cancelled `session_state` rows older than
   * `SESSION_STATE_RESOLVED_TTL_MS` (24h). Open rows are never touched.
   */
  sessionStateStore?: SessionStateStore
  analytics?: AnalyticsLogger
  /**
   * Compaction circuit breaker. Opens after consecutive NON-overflow
   * compaction failures (systemic — e.g. provider outage), at which point an
   * over-limit session degrades to a deterministic fit-to-budget trim instead
   * of hammering the summariser. Overflow failures never open it (the budget
   * wrapper handles those). Defaults to a process-wide singleton; tests inject
   * their own so the state is isolated.
   */
  circuitBreaker?: ReturnType<typeof createCompactionCircuitBreaker>
  /**
   * Optional usage store for attributing the summariser + extractor LLM
   * calls as `overhead:compaction` / `overhead:extraction` rows. When
   * omitted, tokens are silently consumed (legacy behaviour). See
   * docs/platform/cost-and-pricing.md → "Overhead accounting".
   */
  usageStore?: UsageStore
  /**
   * Optional ID of the user message that triggered this turn. When set,
   * the recorded overhead rows link back to it via
   * `usage_tracking.user_message_id`, so the admin "cost per user
   * message" view rolls up compaction cost under the same turn.
   */
  userMessageId?: string
  /**
   * Company-brain ingest (WU-3.6 — `ingest.md` §"Pipeline A — chat
   * compaction checkpoint"). When both are set, the just-compacted
   * conversation window is ingested as a `web_chat` Episode and run
   * through Pipeline B, so the brain learns from live chat — not only the
   * connector batch poller. Optional: cron / channel callers without a
   * workspace-scoped assistant pass neither and skip the extraction.
   */
  workspaceId?: string
  chatEpisodeIngestor?: ChatEpisodeIngestor
}

export type ProactiveCompactionResult = {
  /** The (possibly compacted) message array to send to the query loop. */
  messages: Message[]
  /** Whether compaction actually ran. */
  compacted: boolean
  /** Persisted episodic rows (empty for linear profile or when store was omitted). */
  episodes: EpisodeSection[]
}

/**
 * Run proactive compaction if the conversation exceeds the tier+channel
 * threshold. Returns the (possibly compacted) message array ready to hand
 * to the query loop. Safe to call unconditionally — returns a
 * summary-prepended pass-through if compaction isn't needed.
 *
 * Invariant after persistence: `sessions.compact_boundary_sequence` is
 * the `sequence_num` of the first NON-compactable (recent) DB row.
 * Together with `sessions.compact_summary` (the plain-text summary
 * replacing everything before that seq) this partitions
 * `session_messages` cleanly and avoids the mid-turn orphan-head race
 * that produced the Gemini 400 "function call turn" bug.
 */
/** Plain text of a session_messages row (`content` is a string or ContentBlock[]). */
function rowText(m: SessionMessage): string {
  const content: unknown = m.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b: { type?: string }) => b.type === 'text')
      .map((b: { text?: string }) => b.text ?? '')
      .join(' ')
  }
  return ''
}

/**
 * Process-wide compaction circuit breaker. A single shared instance means a
 * systemic summariser outage trips once and degrades every session to the
 * deterministic trim, rather than each session re-discovering the outage.
 * Reset on the first success. Overridable per-call via `params.circuitBreaker`
 * for test isolation.
 */
const defaultCompactionBreaker = createCompactionCircuitBreaker()

export async function runProactiveCompaction(
  params: ProactiveCompactionParams,
): Promise<ProactiveCompactionResult> {
  const {
    sessionMessages, timezone, session,
    tier, provider, systemPrompt,
    assistantId, userId, ownerId, channelType,
    memoryStore, episodicStore, sessionStateStore, analytics,
    channelClass, profile, unconditional,
    usageStore, userMessageId,
    workspaceId, chatEpisodeIngestor,
  } = params

  const breaker = params.circuitBreaker ?? defaultCompactionBreaker
  const sessionId = session.id

  // 1. Stamp (strictly 1:1 with sessionMessages — toStampedMessages maps
  // each DB row to one Message). We compute the split on THIS array so
  // the DB-row ↔ in-memory-index mapping stays trivial. Pairing is
  // applied separately, downstream, to each half.
  const stamped = toStampedMessages(sessionMessages, timezone) as Message[]

  // 2. Prepend the existing compact summary as a system message so the
  // model sees prior context on every turn. `findRecentSplit` treats
  // role='system' as a non-anchor, so a prepended system row at index 0
  // never gets chosen as the tail anchor.
  const summaryPrepended = typeof session.compactSummary === 'string' && session.compactSummary.length > 0
  const summaryOffset = summaryPrepended ? 1 : 0
  const stampedWithSummary: Message[] = summaryPrepended
    ? [{ role: 'system', content: session.compactSummary as string }, ...stamped]
    : stamped

  // 3. Fast path: no compaction needed — return the pass-through with
  // the summary prepended + pairing applied so the caller's queryLoop
  // still sees a well-formed history.
  if (!unconditional && !needsCompaction(stampedWithSummary, tier, channelClass)) {
    const passthrough = summaryPrepended
      ? [stampedWithSummary[0], ...ensureToolResultPairing(stamped)]
      : ensureToolResultPairing(stamped)
    return { messages: passthrough, compacted: false, episodes: [] }
  }

  // Compaction IS needed. Set up the deterministic fallback + auto-heal
  // accounting shared by every exit below. The fallback fits history to the
  // model window WITHOUT an LLM call — the anti-wedge guarantee: a turn never
  // receives over-limit history, even when the summariser is unavailable.
  // All turn models are Gemini (Anthropic is the outage-only fallback), so the
  // Gemini frontier window is the hard limit that would 400 the next turn.
  const modelHardLimit = resolveInputTokenLimit('gemini-flash')
  const fitBudget = Math.floor(modelHardLimit * MODEL_CONTEXT_FIT_RATIO)
  const preTokens = estimateTokens(stampedWithSummary)
  const wasOverLimit = preTokens > modelHardLimit
  const emitAutohealIfOverLimit = (healedVia: 'compaction' | 'mechanical_trim', compacted: boolean): void => {
    if (!wasOverLimit) return
    analytics?.logEvent({
      userId, assistantId, sessionId,
      eventName: 'session_autohealed', channelType,
      metadata: {
        pre_tokens: preTokens,
        model_limit: modelHardLimit,
        compacted,
        healed_via: sanitizeAnalytics(healedVia),
      },
    })
  }
  const trimmedFallback = (): ProactiveCompactionResult => ({
    messages: ensureToolResultPairing(fitMessagesToBudget(stampedWithSummary, fitBudget).messages),
    compacted: false,
    episodes: [],
  })

  // Breaker open (compaction failing systemically) → skip the LLM summarise
  // and degrade to the deterministic trim. Never pass through full history.
  if (breaker.isOpen) {
    emitAutohealIfOverLimit('mechanical_trim', false)
    return trimmedFallback()
  }

  try {
    // 4. Split on the stamped-with-summary array. Because stamped is
    // 1:1 with sessionMessages, `splitIdx - summaryOffset` maps cleanly
    // back to a DB row index — no reference-set tricks required.
    //
    // findRecentSplit always anchors on a plain user TEXT message, so
    // the split never falls between an assistant tool_use and its user
    // tool_result pair (which is a "user with only tool_result" row,
    // not a plain user text). That means pairing each half separately
    // below is safe — no cross-boundary repair is ever needed.
    const splitIdx = findRecentSplit(stampedWithSummary)
    const firstRecentDbIdx = Math.max(0, splitIdx - summaryOffset)

    const stampedCompactable = stamped.slice(0, firstRecentDbIdx)
    const stampedRecent = stamped.slice(firstRecentDbIdx)

    // Exclude the prepended summary from the LLM-facing compactable
    // slice. We never passed it into `stampedCompactable` in the first
    // place (summary lives only in stampedWithSummary[0]), so this is
    // just the stamped compactable directly. Kept as its own name to
    // make the "don't summarize a summary" intent visible at the call
    // site.
    const compactableForLLM = stampedCompactable

    // Degenerate: nothing new to summarize. Return the pass-through
    // unchanged — no boundary update, no LLM spend.
    if (compactableForLLM.length === 0) {
      const passthrough = summaryPrepended
        ? [stampedWithSummary[0], ...ensureToolResultPairing(stamped)]
        : ensureToolResultPairing(stamped)
      return { messages: passthrough, compacted: false, episodes: [] }
    }

    // 5. Cursor — seq of the first recent DB row, or one past the last
    // row when everything got compacted and nothing is left on the
    // recent side.
    let newCursor: number
    if (firstRecentDbIdx < sessionMessages.length) {
      newCursor = sessionMessages[firstRecentDbIdx].sequenceNum
    } else {
      newCursor = sessionMessages[sessionMessages.length - 1].sequenceNum + 1
    }

    // 7. Pre-compaction memory extraction — safety net for facts not
    // yet saved via saveMemory. Runs regex + cheap LLM pass.
    // Fire-and-forget: extraction failure must not block compaction.
    try {
      // System-level read — pre-compaction extraction runs across the
      // entire memory set for the (assistant, user) pair, so it uses
      // the privileged-service-exception path (no per-viewer
      // projection).
      const existingIndex = await memoryStore.getIndexSystem(assistantId, userId)
      const existingSummaries = existingIndex.map((m) => m.summary)
      const extracted = await extractMemoriesBeforeCompaction({
        provider,
        model: 'gemini-flash',
        messages: compactableForLLM,
        existingMemories: existingSummaries,
      })
      for (const fact of extracted.facts) {
        // Post-Phase-4 (retire-memory-type): no `type` field on the
        // memory write. The fact's categorical signal (if any) can
        // be moved to tags on a future extractor pass.
        await memoryStore.create({
          assistantId,
          userId,
          summary: fact.summary,
          confidence: fact.confidence,
          source: 'pre-compaction',
          sourceSessionId: sessionId,
          sensitivity: 'internal',
          createdByUserId: userId,
          createdByAssistantId: assistantId,
        })
      }
      if (extracted.facts.length > 0) {
        analytics?.logEvent({
          userId, assistantId, sessionId,
          eventName: 'memory_pre_compaction_extracted', channelType,
          metadata: { count: extracted.facts.length },
        })
      }
      await recordOverheadUsage({
        usageStore, userId: ownerId, actorUserId: userId,
        assistantId, sessionId, userMessageId,
        model: extracted.model, usage: extracted.usage,
        source: 'overhead:extraction',
        triggerKey: 'pattern_extractor',
      })
    } catch (err) {
      console.error('[pre-compaction extraction] Failed:', err)
    }

    // 8. Summarize.
    const compactResult = await compactConversation({
      provider,
      model: 'gemini-flash',
      messages: compactableForLLM,
      systemPrompt,
      profile,
      channelClass,
    })
    await recordOverheadUsage({
      usageStore, userId: ownerId, actorUserId: userId,
      assistantId, sessionId, userMessageId,
      model: compactResult.model, usage: compactResult.usage,
      source: 'overhead:compaction',
      triggerKey: 'compaction_full',
    })

    // Defensive cap: if the summarizer exceeded the budget (unusual for
    // a 4K-token output cap but possible with CJK + multi-topic), hard-
    // truncate and log so the cap firing shows up in Cloud Run.
    const rawSummaryText = extractSummaryText(compactResult.boundaryMessage.content)
    const summaryText = capSummary(rawSummaryText, COMPACT_SUMMARY_MAX_CHARS)
    if (summaryText.length < rawSummaryText.length) {
      console.warn(
        `[compaction] summary cap fired for session ${sessionId}: ${rawSummaryText.length} → ${summaryText.length} chars`,
      )
    }

    // 9. Persist atomically with the concurrency guard. If the guard
    // fails (someone else compacted the same session between our read
    // and write), discard our summary and fall through with the
    // pass-through — the other compaction already trimmed the history.
    const claimed = await setCompactSummaryAndBoundary(
      sessionId,
      summaryText,
      newCursor,
      session.compactBoundarySequence,
    )
    if (!claimed) {
      console.warn(`[compaction] lost race for session ${sessionId} (cursor moved by concurrent turn)`)
      analytics?.logEvent({
        userId, assistantId, sessionId,
        eventName: 'compaction_lost_race', channelType,
        metadata: {
          expected_cursor: session.compactBoundarySequence ?? -1,
          attempted_cursor: newCursor,
        },
      })
      // Reload the session to pick up the winner's summary; re-prepend
      // and return as pass-through. We skip episodic persistence too
      // since the winner has already done it.
      const refreshed = await findSessionById(sessionId)
      const refreshedSummary = refreshed?.compactSummary ?? null
      const pairedAll = ensureToolResultPairing(stamped)
      const messagesForFallback: Message[] = refreshedSummary
        ? [{ role: 'system', content: refreshedSummary }, ...pairedAll]
        : pairedAll
      return { messages: messagesForFallback, compacted: false, episodes: [] }
    }

    // 9b. Company-brain ingest — extract a `web_chat` Episode from the
    // just-compacted window so the brain learns from live chat, not only
    // the connector batch poller (ingest.md §"Pipeline A — chat
    // compaction checkpoint"). Fire-and-forget: Pipeline B runs in the
    // background and never blocks the turn; a failure is logged, not
    // surfaced. Mirrors the pre-compaction memory extraction's
    // best-effort discipline. Only runs for a workspace-scoped assistant.
    if (chatEpisodeIngestor && workspaceId) {
      const compactedRows = sessionMessages.filter((m) => m.sequenceNum < newCursor)
      if (compactedRows.length > 0) {
        const content = compactedRows
          .map(rowText)
          .filter((t) => t.trim().length > 0)
          .join('\n\n')
        if (content.trim().length > 0) {
          void chatEpisodeIngestor({
            workspaceId,
            userId,
            assistantId,
            sessionId,
            content,
            occurredAt: compactedRows[0]!.createdAt,
            messageIdRange: [
              compactedRows[0]!.id,
              compactedRows[compactedRows.length - 1]!.id,
            ],
          }).catch((err) => {
            console.error('[compaction] chat episode ingest failed:', err)
          })
        }
      }
    }

    // 10. Episodic lifecycle housekeeping — only runs after we claimed
    // the cursor, so at most one turn does this per compaction.
    let housekeepingStats = { promoted: 0, evicted: 0, kept: 0 }
    if (episodicStore) {
      try {
        housekeepingStats = await houseKeepEpisodic({
          episodicStore, memoryStore,
          sessionId, assistantId, userId,
        })
      } catch (err) {
        console.error('[compaction] episodic housekeeping failed:', err)
      }
    }

    // 10b. Session-state decay — drop resolved rows older than 24h in the
    // same housekeeping window as episodic. Open rows are load-bearing and
    // never touched here. See docs/architecture/context-engine/session-state.md.
    if (sessionStateStore) {
      try {
        const cutoff = new Date(Date.now() - SESSION_STATE_RESOLVED_TTL_MS)
        const purged = await sessionStateStore.purgeResolvedOlderThan(sessionId, cutoff)
        if (purged > 0) {
          analytics?.logEvent({
            userId, assistantId, sessionId,
            eventName: 'session_state_decay', channelType,
            metadata: { purged },
          })
        }
      } catch (err) {
        console.error('[compaction] session-state decay failed:', err)
      }
    }

    const episodes = compactResult.episodes ?? []
    if (episodes.length > 0 && episodicStore) {
      for (const ep of episodes) {
        try {
          await episodicStore.create({
            userId, assistantId, sessionId,
            topicLabel: ep.topicLabel,
            summary: ep.summary,
            messageSpan: {
              fromSequence: ep.messageSpan.fromSequence,
              toSequence: ep.messageSpan.toSequence,
              turnCount: ep.messageSpan.turnCount,
            },
          })
        } catch (err) {
          console.error('[compaction] Failed to persist episodic row for topic', ep.topicLabel, err)
        }
      }
      analytics?.logEvent({
        userId, assistantId, sessionId,
        eventName: 'episodic_memories_emitted', channelType,
        metadata: { count: episodes.length },
      })
    }

    if (housekeepingStats.promoted > 0 || housekeepingStats.evicted > 0) {
      analytics?.logEvent({
        userId, assistantId, sessionId,
        eventName: 'episodic_housekeeping', channelType,
        metadata: {
          promoted: housekeepingStats.promoted,
          evicted: housekeepingStats.evicted,
          kept: housekeepingStats.kept,
        },
      })
    }

    // 11. Build the return messages: fresh summary prepended, recent
    // tail repaired (in case the split broke a tool_use / tool_result
    // pair across the boundary).
    const compactedMessages: Message[] = [
      { role: 'system', content: summaryText },
      ...ensureToolResultPairing(stampedRecent),
    ]

    console.log(
      `[compaction] Session ${sessionId}: ${compactResult.tokensBefore} → ${compactResult.tokensAfter} tokens, cursor → ${newCursor}` +
      (episodes.length > 0 ? ` (${episodes.length} episodic rows)` : ''),
    )

    analytics?.logEvent({
      userId, assistantId, sessionId,
      eventName: 'compaction_triggered', channelType,
      metadata: {
        type: sanitizeAnalytics(unconditional ? 'unconditional' : 'proactive'),
        profile: sanitizeAnalytics(profile ?? 'linear'),
        channel_class: sanitizeAnalytics(channelClass ?? 'web'),
        pre_tokens: compactResult.tokensBefore,
        post_tokens: compactResult.tokensAfter,
        episode_count: episodes.length,
      },
    })

    breaker.recordSuccess()
    emitAutohealIfOverLimit('compaction', true)
    return { messages: compactedMessages, compacted: true, episodes }
  } catch (err) {
    console.error('[compaction] Failed:', err)
    // Overflow failures are handled deterministically by the budget wrapper +
    // the trim fallback below — not a systemic outage, so they must NOT open
    // the breaker. Everything else (provider 5xx, persistence failure) counts.
    if (!isContextOverflowError(err)) breaker.recordFailure()
    analytics?.logEvent({
      userId, assistantId, sessionId,
      eventName: 'compaction_error', channelType,
      metadata: { error_type: sanitizeAnalytics('compaction_failed') },
    })
    // Degrade to a deterministic fit-to-budget trim (NOT full history) so the
    // following turn can't 400 on an over-limit prompt.
    emitAutohealIfOverLimit('mechanical_trim', false)
    return trimmedFallback()
  }
}

/**
 * Extract plain text from a `compactConversation` boundary message. The
 * summarizer returns a `Message` whose `content` is either a string or
 * a `ContentBlock[]`; we always want just the text here so the column
 * stores something the loader can round-trip as a system message.
 */
function extractSummaryText(content: Message['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
}

/**
 * Hard-truncate the summary text if it exceeds `maxChars`. Keeps the
 * head (where the highest-signal "current user request" / "decisions"
 * bullets live in the 6-section prompt) and drops the tail. A follow-up
 * compaction naturally rebuilds the full summary from recent context
 * plus whatever survives here.
 */
function capSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n\n[summary truncated at cap]'
}

type HouseKeepParams = {
  episodicStore: EpisodicStore
  memoryStore: MemoryStore
  sessionId: string
  assistantId: string
  userId: string
}

type HouseKeepStats = {
  promoted: number
  evicted: number
  kept: number
}

/**
 * Reconcile the session's prior episodic rows against their access
 * history. Runs once per successful compaction, before the current
 * compaction's new rows are written.
 *
 *   access_count == 0                       → evict (cold)
 *   survival_count + 1 >= PROMOTION_THRESH  → promote to `memories`
 *   otherwise                                → bump survival_count
 *
 * Promotions write a `context`-type memory with source
 * 'episodic-graduation' carrying the episodic row's own summary as
 * `detail`. The summary itself is derived so the memory index stays
 * scannable. The original episodic row is deleted after successful
 * memory creation so the topic doesn't live in both tiers.
 *
 * Idempotent-on-failure: per-row errors are logged and skipped so
 * a single bad row never blocks the rest of the pass.
 *
 * Exported for unit testing.
 */
export async function houseKeepEpisodic(
  params: HouseKeepParams,
): Promise<HouseKeepStats> {
  const rows = await params.episodicStore.listBySession(params.sessionId)
  const toEvict: EpisodicMemoryRecord[] = []
  const toPromote: EpisodicMemoryRecord[] = []
  const toKeep: EpisodicMemoryRecord[] = []

  for (const row of rows) {
    if (row.accessCount === 0) {
      toEvict.push(row)
    } else if (row.survivalCount + 1 >= EPISODIC_PROMOTION_THRESHOLD) {
      toPromote.push(row)
    } else {
      toKeep.push(row)
    }
  }

  // Promote: write memory first, delete episodic on success. If the
  // memory write fails we deliberately keep the episodic row so the
  // content isn't lost — next compaction will retry the promotion.
  let promoted = 0
  for (const row of toPromote) {
    try {
      await params.memoryStore.create({
        assistantId: params.assistantId,
        userId: params.userId,
        scope: 'shared',
        summary: `Recurring topic: ${row.topicLabel}`,
        detail: row.summary,
        confidence: 0.7,
        source: 'episodic-graduation',
        sourceSessionId: params.sessionId,
        tags: ['episodic-graduation', row.topicLabel],
        sensitivity: 'internal',
        createdByUserId: params.userId,
        createdByAssistantId: params.assistantId,
      })
      await params.episodicStore.deleteById(row.id)
      promoted++
    } catch (err) {
      console.error('[compaction] Failed to promote episodic row', row.id, err)
    }
  }

  // Evict: hard delete. Failures are non-fatal — a stuck cold row just
  // gets another chance next compaction.
  let evicted = 0
  for (const row of toEvict) {
    try {
      await params.episodicStore.deleteById(row.id)
      evicted++
    } catch (err) {
      console.error('[compaction] Failed to evict episodic row', row.id, err)
    }
  }

  // Bump survival on kept rows (batched).
  try {
    await params.episodicStore.incrementSurvivalCount(toKeep.map((r) => r.id))
  } catch (err) {
    console.error('[compaction] Failed to bump survival_count:', err)
  }

  return { promoted, evicted, kept: toKeep.length }
}

