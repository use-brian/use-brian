/**
 * Charter intake interview - growth loop Phase 2
 * (docs/plans/assistant-growth-loop.md §3, spec
 * docs/architecture/features/assistant-profiles.md).
 *
 * A self-terminating setup mode for the web chat route: while an assistant's
 * charter has neither a mission nor a success rubric AND the speaker is the
 * assistant's owner, the route injects the `saveCharter` tool plus the
 * interview addendum (both keyed on ONE boolean - the tool-awareness rule:
 * the prompt may only name a tool that is actually present this turn). The
 * assistant interviews the owner, drafts the charter, gets explicit
 * approval, and saves; the charter is then non-empty, so the next turn's
 * condition is false and the mode disappears on its own.
 *
 * The tool itself carries `requiresConfirmation: true` - the in-conversation
 * "does this look right?" is the model's protocol, but the tap-to-confirm is
 * the mechanism, so a prompt-injected "save this charter" in pasted content
 * can never rewrite identity without the owner's explicit confirmation.
 *
 * [COMP:api/charter-intake]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '@use-brian/core'
import {
  CHARTER_FIELD_LIMITS,
  charterIsEmpty,
  resolveCharter,
  type AssistantCharter,
} from '@use-brian/shared'
import { query } from '../db/client.js'

/**
 * True when this assistant should be offered the setup interview: a
 * standard assistant whose charter carries neither a mission nor a success
 * rubric. `kind='primary'` (the workspace reflector) and `kind='app'`
 * (product specialists with their own souls) never interview.
 */
export function charterNeedsIntake(
  charter: AssistantCharter,
  kind: 'standard' | 'app' | 'primary' | undefined,
): boolean {
  if (kind !== 'standard') return false
  return !charter.mission && !charter.success
}

/**
 * The interview addendum - a SKILL-style stable-prefix block. Injected ONLY
 * alongside the `saveCharter` tool. Kept at the "right altitude": the
 * question list is guidance, not a script, so the interview reads native in
 * whatever language the owner speaks.
 */
export const CHARTER_INTAKE_ADDENDUM = `# SKILL: Charter setup interview

This assistant has not been configured yet - its charter (mission, audience, success rubric, instructions) is empty, and you are talking with its owner. Your first job is to set the charter through a short interview, in the owner's language.

Protocol:
1. If the owner's message is a task, do the task first, then offer the setup ("Before we go further - want to spend two minutes telling me what I should own?"). If they decline, drop it and never nag; they can fill the charter in Studio later.
2. Interview briefly - one or two questions per turn, not a form dump:
   - What outcome should I own, and for whom? (mission)
   - Who do I serve, and how should I treat them? (audience)
   - Show me one example of a great result, or tell me what a good outcome looks like. (success - push gently for something concrete; this is the yardstick your future work is graded against)
   - Anything I must always or never do? Preferred voice? (instructions)
3. Push back once when an answer is too broad to act on ("that covers three different jobs - which one is mine?"). Accept their second answer as final.
4. Draft the charter and show it to the owner in full. Ask explicitly whether to save it.
5. Only after the owner clearly approves, call saveCharter with the drafted fields. Never call it before showing the draft, and never invent field content the owner did not express.

After saving, confirm in one sentence and mention the charter can be edited any time in Studio under the assistant's Settings.`

const saveCharterSchema = z.object({
  mission: z
    .string()
    .min(1)
    .max(CHARTER_FIELD_LIMITS.mission)
    .describe('The outcome this assistant owns, and for whom. One line, approved by the owner.'),
  success: z
    .string()
    .min(1)
    .max(CHARTER_FIELD_LIMITS.success)
    .describe(
      "What a good result looks like - the owner's criteria and/or example. This becomes the rubric the weekly reflection grades the assistant's work against.",
    ),
  audience: z
    .string()
    .max(CHARTER_FIELD_LIMITS.audience)
    .optional()
    .describe('Who the assistant serves and how to treat them. Omit if the owner did not say.'),
  instructions: z
    .string()
    .max(CHARTER_FIELD_LIMITS.instructions)
    .optional()
    .describe('How to work: scope, procedure, rules, voice. Omit if the owner did not say.'),
})

/**
 * Build the `saveCharter` tool for one intake turn. The write merges the
 * approved fields onto the CURRENT effective charter (same semantics as the
 * PATCH route), so a legacy instructions text survives an interview that
 * only set mission + success.
 */
export function createSaveCharterTool(params: { assistantId: string }): Tool {
  return buildTool({
    name: 'saveCharter',
    description:
      "Save this assistant's charter after the owner explicitly approved the drafted fields in conversation. mission and success are required; audience and instructions are optional. Never call this without showing the owner the full draft first.",
    inputSchema: saveCharterSchema,
    requiresConfirmation: true,
    isConcurrencySafe: false,
    isReadOnly: false,
    async execute(input) {
      const current = await query<{ charter: unknown; system_prompt: string | null; bio: string | null }>(
        `SELECT charter, system_prompt, bio FROM assistants WHERE id = $1`,
        [params.assistantId],
      )
      if (current.rows.length === 0) {
        return { data: 'Assistant not found', isError: true }
      }
      const merged = resolveCharter({
        charter: current.rows[0].charter,
        systemPrompt: current.rows[0].system_prompt,
        bio: current.rows[0].bio,
      })
      merged.mission = input.mission.trim()
      merged.success = input.success.trim()
      const audience = input.audience?.trim()
      if (audience) merged.audience = audience
      const instructions = input.instructions?.trim()
      if (instructions) merged.instructions = instructions
      if (charterIsEmpty(merged)) {
        return { data: 'Charter cannot be saved empty', isError: true }
      }
      await query(
        `UPDATE assistants SET charter = $1::jsonb, updated_at = now() WHERE id = $2`,
        [JSON.stringify(merged), params.assistantId],
      )
      return {
        data: 'Charter saved. The setup interview is complete - the owner can refine every field any time in Studio under this assistant\'s Settings.',
      }
    },
  })
}
