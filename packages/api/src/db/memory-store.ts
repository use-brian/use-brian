import type { EntityLinksStore, MemoryStore } from '@sidanclaw/core'
import { query } from './client.js'
import {
  createMemory, updateMemory, getMemoryById, getMemoryByIdSystem, searchMemories, searchMemoriesByIdPrefix,
  getIdentityMemories, getMemoryIndex, getMemoryIndexSystem, getMemoryIndexRanked, trackRecall, trackRecallOutcome, getSoul, countMemories,
  listMemoriesWithMetrics, writeConsolidationScore, deleteMemory,
  listCronContextCandidatesForPrune,
  listForSoulSynthesis, upsertSoul, logConsolidation,
  listMemoryUsers, getLastPhaseAt, hasRecentActivity,
  withWorkerLock,
  listOpenCommitments,
  getWorkspaceIdentityMemories, getWorkspaceMemoryIndex, getWorkspaceMemoryIndexSystem, getWorkspaceMemoriesByCategory, searchWorkspaceMemories, searchWorkspaceMemoriesByIdPrefix,
  listWorkspaceMemoryGroups, listWorkspaceMemoriesWithMetrics, getLastWorkspacePhaseAt, logWorkspaceConsolidation,
} from './memories.js'
import {
  upsertDomainSummary, pruneStaleDomainSummaries,
} from './domain-summaries.js'

/**
 * Create a MemoryStore backed by PostgreSQL.
 * Adapts the DB functions to the core package's MemoryStore interface.
 *
 * WU-1.7 — the optional `entityLinks` dependency wires the edge-write
 * hook: `create` emits a `memory → entity` `mentioned` edge per id in
 * the (cast-supplied) `linkedEntityIds` field, fire-and-forget. The
 * dependency is optional so callers that don't carry the graph layer
 * keep working — edges are simply not emitted in that case.
 */
export function createDbMemoryStore(deps: { entityLinks?: EntityLinksStore } = {}): MemoryStore {
  const { entityLinks } = deps
  return {
    async create(params) {
      // WU-4.5 authorship is now declared on the `MemoryStore.create`
      // interface itself — every caller passes `createdByUserId`
      // through, the cast workaround that previously bridged the gap
      // is gone. `createMemory`'s `assertAuthorshipPresent` guard
      // stays in place as belt-and-suspenders against any future
      // store-layer addition that skips the field.
      const m = await createMemory(
        {
          ...params,
          createdByAssistantId: params.createdByAssistantId ?? undefined,
          sourceEpisodeId: params.sourceEpisodeId ?? undefined,
          linkedEntityIds: params.linkedEntityIds,
        },
        entityLinks,
      )
      return { id: m.id, scope: m.scope, summary: m.summary, detail: m.detail, tags: m.tags, confidence: m.confidence, sensitivity: m.sensitivity, workspaceId: m.workspaceId }
    },

    async update(id, updates, access) {
      const m = await updateMemory(id, updates, access)
      if (!m) return null
      return { id: m.id, scope: m.scope, summary: m.summary, detail: m.detail, tags: m.tags, confidence: m.confidence, sensitivity: m.sensitivity, workspaceId: m.workspaceId }
    },

    async getById(ctx, id) {
      const m = await getMemoryById(ctx, id)
      if (!m) return null
      return { id: m.id, scope: m.scope, summary: m.summary, detail: m.detail, tags: m.tags, confidence: m.confidence, sensitivity: m.sensitivity, workspaceId: m.workspaceId }
    },

    async search(ctx, params) {
      // ID prefix lookup (for truncated index IDs like [id:5794afc9])
      if (params.idPrefix) {
        const results = await searchMemoriesByIdPrefix(ctx, {
          idPrefix: params.idPrefix,
          limit: params.limit,
        })
        return results.map((m) => ({
          id: m.id, scope: m.scope, summary: m.summary,
          detail: m.detail, tags: m.tags, confidence: m.confidence, sensitivity: m.sensitivity,
        }))
      }

      const results = await searchMemories(ctx, {
        searchQuery: params.query,
        limit: params.limit,
      })
      return results.map((m) => ({
        id: m.id, scope: m.scope, summary: m.summary,
        detail: m.detail, tags: m.tags, confidence: m.confidence, sensitivity: m.sensitivity,
      }))
    },

    async getIdentity(ctx) {
      const results = await getIdentityMemories(ctx)
      return results.map((m) => ({
        id: m.id, scope: m.scope, summary: m.summary,
        detail: m.detail, tags: m.tags, confidence: m.confidence, sensitivity: m.sensitivity,
      }))
    },

    async getIndex(ctx, validOnly) {
      return getMemoryIndex(ctx, validOnly)
    },

    async getIndexSystem(assistantId, userId, validOnly) {
      return getMemoryIndexSystem(assistantId, userId, validOnly)
    },

    async getByIdSystem(id) {
      const m = await getMemoryByIdSystem(id)
      if (!m) return null
      return { id: m.id, scope: m.scope, summary: m.summary, detail: m.detail, tags: m.tags, confidence: m.confidence, sensitivity: m.sensitivity, workspaceId: m.workspaceId }
    },

    async getIndexRanked(ctx, limit) {
      return getMemoryIndexRanked(ctx, limit)
    },

    async trackRecall(memoryId, queryHash) {
      return trackRecall(memoryId, queryHash)
    },

    async trackRecallOutcome(memoryId, useful) {
      return trackRecallOutcome(memoryId, useful)
    },

    async getSoul(assistantId, userId, appId) {
      return getSoul(assistantId, userId, appId)
    },

    async count(ctx) {
      return countMemories(ctx)
    },

    // ── Deep consolidation surface ───────────────────────────

    async listWithMetrics(assistantId, userId, page) {
      const rows = await listMemoriesWithMetrics(assistantId, userId, page)
      return rows.map((r) => ({
        id: r.id,
        scope: r.scope,
        summary: r.summary,
        detail: r.detail,
        tags: r.tags,
        confidence: r.confidence,
        sensitivity: r.sensitivity,
        assistantId: r.assistantId,
        userId: r.userId,
        appId: r.appId,
        recallCount: r.recallCount,
        usefulRecallCount: r.usefulRecallCount,
        uniqueQueries: r.uniqueQueries,
        recallDays: r.recallDays,
        ageDays: r.ageDays,
        createdAt: r.createdAt,
      }))
    },

    async writeConsolidationScore(id, score, boostConfidence) {
      await writeConsolidationScore(id, score, boostConfidence)
    },

    async deleteMemory(id) {
      await deleteMemory(id)
    },

    async listCronContextCandidatesForPrune(assistantId, userId, minAgeDays) {
      return listCronContextCandidatesForPrune(assistantId, userId, minAgeDays)
    },

    async listForSoulSynthesis(assistantId, userId, appId) {
      const { selfEntityAttributes, preferences } = await listForSoulSynthesis(assistantId, userId, appId ?? null)
      const project = (m: typeof preferences[number]) => ({
        id: m.id, scope: m.scope, summary: m.summary,
        detail: m.detail, tags: m.tags, confidence: m.confidence, sensitivity: m.sensitivity,
      })
      return { selfEntityAttributes, preferences: preferences.map(project) }
    },

    async upsertSoul(assistantId, userId, appId, content) {
      await upsertSoul(assistantId, userId, appId, content)
    },

    async upsertDomainSummary(params) {
      await upsertDomainSummary({
        assistantId: params.assistantId,
        userId: params.userId,
        appId: params.appId ?? null,
        domain: params.domain,
        summary: params.summary,
        memoryIds: params.memoryIds,
      })
    },

    async pruneStaleDomainSummaries(assistantId, userId, appId, keepDomains) {
      return pruneStaleDomainSummaries(assistantId, userId, appId, keepDomains)
    },

    async logConsolidation(params) {
      await logConsolidation(params)
    },

    async listMemoryUsers() {
      return listMemoryUsers()
    },

    async getLastPhaseAt(assistantId, userId, phase) {
      return getLastPhaseAt(assistantId, userId, phase)
    },

    async hasRecentActivity(assistantId, userId) {
      return hasRecentActivity(assistantId, userId)
    },

    // ── Cross-instance coordination ─────────────────────────
    async withWorkerLock(lockId, fn, options) {
      return withWorkerLock(lockId, fn, options)
    },

    // ── Reflection (LLM learning from correction history) ──────────

    async listForReflection({ workspaceId, sinceMs, limit }) {
      const since = new Date(Date.now() - sinceMs)
      const cap = limit ?? 20
      // UNION across the four correction-signal streams. Each branch
      // joins to the right primitive table for the row's short
      // summary (best-effort — NULL when the row has been hard-deleted
      // since the correction landed).
      //
      // Streams:
      //  1. memory_verifications      (mig 165) — explicit inbox actions on memories
      //  2. brain_verifications       (mig 174) — explicit inbox actions on non-memory primitives
      //  3. correction_audit          (mig 152) — system-level retracts/soft_deletes/re_extracts
      //  4. analytics_events feedback (mig 167 join) — thumbs-down on turns that
      //     recalled specific memories. Each negative-feedback row fans out to one
      //     event per recalled memory (a thumb-down on a turn that cited 5
      //     memories yields 5 reflection events). Emoji reactions land in this
      //     same stream — Slack/Telegram reaction-add handlers feed through
      //     `recordFeedback` which writes analytics_events identically to the web
      //     thumbs-down. See packages/shared/src/emoji-reactions.ts.
      //
      // Cross-stream dedup intentionally skipped: a single delete
      // event lives in exactly one stream, and confirm/adjust events
      // never duplicate across streams either. The feedback fan-out
      // is desirable signal — the LLM benefits from seeing "these 5
      // memories were in context when the user was unhappy". ORDER BY
      // at the outer level gives a consistent recency cap.
      const result = await query<{
        id: string
        action: string
        primitive: string
        rowId: string
        rowSummary: string | null
        reason: string | null
        modelValue: unknown
        userValue: unknown
        at: Date
      }>(
        `WITH events AS (
           -- Memory verifications
           SELECT mv.id,
                  mv.action,
                  'memory'::text AS primitive,
                  mv.memory_id AS "rowId",
                  m.summary AS "rowSummary",
                  mv.reason,
                  mv.model_value AS "modelValue",
                  mv.user_value AS "userValue",
                  mv.created_at AS "at"
           FROM memory_verifications mv
           LEFT JOIN memories m ON m.id = mv.memory_id
           WHERE mv.workspace_id = $1
             AND mv.created_at >= $2
             AND mv.action != 'confirm'

           UNION ALL

           -- Brain verifications (non-memory primitives)
           SELECT bv.id,
                  bv.action,
                  bv.target_kind AS primitive,
                  bv.target_id AS "rowId",
                  COALESCE(
                    (SELECT display_name FROM entities WHERE id = bv.target_id AND bv.target_kind = 'entity'),
                    (SELECT title FROM tasks WHERE id = bv.target_id AND bv.target_kind = 'task'),
                    -- Post CRM↔entity collapse (crm-entity-unification): contact /
                    -- company / deal ids ARE entities rows, so all three resolve
                    -- their label from entities.display_name (deals no longer carry
                    -- a separate stage-based label).
                    (SELECT display_name FROM entities
                      WHERE id = bv.target_id AND bv.target_kind IN ('contact', 'company', 'deal')),
                    (SELECT name FROM workspace_files WHERE id = bv.target_id AND bv.target_kind = 'workspace_file')
                  ) AS "rowSummary",
                  bv.reason,
                  bv.model_value AS "modelValue",
                  bv.user_value AS "userValue",
                  bv.created_at AS "at"
           FROM brain_verifications bv
           WHERE bv.workspace_id = $1
             AND bv.created_at >= $2
             AND bv.action != 'confirm'

           UNION ALL

           -- correction_audit (system-level retracts / soft_deletes /
           -- re_extracts / purges). Less rich than the verification
           -- streams but worth surfacing for completeness.
           SELECT ca.id,
                  ca.action,
                  ca.primitive,
                  ca.row_id AS "rowId",
                  NULL::text AS "rowSummary",
                  ca.reason,
                  NULL::jsonb AS "modelValue",
                  NULL::jsonb AS "userValue",
                  ca.created_at AS "at"
           FROM correction_audit ca
           WHERE ca.workspace_id = $1
             AND ca.created_at >= $2
             AND ca.action IN ('retract', 'soft_delete')

           UNION ALL

           -- Negative-feedback events (thumbs-down on web; emoji reaction on
           -- Slack/Telegram via recordFeedback). Joined to memory_recall_events
           -- so each event names which memories were in context for the
           -- offending turn. metadata->>details carries the user free-text
           -- explanation when they provided one (web feedback modal, or the
           -- normalised emoji label from the reaction handler).
           SELECT ae.id,
                  'negative_feedback'::text AS action,
                  'memory'::text AS primitive,
                  mre.memory_id AS "rowId",
                  m.summary AS "rowSummary",
                  ae.metadata->>'details' AS reason,
                  NULL::jsonb AS "modelValue",
                  NULL::jsonb AS "userValue",
                  ae.created_at AS "at"
           FROM analytics_events ae
           JOIN memory_recall_events mre
             ON mre.assistant_message_id = (ae.metadata->>'messageId')::uuid
           LEFT JOIN memories m ON m.id = mre.memory_id
           WHERE ae.event_name = 'feedback_negative'
             AND ae.created_at >= $2
             AND mre.workspace_id = $1
         )
         SELECT * FROM events
         ORDER BY "at" DESC
         LIMIT $3`,
        [workspaceId, since, cap],
      )
      return result.rows
    },

    // ── Commitment-memory lifecycle ─────────────────────────

    async listOpenCommitments(params) {
      const rows = await listOpenCommitments(params)
      return rows.map((m) => ({
        id: m.id, scope: m.scope, summary: m.summary,
        detail: m.detail, tags: m.tags, confidence: m.confidence, sensitivity: m.sensitivity,
        workspaceId: m.workspaceId,
      }))
    },

    // ── Team memory surface ─────────────────────────────────

    async getWorkspaceIdentity(ctx) {
      const results = await getWorkspaceIdentityMemories(ctx)
      return results.map((m) => ({
        id: m.id, scope: m.scope, summary: m.summary,
        detail: m.detail, tags: m.tags, confidence: m.confidence, sensitivity: m.sensitivity, workspaceId: m.workspaceId,
      }))
    },

    async getWorkspaceIndex(ctx, validOnly) {
      return getWorkspaceMemoryIndex(ctx, validOnly)
    },

    async getWorkspaceIndexSystem(assistantId, workspaceId, validOnly) {
      return getWorkspaceMemoryIndexSystem(assistantId, workspaceId, validOnly)
    },

    async getWorkspaceMemoriesByCategory(ctx, tag) {
      const results = await getWorkspaceMemoriesByCategory(ctx, tag)
      return results.map((m) => ({
        id: m.id,
        scope: m.scope,
        summary: m.summary,
        detail: m.detail,
        tags: m.tags,
        confidence: m.confidence,
        sensitivity: m.sensitivity,
        workspaceId: m.workspaceId,
      }))
    },

    async searchTeam(ctx, params) {
      if (params.idPrefix) {
        const results = await searchWorkspaceMemoriesByIdPrefix(ctx, {
          idPrefix: params.idPrefix,
          limit: params.limit,
        })
        return results.map((m) => ({
          id: m.id, scope: m.scope, summary: m.summary,
          detail: m.detail, tags: m.tags, confidence: m.confidence, sensitivity: m.sensitivity, workspaceId: m.workspaceId,
        }))
      }

      const results = await searchWorkspaceMemories(ctx, {
        searchQuery: params.query,
        limit: params.limit,
      })
      return results.map((m) => ({
        id: m.id, scope: m.scope, summary: m.summary,
        detail: m.detail, tags: m.tags, confidence: m.confidence, sensitivity: m.sensitivity, workspaceId: m.workspaceId,
      }))
    },

    async listWorkspaceMemoryGroups() {
      return listWorkspaceMemoryGroups()
    },

    async listTeamWithMetrics(assistantId, workspaceId, page) {
      const rows = await listWorkspaceMemoriesWithMetrics(assistantId, workspaceId, page)
      return rows.map((r) => ({
        id: r.id, scope: r.scope, summary: r.summary,
        detail: r.detail, tags: r.tags, confidence: r.confidence, sensitivity: r.sensitivity, workspaceId: undefined,
        assistantId: r.assistantId, userId: r.userId, appId: r.appId,
        recallCount: r.recallCount, usefulRecallCount: r.usefulRecallCount,
        uniqueQueries: r.uniqueQueries, recallDays: r.recallDays,
        ageDays: r.ageDays, createdAt: r.createdAt,
      }))
    },

    async getLastWorkspacePhaseAt(assistantId, workspaceId, phase) {
      return getLastWorkspacePhaseAt(assistantId, workspaceId, phase)
    },

    async logWorkspaceConsolidation(params) {
      return logWorkspaceConsolidation(params)
    },
  }
}
