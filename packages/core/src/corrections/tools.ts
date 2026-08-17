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
import { notFoundFailure, toolFailure } from '../tools/tool-failure.js'
import {
  retractMemory,
  MemoryRetractionError,
  type MemoryRetractionRepository,
} from './retraction.js'
import { softDelete, SoftDeleteError, type SoftDeleteRepository } from './soft-delete.js'
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

/**
 * The workspace gate. Chat turns normally carry a workspace, but the type
 * allows null and a personal (workspace-less) assistant reaches these tools.
 *
 * RETURNED, never thrown: a throw is rendered by the generic executor frame,
 * which can only repeat the sentence it was given — so the model saw
 * "correction tool invoked without a workspace context" and had no way to
 * know which surface is missing or what the user must do. The gate names both.
 */
function workspaceGate(
  workspaceId: string | null | undefined,
  tool: string,
): { data: string; isError: true } | null {
  if (!workspaceId) {
    return {
      data:
        `\`${tool}\` did not run: this chat is not bound to a workspace, and every brain correction is scoped to one workspace's rows — there is no row set to correct here. Nothing was changed. ` +
        'Ask the user to make the correction from a workspace chat (or from the web app), and answer the rest of their message normally. ' +
        'No argument change will help in this session; do not retry.',
      isError: true,
    }
  }
  return null
}

/**
 * The tool that re-resolves a current id for each `deleteBrainRow` primitive.
 * A miss must always ship the discovery pointer, and the right pointer depends
 * on the primitive the caller named.
 */
const LIST_TOOL_FOR_PRIMITIVE: Record<
  'entity' | 'task' | 'kb_chunk' | 'contact' | 'company' | 'deal',
  string
> = {
  entity: 'getEntity',
  task: 'listTasks',
  kb_chunk: 'searchKnowledge',
  contact: 'listContacts',
  company: 'listCompanies',
  deal: 'listDeals',
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
      const gate = workspaceGate(context.workspaceId, 'retractMemory')
      if (gate) return gate
      try {
        const result = await retractMemory(
          {
            workspaceId: context.workspaceId!,
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
        if (err instanceof MemoryRetractionError) {
          if (err.code === 'memory_not_found' || err.code === 'workspace_mismatch') {
            return notFoundFailure({
              kind: 'Memory',
              id: input.memory_id,
              discoveryTool: 'searchBrain (or the memory-listing tool)',
              supersession: true,
              extra: 'Nothing was retracted.',
              idSource: 'a memory read or a save result, never a summary line you composed yourself',
            })
          }
          if (err.code === 'memory_already_retracted') {
            return {
              data:
                `Memory ${input.memory_id} is ALREADY retracted, so nothing changed and nothing needed to. ` +
                'The end state the user asked for is in place — tell them it was already marked wrong. ' +
                'Do NOT retry this id and do not look for another retract tool; a second retraction of the same memory will keep failing this way.',
              isError: true,
            }
          }
        }
        return toolFailure(err, {
          tool: 'retractMemory',
          target: `memory ${input.memory_id}`,
          mutating: true,
          next:
            'A memory id comes from a searchBrain / memory-read result and is superseded by every edit — if this one is stale, re-resolve it there. ' +
            'If the memory is right but merely out of date, update it instead of retracting it.',
        })
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
      const gate = workspaceGate(context.workspaceId, 'deleteBrainRow')
      if (gate) return gate
      try {
        const result = await softDelete(
          {
            primitive: input.primitive,
            workspaceId: context.workspaceId!,
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
        if (err instanceof SoftDeleteError) {
          if (err.code === 'row_not_found' || err.code === 'workspace_mismatch') {
            return notFoundFailure({
              kind: input.primitive === 'kb_chunk' ? 'KB chunk' : input.primitive[0]!.toUpperCase() + input.primitive.slice(1),
              id: input.row_id,
              discoveryTool: `${LIST_TOOL_FOR_PRIMITIVE[input.primitive]} (or searchBrain)`,
              supersession: true,
              extra: `Nothing was deleted. \`primitive\` is part of the lookup, so an id of a different kind misses under \`${input.primitive}\` — re-check the kind too.`,
            })
          }
          if (err.code === 'already_soft_deleted' || err.code === 'already_retracted') {
            return {
              data:
                `${input.primitive} ${input.row_id} is ALREADY ${err.code === 'already_retracted' ? 'retracted' : 'deleted'}, so nothing changed and nothing needed to. ` +
                'The end state the user asked for is in place — tell them the record is already gone. ' +
                'Do NOT retry this id; deleting it again will keep failing this way.',
              isError: true,
            }
          }
          if (err.code === 'file_physical_delete_only') {
            return {
              data:
                `deleteBrainRow cannot remove a ${input.primitive}: that primitive is stored as bytes and only supports a physical delete, which is deliberately not a chat tool. Nothing was changed. ` +
                'Use the workspace-files delete path instead, or tell the user this has to be done from the web app. Retrying here will keep failing.',
              isError: true,
            }
          }
        }
        return toolFailure(err, {
          tool: 'deleteBrainRow',
          target: `${input.primitive} ${input.row_id}`,
          mutating: true,
          next:
            `\`primitive\` is part of the lookup, so a ${input.primitive} id that is really another kind of row will never resolve — re-check the kind, and re-resolve the id from the list tool for that primitive (listTasks / listContacts / listCompanies / listDeals / searchBrain).`,
        })
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
      const gate = workspaceGate(context.workspaceId, 'reclassifySensitivity')
      if (gate) return gate
      try {
        const workspaceId = context.workspaceId!
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
            data:
              `reclassifySensitivity did not lower ${input.primitive} ${input.row_id} to ${input.new_sensitivity}: lowering a sensitivity tier widens who can read the row, so it is restricted to workspace owners and admins, and this user is a member. Nothing was changed. ` +
              'Raising a tier is open to any member and would succeed. Tell the user an admin has to make this change; do not retry this call as this user.',
            isError: true,
          }
        }
        return toolFailure(err, {
          tool: 'reclassifySensitivity',
          target: `${input.primitive} ${input.row_id}`,
          mutating: true,
          next:
            `\`primitive\` is part of the lookup, so re-check that ${input.row_id} really is a ${input.primitive}, and re-resolve the id from that primitive's list tool or searchBrain if it is stale.`,
        })
      }
    },
  })

  return [retractMemoryTool, deleteBrainRowTool, reclassifySensitivityTool]
}
