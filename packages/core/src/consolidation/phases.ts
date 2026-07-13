/**
 * Memory consolidation — 3-phase "dreaming" system.
 *
 * Light (6h): dedupe by 90% similarity, DB-only, no LLM cost
 * REM (weekly): cross-domain pattern recognition, Haiku/Flash
 * Deep (daily): 6-signal scoring, pruning, SOUL synthesis, domain summaries
 *
 * All three phases are pure async functions: they take a store + a user
 * + (for REM/Deep) a `callModel` callback, run, and return. They have no
 * opinion on scheduling — the consolidation worker (`./worker.ts`) is the
 * caller that decides when each phase is due per user.
 *
 * Workspace-scoped REM/Deep targets:
 *
 *   - `runREMSkillUmbrella`  — S10 umbrella consolidation pass. Per-
 *     workspace; iterates the workspace list in the worker, not the
 *     per-user list. See `./skill-umbrella.ts`.
 *   - `runDeepSkillDecay`    — CL-8 skill invocation feedback decay.
 *     Per-workspace; same cadence shape. See `./skill-decay.ts`.
 *
 * Both are exported as thin re-exports so the worker can wire them in
 * without depending on the umbrella/decay modules directly.
 */

import type { MemoryStore, MemoryWithMetrics, MemoryRecord } from '../memory/types.js'
import {
  runSkillUmbrellaPass,
  type RunSkillUmbrellaPassParams,
  type RunSkillUmbrellaPassResult,
} from './skill-umbrella.js'
import {
  runSkillDecay,
  type RunSkillDecayParams,
  type RunSkillDecayResult,
} from './skill-decay.js'

// ── Types ──────────────────────────────────────────────────────

export type ConsolidationPhase = 'light' | 'rem' | 'deep' | 'reflection'

export type ConsolidationResult = {
  phase: ConsolidationPhase
  memoriesAffected: string[]
  summary: string
}

/**
 * Legacy alias kept for backwards compatibility. Deep consolidation writes
 * directly through `MemoryStore.logConsolidation` instead; this type only
 * exists because older callers may still import it.
 */
export type ConsolidationStore = {
  log(params: {
    assistantId: string
    userId: string
    phase: ConsolidationPhase
    summary: string
    memoriesAffected: string[]
  }): Promise<void>
}

/** Analytics callback for consolidation events */
export type ConsolidationEvent =
  | { type: 'consolidation_completed'; phase: ConsolidationPhase; memoriesAffected: number; merged: number; patternsFound: number; pruned?: number; promoted?: number; domainsSummarized?: number; opPruned?: number }
  | { type: 'soul_updated'; previousLength: number; newLength: number; changeMagnitude: number }

/**
 * Provenance tag stamped on memories REM consolidation writes (was
 * `type: 'connection'` pre-migration 162). Light/REM/Deep key all
 * REM-specific behavior (looser Jaccard dedup, shorter prune age gate,
 * "shown to model as existing patterns" partitioning) off this tag
 * instead of a special memory `type`. See `migration 162` header and
 * `docs/architecture/context-engine/memory-consolidation.md`.
 */
const REM_OUTPUT_TAG = 'consolidation:rem'

/** True when the memory is REM's own output — used to keep REM patterns
 *  out of REM's own input set and to gate their looser-Jaccard / shorter
 *  age-gate behavior. */
function isRemOutput(memory: { tags: readonly string[] }): boolean {
  return memory.tags.includes(REM_OUTPUT_TAG)
}

/**
 * Operational-state regex set used by `runCronOperationalPrune`.
 *
 * Matches the stable shapes the cron executor's `saveMemory` calls
 * produce when a nag loop runs (e.g.
 * "Pill reminder active (April 22) - 30m overdue, 2nd follow-up sent",
 * "Awaiting confirmation"). These describe per-cycle status, not durable
 * facts, and have no value once the cycle ends.
 *
 * Conservative on purpose — matches require explicit operational language
 * (counter words, time deltas, lifecycle words) so a normal `context`
 * memory like "User went to Tokyo last March" is never flagged.
 *
 * Exported for tests.
 */
export const CRON_OPERATIONAL_PATTERNS: RegExp[] = [
  // "Nth follow-up sent / scheduled"
  /\b\d+(?:st|nd|rd|th)?\s+follow-?up\b/i,
  // "150m overdue", "2 hours overdue"
  /\b\d+\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?\s+overdue\b/i,
  // "Awaiting confirmation"
  /\bawaiting\s+confirmation\b/i,
  // "Nth check"
  /\b\d+(?:st|nd|rd|th)?\s+check\b/i,
  // "follow-up sent / scheduled"
  /\bfollow-?up\s+(?:sent|scheduled|fired)\b/i,
]

/**
 * Returns true when the supplied text contains any operational-state
 * phrasing (see `CRON_OPERATIONAL_PATTERNS`). Callers should pass
 * `summary + '\n' + detail` — a benign summary ("Pill reminder completed")
 * must not let an operational detail ("2.5 hours overdue") smuggle past
 * the filter. The 2026-04-23 Cynthia turn was caused by a "completed" row
 * whose `detail` carried exactly that phrasing and therefore survived
 * every prior scan.
 */
export function looksLikeCronOperationalState(text: string): boolean {
  return CRON_OPERATIONAL_PATTERNS.some((re) => re.test(text))
}

export type ConsolidationOptions = {
  onEvent?: (event: ConsolidationEvent) => void
}

// ── Light phase: dedupe (6h interval, $0) ──────────────────────

/**
 * Hard cap on `detail` length when light consolidation merges two
 * similar memories. Prevents runaway growth from repeated merges where
 * the same memory keeps absorbing new similar entries — without this,
 * a single row can grow into the 100s of MB and eventually exhaust
 * V8's old-space at load time.
 *
 * 16 KB ≈ 4k tokens, more than enough context for a single memory.
 */
const MERGED_DETAIL_MAX_CHARS = 16 * 1024

/**
 * Merge two memory `detail` strings:
 *   1. Take the union of their lines (preserves order from a, then
 *      appends new lines from b not already present in a).
 *   2. Truncate the result to MERGED_DETAIL_MAX_CHARS.
 *
 * The line-level dedup matters because Light merges happen repeatedly
 * across ticks until Deep prunes the loser memory (up to 30 days). A
 * naive concatenation would re-append b's lines to a every tick. With
 * dedup, repeated merges of the same content become no-ops.
 */
function mergeDetails(a: string | null | undefined, b: string | null | undefined): string | undefined {
  const aLines = (a ?? '').split('\n').filter((l) => l.length > 0)
  const bLines = (b ?? '').split('\n').filter((l) => l.length > 0)
  const seen = new Set(aLines)
  const merged = [...aLines]
  for (const line of bLines) {
    if (!seen.has(line)) {
      seen.add(line)
      merged.push(line)
    }
  }
  if (merged.length === 0) return undefined
  const joined = merged.join('\n')
  if (joined.length <= MERGED_DETAIL_MAX_CHARS) return joined
  return joined.slice(0, MERGED_DETAIL_MAX_CHARS) + '\n... [truncated]'
}

/**
 * Deduplicate memories by similarity.
 * Compares summaries — if 90%+ similar, merge the newer into the older.
 */
export async function runLightConsolidation(
  store: MemoryStore,
  assistantId: string,
  userId: string,
  opts?: ConsolidationOptions & {
    knowledgeSummaries?: Array<{ summary: string | null }>
  },
): Promise<ConsolidationResult> {
  // System caller path: `getIndexSystem` skips per-viewer projection
  // (no workspace partition + no visibility-double + no clearance)
  // because consolidation operates across all memories for an
  // (assistant, user). See `permissions.md` § Privileged-service
  // exception.
  const index = await store.getIndexSystem(assistantId, userId, true)
  const affected: string[] = []

  // Compare all pairs (O(n²) but n < 200 at MVP, <1ms)
  for (let i = 0; i < index.length; i++) {
    for (let j = i + 1; j < index.length; j++) {
      const a = index[i]
      const b = index[j]
      // Post-Phase-4 (retire-memory-type): no `type` field. Dedup
      // groups by REM-vs-user provenance (via the `consolidation:rem`
      // tag) and skip cross-group pairs. The looser threshold below
      // would otherwise merge an LLM paraphrase into a user-written
      // observation.
      const aIsRemOutput = isRemOutput(a)
      if (aIsRemOutput !== isRemOutput(b)) continue

      const similarity = computeSimilarity(a.summary, b.summary)
      // REM-output memories are LLM-generated paraphrases of the same
      // insight — use a lower threshold (0.6) so word-overlap-blind
      // duplicates still merge. User-generated rows keep the
      // conservative 0.9 threshold to avoid false merges.
      const threshold = aIsRemOutput ? 0.6 : 0.9
      if (similarity >= threshold) {
        // Merge b into a (keep older, update with newer detail).
        // mergeDetails dedups at the line level + caps total length.
        const bFull = await store.getByIdSystem(b.id)
        if (bFull) {
          const aFull = await store.getByIdSystem(a.id)
          const mergedDetail = mergeDetails(aFull?.detail, bFull.detail)
          await store.update(a.id, { detail: mergedDetail })
          // Mark b as merged (set confidence to 0 for pruning).
          // Light's getMemoryIndex query filters confidence > 0, so b
          // won't reappear in subsequent Light ticks — no re-merge.
          await store.update(b.id, { confidence: 0 })
          affected.push(b.id)
        }
      }
    }
  }

  // Cross-dedup: memory vs knowledge base entries.
  // If a memory's summary closely matches a KB entry, it's a KB echo —
  // mark for pruning so the KB entry remains the authoritative source.
  const kbSummaries = opts?.knowledgeSummaries?.filter((k) => k.summary).map((k) => k.summary!) ?? []
  if (kbSummaries.length > 0) {
    for (const memory of index) {
      if (affected.includes(memory.id)) continue // already merged
      // Post-Phase-4: identity is no longer in memories (lives on the
      // self entity). The "never prune identity" guard is moot here.
      for (const kbSummary of kbSummaries) {
        if (computeSimilarity(memory.summary, kbSummary) >= 0.85) {
          await store.update(memory.id, { confidence: 0 })
          affected.push(memory.id)
          break
        }
      }
    }
  }

  const summary = `Deduped ${affected.length} memories`
  await store.logConsolidation({ assistantId, userId, phase: 'light', summary, memoriesAffected: affected })

  opts?.onEvent?.({
    type: 'consolidation_completed',
    phase: 'light',
    memoriesAffected: affected.length,
    merged: affected.length,
    patternsFound: 0,
  })

  return { phase: 'light', memoriesAffected: affected, summary }
}

// ── REM phase: cross-domain patterns (weekly, Flash) ───────────

/** Minimum memories before REM will attempt pattern recognition. */
const REM_MIN_MEMORIES = 15
/** Minimum distinct memory types before REM runs (prevents hallucinated patterns from thin signal). */
const REM_MIN_TYPES = 3
/** Maximum patterns REM will create per run. */
const REM_MAX_PATTERNS = 3
/** Max summary length (chars) enforced on REM output — keeps the memory index scannable. */
const REM_SUMMARY_MAX_CHARS = 100
/** Max detail length (chars) enforced on REM output — one paragraph worth. */
const REM_DETAIL_MAX_CHARS = 500

type ParsedREMPattern = {
  summary: string
  detail: string | null
  ids: string[]
  extendsId: string | null
}

/**
 * Parse the structured REM output:
 *
 *   SUMMARY: short hook
 *   DETAIL: longer paragraph (optional)
 *   CONNECTS: id1, id2, ...
 *   EXTENDS: existing-connection-id (optional)
 *
 * Blocks can be separated by blank lines or run back-to-back; a new
 * SUMMARY: line always starts a new block. Blocks missing SUMMARY or
 * CONNECTS (with ≥ 2 IDs) are dropped.
 */
function parseREMOutput(text: string): ParsedREMPattern[] {
  const blocks: ParsedREMPattern[] = []
  let current: { summary?: string; detail?: string; ids?: string[]; extendsId?: string } = {}
  const flush = () => {
    if (current.summary && current.ids && current.ids.length >= 2) {
      blocks.push({
        summary: current.summary,
        detail: current.detail ?? null,
        ids: current.ids,
        extendsId: current.extendsId ?? null,
      })
    }
    current = {}
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('SUMMARY:')) {
      flush()
      current.summary = line.slice('SUMMARY:'.length).trim().slice(0, REM_SUMMARY_MAX_CHARS)
    } else if (line.startsWith('DETAIL:') && current.summary) {
      current.detail = line.slice('DETAIL:'.length).trim().slice(0, REM_DETAIL_MAX_CHARS) || undefined
    } else if (line.startsWith('CONNECTS:') && current.summary) {
      current.ids = line.slice('CONNECTS:'.length).trim().split(',').map((s) => s.trim()).filter(Boolean)
    } else if (line.startsWith('EXTENDS:') && current.summary) {
      const id = line.slice('EXTENDS:'.length).trim()
      if (id && id.toLowerCase() !== 'none') current.extendsId = id
    }
  }
  flush()
  return blocks
}

/**
 * Find cross-domain patterns using an LLM.
 * Reads all memory summaries, asks model to identify connections — and
 * shows the existing connection list so the model can extend instead of
 * re-inventing.
 *
 * Guards:
 *  - Needs ≥ 15 non-connection memories and ≥ 3 distinct types to run.
 *  - Caps output to 3 patterns per run.
 *  - Deduplicates patterns against each other (Jaccard ≥ 0.7) before writing.
 *  - If the model emits `EXTENDS: <id>`, the existing connection's detail
 *    is appended/replaced instead of creating a new row.
 *
 * @param callModel - Function to call a cheap LLM (Flash/Haiku)
 */
export async function runREMConsolidation(
  store: MemoryStore,
  assistantId: string,
  userId: string,
  callModel: (prompt: string) => Promise<string>,
  opts?: ConsolidationOptions,
): Promise<ConsolidationResult> {
  const index = await store.getIndexSystem(assistantId, userId, true)

  // Split user-generated memories from existing REM output. Only the
  // user-generated set drives pattern recognition (so the model doesn't
  // build on its own prior insights), but we expose the existing
  // patterns to the prompt so it can extend them rather than reword.
  // Post-migration 162: REM outputs are tagged `consolidation:rem`
  // (formerly `type: 'connection'`); user-generated rows lack the tag.
  const inputMemories = index.filter((m) => !isRemOutput(m))
  const existingPatterns = index.filter((m) => isRemOutput(m))

  if (inputMemories.length < REM_MIN_MEMORIES) {
    return { phase: 'rem', memoriesAffected: [], summary: 'Too few memories for pattern recognition' }
  }

  // Post-Phase-4 (retire-memory-type): the legacy "distinct memory
  // types" gate keyed on `type` is gone. Use distinct tag-clusters as
  // the diversity proxy — patterns synthesised across diverse tag
  // contexts beat those from a single tag. Untagged rows count as one
  // bucket ('untagged').
  const distinctTagClusters = new Set(
    inputMemories.map((m) => (m.tags.length > 0 ? m.tags[0] : 'untagged')),
  )
  if (distinctTagClusters.size < REM_MIN_TYPES) {
    return { phase: 'rem', memoriesAffected: [], summary: 'Too few memory clusters for pattern recognition' }
  }
  const memorySummaries = inputMemories.map((m) => {
    const tagPrefix = m.tags.length > 0 ? `${m.tags[0]}: ` : ''
    return `[${m.id.slice(0, 8)}] ${tagPrefix}${m.summary}`
  }).join('\n')
  const existingBlock = existingPatterns.length
    ? existingPatterns.map((m) => `[${m.id.slice(0, 8)}] ${m.summary}`).join('\n')
    : '(none yet)'

  // Prefix-keyed lookup so we can resolve the 8-char IDs the model emits
  // back to their source sensitivities, and stamp the synthesised pattern
  // with the max.
  const sensitivityByPrefix = new Map<string, 'public' | 'internal' | 'confidential'>()
  for (const m of inputMemories) sensitivityByPrefix.set(m.id.slice(0, 8), m.sensitivity)
  // Full-ID lookup for EXTENDS resolution on existing patterns.
  const connectionByPrefix = new Map<string, typeof existingPatterns[number]>()
  for (const m of existingPatterns) connectionByPrefix.set(m.id.slice(0, 8), m)
  // Prefix → full memory UUID, covering both input memories and existing
  // connections. The model only sees 8-char prefixes (see `memorySummaries`
  // / `existingBlock` above), so its CONNECTS list comes back as prefixes —
  // but `consolidation_logs.memories_affected` is `uuid[]`, which rejects
  // anything that isn't a full UUID. Resolve here; drop unresolvable.
  const fullIdByPrefix = new Map<string, string>()
  for (const m of inputMemories) fullIdByPrefix.set(m.id.slice(0, 8), m.id)
  for (const m of existingPatterns) fullIdByPrefix.set(m.id.slice(0, 8), m.id)
  const resolveIds = (ids: string[]): string[] => {
    const out: string[] = []
    for (const id of ids) {
      const full = fullIdByPrefix.get(id.slice(0, 8))
      if (full) out.push(full)
    }
    return out
  }

  const maxPatterns = Math.min(REM_MAX_PATTERNS, Math.max(1, Math.floor(inputMemories.length / 10)))

  const prompt = `Analyze these user memories and identify cross-domain patterns, connections, or "lasting truths" that span multiple topics.

USER-GENERATED MEMORIES:
${memorySummaries}

EXISTING CONNECTIONS (patterns already known — do not re-invent these):
${existingBlock}

Rules:
- Output at most ${maxPatterns} pattern(s). Quality over quantity.
- Each pattern MUST connect memories from at least 2 different types.
- Do NOT output vague or generic statements. Each pattern must be a specific, actionable insight about THIS user.
- If a candidate pattern already exists in EXISTING CONNECTIONS, either skip it OR emit it with EXTENDS pointing at the existing id (only if you have genuinely new detail to add).
- SUMMARY must be ≤ ${REM_SUMMARY_MAX_CHARS} chars — it is a lookup hook, not the full insight.
- DETAIL carries the full insight — up to ${REM_DETAIL_MAX_CHARS} chars, one paragraph.

For each pattern, output this exact block (blank line between blocks):
SUMMARY: <≤${REM_SUMMARY_MAX_CHARS}-char hook>
DETAIL: <≤${REM_DETAIL_MAX_CHARS}-char explanation with specifics>
CONNECTS: <id1>, <id2>, ...
EXTENDS: <existing-connection-id OR none>

If no clear patterns, output: NO_PATTERNS`

  const result = await callModel(prompt)
  const affected: string[] = []
  const candidates = parseREMOutput(result)

  // Deduplicate candidates against each other — drop any that are ≥ 70%
  // similar to an earlier one.
  const deduped: ParsedREMPattern[] = []
  for (const c of candidates) {
    const isDupe = deduped.some((existing) => computeSimilarity(existing.summary, c.summary) >= 0.7)
    if (!isDupe) deduped.push(c)
  }

  // Apply hard cap and write. Each synthesised pattern inherits the max
  // sensitivity of its connected source memories — so a pattern drawn
  // across confidential facts stays confidential. Defaults to 'internal'
  // when the model emits an ID prefix we can't resolve (defensive).
  //
  // Cross-cycle dedup (only for NEW candidates — EXTENDS bypasses this):
  // if a candidate near-duplicates an existing connection memory, keep the
  // LOWER-tier one (broader access) and delete the higher-tier. This
  // handles the case where day 1 produced a confidential-stamped pattern
  // P, and day 2 re-draws the same gist from purely public sources (P'
  // with a public stamp) — we want P' to win so the insight becomes
  // visible to all clearances, not two near-duplicates at different tiers.
  const rank: Record<'public' | 'internal' | 'confidential', number> = { public: 1, internal: 2, confidential: 3 }

  let patternsFound = 0
  let extended = 0
  for (const c of deduped.slice(0, maxPatterns)) {
    // EXTENDS path: model says this refines an existing connection.
    if (c.extendsId) {
      const target = connectionByPrefix.get(c.extendsId.slice(0, 8))
      if (target) {
        const existing = await store.getByIdSystem(target.id)
        const mergedDetail = [existing?.detail, c.detail]
          .filter((s): s is string => Boolean(s && s.trim()))
          .join('\n')
          .slice(0, REM_DETAIL_MAX_CHARS * 2) // soft cap on unbounded growth
        await store.update(target.id, {
          summary: c.summary,
          detail: mergedDetail || undefined,
        })
        affected.push(target.id, ...resolveIds(c.ids))
        extended++
        continue
      }
      // EXTENDS id didn't resolve — fall through to new-pattern path.
    }

    // Start at the lowest tier and raise to max(source sensitivities).
    // If no source resolves (defensive — shouldn't happen under the dedup
    // upstream), fall through to 'internal' as a safe default.
    let stamp: 'public' | 'internal' | 'confidential' = 'public'
    let anyResolved = false
    for (const id of c.ids) {
      const prefix = id.slice(0, 8)
      const src = sensitivityByPrefix.get(prefix)
      if (src) {
        anyResolved = true
        if (rank[src] > rank[stamp]) stamp = src
      }
    }
    if (!anyResolved) stamp = 'internal'

    // Find near-duplicate existing patterns (Jaccard >= 0.7).
    const duplicates = existingPatterns.filter(
      (ex) => computeSimilarity(ex.summary, c.summary) >= 0.7,
    )

    if (duplicates.length > 0) {
      const lowestExistingRank = Math.min(...duplicates.map((d) => rank[d.sensitivity]))
      if (rank[stamp] >= lowestExistingRank) {
        // An existing pattern already covers this insight at an equal-or-
        // broader tier — skip writing the new one. Consumers of any tier
        // >= lowestExistingRank will still see it through the existing row.
        continue
      }
      // The new pattern is at a strictly lower tier than every existing
      // duplicate — broaden visibility by deleting the higher-tier
      // duplicates and writing the new one.
      for (const dup of duplicates) {
        await store.deleteMemory(dup.id)
      }
    }

    await store.create({
      assistantId, userId,
      // Post-Phase-4 (retire-memory-type): no `type` field. REM
      // output's provenance is the `consolidation:rem` tag (was the
      // bespoke `'connection'` type before edges were a primitive).
      scope: 'shared',
      summary: c.summary,
      detail: c.detail ?? undefined,
      source: 'consolidation',
      confidence: 0.6,
      sensitivity: stamp,
      tags: [REM_OUTPUT_TAG],
      createdByUserId: userId,
      createdByAssistantId: assistantId,
    })
    affected.push(...resolveIds(c.ids))
    patternsFound++
  }

  const summary = extended > 0
    ? `Found ${patternsFound} new patterns, extended ${extended}`
    : `Found ${patternsFound} cross-domain patterns`
  await store.logConsolidation({ assistantId, userId, phase: 'rem', summary, memoriesAffected: affected })

  opts?.onEvent?.({
    type: 'consolidation_completed',
    phase: 'rem',
    memoriesAffected: affected.length,
    merged: 0,
    patternsFound,
  })

  return { phase: 'rem', memoriesAffected: affected, summary }
}

// ── Deep phase: scoring + pruning + SOUL + domain summaries ────

/**
 * 6-signal scoring for memory quality assessment.
 * See docs/architecture/context-engine/memory-consolidation.md for the weight table.
 */
export type MemoryScoreInput = {
  recallCount: number
  usefulRecallCount: number
  uniqueQueries: number
  recallDays: number
  ageDays: number
  tags: string[]
}

const SIGNAL_WEIGHTS = {
  frequency: 0.24,
  relevance: 0.30,
  queryDiversity: 0.15,
  recency: 0.15,
  consolidation: 0.10,
  conceptualRichness: 0.06,
}

export function computeConsolidationScore(input: MemoryScoreInput): number {
  const frequency = Math.log(input.usefulRecallCount + 1) / Math.log(11) // 0-1, based on useful recalls
  const relevance = input.recallCount > 0
    ? input.usefulRecallCount / input.recallCount
    : 0 // utility rate: fraction of recalls that were useful
  const queryDiversity = Math.min(Math.min(input.uniqueQueries, input.recallDays) / 5, 1)
  const recency = Math.exp(-0.693 / 14 * input.ageDays) // 14-day half-life
  const consolidation = Math.min(input.recallDays / 7, 1) // multi-day recurrence
  const conceptualRichness = Math.min(input.tags.length / 6, 1)

  return (
    frequency * SIGNAL_WEIGHTS.frequency +
    relevance * SIGNAL_WEIGHTS.relevance +
    queryDiversity * SIGNAL_WEIGHTS.queryDiversity +
    recency * SIGNAL_WEIGHTS.recency +
    consolidation * SIGNAL_WEIGHTS.consolidation +
    conceptualRichness * SIGNAL_WEIGHTS.conceptualRichness
  )
}

export type DeepConsolidationOptions = ConsolidationOptions & {
  /** App scopes to synthesise per-app SOULs for. Shared SOUL always runs. */
  appIds?: string[]
  /** Minimum age (days) before a low-scoring memory can be pruned. Default 30. */
  pruneAfterDays?: number
  /** Score below which a memory is eligible for pruning. Default 0.3. */
  pruneScoreThreshold?: number
  /** Score above which a memory has its confidence promoted. Default 0.8. */
  promoteScoreThreshold?: number
  /** Memory count above which domain summary generation runs. Default 50. */
  domainSummaryThreshold?: number
  /** Soft cap on the number of domains summarised in one run. Default 50. */
  maxDomains?: number
  /** Total memory count above which the LLM dedup sweep runs. Default 10. */
  dedupSweepMinTotal?: number
  /** Group size at which the LLM dedup sweep calls the model for that group. Default 3. */
  dedupSweepMinGroup?: number
  /** Hard cap on memories per LLM dedup call — prevents oversized prompts. Default 30. */
  dedupSweepMaxGroup?: number
  /** Min age (days) before a cron-source operational-pattern memory becomes prunable. Default 7. */
  cronOpPruneAgeDays?: number
  /**
   * When true, skip the cron-source operational-pattern prune step.
   * Useful for tests or for reverting if the regex set proves too eager.
   * Default false (prune is on).
   */
  cronOpPruneDisabled?: boolean
}

const PROMOTE_THRESHOLD_DEFAULT = 0.8
const PRUNE_THRESHOLD_DEFAULT = 0.3
const PRUNE_AGE_DEFAULT_DAYS = 30
const DOMAIN_SUMMARY_THRESHOLD_DEFAULT = 50
const MAX_DOMAINS_DEFAULT = 50
const DEDUP_MIN_TOTAL_DEFAULT = 10
const DEDUP_MIN_GROUP_DEFAULT = 3
const DEDUP_MAX_GROUP_DEFAULT = 30
/** Max summary length (chars) enforced on dedup output — matches REM for consistency. */
const DEDUP_SUMMARY_MAX_CHARS = 100
/** Max detail length (chars) enforced on dedup output. */
const DEDUP_DETAIL_MAX_CHARS = 800
/** Cron-source operational-pattern prune age gate.
 *
 * Lowered 7 → 2 days on 2026-04-23, then 2 days → 6 hours on 2026-04-23
 * (late). Rationale: the prune runs as a Deep-phase step, and the nag cycle
 * is daily — so anything older than the next nag cycle is strictly stale.
 * Cynthia's 14:32 UTC turn pulled a 2026-04-22 06:00 "150m overdue, tenth
 * follow-up sent" row out of the ranked index (~32h old, below the 2-day
 * gate); the model pattern-matched today's situation against yesterday's
 * snapshot and echoed "2.5 hours overdue" verbatim. At 6h the next-day's
 * cycle starts with a clean slate. The regex + type='context' + source='model'
 * filters remain; only the gate moved. Expressed as a fractional day. */
const CRON_OP_PRUNE_AGE_DAYS_DEFAULT = 0.25

/**
 * Run the daily Deep consolidation phase for one user.
 *
 * Flow:
 *   0. Cron-source operational-pattern prune — hard-delete `context`-typed
 *      memories whose `source_session_id` is a cron session AND whose
 *      summary matches the cron operational regex set ("Nth follow-up
 *      sent", "150m overdue", "awaiting confirmation", etc.). Runs first
 *      so the rest of the pipeline doesn't waste cycles scoring noise.
 *      See `CRON_OPERATIONAL_PATTERNS`.
 *   1. Load every memory with scoring metrics (recall counts, age, tags).
 *   2. Score each memory and persist the result. Memories scoring above
 *      the promote threshold also have their confidence boosted.
 *   3. Prune memories whose score is below the prune threshold AND whose
 *      age exceeds `pruneAfterDays`. Identity memories are NEVER pruned —
 *      "who the user is" is permanent unless the user explicitly asks us
 *      to forget.
 *   4. LLM dedup sweep — groups survivors by (type, sensitivity), asks a
 *      cheap model to identify semantic duplicate clusters Jaccard cannot
 *      catch, merges clusters into a single keeper. Identity memories are
 *      excluded. Gated behind `dedupSweepMinTotal` so small accounts skip.
 *   5. Synthesise the shared SOUL from identity + preference memories via
 *      the callModel callback, and persist to `user_souls` (appId=null).
 *      Then, for each appId passed in options, synthesise an app-scoped
 *      SOUL delta using the same identity block + app-scoped preferences.
 *   6. If the user has >= `domainSummaryThreshold` total memories, generate
 *      a per-domain summary index and upsert rows into `domain_summaries`.
 *      Stale domains (no longer present) are pruned from that table too.
 *   7. Log the run to `consolidation_logs` and emit analytics events.
 */
export async function runDeepConsolidation(
  store: MemoryStore,
  assistantId: string,
  userId: string,
  callModel: (prompt: string) => Promise<string>,
  opts?: DeepConsolidationOptions,
): Promise<ConsolidationResult> {
  const promoteThreshold = opts?.promoteScoreThreshold ?? PROMOTE_THRESHOLD_DEFAULT
  const pruneThreshold = opts?.pruneScoreThreshold ?? PRUNE_THRESHOLD_DEFAULT
  const pruneAfterDays = opts?.pruneAfterDays ?? PRUNE_AGE_DEFAULT_DAYS
  const domainThreshold = opts?.domainSummaryThreshold ?? DOMAIN_SUMMARY_THRESHOLD_DEFAULT
  const maxDomains = opts?.maxDomains ?? MAX_DOMAINS_DEFAULT
  const dedupMinTotal = opts?.dedupSweepMinTotal ?? DEDUP_MIN_TOTAL_DEFAULT
  const dedupMinGroup = opts?.dedupSweepMinGroup ?? DEDUP_MIN_GROUP_DEFAULT
  const dedupMaxGroup = opts?.dedupSweepMaxGroup ?? DEDUP_MAX_GROUP_DEFAULT
  const cronOpPruneAgeDays = opts?.cronOpPruneAgeDays ?? CRON_OP_PRUNE_AGE_DAYS_DEFAULT
  const cronOpPruneEnabled = !opts?.cronOpPruneDisabled

  const affected: string[] = []
  let pruned = 0
  let promoted = 0
  let merged = 0
  let opPruned = 0

  // ── 0. Cron-source operational-pattern prune ──
  // Before scoring, sweep out cron-written context memories whose summaries
  // match the cron operational regex set. These are per-cycle status notes
  // ("Nth follow-up sent", "150m overdue") with no durable value — letting
  // them through to scoring rewards them for being read on every turn (the
  // pink-elephant feedback loop that bricked Cynthia's account 2026-04-22).
  // Two-stage filter: SQL pre-filters by (cron source + type=context + age),
  // regex confirms the operational shape. Both must hold.
  if (cronOpPruneEnabled) {
    const candidates = await store.listCronContextCandidatesForPrune(
      assistantId,
      userId,
      cronOpPruneAgeDays,
    )
    for (const c of candidates) {
      // Scan summary + detail. A benign summary ("Pill reminder completed")
      // can carry operational phrasing in the detail ("2.5 hours overdue")
      // that the model still reads verbatim via getMemory — so both fields
      // must be clean to let the row survive.
      const blob = [c.summary, c.detail ?? ''].filter(Boolean).join('\n')
      if (!looksLikeCronOperationalState(blob)) continue
      await store.deleteMemory(c.id)
      affected.push(c.id)
      opPruned++
    }
  }

  const memories = await store.listWithMetrics(assistantId, userId)

  // ── 1 + 2. Score every memory, persist, optionally promote ──
  const scored: Array<{ memory: MemoryWithMetrics; score: number }> = []
  for (const memory of memories) {
    const score = computeConsolidationScore({
      recallCount: memory.recallCount,
      usefulRecallCount: memory.usefulRecallCount,
      uniqueQueries: memory.uniqueQueries,
      recallDays: memory.recallDays,
      ageDays: memory.ageDays,
      tags: memory.tags,
    })
    const boost = score >= promoteThreshold
    await store.writeConsolidationScore(memory.id, score, boost)
    if (boost) promoted++
    scored.push({ memory, score })
  }

  // ── 3. Prune low-scoring aged memories ──
  // REM-output memories (LLM-generated, tagged `consolidation:rem`)
  // use a shorter age gate (7 days) since they're system-generated and
  // easily recreated. User-generated rows keep the full pruneAfterDays
  // (default 30) to avoid premature deletion. Post-Phase-4: no
  // identity-type guard needed — identity lives on entities now.
  const remPruneAgeDays = Math.min(7, pruneAfterDays)
  for (const { memory, score } of scored) {
    if (score >= pruneThreshold) continue
    const minAge = isRemOutput(memory) ? remPruneAgeDays : pruneAfterDays
    if (memory.ageDays < minAge) continue
    await store.deleteMemory(memory.id)
    affected.push(memory.id)
    pruned++
  }

  // Remove pruned rows from the working set so later steps don't see them.
  let liveScored = scored.filter(({ memory }) => !affected.includes(memory.id))

  // ── 4. LLM dedup sweep (semantic pass over survivors) ──
  // Jaccard in Light catches exact duplicates at $0; this pass catches
  // paraphrases that word-overlap misses (the dominant failure mode for
  // REM-generated connection memories and for repeated saveMemory calls).
  // Gated behind `dedupMinTotal` so small accounts don't pay for it.
  if (liveScored.length >= dedupMinTotal) {
    const liveMemories = liveScored.map(({ memory }) => memory)
    const dedupResult = await runMemoryDedupSweep({
      store, callModel, assistantId, userId,
      memories: liveMemories,
      minGroupSize: dedupMinGroup,
      maxGroupSize: dedupMaxGroup,
    })
    merged = dedupResult.mergedIds.length
    if (merged > 0) {
      affected.push(...dedupResult.mergedIds)
      const mergedSet = new Set(dedupResult.mergedIds)
      liveScored = liveScored.filter(({ memory }) => !mergedSet.has(memory.id))
    }
  }

  // ── 5. SOUL synthesis — shared first, then per-app deltas ──
  const sharedSynth = await store.listForSoulSynthesis(assistantId, userId, null)
  const sharedSoul = await synthesiseSoul({
    callModel,
    input: sharedSynth,
    mode: 'shared',
  })
  if (sharedSoul) {
    const previous = await store.getSoul(assistantId, userId)
    await store.upsertSoul(assistantId, userId, null, sharedSoul)
    opts?.onEvent?.({
      type: 'soul_updated',
      previousLength: previous?.length ?? 0,
      newLength: sharedSoul.length,
      changeMagnitude: changeMagnitude(previous, sharedSoul),
    })
  }

  for (const appId of opts?.appIds ?? []) {
    const appSynth = await store.listForSoulSynthesis(assistantId, userId, appId)
    const appSoul = await synthesiseSoul({
      callModel,
      input: appSynth,
      mode: 'app',
      sharedSoul,
    })
    if (appSoul) {
      const previous = await store.getSoul(assistantId, userId, appId)
      await store.upsertSoul(assistantId, userId, appId, appSoul)
      opts?.onEvent?.({
        type: 'soul_updated',
        previousLength: previous?.length ?? 0,
        newLength: appSoul.length,
        changeMagnitude: changeMagnitude(previous, appSoul),
      })
    }
  }

  // ── 6. Domain summary generation (growth tier only) ──
  let domainsSummarized = 0
  if (liveScored.length >= domainThreshold) {
    const sharedDomains = bucketDomains(
      liveScored.map(({ memory }) => memory).filter((m) => m.appId === null),
      maxDomains,
    )
    const sharedDomainNames = await summariseDomains({
      store, callModel, assistantId, userId, appId: null, domains: sharedDomains,
    })
    domainsSummarized += sharedDomainNames.length
    await store.pruneStaleDomainSummaries(assistantId, userId, null, sharedDomainNames)

    for (const appId of opts?.appIds ?? []) {
      const appDomains = bucketDomains(
        liveScored.map(({ memory }) => memory).filter((m) => m.appId === appId),
        maxDomains,
      )
      const names = await summariseDomains({
        store, callModel, assistantId, userId, appId, domains: appDomains,
      })
      domainsSummarized += names.length
      await store.pruneStaleDomainSummaries(assistantId, userId, appId, names)
    }
  }

  // ── 7. Log + analytics ──
  const summary =
    `Scored ${memories.length}, promoted ${promoted}, pruned ${pruned}` +
    (merged ? `, merged ${merged}` : '') +
    (opPruned ? `, op-pruned ${opPruned}` : '') +
    (domainsSummarized ? `, summarised ${domainsSummarized} domains` : '')

  await store.logConsolidation({ assistantId, userId, phase: 'deep', summary, memoriesAffected: affected })

  opts?.onEvent?.({
    type: 'consolidation_completed',
    phase: 'deep',
    memoriesAffected: affected.length,
    merged,
    patternsFound: 0,
    pruned,
    promoted,
    domainsSummarized,
    opPruned,
  })

  return { phase: 'deep', memoriesAffected: affected, summary }
}

// ── Reflection phase: LLM learning from correction history ─────
//
// Sits alongside Light/REM/Deep. Reads the verification streams
// (memory_verifications + brain_verifications + correction_audit) over
// a rolling window, hands the events to an LLM, and writes synthesised
// memories tagged `consolidation:correction-pattern`. The model that
// got things wrong yesterday reads its own corrections as durable
// preferences tomorrow.
//
// Distinct from the memory-/brain-evolution workers (which compute
// deterministic per-axis rates and emit Layer 2 snippets). Reflection
// produces NEW MEMORY ROWS — qualitative, retrievable, citable —
// versus the prompt-bias the evolution workers emit.
//
// Cadence: weekly (same as Deep). Cost: one LLM call per active
// workspace per week. Bounded.
//
// Spec: docs/architecture/brain/corrections.md → "Reflection
// consolidation" (correction-history learning).

/** Provenance tag stamped on memories the reflection phase writes. */
const REFLECTION_OUTPUT_TAG = 'consolidation:correction-pattern'

/** Per-tick correction-event cap. Keeps the LLM prompt bounded and
 *  the cost predictable. Above this, the oldest events are dropped
 *  (recency bias — recent corrections matter more for future model
 *  behaviour than corrections from three weeks ago). */
const REFLECTION_MAX_EVENTS = 20

/** Default lookback window — 14 days. Tighter than the evolution
 *  workers' 30-day window because reflection writes durable rows and
 *  recent signal is more useful than long-tail history. */
const REFLECTION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

/** Minimum events before reflection fires. Below this we'd be asking
 *  the LLM to synthesise from noise. */
const REFLECTION_MIN_EVENTS = 3

export type ReflectionConsolidationOptions = ConsolidationOptions & {
  windowMs?: number
  maxEvents?: number
}

/**
 * Run reflection consolidation for a workspace.
 *
 * Side effects:
 *   - Reads `memory_verifications` + `brain_verifications` +
 *     `correction_audit` via `store.listForReflection`
 *   - Writes 0..N memory rows via `store.create`, tagged
 *     `consolidation:correction-pattern`
 *   - Logs the run via `store.logWorkspaceConsolidation` with
 *     phase='reflection'
 *
 * The LLM is asked to output a JSON list. We parse defensively — a
 * malformed response is treated as "no patterns this tick" rather
 * than a fatal error.
 *
 * `assistantId` is used as the authorship anchor on synthesized rows.
 * Pass the workspace's primary assistant; the synthesized memories
 * are workspace-scoped (`scope='workspace'`) so they're visible to
 * every assistant in the workspace.
 */
export async function runReflectionConsolidation(
  store: MemoryStore,
  callModel: (prompt: string) => Promise<string>,
  params: {
    workspaceId: string
    assistantId: string
    userId: string
  },
  opts?: ReflectionConsolidationOptions,
): Promise<ConsolidationResult> {
  const windowMs = opts?.windowMs ?? REFLECTION_WINDOW_MS
  const maxEvents = opts?.maxEvents ?? REFLECTION_MAX_EVENTS

  const events = await store.listForReflection({
    workspaceId: params.workspaceId,
    sinceMs: windowMs,
    limit: maxEvents,
  })

  if (events.length < REFLECTION_MIN_EVENTS) {
    return {
      phase: 'reflection',
      memoriesAffected: [],
      summary: `Too few corrections for reflection (${events.length} < ${REFLECTION_MIN_EVENTS})`,
    }
  }

  const prompt = buildReflectionPrompt(events)
  const raw = (await callModel(prompt)).trim()
  const patterns = parseReflectionOutput(raw)

  if (patterns.length === 0) {
    return {
      phase: 'reflection',
      memoriesAffected: [],
      summary: `LLM returned no patterns over ${events.length} corrections`,
    }
  }

  // Stamp every synthesised pattern. Sensitivity defaults to 'internal'
  // — the corrections themselves cross sensitivity tiers and the
  // synthesised rule is necessarily a coarser abstraction; reading it
  // back doesn't leak the underlying confidential row content.
  const affected: string[] = []
  for (const p of patterns) {
    try {
      // No cast: the type-erasing `as Parameters<...>` here used to hide a
      // missing `createdByUserId`, so every create threw against the WU-4.5
      // authorship guard and the catch below swallowed it — reflection
      // memories never persisted (2026-07-10 source audit, dead write path).
      // `scope` is the DB vocabulary ('workspace', per the header contract
      // "synthesized memories are workspace-scoped") — the old 'team' value
      // was the tool-surface alias and violates the valid_scope CHECK.
      const memory = await store.create({
        assistantId: params.assistantId,
        userId: params.userId,
        workspaceId: params.workspaceId,
        scope: 'workspace',
        tags: [REFLECTION_OUTPUT_TAG, ...(p.tags ?? [])],
        summary: p.summary,
        detail: p.detail,
        source: 'reflection',
        sensitivity: 'internal',
        createdByUserId: params.userId,
        createdByAssistantId: params.assistantId,
      })
      affected.push(memory.id)
    } catch (err) {
      // Per-pattern failure shouldn't kill the whole reflection run —
      // the LLM might emit a malformed pattern that breaks one create
      // call. Log and continue.
      console.warn(
        '[reflection-consolidation] memory write failed:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  const summary = `Synthesised ${affected.length} patterns from ${events.length} corrections`
  await store.logWorkspaceConsolidation({
    assistantId: params.assistantId,
    workspaceId: params.workspaceId,
    phase: 'reflection',
    summary,
    memoriesAffected: affected,
  })

  opts?.onEvent?.({
    type: 'consolidation_completed',
    phase: 'reflection',
    memoriesAffected: affected.length,
    merged: 0,
    patternsFound: patterns.length,
  })

  return { phase: 'reflection', memoriesAffected: affected, summary }
}

/** LLM prompt template for the reflection phase. */
function buildReflectionPrompt(
  events: Awaited<ReturnType<MemoryStore['listForReflection']>>,
): string {
  const lines = events.map((e, i) => {
    const ageMin = Math.round((Date.now() - e.at.getTime()) / 60_000)
    const ageHuman =
      ageMin < 60
        ? `${ageMin}m ago`
        : ageMin < 1440
        ? `${Math.round(ageMin / 60)}h ago`
        : `${Math.round(ageMin / 1440)}d ago`
    const row = e.rowSummary ? `"${e.rowSummary.slice(0, 120)}"` : `(row ${e.rowId.slice(0, 8)})`
    const reason = e.reason ? ` — user reason: "${e.reason.slice(0, 200)}"` : ''

    // Negative-feedback events carry no model/user JSON delta — they're
    // a turn-level signal that the recalled memory may have steered the
    // model wrong. Render them in a recognisable shape so the LLM can
    // weigh them differently from explicit edit/delete corrections.
    // `reason` here holds either the web feedback modal's free text or
    // the normalised emoji label (`:thumbsdown:`, `:angry:`, etc.).
    if (e.action === 'negative_feedback') {
      return `${i + 1}. [${ageHuman}] negative_feedback on turn that recalled memory ${row}${reason}`
    }

    const delta = e.modelValue !== null && e.userValue !== null
      ? ` (model: ${JSON.stringify(e.modelValue).slice(0, 80)} → user: ${JSON.stringify(e.userValue).slice(0, 80)})`
      : ''
    return `${i + 1}. [${ageHuman}] ${e.primitive} ${e.action}: ${row}${delta}${reason}`
  })

  return `You are the reflection synthesiser for a workspace brain. Your job is to read the user's recent corrections to model-written rows in the brain and extract any durable rules, preferences, or facts the model should learn for future behaviour.

RECENT CORRECTIONS (newest first):
${lines.join('\n')}

INSTRUCTIONS:
- Look for patterns across multiple corrections. A single one-off correction is usually noise; a repeated correction or a thematic cluster is signal.
- Treat \`negative_feedback\` events as softer signal than explicit \`delete\` / \`adjust\` corrections — a thumb-down or 👎 emoji means "this turn was off" but the user did not tell you exactly which memory was wrong. Use them to corroborate patterns you already see in the explicit corrections, not as standalone evidence.
- For each pattern you find, output a JSON object with:
    "summary": one-line statement of the rule/preference/fact (max 200 chars)
    "detail": optional longer-form rationale (max 800 chars)
    "tags": optional string[] of relevance tags (e.g. ["voice", "scope", "person:sarah"])
- Output a JSON array. Wrap nothing else around it. If no patterns are durable, output [].
- Be CONSERVATIVE. It's better to output nothing than to fabricate a pattern from thin signal.
- The patterns will be saved as workspace-shared memories the model reads on every future turn — they should be true workspace conventions, not personal observations.

OUTPUT (JSON array only):`
}

/** Parse the LLM's JSON list response. Defensive — any parse failure
 *  yields an empty list. */
function parseReflectionOutput(raw: string): Array<{
  summary: string
  detail?: string
  tags?: string[]
}> {
  // Strip markdown fences if the model emitted them despite instructions.
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()
  if (stripped.length === 0 || stripped === '[]') return []

  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: Array<{ summary: string; detail?: string; tags?: string[] }> = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    if (typeof obj.summary !== 'string' || obj.summary.length === 0) continue
    out.push({
      summary: obj.summary.slice(0, 500),
      detail: typeof obj.detail === 'string' ? obj.detail.slice(0, 2000) : undefined,
      tags: Array.isArray(obj.tags)
        ? obj.tags.filter((t): t is string => typeof t === 'string').slice(0, 8)
        : undefined,
    })
  }
  return out
}

// ── Deep-phase helpers ─────────────────────────────────────────

type DedupCluster = {
  keepId: string
  mergeIds: string[]
  combinedSummary: string
  combinedDetail: string | null
}

/**
 * Parse the LLM dedup output:
 *
 *   KEEP: <id>
 *   MERGE: <id1>, <id2>, ...
 *   COMBINED_SUMMARY: <text>
 *   COMBINED_DETAIL: <text>
 *
 * Blocks missing KEEP or MERGE (with ≥1 ID) are dropped.
 */
function parseDedupOutput(text: string): DedupCluster[] {
  const blocks: DedupCluster[] = []
  let current: { keepId?: string; mergeIds?: string[]; summary?: string; detail?: string } = {}
  const flush = () => {
    if (current.keepId && current.mergeIds && current.mergeIds.length >= 1 && current.summary) {
      blocks.push({
        keepId: current.keepId,
        mergeIds: current.mergeIds.filter((id) => id !== current.keepId),
        combinedSummary: current.summary.slice(0, DEDUP_SUMMARY_MAX_CHARS),
        combinedDetail: current.detail ? current.detail.slice(0, DEDUP_DETAIL_MAX_CHARS) : null,
      })
    }
    current = {}
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('KEEP:')) {
      flush()
      current.keepId = line.slice('KEEP:'.length).trim()
    } else if (line.startsWith('MERGE:') && current.keepId) {
      current.mergeIds = line.slice('MERGE:'.length).trim().split(',').map((s) => s.trim()).filter(Boolean)
    } else if (line.startsWith('COMBINED_SUMMARY:') && current.keepId) {
      current.summary = line.slice('COMBINED_SUMMARY:'.length).trim()
    } else if (line.startsWith('COMBINED_DETAIL:') && current.keepId) {
      current.detail = line.slice('COMBINED_DETAIL:'.length).trim() || undefined
    }
  }
  flush()
  // Clusters where MERGE became empty after removing keepId are meaningless
  // (nothing to merge into the keeper) — drop them.
  return blocks.filter((b) => b.mergeIds.length > 0)
}

/**
 * LLM-based dedup sweep — the semantic counterpart to Light's Jaccard pass.
 *
 * Groups memories by `(type, sensitivity)` so merges never downgrade
 * sensitivity (a confidential memory can't be laundered into a public
 * one via merge). Identity memories are excluded — identity is sacred
 * and only the user/model can explicitly update it.
 *
 * For each group with ≥ `minGroupSize` memories, one Flash call asks
 * for duplicate clusters. The keeper is updated with a combined
 * summary + detail; the merged memories are hard-deleted.
 *
 * Model IDs are resolved by 8-char prefix — matches the format the
 * prompt uses. Prefix collisions within a group would break this, but
 * UUIDv4 prefix collisions in a group of 30 are vanishingly rare.
 *
 * Returns the IDs that were merged (hard-deleted). The keeper is not
 * in the returned list — it lives on with new summary/detail.
 */
async function runMemoryDedupSweep(params: {
  store: MemoryStore
  callModel: (prompt: string) => Promise<string>
  assistantId: string
  userId: string
  memories: MemoryWithMetrics[]
  minGroupSize: number
  maxGroupSize: number
}): Promise<{ mergedIds: string[] }> {
  const { store, callModel, memories, minGroupSize, maxGroupSize } = params
  const mergedIds: string[] = []

  // Post-Phase-4 (retire-memory-type): bucket by (first-tag,
  // sensitivity). The first tag is a coarse proxy for what was
  // previously the `type` axis (commitment:, consolidation:rem,
  // operational-state, etc.). Untagged rows form one shared bucket.
  // Identity is no longer in memories so no special-case skip.
  const buckets = new Map<string, MemoryWithMetrics[]>()
  for (const m of memories) {
    const tagKey = m.tags[0] ?? 'untagged'
    const key = `${tagKey}::${m.sensitivity}`
    const list = buckets.get(key) ?? []
    list.push(m)
    buckets.set(key, list)
  }

  for (const [, group] of buckets) {
    if (group.length < minGroupSize) continue

    // If the group exceeds maxGroupSize, slice to the most recently
    // created ones — those are the most likely duplicate candidates (the
    // long-lived survivors are usually canonical and stable).
    const subset = group.length > maxGroupSize
      ? [...group].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, maxGroupSize)
      : group

    const byPrefix = new Map<string, MemoryWithMetrics>()
    for (const m of subset) byPrefix.set(m.id.slice(0, 8), m)

    const block = subset
      .map((m) => {
        const detail = m.detail ? ` — ${m.detail.slice(0, 200)}` : ''
        return `[${m.id.slice(0, 8)}] ${m.summary}${detail}`
      })
      .join('\n')

    const prompt = `Review these memories and identify clusters that express the SAME fact or preference, even if phrased differently.

MEMORIES:
${block}

Output each cluster (≥2 IDs, one cluster per block, blank line between blocks):
KEEP: <id_with_best_content>
MERGE: <id1>, <id2>, ...
COMBINED_SUMMARY: <≤${DEDUP_SUMMARY_MAX_CHARS}-char concise hook>
COMBINED_DETAIL: <≤${DEDUP_DETAIL_MAX_CHARS}-char merged content>

Rules:
- Be conservative. Only cluster memories that truly mean the same thing.
- Different aspects of the same topic are NOT duplicates — keep them separate.
- Do NOT output a cluster of a single id.
- COMBINED_SUMMARY is a lookup hook — short and neat.
- COMBINED_DETAIL carries the full merged content.

If no duplicates, output: NO_CLUSTERS`

    const response = await callModel(prompt)
    if (!response || response.trim() === 'NO_CLUSTERS') continue

    const clusters = parseDedupOutput(response)
    const alreadyTouched = new Set<string>()

    for (const cluster of clusters) {
      const keeper = byPrefix.get(cluster.keepId.slice(0, 8))
      if (!keeper) continue
      if (alreadyTouched.has(keeper.id)) continue

      // Resolve merge IDs against the subset; drop any that don't match
      // or were already touched in a prior cluster from the same response.
      const mergeTargets: MemoryWithMetrics[] = []
      for (const mergeId of cluster.mergeIds) {
        const target = byPrefix.get(mergeId.slice(0, 8))
        if (!target) continue
        if (target.id === keeper.id) continue
        if (alreadyTouched.has(target.id)) continue
        // Sanity: only merge within the same sensitivity tier. The bucket
        // guarantees this, but double-check in case the model crossed
        // buckets by accident.
        if (target.sensitivity !== keeper.sensitivity) continue
        mergeTargets.push(target)
      }
      if (mergeTargets.length === 0) continue

      // Apply: update keeper, hard-delete merge targets.
      await store.update(keeper.id, {
        summary: cluster.combinedSummary,
        detail: cluster.combinedDetail ?? undefined,
      })
      alreadyTouched.add(keeper.id)
      for (const target of mergeTargets) {
        await store.deleteMemory(target.id)
        alreadyTouched.add(target.id)
        mergedIds.push(target.id)
      }
    }
  }

  return { mergedIds }
}

/**
 * Ask the model to synthesise a SOUL paragraph from identity + preference
 * memories. Returns null when there is nothing worth synthesising or the
 * model declines to produce anything.
 */
async function synthesiseSoul(params: {
  callModel: (prompt: string) => Promise<string>
  input: { selfEntityAttributes: Record<string, unknown> | null; preferences: MemoryRecord[] }
  mode: 'shared' | 'app'
  sharedSoul?: string | null
}): Promise<string | null> {
  const { selfEntityAttributes, preferences } = params.input
  // Don't burn tokens if there's no signal yet.
  const attrEntries = selfEntityAttributes
    ? Object.entries(selfEntityAttributes).filter(([k]) => k !== 'self')
    : []
  if (attrEntries.length === 0 && preferences.length === 0) return null

  // Post-Phase-4 (retire-memory-type): identity comes from the user's
  // self entity attributes (key/value pairs), not from identity memories.
  // Render as `- key: value` so the prompt template stays close to the
  // pre-Phase-4 shape ("- User's name is Hinson").
  const profileBlock = attrEntries.length
    ? attrEntries
        .map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n')
    : '(none)'
  const preferenceBlock = preferences.length
    ? preferences.map((m) => `- ${m.summary}${m.detail ? `\n  ${m.detail}` : ''}`).join('\n')
    : '(none)'

  const sharedBlock = params.mode === 'app' && params.sharedSoul
    ? `\n\nSHARED SOUL (already synthesised — DO NOT repeat its traits):\n${params.sharedSoul}\n`
    : ''

  const instruction = params.mode === 'shared'
    ? `Synthesise a cohesive behavioural-style paragraph ("SOUL") that describes how to respond to this user across ALL apps. Focus on tone, communication style, formality, language preferences, and any hard boundaries. Do NOT restate specific facts (those live in memory). Keep it under 200 words. If the signal is too thin to say anything useful, output exactly: NO_SOUL`
    : `Synthesise a DELTA paragraph capturing behavioural style that is specific to THIS app and DIFFERS from the shared SOUL. Only include traits not already covered above. Keep it under 150 words. If there is no meaningful delta, output exactly: NO_SOUL`

  const prompt = `You are the personality synthesiser for a workspace brain.

USER PROFILE (from self entity attributes):
${profileBlock}

PREFERENCE MEMORIES:
${preferenceBlock}${sharedBlock}

${instruction}`

  const result = (await params.callModel(prompt)).trim()
  if (!result || result === 'NO_SOUL') return null
  return result
}

/**
 * Cluster memories into domains for summary generation. We bucket by the
 * first tag when present, otherwise by memory `type`. A rough heuristic —
 * good enough for MVP at the 50-memory scale where this kicks in, and
 * easily upgraded to embedding-based clustering once that lands.
 */
export function bucketDomains(
  memories: MemoryWithMetrics[],
  maxDomains: number,
): Map<string, MemoryWithMetrics[]> {
  const buckets = new Map<string, MemoryWithMetrics[]>()
  for (const m of memories) {
    // Post-Phase-4 (retire-memory-type): no `type` fallback. Untagged
    // memories share the 'untagged' bucket.
    const key = (m.tags[0] ?? 'untagged').toLowerCase()
    const list = buckets.get(key) ?? []
    list.push(m)
    buckets.set(key, list)
  }

  if (buckets.size <= maxDomains) return buckets

  // Too many domains — keep the biggest ones, lump the rest into 'other'.
  const sorted = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length)
  const kept = new Map<string, MemoryWithMetrics[]>(sorted.slice(0, maxDomains - 1))
  const other: MemoryWithMetrics[] = []
  for (const [, list] of sorted.slice(maxDomains - 1)) other.push(...list)
  if (other.length > 0) kept.set('other', other)
  return kept
}

/**
 * Per-domain summarisation. One LLM call per bucket with >= 2 memories
 * (single-entry buckets get a trivial summary straight from the memory so
 * we don't burn tokens on noise). Returns the list of domain names that
 * were upserted so the caller can prune stale rows.
 */
async function summariseDomains(params: {
  store: MemoryStore
  callModel: (prompt: string) => Promise<string>
  assistantId: string
  userId: string
  appId: string | null
  domains: Map<string, MemoryWithMetrics[]>
}): Promise<string[]> {
  const upserted: string[] = []

  for (const [domain, bucket] of params.domains) {
    if (bucket.length === 0) continue

    let summary: string
    if (bucket.length === 1) {
      summary = bucket[0].summary
    } else {
      const block = bucket
        .map((m) => `- [${m.id.slice(0, 8)}] ${m.summary}${m.detail ? ` — ${m.detail}` : ''}`)
        .join('\n')
      const prompt = `Summarise the following ${bucket.length} memories about "${domain}" into a single dense sentence capturing the gist. Do not list every detail — synthesise.

${block}

Output a single line, no preamble.`
      summary = (await params.callModel(prompt)).trim().split('\n')[0] ?? ''
      if (!summary) summary = `${bucket.length} entries about ${domain}`
    }

    await params.store.upsertDomainSummary({
      assistantId: params.assistantId,
      userId: params.userId,
      appId: params.appId,
      domain,
      summary,
      memoryIds: bucket.map((m) => m.id),
    })
    upserted.push(domain)
  }

  return upserted
}

/**
 * A crude change-magnitude signal for analytics. 0 means unchanged, 1 means
 * completely different. Character-level edit distance would be more faithful
 * but also more expensive; this approximation is fine for bucketing trends.
 */
function changeMagnitude(previous: string | null | undefined, next: string): number {
  if (!previous) return 1
  if (previous === next) return 0
  const shared = commonPrefixLength(previous, next)
  const longer = Math.max(previous.length, next.length)
  return longer === 0 ? 0 : 1 - shared / longer
}

function commonPrefixLength(a: string, b: string): number {
  const len = Math.min(a.length, b.length)
  let i = 0
  while (i < len && a[i] === b[i]) i++
  return i
}

// ── Similarity helper ──────────────────────────────────────────

function computeSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/))
  const wordsB = new Set(b.toLowerCase().split(/\s+/))
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length
  const union = new Set([...wordsA, ...wordsB]).size
  return union === 0 ? 0 : intersection / union // Jaccard similarity
}

// ── Team consolidation wrappers ───────────────────────────────
//
// Thin wrappers that reuse the same scoring/dedup logic but operate on
// (assistant_id, workspace_id) tuples instead of (assistant_id, user_id).

export async function runTeamLightConsolidation(
  store: MemoryStore,
  assistantId: string,
  workspaceId: string,
  opts?: ConsolidationOptions,
): Promise<ConsolidationResult> {
  // System-level read — `getWorkspaceIndexSystem` skips per-viewer
  // projection (no user filter, no clearance) because team
  // consolidation operates across every user's contribution.
  const index = await store.getWorkspaceIndexSystem(assistantId, workspaceId, true)
  const affected: string[] = []

  for (let i = 0; i < index.length; i++) {
    for (let j = i + 1; j < index.length; j++) {
      const a = index[i]
      const b = index[j]
      // Post-Phase-4: keep REM-output and user-generated rows in
      // separate dedup groups (see Light phase comment).
      const aIsRemOutput = isRemOutput(a)
      if (aIsRemOutput !== isRemOutput(b)) continue
      const similarity = computeSimilarity(a.summary, b.summary)
      const threshold = aIsRemOutput ? 0.6 : 0.9
      if (similarity >= threshold) {
        const bFull = await store.getByIdSystem(b.id)
        if (bFull) {
          const aFull = await store.getByIdSystem(a.id)
          const mergedDetail = mergeDetails(aFull?.detail, bFull.detail)
          await store.update(a.id, { detail: mergedDetail })
          await store.update(b.id, { confidence: 0 })
          affected.push(b.id)
        }
      }
    }
  }

  const summary = `Deduped ${affected.length} team memories`
  await store.logWorkspaceConsolidation({ assistantId, workspaceId, phase: 'light', summary, memoriesAffected: affected })

  opts?.onEvent?.({
    type: 'consolidation_completed',
    phase: 'light',
    memoriesAffected: affected.length,
    merged: affected.length,
    patternsFound: 0,
  })

  return { phase: 'light', memoriesAffected: affected, summary }
}

export async function runTeamDeepConsolidation(
  store: MemoryStore,
  assistantId: string,
  workspaceId: string,
  callModel: (prompt: string) => Promise<string>,
  opts?: DeepConsolidationOptions,
): Promise<ConsolidationResult> {
  const promoteThreshold = opts?.promoteScoreThreshold ?? PROMOTE_THRESHOLD_DEFAULT
  const pruneThreshold = opts?.pruneScoreThreshold ?? PRUNE_THRESHOLD_DEFAULT
  const pruneAfterDays = opts?.pruneAfterDays ?? PRUNE_AGE_DEFAULT_DAYS

  const memories = await store.listTeamWithMetrics(assistantId, workspaceId)
  const affected: string[] = []
  let pruned = 0
  let promoted = 0

  // Score + promote
  for (const memory of memories) {
    const score = computeConsolidationScore({
      recallCount: memory.recallCount,
      usefulRecallCount: memory.usefulRecallCount,
      uniqueQueries: memory.uniqueQueries,
      recallDays: memory.recallDays,
      ageDays: memory.ageDays,
      tags: memory.tags,
    })
    const boost = score >= promoteThreshold
    await store.writeConsolidationScore(memory.id, score, boost)
    if (boost) promoted++
  }

  // Prune — REM-output rows (tagged `consolidation:rem`) get the
  // shorter 7-day age gate; user-generated rows keep `pruneAfterDays`.
  // Post-Phase-4: no identity-guard needed.
  const remPruneAgeDays = Math.min(7, pruneAfterDays)
  for (const memory of memories) {
    const score = computeConsolidationScore({
      recallCount: memory.recallCount,
      usefulRecallCount: memory.usefulRecallCount,
      uniqueQueries: memory.uniqueQueries,
      recallDays: memory.recallDays,
      ageDays: memory.ageDays,
      tags: memory.tags,
    })
    if (score >= pruneThreshold) continue
    const minAge = isRemOutput(memory) ? remPruneAgeDays : pruneAfterDays
    if (memory.ageDays < minAge) continue
    await store.deleteMemory(memory.id)
    affected.push(memory.id)
    pruned++
  }

  const summary = `Scored ${memories.length}, promoted ${promoted}, pruned ${pruned} team memories`
  await store.logWorkspaceConsolidation({ assistantId, workspaceId, phase: 'deep', summary, memoriesAffected: affected })

  opts?.onEvent?.({
    type: 'consolidation_completed',
    phase: 'deep',
    memoriesAffected: affected.length,
    merged: 0,
    patternsFound: 0,
    pruned,
    promoted,
  })

  return { phase: 'deep', memoriesAffected: affected, summary }
}

// ── Workspace-scoped REM emission target: S10 umbrella pass ─────
//
// REM has historically been per-user; S10 is per-workspace. This
// helper preserves the per-phase pure-function shape: caller passes
// in the workspace, the store, the digest store, the embedding
// callback, and a `callModel`. The worker iterates active
// workspaces and calls it.
//
// `runSkillUmbrellaPass` is the implementation in
// `./skill-umbrella.ts`; this wrapper is the named hook surfaced
// alongside the other REM emission targets so future phases (e.g.
// kb-gap aggregation) can register the same shape here.

export async function runREMSkillUmbrella(
  params: RunSkillUmbrellaPassParams,
): Promise<RunSkillUmbrellaPassResult> {
  return runSkillUmbrellaPass(params)
}

// ── Workspace-scoped Deep emission target: CL-8 decay ───────────

export async function runDeepSkillDecay(
  params: RunSkillDecayParams,
): Promise<RunSkillDecayResult> {
  return runSkillDecay(params)
}
