import { createHash } from 'node:crypto'
import { ContextScopeAccumulator, DerivedScopeError,bindScopeSource,bindScopeSources,boundScopeSources, type EntityLinksStore, type MemoryRecord, type MemoryStore, type ScopeSource } from '@use-brian/core'
import { query } from './client.js'
import {readRetainedContextFrame,writeRetainedContextFrame} from './session-context-revisions.js'
import {readExternalSourceAncestors} from '../application-platform/external-source-ancestry.js'
import {readApplicationFieldAncestors} from '../application-platform/field-evidence.js'
import { readReflectionReceipt, type ReflectionReceiptKind } from './reflection-evidence.js'
import { writeScopedSummary, getSoulContext } from './scoped-summary-store.js'
import {
  emitCreatedMemoryEdges,createMemory, updateMemory, getMemoryById, getMemoryByIdSystem, searchMemories, searchMemoriesByIdPrefix,
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

type MemorySourceRow = Pick<MemoryRecord, 'id' | 'workspaceId' | 'userId' | 'assistantId' | 'sensitivity' | 'compartments' | 'projectIds' | 'scopeVersion' | 'scopeSource'>

function bindMemorySource<T extends MemorySourceRow>(row: T): T {
  // These are canonical DB projections, never parsed tool content. Missing
  // provenance is an adapter error, not an assertion that the row is General.
  return bindScopeSource(row, row.scopeSource ?? {
    resourceKind: 'memory', resourceId: row.id, version: row.scopeVersion!,
    workspaceId: row.workspaceId!, userId: row.userId!, assistantId: row.assistantId!,
    sensitivity: row.sensitivity, compartments: row.compartments!, projectIds: row.projectIds!,
  })
}

function projectMemory(m: MemoryRecord): MemoryRecord {
  return bindScopeSources(bindMemorySource({ id: m.id, scope: m.scope, summary: m.summary,
    detail: m.detail, tags: m.tags, confidence: m.confidence, sensitivity: m.sensitivity,
    workspaceId: m.workspaceId, userId: m.userId, assistantId: m.assistantId,
    compartments: m.compartments, projectIds: m.projectIds, scopeVersion: m.scopeVersion,
    ...(m.scopeSource ? { scopeSource: m.scopeSource } : {}),
  }),boundScopeSources(m))
}

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
      const {authority,...command}=params
      if(authority){
        const {execution,accumulator}=authority
        if(!(accumulator instanceof ContextScopeAccumulator)||command.createdByUserId!==execution.security.access.userId
          ||command.createdByAssistantId!=null&&command.createdByAssistantId!==execution.assistant.id
          ||command.assistantId!==execution.assistant.id||command.workspaceId!==undefined&&command.workspaceId!==execution.security.access.workspaceId
          ||command.sourceSessionId!==undefined&&command.sourceSessionId!==execution.lifecycle.sessionId)throw new DerivedScopeError('scope_evidence_missing')
        const roots=new ContextScopeAccumulator({sources:[...(accumulator.evidence.sources??[]),...(command.derivation?.sources??[])]})
        const initial=roots.evidence.sources??[],workspaceId=execution.security.access.workspaceId
        roots.note({sources:[...await readExternalSourceAncestors(workspaceId,initial),...await readApplicationFieldAncestors(workspaceId,initial)]})
        const sources=roots.evidence.sources??[]
        const m=await writeRetainedContextFrame(authority,sources,client=>createMemory({...command,workspaceId,
          createdByAssistantId:command.createdByAssistantId??undefined,sourceEpisodeId:command.sourceEpisodeId??undefined,
          ...(sources.length?{derivation:{producer:command.derivation?.producer??'tool:saveMemory:create',sources}}:{})},undefined,client))
        // Preserve the canonical hook after commit. Source-backed graph
        // publication still owns its independent current authority contract.
        emitCreatedMemoryEdges(m,{...command,...(sources.length?{derivation:{producer:command.derivation?.producer??'tool:saveMemory:create',sources}}:{}),createdByAssistantId:command.createdByAssistantId??undefined,sourceEpisodeId:command.sourceEpisodeId??undefined},entityLinks)
        return projectMemory(m)
      }
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
      return projectMemory(m)
    },

    async update(id, updates, access, operation) {
      if (operation) {
        const { authority, expectedVersion, writeFields } = operation
        const { execution, accumulator } = authority
        if (!(accumulator instanceof ContextScopeAccumulator) || !access || access.systemRead
          || access.userId !== execution.security.access.userId || access.workspaceId !== execution.security.access.workspaceId
          || access.assistantId !== execution.assistant.id || !expectedVersion) throw new DerivedScopeError('scope_evidence_missing')
        const prior = await getMemoryById(access, id, undefined, undefined, authority)
        if (!prior || prior.scopeVersion !== expectedVersion) throw new DerivedScopeError('scope_source_changed')
        const roots = new ContextScopeAccumulator({sources:[...accumulator.evidence.sources ?? [],
          ...updates.derivation?.sources ?? [], ...boundScopeSources(prior)]})
        roots.note({sources:[{resourceKind:'memory',resourceId:prior.id,version:prior.scopeVersion,
          workspaceId:access.workspaceId,userId:prior.userId,assistantId:prior.assistantId,
          sensitivity:prior.sensitivity,compartments:prior.compartments,projectIds:prior.projectIds}]})
        const workspaceId = access.workspaceId, initial = roots.evidence.sources ?? []
        roots.note({sources:[...await readExternalSourceAncestors(workspaceId,initial),
          ...await readApplicationFieldAncestors(workspaceId,initial)]})
        const sources = roots.evidence.sources ?? []
        const contextFingerprint = createHash('sha256').update(JSON.stringify({identity:execution.identity,
          ceiling:execution.security.ceiling,ownership:execution.ownership})).digest('hex')
        const m = await writeRetainedContextFrame(authority,sources,client => updateMemory(id,
          {...updates,derivation:{producer:updates.derivation?.producer ?? 'tool:saveMemory:update',sources}},access,client,
          {expectedVersion,writeFields,assistantId:execution.assistant.id,sessionId:execution.lifecycle.sessionId,contextFingerprint}))
        return m ? projectMemory(m) : null
      }
      const m = await updateMemory(id, updates, access)
      if (!m) return null
      return projectMemory(m)
    },

    async getById(ctx, id,authority) {
      if(authority){
        const {execution,accumulator}=authority
        if(!(accumulator instanceof ContextScopeAccumulator)||ctx.systemRead||ctx.userId!==execution.security.access.userId
          ||ctx.workspaceId!==execution.security.access.workspaceId||ctx.assistantId!==execution.assistant.id)throw new DerivedScopeError('scope_evidence_missing')
        const m=await getMemoryById(ctx,id,undefined,undefined,authority)
        return m?projectMemory(m):null
      }
      const m = await getMemoryById(ctx, id)
      if (!m) return null
      return projectMemory(m)
    },

    async search(ctx, params,authority) {
      // ID prefix lookup (for truncated index IDs like [id:5794afc9])
      if (params.idPrefix) {
        const results = await searchMemoriesByIdPrefix(ctx, {
          idPrefix: params.idPrefix,
          limit: params.limit,
        },authority)
        return bindScopeSources(results.map(projectMemory),boundScopeSources(results))
      }

      const results = await searchMemories(ctx, {
        searchQuery: params.query,
        limit: params.limit,
      },authority)
      return bindScopeSources(results.map(projectMemory),boundScopeSources(results))
    },

    async getIdentity(ctx) {
      const results = await getIdentityMemories(ctx)
      return results.map(projectMemory)
    },

    async getIndex(ctx, validOnly) {
      return (await getMemoryIndex(ctx, validOnly)).map(bindMemorySource)
    },

    async getIndexSystem(assistantId, userId, validOnly) {
      return (await getMemoryIndexSystem(assistantId, userId, validOnly)).map(bindMemorySource)
    },

    async getByIdSystem(id) {
      const m = await getMemoryByIdSystem(id)
      if (!m) return null
      return projectMemory(m)
    },

    async getIndexRanked(ctx, limit) {
      const result = await getMemoryIndexRanked(ctx, limit)
      return { ...result, rows: result.rows.map(bindMemorySource) }
    },

    async trackRecall(memoryId, queryHash) {
      return trackRecall(memoryId, queryHash)
    },

    async trackRecallOutcome(memoryId, useful) {
      return trackRecallOutcome(memoryId, useful)
    },

    getSoulContext,

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
        workspaceId: r.workspaceId, compartments: r.compartments, projectIds: r.projectIds, scopeVersion: r.scopeVersion,
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
      await deleteMemory(id, { actor: 'consolidation_run', reason: 'consolidation' })
    },

    async listCronContextCandidatesForPrune(assistantId, userId, minAgeDays) {
      return listCronContextCandidatesForPrune(assistantId, userId, minAgeDays)
    },

    async listForSoulSynthesis(assistantId, userId, appId) {
      const { selfEntityAttributes, selfEntitySources, preferences } = await listForSoulSynthesis(assistantId, userId, appId ?? null)
      const project = (m: typeof preferences[number]) => ({
        id: m.id, scope: m.scope, summary: m.summary,
        detail: m.detail, tags: m.tags, confidence: m.confidence, sensitivity: m.sensitivity,
        workspaceId: m.workspaceId,userId: m.userId,assistantId: m.assistantId,scopeVersion: m.scopeVersion,compartments: m.compartments,projectIds: m.projectIds,
      })
      return { selfEntityAttributes, selfEntitySources, preferences: preferences.map(project) }
    },

    async upsertSoul(assistantId, userId, appId, content, derivation) {
      if (derivation) return writeScopedSummary({ assistantId,userId,kind: 'soul',slotKey: appId ? `app:${appId}` : 'shared',content,derivation })
      await upsertSoul(assistantId, userId, appId, content)
    },

    async upsertDomainSummary(params) {
      if (params.derivation) return writeScopedSummary({ assistantId: params.assistantId,userId: params.userId,
        kind: 'domain',slotKey: JSON.stringify([params.appId ?? null,params.domain]),content: params.summary,derivation: params.derivation })
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
        sourceKind: ReflectionReceiptKind | null
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
                  'memory_verification'::text AS "sourceKind",
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
                  'brain_verification'::text AS "sourceKind",
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
                  'correction_audit'::text AS "sourceKind",
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
                  'feedback_event'::text AS "sourceKind",
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
      const events: Awaited<ReturnType<MemoryStore['listForReflection']>> = []
      for (const row of result.rows) {
        const verified = row.sourceKind && await readReflectionReceipt(
          workspaceId,row.sourceKind,row.id,row.rowId,
        )
        // Missing/legacy evidence is deliberately left unproven. The phase
        // counts and withholds it before any model call.
        events.push(verified || row)
      }
      return events
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
      return results.map(projectMemory)
    },

    async getWorkspaceIndex(ctx, validOnly) {
      return (await getWorkspaceMemoryIndex(ctx, validOnly)).map(bindMemorySource)
    },

    async getWorkspaceIndexSystem(assistantId, workspaceId, validOnly) {
      return (await getWorkspaceMemoryIndexSystem(assistantId, workspaceId, validOnly)).map(bindMemorySource)
    },

    async getWorkspaceMemoriesByCategory(ctx, tag) {
      const results = await getWorkspaceMemoriesByCategory(ctx, tag)
      return results.map(projectMemory)
    },

    async searchTeam(ctx, params) {
      if (params.idPrefix) {
        const results = await searchWorkspaceMemoriesByIdPrefix(ctx, {
          idPrefix: params.idPrefix,
          limit: params.limit,
        })
        return results.map(projectMemory)
      }

      const results = await searchWorkspaceMemories(ctx, {
        searchQuery: params.query,
        limit: params.limit,
      })
      return results.map(projectMemory)
    },

    async listWorkspaceMemoryGroups() {
      return listWorkspaceMemoryGroups()
    },

    async listTeamWithMetrics(assistantId, workspaceId, page) {
      const rows = await listWorkspaceMemoriesWithMetrics(assistantId, workspaceId, page)
      return rows.map((r) => ({
        id: r.id, scope: r.scope, summary: r.summary,
        detail: r.detail, tags: r.tags, confidence: r.confidence, sensitivity: r.sensitivity, workspaceId: r.workspaceId,
        compartments: r.compartments, projectIds: r.projectIds, scopeVersion: r.scopeVersion,
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
