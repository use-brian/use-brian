/**
 * Brain-healing chat tools (Q10 of the brain-ingestion-classification
 * design thread). User-visible surface for the self-healing reclassifier.
 *
 *  • `listBrainCandidates`  — view pending candidates + recent reclassifications.
 *  • `dismissBrainCandidate` — reject a pending candidate.
 *  • `acceptBrainCandidate` — apply an attribute candidate via the existing
 *                             `promoteMemoryToEntity` (Q8 delegation).
 *  • `healMemories`          — run the reclassifier on demand against a slice
 *                             of recent memories (rate-limited).
 *
 * Pattern follows `createCorrectionTools` (corrections/tools.ts) — pure
 * orchestration with injected ports; `apps/api` wires DB adapters and
 * registers the tools into the boot-time first-party map.
 *
 * Scope:
 *   - Tools surface only on assistants with `kind='primary' | 'standard'`
 *     (Q10). Distribution apps have no personal brain to heal — the
 *     wiring layer is responsible for the kind gate.
 *   - The `healMemories` rate limit (5/user/day) is enforced inline.
 *   - `undoReclassification` is deferred to a follow-up — the candidate
 *     audit row already records what changed, so manual reversal via
 *     existing tools (`saveMemory`, `retractMemory`, etc.) covers the
 *     escape hatch in v1.
 *
 * [COMP:brain/healing-tools]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import { isAutonomousToolContext } from '../tools/capability-gate.js'
import { createRateLimiter } from '../security/rate-limiter.js'
import {
  promoteMemoryToEntity,
  type MemoryToEntityPromotionPorts,
} from '../corrections/memory-to-entity-promotion.js'
import {
  runReclassification,
  filterMemoriesForReclassification,
  type MemoryForReclassification,
  type ReclassificationDeps,
  type ReclassificationResult,
} from '../consolidation/reclassifier.js'
import {
  runEntityDedupe,
  type EntityDedupeResult,
} from '../consolidation/entity-dedupe.js'
import type { EntityMergeDeps } from '../corrections/entity-merge.js'
import type {
  BrainCandidate,
  BrainCandidateStore,
} from './candidates-types.js'
import type {
  EntityKind,
  EntityLinksStore,
  EntityStore,
} from '../entities/types.js'
import type { MemoryStore } from '../memory/types.js'
import type { LLMProvider } from '../providers/types.js'
import type { TaskStore } from '../tasks/types.js'

export interface HealingToolsDeps {
  candidates: BrainCandidateStore
  memories: MemoryStore
  entities: EntityStore
  entityLinks: EntityLinksStore
  tasks: TaskStore
  /**
   * Merge ports for the `dedupeEntities` self-healing tool. When omitted
   * the tool registers but rejects at execute time — wiring requires the
   * DB adapter that fulfils `EntityMergeRepository` (lives in
   * `packages/api/src/db/entity-merge-store.ts`).
   */
  entityMerge?: EntityMergeDeps
  /**
   * Promotion ports for `acceptBrainCandidate` (attribute case). When
   * omitted, the tool registers but rejects with "promotion ports not
   * wired" at execute time — the other three healing tools still work.
   * Wiring this requires a DB adapter that fulfils the three ports
   * (read memory by id, read entity by id, D.7 supersedeEntity); see
   * `packages/core/src/corrections/memory-to-entity-promotion.ts`.
   */
  promotion?: MemoryToEntityPromotionPorts
  provider: LLMProvider
  /** Model id used by the reclassifier LLM call (Flash-class is fine). */
  reclassifierModel: string
  /**
   * Rate limit for `healMemories` — defaults to 5 invocations per user
   * per 24h per Q10. Tests can override.
   */
  healRateLimiter?: { check(userId: string): boolean }
}

function requireWorkspace(workspaceId: string | null | undefined): string {
  if (!workspaceId) {
    throw new Error('brain healing tool invoked without a workspace context')
  }
  return workspaceId
}

function errorData(err: unknown): { data: string; isError: true } {
  return { data: err instanceof Error ? err.message : String(err), isError: true }
}

function defaultHealRateLimiter() {
  const limiter = createRateLimiter({
    maxRequests: 5,
    windowMs: 24 * 60 * 60 * 1000,
  })
  return { check: (userId: string) => limiter.check(userId) }
}

function candidateToReply(c: BrainCandidate) {
  return {
    id: c.id,
    memoryId: c.memoryId,
    action: c.suggestedAction,
    targetKind: c.targetKind,
    targetId: c.targetId,
    suggestedKey: c.suggestedKey,
    suggestedValue: c.suggestedValue,
    reason: c.reason,
    confidence: c.confidence,
    createdAt: c.createdAt.toISOString(),
    appliedAt: c.appliedAt?.toISOString() ?? null,
    dismissedAt: c.dismissedAt?.toISOString() ?? null,
    undoneAt: c.undoneAt?.toISOString() ?? null,
  }
}

export function createBrainHealingTools(deps: HealingToolsDeps): Tool[] {
  const healLimiter = deps.healRateLimiter ?? defaultHealRateLimiter()

  // ── 1. listBrainCandidates ────────────────────────────────────────

  const listBrainCandidates = buildTool({
    name: 'listBrainCandidates',
    description:
      'Show the brain reclassifier\'s recent decisions and pending suggestions. ' +
      'Use when the user asks "what changed in my brain?", "show recent memory ' +
      'cleanup", or wants to review what the self-healing pass did. Returns ' +
      'pending attribute candidates (waiting for the user\'s yes/no) and the ' +
      'last N auto-applied actions (drop / task / edge).',
    inputSchema: z.object({
      pending_only: z
        .boolean()
        .optional()
        .describe('When true, return only candidates awaiting user confirmation.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Cap on rows returned. Defaults to 20.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,

    async execute(input, context) {
      try {
        const ctx = {
          workspaceId: requireWorkspace(context.workspaceId),
          userId: context.userId,
          assistantId: context.assistantId,
          assistantKind: context.assistantKind ?? 'primary',
        }
        const limit = input.limit ?? 20
        const rows = input.pending_only
          ? await deps.candidates.listPending(ctx, { limit })
          : await deps.candidates.listRecent(ctx, { limit })
        return { data: { candidates: rows.map(candidateToReply) } }
      } catch (err) {
        return errorData(err)
      }
    },
  })

  // ── 2. dismissBrainCandidate ──────────────────────────────────────

  const dismissBrainCandidate = buildTool({
    name: 'dismissBrainCandidate',
    description:
      'Reject a pending brain reclassifier suggestion. Use when the user says ' +
      '"no, leave that memory alone" about a specific candidate. The memory is ' +
      'untouched; only the suggestion is dismissed.',
    inputSchema: z.object({
      candidate_id: z.string().uuid(),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,

    async execute(input, context) {
      try {
        const result = await deps.candidates.markDismissed(
          input.candidate_id,
          context.userId,
        )
        if (!result) {
          return {
            data: 'Candidate not found or already in a terminal state.',
            isError: true,
          }
        }
        return { data: { dismissed: true, candidateId: result.id } }
      } catch (err) {
        return errorData(err)
      }
    },
  })

  // ── 3. acceptBrainCandidate ───────────────────────────────────────

  const acceptBrainCandidate = buildTool({
    name: 'acceptBrainCandidate',
    description:
      'Apply a pending brain reclassifier suggestion. Today this is used for ' +
      'attribute candidates — the reclassifier saw a memory that looks like ' +
      'a structured fact about an entity (e.g. "Alice is CEO"), and accepting ' +
      'promotes the fact into the entity\'s attributes as a new version in ' +
      'the prior-version chain. ' +
      'The original memory stays as provenance. Caller must be the memory\'s ' +
      'original author (existing promoteMemoryToEntity gate).',
    inputSchema: z.object({
      candidate_id: z.string().uuid(),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,

    async execute(input, context) {
      try {
        const ctx = {
          workspaceId: requireWorkspace(context.workspaceId),
          userId: context.userId,
          assistantId: context.assistantId,
          assistantKind: context.assistantKind ?? 'primary',
        }
        const candidate = await deps.candidates.getById(ctx, input.candidate_id)
        if (!candidate) return { data: 'Candidate not found.', isError: true }
        if (candidate.appliedAt) return { data: 'Candidate already applied.', isError: true }
        if (candidate.dismissedAt) return { data: 'Candidate already dismissed.', isError: true }

        if (candidate.suggestedAction === 'extract') {
          // Extract proposes brand-new primitives (contact / entity) split
          // out of a memory. The accept path that mints them is a follow-up;
          // until then surface a manual route rather than a misleading
          // "auto-applied" message.
          return {
            data:
              'Extract candidates propose new entities split out of a memory. ' +
              'One-click accept is not wired yet — review the proposed targets via ' +
              'listBrainCandidates and create them with saveContact / createEntity, ' +
              'then dismiss the candidate.',
            isError: true,
          }
        }
        if (candidate.suggestedAction !== 'attribute') {
          return {
            data:
              `Only attribute candidates are user-applied via this tool — got ${candidate.suggestedAction}. ` +
              'drop / task / edge candidates are auto-applied by the reclassifier.',
            isError: true,
          }
        }
        if (!candidate.targetId || !candidate.suggestedKey) {
          return {
            data: 'Attribute candidate missing target entity or key.',
            isError: true,
          }
        }

        if (!deps.promotion) {
          return {
            data:
              'Attribute promotion not yet wired. The healing-tool surface is up; the ' +
              'promoteMemoryToEntity port adapter ships in a follow-up.',
            isError: true,
          }
        }

        const result = await promoteMemoryToEntity(deps.promotion, {
          memoryId: candidate.memoryId,
          targetEntityId: candidate.targetId,
          attributeKey: candidate.suggestedKey,
          attributeValue: candidate.suggestedValue,
          actorUserId: context.userId,
        })

        const marked = await deps.candidates.markApplied(candidate.id, context.userId)

        return {
          data: {
            applied: true,
            candidateId: candidate.id,
            oldEntityId: result.oldEntityId,
            newEntityId: result.newEntityId,
            attributeKey: result.attributeKey,
            appliedAt: marked?.appliedAt?.toISOString() ?? null,
          },
        }
      } catch (err) {
        return errorData(err)
      }
    },
  })

  // ── 4. undoReclassification ──────────────────────────────────────

  const undoReclassification = buildTool({
    name: 'undoReclassification',
    description:
      'Reverse a previously-applied brain reclassification. Looks up the ' +
      'candidate row, dispatches on its action: `drop` recreates the memory ' +
      'from the captured snapshot; `task` archives the created task and ' +
      'recreates the memory; `edge` retracts the entity_link. Use when the ' +
      'user says "undo that change", "put that memory back", or wants to ' +
      'roll back a self-healing decision. Attribute promotions cannot be ' +
      'undone via this tool — they go through the prior-version chain; revert by ' +
      'using the existing entity-correction tools to supersede again.',
    inputSchema: z.object({
      candidate_id: z.string().uuid(),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    // Tier-C write-gate (Posture A, docs/architecture/engine/tool-executor.md
    // §3): recreates memories / archives tasks / retracts edges. Itself an
    // undo of soft ops, so interactive stays silent; the autonomous path
    // gates so a headless loop can't silently roll changes back and forth.
    resolveConfirmation: async (context) => isAutonomousToolContext(context),

    async execute(input, context) {
      try {
        const ctx = {
          workspaceId: requireWorkspace(context.workspaceId),
          userId: context.userId,
          assistantId: context.assistantId,
          assistantKind: context.assistantKind ?? 'primary',
        }
        const candidate = await deps.candidates.getById(ctx, input.candidate_id)
        if (!candidate) return { data: 'Candidate not found.', isError: true }
        if (!candidate.appliedAt) return { data: 'Candidate is not in applied state.', isError: true }
        if (candidate.undoneAt) return { data: 'Candidate already undone.', isError: true }

        switch (candidate.suggestedAction) {
          case 'drop': {
            const recreated = await recreateMemoryFromSnapshot(
              deps.memories,
              candidate.suggestedValue,
              ctx.workspaceId,
              context.userId,
              ctx.assistantId,
              context.sessionId,
            )
            if (!recreated) return { data: 'Drop snapshot missing — cannot reconstruct memory.', isError: true }
            await deps.candidates.markUndone(candidate.id, context.userId)
            return {
              data: { undone: true, action: 'drop', recreatedMemoryId: recreated.id },
            }
          }
          case 'task': {
            if (!candidate.targetId) {
              return { data: 'Task candidate missing targetId.', isError: true }
            }
            // Archive the auto-created task. v1 uses status='archived'
            // rather than a hard delete so the task history is preserved
            // (the brain-correction audit pattern).
            const archived = await deps.tasks.update(context.userId, candidate.targetId, {
              status: 'archived',
            })
            if (!archived) {
              return { data: 'Auto-created task not found — may have been further modified.', isError: true }
            }
            const recreated = await recreateMemoryFromSnapshot(
              deps.memories,
              candidate.suggestedValue,
              ctx.workspaceId,
              context.userId,
              ctx.assistantId,
              context.sessionId,
            )
            await deps.candidates.markUndone(candidate.id, context.userId)
            return {
              data: {
                undone: true,
                action: 'task',
                archivedTaskId: candidate.targetId,
                recreatedMemoryId: recreated?.id ?? null,
              },
            }
          }
          case 'edge': {
            if (!candidate.targetId) {
              return { data: 'Edge candidate missing targetId.', isError: true }
            }
            const retracted = await deps.entityLinks.retract(
              context.userId,
              candidate.targetId,
              'undoReclassification — auto-applied edge reversed',
            )
            if (!retracted) {
              return { data: 'Entity link not found or already closed.', isError: true }
            }
            await deps.candidates.markUndone(candidate.id, context.userId)
            return {
              data: { undone: true, action: 'edge', retractedLinkId: candidate.targetId },
            }
          }
          case 'attribute': {
            return {
              data:
                'Attribute promotions cannot be undone via this tool. The prior-version ' +
                'chain is itself reversible — use the existing entity-correction surface to ' +
                'supersede again with the prior attribute set.',
              isError: true,
            }
          }
          case 'extract': {
            // Unreachable in practice — extract candidates are never
            // auto-applied, so the `!appliedAt` guard above rejects first.
            // Kept for switch exhaustiveness.
            return {
              data:
                'Extract candidates are never auto-applied — there is nothing to undo. ' +
                'Use dismissBrainCandidate to clear a pending extract suggestion.',
              isError: true,
            }
          }
        }
      } catch (err) {
        return errorData(err)
      }
    },
  })

  // ── 5. healMemories ───────────────────────────────────────────────

  const healMemories = buildTool({
    name: 'healMemories',
    description:
      'Run the brain reclassifier on demand against the user\'s recent memories. ' +
      'For each memory the LLM decides if it would have been better as a task / ' +
      'entity link / entity attribute / drop — and either auto-applies the safe ' +
      'cases (drop / task / edge) or queues attribute candidates for review. ' +
      'Rate-limited to 5 invocations per user per day. Use when the user asks to ' +
      'clean up their brain, reorganize memories, or "make the brain smarter ' +
      'about X".',
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Max memories to consider this run. Defaults to 20 (the daily cap).'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    // Tier-C write-gate (see undoReclassification): auto-applies drop /
    // task / edge reclassifications across memories. Mixed reversibility,
    // so interactive stays silent (the user sees the turn); a cron/workflow
    // run mass-reclassifying with no human present parks in Approvals.
    resolveConfirmation: async (context) => isAutonomousToolContext(context),

    async execute(input, context) {
      const allowed = healLimiter.check(context.userId)
      if (!allowed) {
        return {
          data: 'Rate limit exceeded — `healMemories` is capped at 5 invocations per user per day.',
          isError: true,
        }
      }
      try {
        const ctx = {
          workspaceId: requireWorkspace(context.workspaceId),
          userId: context.userId,
          assistantId: context.assistantId,
          assistantKind: context.assistantKind ?? 'primary',
        }

        const memoryMetrics = await deps.memories.listWithMetrics(ctx.assistantId, ctx.userId)
        if (memoryMetrics.length === 0) {
          return { data: { result: emptyHealResult(), note: 'No memories to consider.' } }
        }

        const candidatesForReclassifier: MemoryForReclassification[] =
          memoryMetrics.map((m) => ({
            id: m.id,
            summary: m.summary,
            detail: m.detail,
            tags: m.tags,
            scope: m.scope,
            sensitivity: m.sensitivity,
            workspaceId: m.workspaceId ?? ctx.workspaceId,
            userId: m.userId,
            assistantId: m.assistantId,
            // v1: stub authorship from the chat actor (used only for
            // snapshot serialisation on `drop`/`task` candidates; the
            // accept-attribute path consults the memory's own author
            // via `promoteMemoryToEntity`'s gate).
            createdByUserId: context.userId,
            createdByAssistantId: ctx.assistantId,
            createdAt: m.createdAt,
          }))

        // Blast-radius caller-side filter is best-effort — v1 ignores
        // the entity_links count (we don't have a cheap workspace-wide
        // count) and relies on the other three guardrails. The
        // reclassifier exposes the filter helper so wiring layers can
        // extend it once a count port is added.
        const filtered = filterMemoriesForReclassification(
          candidatesForReclassifier,
          new Map(),
        )
        if (filtered.length === 0) {
          return {
            data: {
              result: emptyHealResult(),
              note: 'No memories matched the guardrails (>24h old, not high-sensitivity).',
            },
          }
        }

        const entityRows = await deps.entities.listForWorkspace(ctx, { limit: 200 })

        const result: ReclassificationResult = await runReclassification({
          memories: filtered,
          entities: entityRows,
          workspaceId: ctx.workspaceId,
          actorUserId: ctx.userId,
          actorAssistantId: ctx.assistantId,
          memoryStore: deps.memories,
          taskStore: deps.tasks,
          entityLinks: deps.entityLinks,
          candidates: deps.candidates,
          provider: deps.provider,
          model: deps.reclassifierModel,
        } satisfies ReclassificationDeps)

        return {
          data: {
            considered: filtered.length,
            applied: result.applied,
            enqueuedAttribute: result.enqueuedAttribute,
            enqueuedExtract: result.enqueuedExtract,
            kept: result.kept,
            unresolvedTargets: result.unresolvedTargets,
            noOpinion: result.noOpinion,
          },
        }
      } catch (err) {
        return errorData(err)
      }
    },
  })

  // ── 6. dedupeEntities ─────────────────────────────────────────────

  const dedupeEntities = buildTool({
    name: 'dedupeEntities',
    description:
      'Self-heal duplicate entities in this workspace. Runs two passes: ' +
      '(1) within-kind collisions on (kind, lower(display_name)); ' +
      '(2) cross-kind collisions on lower(display_name) alone, capped at ' +
      'small clusters so legitimately-ambiguous shared names are not ' +
      'auto-merged. Each duplicate is merged into the oldest survivor ' +
      '(within-kind) or the highest-priority kind (cross-kind: CRM > ' +
      'repository > project > product) using survivor-wins reconciliation. ' +
      'Use when the user says "clean up duplicates", "dedupe my brain", ' +
      '"I see the same project listed five times".',
    inputSchema: z.object({
      cluster_cap: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Cap on clusters processed in this invocation. Defaults to 25.'),
      kind: z
        .string()
        .optional()
        .describe(
          'Optional entity kind filter (person | company | project | product | deal | repository). ' +
            'Omit to dedupe every kind in one pass.',
        ),
      cluster_by_llm: z
        .boolean()
        .optional()
        .describe(
          'Opt-in: run a third LLM-clustering pass that catches semantic ' +
            'aliases the lexical passes miss (e.g. "AC" ↔ "Acme Corp"). ' +
            'Costs one Flash-class LLM call per invocation. Default false.',
        ),
      llm_auto_apply_threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          'Confidence threshold for auto-applying LLM-proposed clusters. ' +
            'Lower-confidence clusters are returned as suggestions in the ' +
            'reply. Default 0.85.',
        ),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    // Tier-D write-gate (Posture A, docs/architecture/engine/tool-executor.md
    // §3): dedupeEntities is the ONE genuinely irreversible tool —
    // survivor-wins merge collapses the loser's identity and cannot be
    // cheaply undone (it IS the fixed CRM-dedupe incident class). Gate
    // EVERYWHERE: interactive gets a confirmation card, the autonomous
    // path parks a pending_approvals row (tool-executor fallback). A merge
    // you can't walk back must never fire un-previewed.
    requiresConfirmation: true,
    allowPersistentApproval: false,

    // Preview the merge clusters the two LEXICAL passes would collapse —
    // "Acme Corp (company) <- AC, Acme" style — so the human sees exactly
    // what identity is about to be merged before approving. Mirrors
    // deleteMemory's id -> summary enrichment (memory/tools.ts). Cheap by
    // construction: findDuplicateClustersSystem / findCrossKindDuplicate...
    // are pure READS (they return clusters, they do NOT merge), and the
    // opt-in LLM alias pass is deliberately NOT run here (it costs a
    // Flash-class call and only surfaces suggestions, not auto-applies).
    async describeConfirmation(input, context) {
      const workspaceId = context.workspaceId
      if (!workspaceId) return null
      const parsed = input as {
        cluster_cap?: number
        kind?: string
        cluster_by_llm?: boolean
      }
      const clusterCap = parsed.cluster_cap ?? 25
      const kind = parsed.kind as EntityKind | undefined

      try {
        const withinKind = await deps.entities.findDuplicateClustersSystem(
          context.userId,
          workspaceId,
          { limit: clusterCap, kind },
        )
        // Cross-kind pass runs only when no single-kind filter is set —
        // exactly the runEntityDedupe gate, so the preview matches execute.
        const crossKind =
          kind === undefined
            ? await deps.entities.findCrossKindDuplicateClustersSystem(
                context.userId,
                workspaceId,
                { limit: clusterCap },
              )
            : []

        if (withinKind.length === 0 && crossKind.length === 0) {
          return ['No duplicate clusters found — nothing would be merged.']
        }

        // Resolve every clustered id to its display name in one system read.
        const names = await resolveEntityDisplayNames(
          deps.entities,
          context.userId,
          workspaceId,
          kind,
        )
        const nameOf = (id: string) => names.get(id) ?? `(id ${id.slice(0, 8)})`

        const lines: string[] = []
        for (const cluster of withinKind) {
          const [survivorId, ...mergedIds] = cluster.entityIds
          if (!survivorId || mergedIds.length === 0) continue
          lines.push(
            `• ${nameOf(survivorId)} (${cluster.kind}) <- ${mergedIds
              .map(nameOf)
              .join(', ')}`,
          )
        }
        for (const cluster of crossKind) {
          // Cross-kind survivor is the highest-priority kind, tie-broken by
          // oldest — but that ranking lives in entity-dedupe's private
          // helper. For a preview, name every member and its kind so the
          // human sees the collapse without needing the exact survivor.
          if (cluster.entityIds.length < 2) continue
          const members = cluster.entityIds
            .map((id, i) => `${nameOf(id)} (${cluster.kinds[i]})`)
            .join(' + ')
          lines.push(`• cross-kind: ${members}`)
        }

        if (lines.length === 0) {
          return ['No duplicate clusters found — nothing would be merged.']
        }
        if (parsed.cluster_by_llm) {
          lines.push(
            '(plus any semantic-alias clusters the opt-in LLM pass finds at run time)',
          )
        }
        return lines
      } catch (err) {
        console.debug('[healing-tools] dedupeEntities describeConfirmation failed:', err)
        return null
      }
    },

    async execute(input, context) {
      try {
        const workspaceId = requireWorkspace(context.workspaceId)
        if (!deps.entityMerge) {
          return {
            data:
              'dedupeEntities is unavailable — merge ports not wired in this ' +
              'environment. Have an operator run the cleanup SQL or wire ' +
              'EntityMergeRepository on createBrainHealingTools.',
            isError: true,
          }
        }
        const result: EntityDedupeResult = await runEntityDedupe({
          entities: deps.entities,
          merge: deps.entityMerge,
          workspaceId,
          actorUserId: context.userId,
          clusterCap: input.cluster_cap,
          kind: input.kind,
          clusterByLlm: input.cluster_by_llm,
          llmAutoApplyThreshold: input.llm_auto_apply_threshold,
          llmClusterer: input.cluster_by_llm
            ? { provider: deps.provider, model: deps.reclassifierModel }
            : undefined,
        })
        const totalPairsMerged =
          result.pairsMerged
          + result.crossKind.pairsMerged
          + result.llmCluster.applied.reduce((n, c) => n + c.mergedEntityIds.length, 0)
        return {
          data: {
            withinKind: {
              clustersScanned: result.clustersScanned,
              pairsMerged: result.pairsMerged,
              pairsConflicted: result.pairsConflicted,
              pairsErrored: result.pairsErrored,
              details: result.details,
            },
            crossKind: result.crossKind,
            llmCluster: result.llmCluster,
            totalPairsMerged,
          },
        }
      } catch (err) {
        return errorData(err)
      }
    },
  })

  // ── 7. noteAlias ──────────────────────────────────────────────────

  const noteAlias = buildTool({
    name: 'noteAlias',
    description:
      'Register an alternate name for an existing entity. After this, ' +
      'every extraction or chat mention of the alias resolves to the ' +
      'same entity row — ingest no longer creates a duplicate. ' +
      'Use when the user says "AC is the same as Acme Corp", "tonic ' +
      'is short for acme-labs/tonic", or "acme-labs/gateway ' +
      'is the gateway repo". Aliases are stored lowercase but ' +
      'case-insensitively matched. Returns a conflict error (with the ' +
      'other entity id) if the alias is already bound to a different ' +
      'live entity in this workspace; resolve via dedupeEntities or ' +
      'pick a different alias.',
    inputSchema: z.object({
      entity_id: z
        .string()
        .uuid()
        .describe('The canonical entity id that the alias should resolve to.'),
      alias: z
        .string()
        .min(1)
        .max(200)
        .describe(
          'The alternate name to register. Lowercased + trimmed for storage; ' +
            'case-insensitive on lookup.',
        ),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,

    async execute(input, context) {
      try {
        // Pre-flight: ensure the workspace context is set; the underlying
        // store call is RLS-gated so we don't need to thread workspaceId
        // through, but a missing workspace context means this assistant
        // has no brain to teach.
        requireWorkspace(context.workspaceId)
        const result = await deps.entities.addAlias(
          context.userId,
          input.entity_id,
          input.alias,
        )
        if (result.kind === 'not_found') {
          return {
            data: 'Entity not found (or not visible to you).',
            isError: true,
          }
        }
        if (result.kind === 'conflict') {
          return {
            data: {
              conflict: true,
              conflictingEntityId: result.conflictingEntityId,
              message:
                `The alias is already bound to entity ${result.conflictingEntityId}. ` +
                `Merge the two entities first (dedupeEntities) or pick a different alias.`,
            },
            isError: true,
          }
        }
        return {
          data: {
            entityId: result.entity.id,
            displayName: result.entity.displayName,
            aliases: result.entity.aliases,
          },
        }
      } catch (err) {
        return errorData(err)
      }
    },
  })

  // ── 8. splitAlias ─────────────────────────────────────────────────

  const splitAlias = buildTool({
    name: 'splitAlias',
    description:
      'Remove a previously-registered alias from an entity. Use when ' +
      'the user says "actually AC is NOT Acme Corp" or "stop treating ' +
      'X as Y". The next extraction of the removed alias will resolve ' +
      'as a new entity (or whatever else matches it). Idempotent — ' +
      'removing an alias that was not registered is a no-op.',
    inputSchema: z.object({
      entity_id: z.string().uuid(),
      alias: z.string().min(1).max(200),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    // Tier-C write-gate (see undoReclassification): removes an alias
    // binding. Idempotent / re-noteable, so interactive stays silent; the
    // autonomous path gates.
    resolveConfirmation: async (context) => isAutonomousToolContext(context),

    async execute(input, context) {
      try {
        requireWorkspace(context.workspaceId)
        const updated = await deps.entities.removeAlias(
          context.userId,
          input.entity_id,
          input.alias,
        )
        if (!updated) {
          return {
            data: 'Entity not found (or not visible to you).',
            isError: true,
          }
        }
        return {
          data: {
            entityId: updated.id,
            displayName: updated.displayName,
            aliases: updated.aliases,
          },
        }
      } catch (err) {
        return errorData(err)
      }
    },
  })

  return [
    listBrainCandidates,
    dismissBrainCandidate,
    acceptBrainCandidate,
    undoReclassification,
    healMemories,
    dedupeEntities,
    noteAlias,
    splitAlias,
  ]
}

/**
 * Build an id -> displayName map for every live entity in the workspace,
 * so `dedupeEntities`' confirmation preview can name each clustered id.
 * One system read (`listLiveEntitiesSystem`, the same source the LLM
 * alias pass already uses). When a `kind` filter is set the caller only
 * previews that kind's within-kind clusters, so the narrowed list is
 * enough; unfiltered previews (which also show cross-kind clusters) pull
 * every kind. Best-effort — an id missing from the map falls back to a
 * short id in the caller.
 */
async function resolveEntityDisplayNames(
  entities: EntityStore,
  actorUserId: string,
  workspaceId: string,
  kind: EntityKind | undefined,
): Promise<Map<string, string>> {
  const rows = await entities.listLiveEntitiesSystem(actorUserId, workspaceId, {
    kind,
    limit: 500,
  })
  return new Map(rows.map((e) => [e.id, e.displayName]))
}

/**
 * Recreate a memory from a `brain_candidates.suggested_value` snapshot.
 * Returns the new memory record on success, or `null` when the snapshot
 * is missing or malformed (e.g. an older candidate row without the
 * captured pre-state).
 */
async function recreateMemoryFromSnapshot(
  memoryStore: MemoryStore,
  snapshot: unknown,
  workspaceId: string,
  actorUserId: string,
  actorAssistantId: string,
  actorSessionId?: string,
): Promise<{ id: string } | null> {
  if (!snapshot || typeof snapshot !== 'object') return null
  const s = snapshot as Record<string, unknown>
  const summary = typeof s.summary === 'string' ? s.summary : null
  if (!summary) return null

  // Re-stamp authorship on the recreated row (matches the chat-side
  // `saveMemory` pattern — the user who runs `undoReclassification` is
  // the new author). The original `userId` / `assistantId` from the
  // snapshot remain in the visibility double.
  const userId = typeof s.userId === 'string' ? s.userId : actorUserId
  const assistantId = typeof s.assistantId === 'string' ? s.assistantId : actorAssistantId
  const sensitivity =
    s.sensitivity === 'public' || s.sensitivity === 'internal' || s.sensitivity === 'confidential'
      ? s.sensitivity
      : 'internal'

  return memoryStore.create({
    assistantId,
    userId,
    workspaceId,
    scope: typeof s.scope === 'string' ? s.scope : undefined,
    summary,
    detail: typeof s.detail === 'string' ? s.detail : undefined,
    tags: Array.isArray(s.tags) ? (s.tags as string[]) : undefined,
    sensitivity,
    source: 'undo-reclassification',
    // Source anchor: prefer the ORIGINAL memory's session (the recreated
    // row's origin is the conversation that first saved it), falling back
    // to the undoing chat's session (2026-07-10 source audit — this path
    // held the session in scope and dropped it).
    sourceSessionId:
      typeof s.sourceSessionId === 'string' ? s.sourceSessionId : actorSessionId,
    createdByUserId: actorUserId,
    createdByAssistantId: actorAssistantId,
  })
}

function emptyHealResult() {
  return {
    considered: 0,
    applied: { drop: 0, task: 0, edge: 0 },
    enqueuedAttribute: 0,
    enqueuedExtract: 0,
    kept: 0,
    unresolvedTargets: 0,
    noOpinion: 0,
  }
}
