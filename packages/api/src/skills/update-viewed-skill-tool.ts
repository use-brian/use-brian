/**
 * The `updateViewedSkill` tool: edits the workspace skill open in the user's
 * Brain skill editor, after the user's approval. Declared here rather than in
 * the chat route so the boot tool step (`boot/tools.register.ts`, the hidden
 * restart-safe replay instance) and the chat route (the visible, editor-scoped
 * instance) import the declaring module, and the tool step no longer loads the
 * chat route module (M4 step 5, D13). Behaviour unchanged by the move.
 *
 * Spec: docs/architecture/engine/skill-system.md; failure copy follows
 * docs/architecture/engine/tool-executor.md -> "Failure copy".
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { buildTool, type Tool } from '@use-brian/agent-runtime/tools/types.js'
import type { WorkspaceSkillStore } from '../db/skill-store.js'
import { isSkillOfferable } from '../routes/route-helpers.js'

export function workspaceSkillRevision(skill: {
  name: string
  description: string
  whenToUse?: string
  content: string
}): string {
  return createHash('sha256')
    .update(JSON.stringify([skill.name, skill.description, skill.whenToUse ?? null, skill.content]))
    .digest('hex')
}

/**
 * A visible instance is scoped to the skill already resolved through the
 * editor's RLS read and rejects any mismatched row id. The hidden boot instance
 * accepts the frozen, approved id only for restart-safe replay. Confirmation is
 * load-bearing: the store treats a human-approved name/body edit as certification.
 */
export function createUpdateViewedSkillTool(args: {
  workspaceSkillStore: Pick<WorkspaceSkillStore, 'getByIdSystem' | 'update'>
  workspaceId?: string
  skillRowId?: string
  skillName?: string
  expectedRevision?: string
  assistantClearance?: 'public' | 'internal' | 'confidential'
}): Tool {
  const scoped = Boolean(args.workspaceId && args.skillRowId && args.skillName)
  return buildTool({
    name: 'updateViewedSkill',
    description:
      `Update the workspace skill currently open in the user's editor${args.skillName ? ` (${JSON.stringify(args.skillName)})` : ''}. ` +
      'Pass only fields the user asked to change; omitted fields remain unchanged. This tool is scoped ' +
      'to the open skill and asks the user to approve before saving.',
    inputSchema: z
      .object({
        skillRowId: z.string().min(1).describe('The row id shown in the currently-viewing skill context.'),
        expectedRevision: z.string().length(64).describe('The revision shown in the currently-viewing skill context.'),
        name: z.string().trim().min(1).max(100).optional(),
        description: z.string().trim().max(250).optional(),
        whenToUse: z.string().trim().max(300).nullable().optional(),
        content: z.string().trim().min(1).max(5000).optional(),
      })
      .refine(
        ({ skillRowId: _skillRowId, expectedRevision: _expectedRevision, ...updates }) =>
          Object.values(updates).some((value) => value !== undefined),
        { message: 'Provide at least one field to update.' },
      ),
    hiddenFromModel: !scoped,
    requiresConfirmation: true,
    async describeConfirmation(input) {
      const { skillRowId, expectedRevision: _expectedRevision, ...updates } = input as Record<string, unknown>
      const lines = [`Skill: ${args.skillName ?? String(skillRowId)}`]
      const labels: Record<string, string> = {
        name: 'Name',
        description: 'Description',
        whenToUse: 'When to use',
        content: 'Instructions',
      }
      for (const [field, value] of Object.entries(updates)) {
        lines.push(`${labels[field] ?? field}: ${value === null ? '(clear)' : String(value)}`)
      }
      if ('name' in updates || 'content' in updates) {
        lines.push('Effect: Approving verifies and activates this skill at certified confidence.')
      }
      return lines
    },
    async execute(input, ctx) {
      // Failure copy contract (docs/architecture/engine/tool-executor.md →
      // "Failure copy"): every refusal below names the skill, why the write did
      // not happen, where a correct rowId/revision comes from (the
      // "Currently viewing — workspace skill" block is the ONLY source — there
      // is no skill-listing tool on this surface), and whether a retry can work.
      const openSkill = args.skillName ? JSON.stringify(args.skillName) : `skill ${input.skillRowId}`
      const VIEWING_BLOCK = 'the "Currently viewing — workspace skill" block in this conversation'
      if (!ctx.workspaceId || (args.workspaceId && ctx.workspaceId !== args.workspaceId)) {
        return {
          data:
            `${openSkill} was NOT updated: this conversation is not running in the workspace that owns the open skill, so the update was refused before it touched anything. ` +
            'Ask the user to reopen the skill in the Brain skill editor of that workspace and repeat the change there. ' +
            'Retrying updateViewedSkill from this conversation will be refused the same way.',
          isError: true,
        }
      }
      if (args.skillRowId && input.skillRowId !== args.skillRowId) {
        return {
          data:
            `Nothing was saved: skillRowId ${input.skillRowId} is not the skill open in the editor (${args.skillRowId}). ` +
            'This tool can only edit the ONE skill the user currently has open - it cannot reach any other skill, and there is no tool here that lists skills. ' +
            `Re-issue with the exact row id from ${VIEWING_BLOCK}. If the user meant a different skill, tell them to open that one first. Do NOT retry this row id.`,
          isError: true,
        }
      }
      if (args.expectedRevision && input.expectedRevision !== args.expectedRevision) {
        return {
          data:
            `${openSkill} was NOT updated: the expectedRevision you sent (${input.expectedRevision.slice(0, 12)}…) is not the revision of the skill open in the editor. ` +
            'The revision is the guard that stops an approved edit from overwriting a newer version, so a mismatch is refused rather than applied. ' +
            `Copy the revision verbatim from ${VIEWING_BLOCK} and re-issue with it. Do NOT retry this revision - it will be refused every time.`,
          isError: true,
        }
      }
      const current = await args.workspaceSkillStore.getByIdSystem(input.skillRowId)
      if (!current || current.workspaceId !== ctx.workspaceId || current.state === 'archived') {
        return {
          data:
            `${openSkill} was NOT updated: workspace skill ${input.skillRowId} is no longer editable - it has been deleted, archived, or moved to another workspace since the editor opened it. Nothing was saved. ` +
            'Tell the user the skill is gone from this workspace; an archived skill has to be restored in the Brain skill editor before it can be changed. ' +
            'Do NOT retry this row id.',
          isError: true,
        }
      }
      const assistantClearance = args.assistantClearance ?? ctx.assistantClearance ?? ctx.clearance ?? 'public'
      if (!isSkillOfferable(current, { assistantClearance })) {
        return {
          data:
            `${JSON.stringify(current.name)} was NOT updated: the skill is classified ${current.sensitivity} and this assistant's clearance is ${assistantClearance}, so it may not write it. Nothing was saved. ` +
            'No wording of this call gets past a clearance gate. Tell the user the skill is above this assistant\'s clearance, and that either the skill\'s sensitivity or the assistant\'s clearance has to be changed in Studio.',
          isError: true,
        }
      }
      if (workspaceSkillRevision(current) !== input.expectedRevision) {
        return {
          data:
            `${JSON.stringify(current.name)} was NOT updated: someone else edited the skill while this change waited for the user's approval, so the approved revision no longer matches what is saved and the write was refused rather than clobbering their edit. Nothing was saved. ` +
            'Read the skill again, show the user what changed, and propose the update against the current text. Re-sending the same expectedRevision will keep failing.',
          isError: true,
        }
      }
      const { skillRowId, expectedRevision: _expectedRevision, ...updates } = input
      const updated = await args.workspaceSkillStore.update(
        ctx.userId,
        ctx.workspaceId,
        skillRowId,
        updates,
        {
          name: current.name,
          description: current.description,
          whenToUse: current.whenToUse,
          content: current.content,
        },
      )
      if (!updated) {
        return {
          data:
            `${JSON.stringify(current.name)} was NOT updated: another editor saved the skill in the moment between the revision check and this write, so the approved change was dropped instead of being applied on top of theirs. Nothing was saved. ` +
            'Read the skill again, confirm the user\'s change still makes sense against the new text, and propose it once more. Retrying this exact call will fail the same way.',
          isError: true,
        }
      }
      return { data: `Saved the approved changes to ${JSON.stringify(updated.name)}.` }
    },
  })
}
