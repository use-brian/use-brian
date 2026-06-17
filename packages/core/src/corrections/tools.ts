/**
 * Correction chat tools (WU-6.8 — tool layer).
 *
 * The user-facing surface for D.3 / D.4 / D.6 corrections. Spec:
 * docs/architecture/brain/corrections.md §D.3, §D.4, §D.6, §D.8.
 *
 * Three tools the chat model resolves so a user can correct the brain
 * through their own channel — per CLAUDE.md, every recovery must be
 * reachable through the user's own channel (chat or web UI), never an
 * ad-hoc operator cleanup:
 *
 *  • `retractMemory`         — D.3: mark a memory "was never correct".
 *  • `deleteBrainRow`        — D.4: bi-temporal soft-delete of a non-memory row.
 *  • `reclassifySensitivity` — D.6: change a row's sensitivity tier.
 *
 * Pure `packages/core` — persistence is via the injected correction
 * repository ports. `apps/api` wires the DB adapters and adds the
 * returned tools to the boot-time first-party map (`allTools`), the same
 * way `createWorkflowBrainTools` is wired.
 *
 * Scope decisions (corrections.md §D.8 — "the tool layer"):
 *
 *  • Irreversible operations are deliberately NOT chat tools — `purgeMemory`
 *    / `hardPurge` (hard DELETE) and the operator-only `reExtractEpisode`
 *    route through an operator surface, not the model. A chat tool exposes
 *    only the reversible corrections.
 *  • `reclassifySensitivity` honours the D.8 asymmetric direction rule:
 *    raising a tier is open to any workspace member, lowering one is
 *    admin-only. The tool resolves the actor's role and picks the
 *    orchestrator `triggeredBy` accordingly — `per_row_operator` for an
 *    admin (both directions), the non-operator path for a member (the
 *    orchestrator then refuses a downgrade). Every call carries a
 *    mandatory, audited `reason`.
 *
 * [COMP:corrections/tools]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import { retractMemory, type MemoryRetractionRepository } from './retraction.js'
import { softDelete, type SoftDeleteRepository } from './soft-delete.js'
import {
  reclassifyRowSensitivity,
  SensitivityReclassificationError,
  type SensitivityReclassificationRepository,
} from './sensitivity-reclassification.js'

/**
 * Resolves the actor's workspace role. Per corrections.md §D.8 a
 * sensitivity *downgrade* is an admin-tier action while an *upgrade* is
 * open to any member; `reclassifySensitivity` reads the role to pick the
 * orchestrator's `triggeredBy`.
 */
export type WorkspaceRoleResolver = (
  userId: string,
  workspaceId: string,
) => Promise<'owner' | 'admin' | 'member' | null>

export type CorrectionToolsDeps = {
  retraction: MemoryRetractionRepository
  softDelete: SoftDeleteRepository
  reclassify: SensitivityReclassificationRepository
  resolveWorkspaceRole: WorkspaceRoleResolver
}

/** Chat turns always carry a workspace for brain tools; the type allows null. */
function requireWorkspace(workspaceId: string | null | undefined): string {
  if (!workspaceId) {
    throw new Error('correction tool invoked without a workspace context')
  }
  return workspaceId
}

function errorData(err: unknown): { data: string; isError: true } {
  return { data: err instanceof Error ? err.message : String(err), isError: true }
}

export function createCorrectionTools(deps: CorrectionToolsDeps): Tool[] {
  const retractMemoryTool = buildTool({
    name: 'retractMemory',
    description:
      'Retract a memory the brain got wrong — marks it "was never correct" so it stops ' +
      'being surfaced and is never re-derived from its source. Use when the user says a ' +
      'stored fact about a person or the company is false. For "this was true but has ' +
      'since changed", update the memory normally instead of retracting it.',
    inputSchema: z.object({
      memory_id: z.string().uuid().describe('The id of the memory to retract.'),
      reason: z
        .string()
        .min(1)
        .describe('Why it is wrong — recorded in the correction audit.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,

    async execute(input, context) {
      try {
        const result = await retractMemory(
          {
            workspaceId: requireWorkspace(context.workspaceId),
            memoryId: input.memory_id,
            actorUserId: context.userId,
            reason: input.reason,
          },
          { memoryRepo: deps.retraction },
        )
        return {
          data: {
            memoryId: result.memoryId,
            retractedAt: result.retractedAt.toISOString(),
          },
        }
      } catch (err) {
        return errorData(err)
      }
    },
  })

  const deleteBrainRowTool = buildTool({
    name: 'deleteBrainRow',
    description:
      'Soft-delete a brain row — an entity, task, KB chunk, contact, company, or deal. ' +
      'Closes the row\'s validity window so it stops appearing, while its history is ' +
      'preserved for audit. Use when the user says a record should no longer exist. ' +
      'For memories use retractMemory instead.',
    inputSchema: z.object({
      primitive: z.enum(['entity', 'task', 'kb_chunk', 'contact', 'company', 'deal']),
      row_id: z.string().uuid().describe('The id of the row to delete.'),
      reason: z.string().min(1).describe('Why — recorded in the correction audit.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,

    async execute(input, context) {
      try {
        const result = await softDelete(
          {
            primitive: input.primitive,
            workspaceId: requireWorkspace(context.workspaceId),
            rowId: input.row_id,
            actorUserId: context.userId,
            reason: input.reason,
          },
          { repo: deps.softDelete },
        )
        return {
          data: {
            primitive: result.primitive,
            rowId: result.rowId,
            deletedAt: result.deletedAt.toISOString(),
          },
        }
      } catch (err) {
        return errorData(err)
      }
    },
  })

  const reclassifySensitivityTool = buildTool({
    name: 'reclassifySensitivity',
    description:
      'Change the sensitivity tier (public / internal / confidential) of a brain row. ' +
      'Raising the tier is available to any workspace member and cascades to rows derived ' +
      'from it; lowering a tier widens who can read the row and is restricted to workspace ' +
      'admins.',
    inputSchema: z.object({
      primitive: z.enum([
        'memory',
        'entity',
        'task',
        'episode',
        'kb_chunk',
        'contact',
        'company',
        'deal',
        'workspace_file',
        'entity_link',
      ]),
      row_id: z.string().uuid().describe('The id of the row to reclassify.'),
      new_sensitivity: z.enum(['public', 'internal', 'confidential']),
      reason: z.string().min(1).describe('Why — recorded in the correction audit.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,

    async execute(input, context) {
      try {
        const workspaceId = requireWorkspace(context.workspaceId)
        const role = await deps.resolveWorkspaceRole(context.userId, workspaceId)
        const isAdmin = role === 'owner' || role === 'admin'
        const result = await reclassifyRowSensitivity(
          {
            primitive: input.primitive,
            workspaceId,
            rowId: input.row_id,
            newSensitivity: input.new_sensitivity,
            actorUserId: context.userId,
            reason: input.reason,
            // D.8 — an admin may move a tier in either direction; a member
            // may only raise it. The non-operator path lets the orchestrator
            // permit an upgrade and refuse a downgrade.
            triggeredBy: isAdmin ? 'per_row_operator' : 'automatic_detection',
          },
          { rowRepo: deps.reclassify },
        )
        return {
          data: {
            rowId: result.rowId,
            priorSensitivity: result.priorSensitivity,
            newSensitivity: result.newSensitivity,
            direction: result.direction,
            cascadeApplied: result.cascadeApplied,
          },
        }
      } catch (err) {
        if (
          err instanceof SensitivityReclassificationError &&
          err.code === 'downgrade_requires_operator'
        ) {
          return {
            data: 'Lowering a sensitivity tier is restricted to workspace admins.',
            isError: true,
          }
        }
        return errorData(err)
      }
    },
  })

  return [retractMemoryTool, deleteBrainRowTool, reclassifySensitivityTool]
}
