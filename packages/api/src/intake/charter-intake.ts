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
 * The condition (`charterNeedsIntake`) and the addendum
 * (`CHARTER_INTAKE_ADDENDUM`) live in the leaf contract module
 * `../charter-intake-contract.ts`; the chat route loads this module lazily,
 * only when intake mode is on.
 *
 * [COMP:api/charter-intake]
 */

import { z } from 'zod'
import { toolFailure } from '@use-brian/agent-runtime/tools/tool-failure.js'
import { buildTool, type Tool } from '@use-brian/agent-runtime/tools/types.js'
import {
  CHARTER_FIELD_LIMITS,
  charterIsEmpty,
  resolveCharter,
} from '@use-brian/shared'
import { query } from '../db/client.js'

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
      let current: { rows: Array<{ charter: unknown; system_prompt: string | null; bio: string | null }> }
      try {
        current = await query<{ charter: unknown; system_prompt: string | null; bio: string | null }>(
          `SELECT charter, system_prompt, bio FROM assistants WHERE id = $1`,
          [params.assistantId],
        )
      } catch (err) {
        // The read that the merge is built on. It failed, so nothing was
        // written — say so, rather than leaving the model to guess whether
        // the owner's approved charter landed.
        return toolFailure(err, {
          tool: 'saveCharter',
          action: "Reading this assistant's current charter before merging the approved fields",
          target: `assistant ${params.assistantId}`,
          next: 'Nothing was saved — the assistant still has the charter it had before. Do not re-run the interview; the owner\'s answers are still valid.',
        })
      }
      if (current.rows.length === 0) {
        return {
          data:
            `The charter was NOT saved: assistant ${params.assistantId} — the assistant this conversation is running as — no longer exists, so there is no row to write the mission and success rubric onto. ` +
            'It was deleted while the setup interview was in progress. This id is bound to the conversation, not something you passed, so there is nothing to correct and no id to look up: ' +
            'tell the user the assistant is gone and that the charter has to be set on a live assistant in Studio. Retrying saveCharter will fail the same way.',
          isError: true,
        }
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
        return {
          data:
            `The charter was NOT saved for assistant ${params.assistantId}: every field is blank once trimmed, so this would have wiped the assistant's identity instead of setting it. ` +
            '`mission` and `success` must each carry real text (whitespace alone passes the length check but trims away). ' +
            "Re-issue saveCharter with the mission and success the owner actually approved, in their words. Sending blank or whitespace-only fields again will be refused the same way.",
          isError: true,
        }
      }
      try {
        await query(
          `UPDATE assistants SET charter = $1::jsonb, updated_at = now() WHERE id = $2`,
          [JSON.stringify(merged), params.assistantId],
        )
      } catch (err) {
        return toolFailure(err, {
          tool: 'saveCharter',
          action: 'Saving the charter the owner approved',
          target: `assistant ${params.assistantId}`,
          mutating: true,
          next: 'Do not tell the user the setup is complete. Report that the charter could not be saved and that they can set mission and success in Studio under this assistant\'s Settings.',
        })
      }
      return {
        data: 'Charter saved. The setup interview is complete - the owner can refine every field any time in Studio under this assistant\'s Settings.',
      }
    },
  })
}
