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
 *  • `dedupeEntities`        — visibility-scoped self-heal sweep (D.9 guard).
 *  • `mergeEntities`         — scoped pairwise merge of two named records
 *                             (D.1) — the "combine these two" path that never
 *                             touches the whole-workspace sweep.
 *  • `undoEntityMerge`       — reverse a merge within the 7-day window (D.2),
 *                             the self-recovery path for an errant merge.
 *  • `noteAlias` / `splitAlias` — alias curation for the resolver.
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
import { buildTool, type Tool, type ToolContext } from '../tools/types.js'
import { isAutonomousToolContext } from '../tools/capability-gate.js'
import type { AccessContext } from '../security/access-context.js'
import { createRateLimiter } from '../security/rate-limiter.js'
import { notFoundFailure, toolFailure } from '../tools/tool-failure.js'
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
import {
  mergeEntities,
  undoMerge,
  reconcileAttributes,
  EntityMergeError,
  UndoMergeError,
  type EntityMergeDeps,
  type ReconciliationMode,
} from '../corrections/entity-merge.js'
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
  resolveLlm?: (workspaceId: string) => Promise<{ provider: LLMProvider; model: string } | null>
  /**
   * Rate limit for `healMemories` — defaults to 5 invocations per user
   * per 24h per Q10. Tests can override.
   */
  healRateLimiter?: { check(userId: string): boolean }
}

/**
 * The workspace gate for every healing tool.
 *
 * RETURNED, never thrown. A throw is caught by the generic frame below, which
 * can only re-state the sentence it was handed — the model used to see
 * "brain healing tool invoked without a workspace context" and had no way to
 * know which surface is missing or what the user should do about it. Returning
 * the failure keeps the copy where the context lives.
 */
function workspaceGate(
  workspaceId: string | null | undefined,
  tool: string,
): { data: string; isError: true } | null {
  if (!workspaceId) {
    return {
      data:
        `\`${tool}\` did not run: this chat is not bound to a workspace, and brain healing only ever operates on one workspace's own records — there is no brain to heal here. Nothing was changed. ` +
        'Ask the user to run this from a workspace chat (or from the web app) and carry on answering the rest of their message. ' +
        'No argument change will help in this session; do not retry.',
      isError: true,
    }
  }
  return null
}

/**
 * The tool that lists open candidates, named in every terminal-state
 * rejection so the model stops re-poking the row it just learned is closed.
 */
const CANDIDATE_LIST_TOOL = 'listBrainCandidates({ pending_only: true })'

/**
 * The caller's access context for a dedupe run (corrections.md §D.9
 * dedupe guard). Threaded into `runEntityDedupe` and the confirmation
 * preview so the sweep is scoped to rows the caller can see and never
 * merges across the visibility double.
 */
function dedupeAccess(context: ToolContext, workspaceId: string): AccessContext {
  return {
    workspaceId,
    userId: context.userId,
    assistantId: context.assistantId,
    assistantKind: context.assistantKind ?? 'standard',
    clearance: context.clearance,
    compartments: context.compartments,
  }
}

/**
 * Map a scoped-merge failure to user-facing copy that names the ids it was
 * about, the next step, and whether the same call can ever work.
 */
function mergeErrorMessage(err: EntityMergeError, survivorId: string, mergedId: string): string {
  switch (err.code) {
    case 'self_merge':
      return `mergeEntities did not run: survivor_id and merged_id are both ${survivorId}, and a record cannot be merged into itself. Nothing was changed. Pass the TWO different ids the user named — call searchBrain / getEntity (or listContacts / listCompanies / listDeals) to resolve the second one. Retrying with these arguments will keep failing.`
    case 'entity_not_found':
      return `mergeEntities did not run: at least one of survivor_id ${survivorId} / merged_id ${mergedId} no longer exists in this workspace. Nothing was changed. A merge supersedes the record it folds in, so an id from before an earlier merge is dead — call searchBrain / getEntity to re-resolve BOTH ids, then retry with the current pair. Do NOT retry this exact pair.`
    case 'entity_inactive':
      return `mergeEntities did not run: one of survivor_id ${survivorId} / merged_id ${mergedId} was already merged away or deleted, so there is nothing left to fold in. Nothing was changed. Re-resolve both ids with searchBrain / getEntity — the surviving record may already contain what the user wanted merged. Do NOT retry this exact pair.`
    case 'cross_workspace_rejected':
      return `mergeEntities did not run: survivor_id ${survivorId} and merged_id ${mergedId} belong to different workspaces, and identity is never merged across that boundary. Nothing was changed. Re-resolve both ids inside this workspace with searchBrain / getEntity. Retrying this pair will keep failing.`
    case 'conflict_requires_resolution':
      return `mergeEntities did not merge ${mergedId} into ${survivorId}: some fields hold different values on the two records, and the default mode refuses to silently drop one. Nothing was changed. Re-run the SAME two ids with on_conflict="keep_survivor" or on_conflict="keep_merged" (ask the user which if it matters). Retrying unchanged will keep failing.`
  }
}

/**
 * Map an undo-merge failure to user-facing copy. Every branch names the merge
 * id, and the four unrecoverable ones say so outright — this is the recovery
 * path, so a model that keeps retrying it strands the user.
 */
function undoErrorMessage(err: UndoMergeError, mergeId: string): string {
  switch (err.code) {
    case 'merge_not_found':
      return `undoEntityMerge found no merge with id ${mergeId} in this workspace — it may already have been undone, or the id may not be a merge id at all. Nothing was changed. merge_id comes from the mergeEntities result (its \`mergeId\` field) or the merge audit, never from an entity id. If the user says the merge is already reversed, check the records with getEntity rather than calling this again. Do NOT retry this exact id.`
    case 'snapshot_unavailable':
      return `undoEntityMerge cannot reverse merge ${mergeId}: it predates undo support, so no pre-merge snapshot was captured and there is nothing to restore. Nothing was changed. This can never succeed for this merge — tell the user the record has to be rebuilt by hand (createEntity / the CRM save tools) and offer to do it. Do NOT retry.`
    case 'merge_too_old':
      return `undoEntityMerge cannot reverse merge ${mergeId}: it is outside the 7-day undo window. Nothing was changed. The window does not reopen, so this will never succeed — tell the user the automatic undo has expired and offer to rebuild the record by hand. Do NOT retry.`
    case 'survivor_superseded':
      return `undoEntityMerge cannot reverse merge ${mergeId} yet: the surviving record has since been merged again, and the later merge has to come off first. Nothing was changed. Undo the LATER merge (its merge_id is in the merge audit / that merge's result), then call this again with ${mergeId}. Retrying ${mergeId} before that will keep failing.`
    case 'cascade_target_missing':
      return `undoEntityMerge cannot cleanly reverse merge ${mergeId}: a record involved in it was hard-deleted, so restoring the pre-merge state is no longer possible. Nothing was changed. This will never succeed — tell the user what is missing and offer to rebuild the record by hand. Do NOT retry.`
  }
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
      const gate = workspaceGate(context.workspaceId, 'listBrainCandidates')
      if (gate) return gate
      try {
        const ctx = {
          workspaceId: context.workspaceId!,
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
        return toolFailure(err, {
          tool: 'listBrainCandidates',
          target: input.pending_only ? 'the pending-candidate list' : 'the recent-candidate list',
          next: 'If it persists, tell the user the brain-cleanup history could not be read rather than guessing at what changed.',
        })
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
            data:
              `dismissBrainCandidate did nothing to candidate ${input.candidate_id}: no pending candidate has that id in this workspace. ` +
              'Either the id is wrong, or the candidate is already in a TERMINAL state (applied, dismissed, or undone) and a dismissal no longer applies to it. ' +
              `Do NOT retry this exact id — call ${CANDIDATE_LIST_TOOL} to see which candidates are still open, and dismiss one of those. ` +
              'If the user was pointing at a suggestion that is already dealt with, say so instead of calling again.',
            isError: true,
          }
        }
        return { data: { dismissed: true, candidateId: result.id } }
      } catch (err) {
        return toolFailure(err, {
          tool: 'dismissBrainCandidate',
          target: `candidate ${input.candidate_id}`,
          mutating: true,
          next: `Candidate ids come from ${CANDIDATE_LIST_TOOL}; re-resolve there if this one is stale.`,
        })
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
      const gate = workspaceGate(context.workspaceId, 'acceptBrainCandidate')
      if (gate) return gate
      try {
        const ctx = {
          workspaceId: context.workspaceId!,
          userId: context.userId,
          assistantId: context.assistantId,
          assistantKind: context.assistantKind ?? 'primary',
        }
        const candidate = await deps.candidates.getById(ctx, input.candidate_id)
        if (!candidate) {
          return notFoundFailure({
            kind: 'Brain candidate',
            id: input.candidate_id,
            discoveryTool: CANDIDATE_LIST_TOOL,
            extra: 'Nothing was applied.',
            idSource: 'a listBrainCandidates result (its `id` field), never a memory id or an entity id',
          })
        }
        if (candidate.appliedAt) {
          return {
            data:
              `Candidate ${input.candidate_id} was ALREADY applied (at ${candidate.appliedAt.toISOString()}), so nothing changed and nothing needed to — the suggestion is in the brain. ` +
              'Tell the user it is already done. ' +
              `Do NOT retry this id: an applied candidate is terminal. Call ${CANDIDATE_LIST_TOOL} if you need one that is still open, or undoReclassification if the user wants this one reversed.`,
            isError: true,
          }
        }
        if (candidate.dismissedAt) {
          return {
            data:
              `Candidate ${input.candidate_id} was ALREADY dismissed (at ${candidate.dismissedAt.toISOString()}), so it cannot be accepted — a dismissal is terminal. Nothing was changed. ` +
              `Do NOT retry this id. Call ${CANDIDATE_LIST_TOOL} for the suggestions still open; if the user really wants this change, make it directly with the ordinary save tools instead.`,
            isError: true,
          }
        }

        if (candidate.suggestedAction === 'extract') {
          // Extract proposes brand-new primitives (contact / entity) split
          // out of a memory. The accept path that mints them is a follow-up;
          // until then surface a manual route rather than a misleading
          // "auto-applied" message.
          return {
            data:
              `acceptBrainCandidate cannot apply candidate ${input.candidate_id}: it is an EXTRACT candidate, which proposes brand-new records split out of a memory, and the one-click accept path for that kind is not built yet. Nothing was changed. ` +
              `Do the same thing by hand instead: read the proposed target on this candidate (it is in the ${CANDIDATE_LIST_TOOL} row), create the record with saveContact / saveCompany / createEntity, then dismissBrainCandidate to clear the suggestion. ` +
              'Retrying accept on this candidate will keep failing — no argument changes that.',
            isError: true,
          }
        }
        if (candidate.suggestedAction !== 'attribute') {
          return {
            data:
              `acceptBrainCandidate cannot apply candidate ${input.candidate_id}: it is a \`${candidate.suggestedAction}\` candidate, and this tool only applies \`attribute\` ones. Nothing was changed. ` +
              'drop / task / edge candidates are applied automatically by the reclassifier, so there is nothing for the user to accept — they are already in effect. ' +
              `Tell the user that, and use undoReclassification if they want it reversed. Do NOT retry accept on this id; call ${CANDIDATE_LIST_TOOL} for candidates that are actually awaiting a yes/no.`,
            isError: true,
          }
        }
        if (!candidate.targetId || !candidate.suggestedKey) {
          return {
            data:
              `acceptBrainCandidate cannot apply candidate ${input.candidate_id}: the row is incomplete — it has no ${!candidate.targetId ? 'target entity' : 'attribute key'}, so there is nothing to promote the memory onto. Nothing was changed. ` +
              'This is a defect in the stored candidate, not in your arguments; no retry can fix it. ' +
              `Dismiss it with dismissBrainCandidate and, if the underlying fact is right, write it directly with the ordinary save tools. Call ${CANDIDATE_LIST_TOOL} for the other open suggestions.`,
            isError: true,
          }
        }

        if (!deps.promotion) {
          return {
            data:
              `acceptBrainCandidate cannot apply candidate ${input.candidate_id}: attribute promotion is not wired in this deployment, so the surface exists but the write path behind it does not. Nothing was changed. ` +
              'No argument change or retry will make this work here. ' +
              `Apply the fact by hand instead — write it with the ordinary save tools — then dismissBrainCandidate to clear the suggestion. On a self-hosted install, tell the user the promotion port has to be wired on the API (see \`createBrainHealingTools\`).`,
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
        return toolFailure(err, {
          tool: 'acceptBrainCandidate',
          target: `candidate ${input.candidate_id}`,
          mutating: true,
          next:
            'Promotion is gated on the memory\'s original author, so if the message names authorship or clearance, this user cannot accept this candidate and you should say so rather than retrying. ' +
            `Otherwise re-resolve the candidate with ${CANDIDATE_LIST_TOOL}.`,
        })
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
      const gate = workspaceGate(context.workspaceId, 'undoReclassification')
      if (gate) return gate
      try {
        const ctx = {
          workspaceId: context.workspaceId!,
          userId: context.userId,
          assistantId: context.assistantId,
          assistantKind: context.assistantKind ?? 'primary',
        }
        const candidate = await deps.candidates.getById(ctx, input.candidate_id)
        if (!candidate) {
          return notFoundFailure({
            kind: 'Brain candidate',
            id: input.candidate_id,
            discoveryTool: 'listBrainCandidates',
            extra: 'Nothing was reversed.',
            idSource: 'a listBrainCandidates result (its `id` field), never the id of the memory / task / link the change touched',
          })
        }
        if (!candidate.appliedAt) {
          return {
            data:
              `undoReclassification has nothing to reverse for candidate ${input.candidate_id}: it was never applied${candidate.dismissedAt ? ' (it was dismissed instead)' : ' (it is still awaiting a yes/no)'}, so the brain never changed. Nothing was changed now either. ` +
              'Tell the user there is nothing to roll back. ' +
              `Do NOT retry this id: an un-applied candidate is not undoable. If they want to clear the suggestion, call dismissBrainCandidate; call ${CANDIDATE_LIST_TOOL} to see what is open.`,
            isError: true,
          }
        }
        if (candidate.undoneAt) {
          return {
            data:
              `Candidate ${input.candidate_id} was ALREADY undone (at ${candidate.undoneAt.toISOString()}), so nothing changed and nothing needed to — the reclassification is already rolled back. ` +
              'Tell the user it is already reversed. ' +
              'Do NOT retry this id; an undone candidate is terminal. If something still looks wrong, read the current state with searchBrain / getEntity rather than undoing again.',
            isError: true,
          }
        }

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
            if (!recreated) {
              return {
                data:
                  `undoReclassification could not reverse candidate ${input.candidate_id}: the row records that a memory was dropped, but its pre-drop snapshot is missing or malformed, so there is nothing to restore from. Nothing was changed. ` +
                  'This is a defect in the stored candidate — no argument change or retry will produce the snapshot. ' +
                  'Ask the user what the memory said and save it again with the ordinary memory tool, then tell them the automatic undo was not possible.',
                isError: true,
              }
            }
            await deps.candidates.markUndone(candidate.id, context.userId)
            return {
              data: { undone: true, action: 'drop', recreatedMemoryId: recreated.id },
            }
          }
          case 'task': {
            if (!candidate.targetId) {
              return {
                data:
                  `undoReclassification could not reverse candidate ${input.candidate_id}: the row says a task was created from a memory but does not record WHICH task (no target id), so there is nothing to archive. Nothing was changed. ` +
                  'This is a defect in the stored candidate; no retry can fix it. ' +
                  'Call listTasks to find the task the user means and archive it with the task tools, then say the automatic undo was not possible.',
                isError: true,
              }
            }
            // Archive the auto-created task. v1 uses status='archived'
            // rather than a hard delete so the task history is preserved
            // (the brain-correction audit pattern).
            const archived = await deps.tasks.update(context.userId, candidate.targetId, {
              status: 'archived',
            })
            if (!archived) {
              return {
                data:
                  `undoReclassification could not archive task ${candidate.targetId} while reversing candidate ${input.candidate_id}: no task with that id is visible in this workspace. Nothing was changed. ` +
                  'The task was probably edited since (every task update mints a NEW id, superseding the old one), or it was already archived or deleted. ' +
                  'Call listTasks to find its current row and archive that one with the task tools. Do NOT retry this candidate id — it will keep pointing at the same dead task id.',
                isError: true,
              }
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
              return {
                data:
                  `undoReclassification could not reverse candidate ${input.candidate_id}: the row says an entity link was created but does not record WHICH link (no target id), so there is nothing to retract. Nothing was changed. ` +
                  'This is a defect in the stored candidate; no retry can fix it. ' +
                  'Call getEntity on the entity the user means to see its current edges, and retract the wrong one from there.',
                isError: true,
              }
            }
            const retracted = await deps.entityLinks.retract(
              context.userId,
              candidate.targetId,
              'undoReclassification — auto-applied edge reversed',
            )
            if (!retracted) {
              return {
                data:
                  `undoReclassification could not retract entity link ${candidate.targetId} while reversing candidate ${input.candidate_id}: that link is not open in this workspace — it is already closed, or it no longer exists. Nothing was changed. ` +
                  'If it is already closed, the reversal the user wanted has effectively happened: say so. ' +
                  'Do NOT retry this candidate id. Call getEntity on the entity to see which edges are actually live.',
                isError: true,
              }
            }
            await deps.candidates.markUndone(candidate.id, context.userId)
            return {
              data: { undone: true, action: 'edge', retractedLinkId: candidate.targetId },
            }
          }
          case 'attribute': {
            return {
              data:
                `undoReclassification does not reverse candidate ${input.candidate_id}: it is an \`attribute\` promotion, and those roll back through the entity's prior-version chain rather than through this tool. Nothing was changed. ` +
                'Do it the supported way: read the entity with getEntity, then write the PRIOR attribute value back with the ordinary save tool — that supersedes the promotion. ' +
                'Retrying here will keep failing; no argument changes that.',
              isError: true,
            }
          }
          case 'extract': {
            // Unreachable in practice — extract candidates are never
            // auto-applied, so the `!appliedAt` guard above rejects first.
            // Kept for switch exhaustiveness.
            return {
              data:
                `undoReclassification has nothing to reverse for candidate ${input.candidate_id}: extract candidates are never auto-applied, so the brain never changed from this one. Nothing was changed now either. ` +
                'Tell the user there is nothing to roll back. ' +
                'Do NOT retry this id — use dismissBrainCandidate if they simply want the suggestion cleared.',
              isError: true,
            }
          }
        }
      } catch (err) {
        return toolFailure(err, {
          tool: 'undoReclassification',
          target: `candidate ${input.candidate_id}`,
          mutating: true,
          next: 'The rollback is not atomic across steps — read the affected memory / task / link back with searchBrain, listTasks or getEntity before telling the user what state it is in.',
        })
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
      // Gate on the workspace BEFORE the limiter: a call that can never run
      // must not spend one of the user's five daily runs.
      const gate = workspaceGate(context.workspaceId, 'healMemories')
      if (gate) return gate
      const allowed = healLimiter.check(context.userId)
      if (!allowed) {
        return {
          data:
            '`healMemories` did not run: this user has already used all 5 of the daily on-demand cleanup runs (the cap exists because each run is a batch of LLM calls over their memories). Nothing was changed. ' +
            'The allowance refills 24h after the earliest of those runs. ' +
            'Tell the user that plainly and offer the alternatives that are not capped — reviewing pending suggestions with listBrainCandidates, or fixing a specific record directly. Do NOT retry today; no argument change lifts the cap.',
          isError: true,
        }
      }
      try {
        const ctx = {
          workspaceId: context.workspaceId!,
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

        const runtime = await deps.resolveLlm?.(ctx.workspaceId)
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
          provider: runtime?.provider ?? deps.provider,
          model: runtime?.model ?? deps.reclassifierModel,
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
        return toolFailure(err, {
          tool: 'healMemories',
          target: 'this workspace\'s recent memories',
          mutating: true,
          next:
            'The run is a batch, so some reclassifications may already have applied before it failed — call listBrainCandidates to see what actually landed before telling the user anything about the outcome. ' +
            'This call consumed one of the 5 daily runs either way, so do not loop on it.',
        })
      }
    },
  })

  // ── 6. dedupeEntities ─────────────────────────────────────────────

  const dedupeEntities = buildTool({
    name: 'dedupeEntities',
    description:
      'Self-heal duplicate entities you can see in this workspace. Only ' +
      'merges entities visible to you and never merges across a visibility ' +
      'boundary, so a record that has no duplicate you can see is never ' +
      'touched. Runs two auto-apply passes over that visible scope: ' +
      '(1) within-kind collisions on (kind, lower(display_name)); ' +
      '(2) cross-kind collisions on lower(display_name) alone, capped at ' +
      'small clusters so legitimately-ambiguous shared names are not ' +
      'auto-merged. Each duplicate is merged into the curated survivor ' +
      '(within-kind: a user-verified / user-created row, else the oldest) ' +
      'or the highest-priority kind (cross-kind: CRM > repository > project ' +
      '> product) using survivor-wins reconciliation. This operates on the ' +
      'WHOLE visible workspace, not a named pair — when the user names two ' +
      'specific records to combine ("combine these two Ashley Chan ' +
      'contacts"), use mergeEntities instead. Use dedupeEntities when the ' +
      'user says "clean up duplicates", "dedupe my brain", "I see the same ' +
      'project listed five times".',
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
            'Costs one Flash-class LLM call per invocation. Its clusters are ' +
            'returned as suggestions for the user to confirm and are NEVER ' +
            'auto-merged. Default false.',
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

      // Same visibility scope as execute (corrections.md §D.9 dedupe
      // guard) — the preview must show exactly what would merge, so it
      // reads through the caller's access context too.
      const access = dedupeAccess(context, workspaceId)
      try {
        const withinKind = await deps.entities.findDuplicateClustersSystem(
          context.userId,
          workspaceId,
          { limit: clusterCap, kind },
          access,
        )
        // Cross-kind pass runs only when no single-kind filter is set —
        // exactly the runEntityDedupe gate, so the preview matches execute.
        const crossKind =
          kind === undefined
            ? await deps.entities.findCrossKindDuplicateClustersSystem(
                context.userId,
                workspaceId,
                { limit: clusterCap },
                access,
              )
            : []

        if (withinKind.length === 0 && crossKind.length === 0) {
          return ['No duplicate clusters found — nothing would be merged.']
        }

        // Resolve every clustered id to its display name in one visible read.
        const names = await resolveEntityDisplayNames(
          deps.entities,
          context.userId,
          workspaceId,
          kind,
          access,
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
            '(plus any semantic-alias clusters the opt-in LLM pass proposes — those are returned as suggestions for you to confirm, never auto-merged)',
          )
        }
        return lines
      } catch (err) {
        console.debug('[healing-tools] dedupeEntities describeConfirmation failed:', err)
        return null
      }
    },

    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId, 'dedupeEntities')
      if (gate) return gate
      try {
        const workspaceId = context.workspaceId!
        if (!deps.entityMerge) {
          return {
            data:
              'dedupeEntities did not run: the entity-merge ports are not wired in this deployment, so the tool is registered but has no write path behind it. Nothing was changed. ' +
              'No argument change or retry will make it work here. ' +
              'Tell the user duplicate cleanup is not available on this install and offer what is: point at the duplicates you can see with searchBrain / getEntity so they can decide, and note that a self-hosted install needs `EntityMergeRepository` wired on `createBrainHealingTools`.',
            isError: true,
          }
        }
        const runtime = input.cluster_by_llm ? await deps.resolveLlm?.(workspaceId) : null
        const result: EntityDedupeResult = await runEntityDedupe({
          entities: deps.entities,
          merge: deps.entityMerge,
          workspaceId,
          actorUserId: context.userId,
          // Scope the sweep to rows the caller can see (corrections.md
          // §D.9 dedupe guard) — never merge across a visibility boundary.
          access: dedupeAccess(context, workspaceId),
          clusterCap: input.cluster_cap,
          kind: input.kind,
          clusterByLlm: input.cluster_by_llm,
          llmClusterer: input.cluster_by_llm
            ? {
                provider: runtime?.provider ?? deps.provider,
                model: runtime?.model ?? deps.reclassifierModel,
              }
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
        return toolFailure(err, {
          tool: 'dedupeEntities',
          target: input.kind ? `every visible ${input.kind} record in this workspace` : 'every visible record in this workspace',
          mutating: true,
          next:
            'The sweep merges cluster by cluster, so some merges may already have applied before it failed — read the current state with searchBrain / getEntity before telling the user what was combined. ' +
            'A merge is reversible for 7 days with undoEntityMerge. Do NOT re-run the sweep to "make sure"; that risks merging further.',
        })
      }
    },
  })

  // ── 7. mergeEntities (scoped pairwise merge — corrections.md D.1) ──

  const mergeEntitiesTool = buildTool({
    name: 'mergeEntities',
    description:
      'Combine TWO specific duplicate records into one — the scoped, ' +
      'pairwise merge. Use this (not dedupeEntities) when the user names ' +
      'the records to combine ("combine these two Ashley Chan contacts", ' +
      '"these two are the same company"). survivor_id is the record to ' +
      'KEEP; merged_id is folded into it and superseded. Pass the id of a ' +
      'contact / company / deal / entity from listContacts / getContact / ' +
      'searchBrain / getEntity (the CRM row id and the entity id are the ' +
      'same value). Non-conflicting fields are unioned onto the survivor; ' +
      'if a field genuinely differs the tool tells you which and you re-run ' +
      'with on_conflict to choose. Only records you can see can be merged, ' +
      'and the merge is reversible for 7 days with undoEntityMerge.',
    inputSchema: z.object({
      survivor_id: z
        .string()
        .uuid()
        .describe('The record to KEEP (survives the merge).'),
      merged_id: z
        .string()
        .uuid()
        .describe('The duplicate record to fold into the survivor (superseded).'),
      on_conflict: z
        .enum(['ask', 'keep_survivor', 'keep_merged'])
        .optional()
        .describe(
          'How to resolve a field that differs between the two records. ' +
            '"ask" (default) surfaces the conflicting fields instead of ' +
            'guessing; "keep_survivor" takes the survivor\'s values; ' +
            '"keep_merged" takes the merged record\'s values.',
        ),
      reason: z
        .string()
        .optional()
        .describe('Optional note recorded in the merge audit.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    // Tier-D write-gate (Posture A) — a merge collapses one record's
    // identity into another and can drop a field under keep_survivor /
    // keep_merged. Reversible for 7 days, but a destructive identity
    // change must never fire un-previewed. Gate everywhere with a preview.
    requiresConfirmation: true,
    allowPersistentApproval: false,

    async describeConfirmation(input, context) {
      const workspaceId = context.workspaceId
      if (!workspaceId) return null
      const parsed = input as { survivor_id?: string; merged_id?: string }
      if (!parsed.survivor_id || !parsed.merged_id) return null
      try {
        const access = dedupeAccess(context, workspaceId)
        const [survivor, merged] = await Promise.all([
          deps.entities.getById(access, parsed.survivor_id),
          deps.entities.getById(access, parsed.merged_id),
        ])
        const sName = survivor?.displayName ?? `(id ${parsed.survivor_id.slice(0, 8)})`
        const mName = merged?.displayName ?? `(id ${parsed.merged_id.slice(0, 8)})`
        return [
          `Merge ${mName} into ${sName}. ${sName} survives and keeps its identity; ${mName} is folded in and superseded. Reversible for 7 days.`,
        ]
      } catch (err) {
        console.debug('[healing-tools] mergeEntities describeConfirmation failed:', err)
        return null
      }
    },

    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId, 'mergeEntities')
      if (gate) return gate
      try {
        const workspaceId = context.workspaceId!
        if (!deps.entityMerge) {
          return {
            data:
              'mergeEntities did not run: the entity-merge ports are not wired in this deployment, so the tool is registered but has no write path behind it. Nothing was changed. ' +
              'No argument change or retry will make it work here. ' +
              'Tell the user records cannot be combined on this install (a self-hosted install needs `EntityMergeRepository` wired on `createBrainHealingTools`), and offer to note the duplication in a memory instead.',
            isError: true,
          }
        }
        if (input.survivor_id === input.merged_id) {
          return {
            data:
              `mergeEntities did not run: survivor_id and merged_id are both ${input.survivor_id}, and a record cannot be merged into itself. Nothing was changed. ` +
              'Resolve the SECOND record the user named — call searchBrain / getEntity (or listContacts / listCompanies / listDeals) and pass its id as merged_id. ' +
              'Retrying with the same id twice will keep failing.',
            isError: true,
          }
        }

        // Visibility guard (corrections.md §D.9): only records the caller
        // can actually see may be merged — resolve both through the
        // access-scoped read, never a system lookup. This is the pairwise
        // analogue of the dedupe sweep's visibility scoping.
        const access = dedupeAccess(context, workspaceId)
        const [survivor, merged] = await Promise.all([
          deps.entities.getById(access, input.survivor_id),
          deps.entities.getById(access, input.merged_id),
        ])
        if (!survivor) {
          return {
            data:
              `mergeEntities did not run: survivor_id ${input.survivor_id} is not a record you can see in this workspace — it does not exist, was itself merged away (a merge supersedes the folded-in id), or sits above this assistant's clearance. Nothing was changed. ` +
              'Re-resolve BOTH ids with searchBrain / getEntity (or listContacts / listCompanies / listDeals) and retry with the current pair. ' +
              'Do NOT retry this exact id.',
            isError: true,
          }
        }
        if (!merged) {
          return {
            data:
              `mergeEntities did not run: merged_id ${input.merged_id} is not a record you can see in this workspace — it does not exist, was itself merged away (a merge supersedes the folded-in id), or sits above this assistant's clearance. Nothing was changed. ` +
              `The survivor ${input.survivor_id} resolved fine, so only this id is wrong: re-resolve it with searchBrain / getEntity (or listContacts / listCompanies / listDeals). ` +
              'Do NOT retry this exact id.',
            isError: true,
          }
        }

        const onConflict = input.on_conflict ?? 'ask'
        const mode: ReconciliationMode =
          onConflict === 'keep_survivor'
            ? 'survivor-wins'
            : onConflict === 'keep_merged'
              ? 'merged-wins'
              : 'auto-merge-with-prompt'

        // In the default 'ask' mode, surface the exact conflicting fields
        // (and both values) instead of a bare failure, so the user can
        // choose which record's values win rather than silently losing one.
        if (mode === 'auto-merge-with-prompt') {
          const { conflicts } = reconcileAttributes(survivor.attributes, merged.attributes, mode)
          const unresolved = conflicts.filter((c) => c.severity === 'requires_resolution')
          if (unresolved.length > 0) {
            const fields = unresolved
              .map((c) => `${c.field} (${JSON.stringify(c.survivorValue)} vs ${JSON.stringify(c.mergedValue)})`)
              .join('; ')
            return {
              data:
                `mergeEntities did not merge ${merged.displayName} (${merged.id}) into ${survivor.displayName} (${survivor.id}): these fields hold different values on the two records, and the default mode refuses to silently drop one — ${fields}. Nothing was changed. ` +
                `Re-run the SAME two ids with on_conflict="keep_survivor" (keep ${survivor.displayName}'s values) or on_conflict="keep_merged" (keep ${merged.displayName}'s values); ask the user which if the difference matters. ` +
                'Retrying unchanged will keep failing.',
              isError: true,
            }
          }
        }

        const record = await mergeEntities(
          {
            workspaceId,
            survivingId: survivor.id,
            mergedId: merged.id,
            actorUserId: context.userId,
            reason: input.reason ?? 'user-initiated pairwise merge (chat)',
            mode,
          },
          deps.entityMerge,
        )

        return {
          data: {
            merged: true,
            survivorId: survivor.id,
            survivorName: survivor.displayName,
            mergedId: merged.id,
            mergedName: merged.displayName,
            mergeId: record.id,
            note:
              `Merged ${merged.displayName} into ${survivor.displayName}. ` +
              `Reversible for 7 days with undoEntityMerge (merge_id ${record.id}).`,
          },
        }
      } catch (err) {
        if (err instanceof EntityMergeError) {
          return { data: mergeErrorMessage(err, input.survivor_id, input.merged_id), isError: true }
        }
        return toolFailure(err, {
          tool: 'mergeEntities',
          target: `survivor ${input.survivor_id} + merged ${input.merged_id}`,
          mutating: true,
          next: 'Read both records back with getEntity before telling the user anything about the outcome; if the merge did land, it is reversible for 7 days with undoEntityMerge.',
        })
      }
    },
  })

  // ── 8. undoEntityMerge (reverse a merge — corrections.md D.2) ──────

  const undoEntityMergeTool = buildTool({
    name: 'undoEntityMerge',
    description:
      'Reverse an entity merge within its 7-day window — restores both ' +
      'records to their pre-merge state. Use when the user says "undo that ' +
      'merge", "they are actually different people, split them back", or ' +
      '"put that record back" after a mergeEntities or dedupeEntities run. ' +
      'Pass merge_id from the merge result. Outside 7 days, or if the ' +
      'survivor was merged again, the tool says so and the record must be ' +
      'rebuilt by hand.',
    inputSchema: z.object({
      merge_id: z
        .string()
        .uuid()
        .describe('The merge id returned by mergeEntities (or from the merge audit).'),
      reason: z
        .string()
        .optional()
        .describe('Optional note recorded in the undo audit.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    // Tier-C write-gate (see undoReclassification): this IS the recovery
    // path for an errant merge, so interactive stays silent; the
    // autonomous path gates so a headless loop can't roll merges back and
    // forth unattended.
    resolveConfirmation: async (context) => isAutonomousToolContext(context),

    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId, 'undoEntityMerge')
      if (gate) return gate
      try {
        const workspaceId = context.workspaceId!
        if (!deps.entityMerge) {
          return {
            data:
              'undoEntityMerge did not run: the entity-merge ports are not wired in this deployment, so the tool is registered but has no write path behind it. Nothing was changed. ' +
              'No argument change or retry will make it work here. ' +
              'Tell the user the automatic undo is not available on this install (a self-hosted install needs `EntityMergeRepository` wired on `createBrainHealingTools`) and offer to rebuild the separated record by hand.',
            isError: true,
          }
        }
        await undoMerge(
          {
            workspaceId,
            mergeId: input.merge_id,
            actorUserId: context.userId,
            reason: input.reason,
          },
          deps.entityMerge,
        )
        return {
          data: {
            undone: true,
            mergeId: input.merge_id,
            note: 'The merge was reversed — both records are back to their pre-merge state.',
          },
        }
      } catch (err) {
        if (err instanceof UndoMergeError) {
          return { data: undoErrorMessage(err, input.merge_id), isError: true }
        }
        return toolFailure(err, {
          tool: 'undoEntityMerge',
          target: `merge ${input.merge_id}`,
          mutating: true,
          next: 'Read both records back with getEntity before telling the user whether they were separated; the 7-day undo window keeps running while you retry, so do not loop.',
        })
      }
    },
  })

  // ── 9. noteAlias ──────────────────────────────────────────────────

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
      // Pre-flight: ensure the workspace context is set; the underlying
      // store call is RLS-gated so we don't need to thread workspaceId
      // through, but a missing workspace context means this assistant
      // has no brain to teach.
      const gate = workspaceGate(context.workspaceId, 'noteAlias')
      if (gate) return gate
      try {
        const result = await deps.entities.addAlias(
          context.userId,
          input.entity_id,
          input.alias,
        )
        if (result.kind === 'not_found') {
          return notFoundFailure({
            kind: 'Entity',
            id: input.entity_id,
            discoveryTool: 'searchBrain / getEntity',
            extra: `The alias "${input.alias}" was NOT registered. The record may also be above this assistant's clearance, which reads the same as missing.`,
            idSource: 'a searchBrain / getEntity / listContacts result, never a display name',
          })
        }
        if (result.kind === 'conflict') {
          // D5: prose first, structured tail after — a multi-key object would
          // reach the model as raw JSON it has to parse to read a sentence.
          return {
            data:
              `noteAlias did not register "${input.alias}" on entity ${input.entity_id}: that alias is already bound to a DIFFERENT live entity, ${result.conflictingEntityId}, and one alias cannot resolve to two records. Nothing was changed. ` +
              `Decide which case this is: if the two records are the same thing, merge them first (mergeEntities with survivor_id ${input.entity_id} and merged_id ${result.conflictingEntityId}, or the other way round) and the alias question disappears; if they are genuinely different, pick a more specific alias. ` +
              'Retrying this exact alias unchanged will keep failing. ' +
              `(conflicting_entity_id: ${result.conflictingEntityId})`,
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
        return toolFailure(err, {
          tool: 'noteAlias',
          target: `alias "${input.alias}" on entity ${input.entity_id}`,
          mutating: true,
          next: 'Entity ids come from searchBrain / getEntity and are superseded by a merge — re-resolve there if this one is stale.',
        })
      }
    },
  })

  // ── 10. splitAlias ────────────────────────────────────────────────

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
      const gate = workspaceGate(context.workspaceId, 'splitAlias')
      if (gate) return gate
      try {
        const updated = await deps.entities.removeAlias(
          context.userId,
          input.entity_id,
          input.alias,
        )
        if (!updated) {
          return notFoundFailure({
            kind: 'Entity',
            id: input.entity_id,
            discoveryTool: 'searchBrain / getEntity',
            extra: `The alias "${input.alias}" was NOT removed. The record may also be above this assistant's clearance, which reads the same as missing. (Removing an alias the entity never had is a no-op, not this error — this error means the ENTITY did not resolve.)`,
            idSource: 'a searchBrain / getEntity / listContacts result, never a display name',
          })
        }
        return {
          data: {
            entityId: updated.id,
            displayName: updated.displayName,
            aliases: updated.aliases,
          },
        }
      } catch (err) {
        return toolFailure(err, {
          tool: 'splitAlias',
          target: `alias "${input.alias}" on entity ${input.entity_id}`,
          mutating: true,
          next: 'Entity ids come from searchBrain / getEntity and are superseded by a merge — re-resolve there if this one is stale.',
        })
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
    mergeEntitiesTool,
    undoEntityMergeTool,
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
  access?: AccessContext,
): Promise<Map<string, string>> {
  const rows = await entities.listLiveEntitiesSystem(
    actorUserId,
    workspaceId,
    { kind, limit: 500 },
    access,
  )
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
