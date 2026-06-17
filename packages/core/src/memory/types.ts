/**
 * Memory store interface.
 * Injected by the API layer into the memory tools and consolidation phases.
 * Core package has no direct DB dependency.
 *
 * WU-4.2b: user-facing read methods take a leading `ctx: AccessContext`
 * carrying viewer projection (workspace + visibility-double + optional
 * clearance). System-only methods (consolidation worker enumerations,
 * `consolidation_logs` reads, SOUL synthesis) keep their legacy
 * (assistant_id, user_id|workspace_id) signatures — they bypass per-
 * viewer projection per `permissions.md` § Privileged-service exception.
 */

import type { AccessContext } from '../security/access-context.js'
import type { Sensitivity } from '../security/sensitivity.js'

export type MemoryRecord = {
  id: string
  scope: string
  summary: string
  detail: string | null
  /**
   * Single semantic axis. Voice rules are tagged `voice` (drives the
   * `## Voice Rules` block). Lifecycle markers ride here too:
   * `commitment:open`, `consolidation:rem`, `operational-state`, etc.
   * Post-Phase-4 (retire-memory-type plan): replaces the legacy
   * `type` enum + `category` column.
   */
  tags: string[]
  confidence: number
  sensitivity: Sensitivity
  workspaceId?: string | null
}

/**
 * A memory enriched with the scoring signals Deep consolidation needs.
 * `ageDays` is computed by the store relative to "now" at fetch time.
 */
export type MemoryWithMetrics = MemoryRecord & {
  assistantId: string
  userId: string
  appId: string | null
  recallCount: number
  usefulRecallCount: number
  uniqueQueries: number
  recallDays: number
  ageDays: number
  createdAt: Date
}

/**
 * SOUL synthesis input — post-Phase-4 (retire-memory-type plan).
 *
 * Identity is no longer a memory `type`; it lives on the user's self
 * entity attributes. SOUL synthesis reads attributes + remaining
 * preferences to compose the per-user behavioural-style paragraph.
 *
 * `selfEntityAttributes` is `null` when the user has no self entity
 * in this workspace yet — the synthesis prompt then operates on
 * preferences alone.
 */
export type SoulSynthesisInput = {
  selfEntityAttributes: Record<string, unknown> | null
  preferences: MemoryRecord[]
}

export type MemoryStore = {
  create(params: {
    assistantId: string
    userId: string
    scope?: string
    tags?: string[]
    summary: string
    detail?: string
    confidence?: number
    source?: string
    sourceSessionId?: string
    workspaceId?: string
    sensitivity: Sensitivity
    /** Compartment set (MLS category axis) to stamp on the row. Default '{}'. */
    compartments?: string[]
    /**
     * WU-4.5 authorship — every brain-primitive row records who created
     * it. Required at the interface level: the underlying DB helper
     * (`createMemory`) calls `assertAuthorshipPresent` and throws on
     * missing/empty values, so silently omitting this here always
     * resulted in a runtime failure that callers' try/catches typically
     * swallowed as `console.warn`. Declaring it required surfaces the
     * gap at compile time instead.
     */
    createdByUserId: string
    createdByAssistantId?: string | null
    sourceEpisodeId?: string | null
    /**
     * Optional entity IDs this memory mentions. The DB adapter fires a
     * `mentioned` edge for each (WU-1.7). Empty/absent = no edge.
     */
    linkedEntityIds?: readonly string[]
  }): Promise<MemoryRecord>

  update(id: string, updates: {
    summary?: string
    detail?: string
    confidence?: number
    tags?: string[]
  }): Promise<MemoryRecord | null>

  getById(ctx: AccessContext, id: string): Promise<MemoryRecord | null>

  search(ctx: AccessContext, params: {
    query: string
    limit?: number
    /** Match memories whose ID starts with this prefix (for truncated index IDs) */
    idPrefix?: string
  }): Promise<MemoryRecord[]>

  getIdentity(ctx: AccessContext): Promise<MemoryRecord[]>

  /**
   * `validOnly=true` filters out bi-temporally tombstoned rows
   * (`valid_to IS NOT NULL` — superseded by a newer version). Consolidation
   * passes `true` so dedup/scoring/SOUL don't see dead rows. Default `false`
   * preserves the legacy behavior for compaction / inter-assistant / chat /
   * public-api callers, which still surface superseded rows today.
   */
  getIndex(ctx: AccessContext, validOnly?: boolean): Promise<Array<{
    id: string; summary: string; tags: string[]; sensitivity: Sensitivity
  }>>

  /**
   * System-level read for the consolidation worker. Bypasses per-viewer
   * projection — see `permissions.md` § Privileged-service exception.
   * Do not call from chat tools or routes.
   */
  getIndexSystem(assistantId: string, userId: string, validOnly?: boolean): Promise<Array<{
    id: string; summary: string; tags: string[]; sensitivity: Sensitivity
  }>>

  /**
   * System-level read for the consolidation worker. Bypasses per-viewer
   * projection — see `permissions.md` § Privileged-service exception.
   * Do not call from chat tools or routes.
   */
  getByIdSystem(id: string): Promise<MemoryRecord | null>

  /**
   * Ranked, capped, identity-excluded slice of the memory index for
   * per-turn system prompt injection.
   *
   * The full index (`getIndex`) grows linearly with memory count and
   * would dominate the system prompt for power users (see
   * `docs/architecture/context-engine/memory-system.md` → "Index cap").
   * Per-turn callers use this method instead; consolidation / compaction
   * / inter-assistant still use the uncapped `getIndex`.
   *
   * Ordering: `last_recalled_at DESC NULLS LAST, recall_count DESC,
   * updated_at DESC` — most useful / most fresh first.
   *
   * `totalCount` is the number of non-identity memories that match the
   * scope (before LIMIT). Callers pass it into `buildMemoryContext` so
   * the model can see "N more memories stored — use getMemory to
   * search" when the cap trims rows.
   */
  getIndexRanked(
    ctx: AccessContext,
    limit: number,
  ): Promise<{
    rows: Array<{
      id: string
      summary: string
      tags: string[]
      sensitivity: Sensitivity
      /** When the row was written. Surfaced on index lines so the model
       *  sees stale operational snapshots as visibly old — a row from
       *  "yesterday" is not a live fact. See `buildMemoryContext`. */
      createdAt: Date
    }>
    totalCount: number
  }>

  trackRecall(memoryId: string, queryHash?: string): Promise<void>

  /** Track whether a recalled memory was actually useful in the response. */
  trackRecallOutcome(memoryId: string, useful: boolean): Promise<void>

  getSoul(assistantId: string, userId: string, appId?: string): Promise<string | null>

  /** Count total memories for a viewer within their workspace. Used for plan-based caps. */
  count(ctx: AccessContext): Promise<number>

  // ── Deep consolidation surface ───────────────────────────────
  // These methods are only used by runDeepConsolidation and the
  // consolidation worker. They are grouped here (not a separate store
  // interface) because the API layer implements all memory-adjacent
  // state with the same pg pool and RLS model.

  /**
   * List every memory for (assistant, user) enriched with the scoring
   * signals Deep phase needs: recall_count, unique query hashes, recall
   * days, age in days, created_at. The age-in-days field is computed
   * server-side against `now()` so consolidation logic stays clock-free.
   */
  listWithMetrics(assistantId: string, userId: string): Promise<MemoryWithMetrics[]>

  /**
   * Persist a computed consolidation score. When `boostConfidence` is true,
   * the memory's `confidence` is also raised (capped at 1.0) and
   * `promoted_at` is set. Used by the Deep phase scoring loop.
   */
  writeConsolidationScore(id: string, score: number, boostConfidence: boolean): Promise<void>

  /** Hard-delete a memory. Used by Deep phase pruning. */
  deleteMemory(id: string): Promise<void>

  /**
   * Return model-written memories tagged `operational-state` older
   * than `minAgeDays` that are candidates for the operational-pattern
   * prune. Post-Phase-4 (retire-memory-type Q4 lock): the narrowing
   * tag replaces the legacy `type='context'` filter; any callsite
   * (cron executor, telegram session, etc.) that emits short-lived
   * operational state SHOULD tag it `operational-state`. Returns id
   * + summary + detail so the consolidation regex can scan both — a
   * benign summary ("Pill reminder completed") can still carry
   * operational detail ("2.5 hours overdue") that poisons later
   * turns if left behind. `minAgeDays` accepts fractional values
   * (0.25 = 6 hours).
   */
  listCronContextCandidatesForPrune(
    assistantId: string,
    userId: string,
    minAgeDays: number,
  ): Promise<Array<{ id: string; summary: string; detail: string | null }>>

  /**
   * Fetch the identity + preference memories that drive SOUL synthesis.
   * When `appId` is null/omitted the result is the shared-scope block used
   * for the per-user shared SOUL. Otherwise it returns the app-scoped
   * block used for the per-user per-app SOUL delta.
   */
  listForSoulSynthesis(assistantId: string, userId: string, appId?: string | null): Promise<SoulSynthesisInput>

  /**
   * Upsert a SOUL row (shared when appId=null, per-app otherwise).
   * Writing empty content is a no-op so callers can safely skip synthesis
   * when the LLM declines to produce anything.
   */
  upsertSoul(assistantId: string, userId: string, appId: string | null, content: string): Promise<void>

  /**
   * Upsert a single domain summary row. The unique key is
   * (assistant_id, user_id, app_id, domain).
   */
  upsertDomainSummary(params: {
    assistantId: string
    userId: string
    appId?: string | null
    domain: string
    summary: string
    memoryIds: string[]
  }): Promise<void>

  /**
   * Delete domain summaries for (assistant, user, app) whose domain is NOT
   * in `keepDomains`. Called at the end of a Deep run so stale domains
   * disappear. Returns the number of rows removed.
   */
  pruneStaleDomainSummaries(
    assistantId: string,
    userId: string,
    appId: string | null,
    keepDomains: string[],
  ): Promise<number>

  /**
   * Append a row to `consolidation_logs`. Called by every phase that
   * actually did work so the user-facing "why did this memory disappear"
   * view has an audit trail.
   */
  logConsolidation(params: {
    assistantId: string
    userId: string
    phase: 'light' | 'rem' | 'deep' | 'reflection'
    summary: string
    memoriesAffected: string[]
  }): Promise<void>

  /**
   * Enumerate the distinct (assistant_id, user_id) tuples that have any
   * memories stored. Used by the consolidation worker to pick which users
   * need a consolidation tick.
   */
  listMemoryUsers(): Promise<Array<{ assistantId: string; userId: string }>>

  /**
   * Return the most recent `consolidation_logs.created_at` for the given
   * (assistant, user, phase) — used by the consolidation worker to decide
   * whether a phase is due. `null` means "never run".
   */
  getLastPhaseAt(
    assistantId: string,
    userId: string,
    phase: 'light' | 'rem' | 'deep' | 'reflection',
  ): Promise<Date | null>

  /**
   * True iff the (assistant, user) has either an enabled scheduled job or a
   * user-role message in a human-facing channel (cron / assistant-call /
   * notification excluded) within the last 7 days. Drives consolidation
   * gating so ghost users don't burn REM/Deep tokens.
   */
  hasRecentActivity(assistantId: string, userId: string): Promise<boolean>

  // ── Team memory surface ──────────────────────────────────────────
  // Methods for reading/writing team-scoped shared memories. Team memories
  // have workspace_id set and are visible to all team members.

  /** Get team identity memories (shared facts visible to all members). */
  getWorkspaceIdentity(ctx: AccessContext): Promise<MemoryRecord[]>

  /**
   * Get team memory index (summary-only) for system prompt injection.
   *
   * `validOnly=true` filters out bi-temporally tombstoned rows; see
   * `getIndex` for the policy split.
   */
  getWorkspaceIndex(ctx: AccessContext, validOnly?: boolean): Promise<Array<{
    id: string; summary: string; tags: string[]; sensitivity: Sensitivity
  }>>

  /**
   * System-level read for the team consolidation worker. Bypasses
   * per-viewer projection — see `permissions.md` § Privileged-service
   * exception. Do not call from chat tools or routes.
   */
  getWorkspaceIndexSystem(assistantId: string, workspaceId: string, validOnly?: boolean): Promise<Array<{
    id: string; summary: string; tags: string[]; sensitivity: Sensitivity
  }>>

  /**
   * Get team memories carrying a specific tag (e.g. 'voice'). Used
   * by the L1 prompt loader to lift tagged rows into a dedicated
   * section. Full records (summary + detail) so the rendered block
   * can show the rule rationale, unlike the index which is
   * summary-only.
   *
   * Post-Phase-4 (retire-memory-type Q3 lock): the method name is
   * preserved for test-stub compatibility, but it now reads by tag
   * (`<tag> = ANY(tags)`) instead of the dropped `category` column.
   * Future rename: `getWorkspaceMemoriesByTag`.
   *
   * See docs/architecture/feed/voice-learning.md.
   */
  getWorkspaceMemoriesByCategory(
    ctx: AccessContext,
    tag: string,
  ): Promise<MemoryRecord[]>

  /** Search team memories (FTS + fallback, same as personal search). */
  searchTeam(ctx: AccessContext, params: {
    query: string
    limit?: number
    idPrefix?: string
  }): Promise<MemoryRecord[]>

  /** Enumerate (assistant_id, workspace_id) pairs with team memories. */
  listWorkspaceMemoryGroups(): Promise<Array<{ assistantId: string; workspaceId: string }>>

  /** List team memories with scoring metrics for Deep consolidation. */
  listTeamWithMetrics(assistantId: string, workspaceId: string): Promise<MemoryWithMetrics[]>

  /** Last consolidation run for a team phase. */
  getLastWorkspacePhaseAt(assistantId: string, workspaceId: string, phase: 'light' | 'rem' | 'deep' | 'reflection'): Promise<Date | null>

  /** Log a team consolidation run. */
  logWorkspaceConsolidation(params: {
    assistantId: string
    workspaceId: string
    phase: 'light' | 'rem' | 'deep' | 'reflection'
    summary: string
    memoriesAffected: string[]
  }): Promise<void>

  // ── Reflection (LLM learning from correction history) ──────────

  /**
   * Load recent correction events for reflection consolidation. UNIONs
   * `memory_verifications` (mig 165) + `brain_verifications` (mig 174)
   * + `correction_audit` (mig 152) over a rolling window, joined to
   * each primitive's row table for a short row summary.
   *
   * The reflection phase (`runReflectionConsolidation`) feeds these
   * events into an LLM and writes synthesized memories tagged
   * `consolidation:correction-pattern`. v1 cap is small (~20 events
   * per workspace per tick) to keep the LLM prompt bounded.
   *
   * System-level — caller is the consolidation worker; no per-user
   * RLS context.
   */
  listForReflection(params: {
    workspaceId: string
    sinceMs: number
    limit?: number
  }): Promise<Array<{
    id: string
    /** confirm / adjust_* / edit_* / delete / retract */
    action: string
    /** memory / entity / entity_link / task / contact / company / deal / workspace_file */
    primitive: string
    rowId: string
    /** Best-effort summary of the affected row (memory.summary, entity.display_name, task.title, etc.). NULL if the row no longer exists. */
    rowSummary: string | null
    /** Free-text user reason on the correction, when supplied. */
    reason: string | null
    /** JSONB before-value (model's original) — adjust/edit only. */
    modelValue: unknown
    /** JSONB after-value (user's correction) — adjust/edit only. */
    userValue: unknown
    at: Date
  }>>

  // ── Commitment-memory lifecycle ─────────────────────────────────

  /**
   * List open commitment-memories — rows tagged `commitment:open` whose
   * supersession chain has not yet closed. Drives
   * `createCommitmentLifecycleWorker`. Filters are independent: pass
   * `assistantId`, `workspaceId`, both, or neither.
   *
   * See docs/architecture/brain/corrections.md → "Commitment-memory
   * lifecycle" and decisions-log.md → "SV — Commitment-memory convention".
   */
  listOpenCommitments(params: {
    workspaceId?: string | null
    assistantId?: string | null
    limit?: number
  }): Promise<MemoryRecord[]>

  // ── Cross-instance coordination ─────────────────────────────────

  /**
   * Run `fn` while holding an advisory lock. The implementation must:
   *  1. Check out a dedicated DB connection (not from the pool).
   *  2. Acquire `pg_try_advisory_lock(lockId)` on that connection.
   *  3. If acquired, run `fn()`, then release the lock.
   *  4. If not acquired (another instance holds it), skip `fn` and return false.
   *
   * Returns true if `fn` ran, false if the lock was held by another instance.
   *
   * Implementations that don't support process-level locks (e.g. test
   * fakes) may omit this method — the worker falls back to running
   * without coordination (single-instance assumption).
   *
   * **Implementation note.** The DB-backed implementation in
   * `@sidanclaw/api` is row-based (`worker_locks` table) — acquire/
   * heartbeat/release each check out a pool connection for a single
   * statement and return it. The lock itself is the row, not a
   * connection-tied resource. The previous `pg_try_advisory_lock`
   * implementation tied lock-hold to connection-hold and pinned a
   * pool slot for the entire `fn()` duration; under a low connection
   * ceiling (db-f1-micro) that exhausted the pool. See
   * `docs/architecture/context-engine/memory-consolidation.md` →
   * "Lock pattern".
   */
  withWorkerLock?(
    lockId: number,
    fn: () => Promise<void>,
    options?: { holderLabel?: string; ttlMs?: number },
  ): Promise<boolean>
}
