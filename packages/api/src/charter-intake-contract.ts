/**
 * Charter intake contract: the setup-interview condition and its addendum
 * (growth loop Phase 2, docs/architecture/features/assistant-profiles.md
 * "The setup interview"). A leaf module with no tool or database imports, so
 * the web chat route decides intake mode without statically loading the intake
 * implementation; the `saveCharter` tool (`intake/charter-intake.ts`) is loaded
 * only on a turn whose intake mode is on. Split from `intake/charter-intake.ts`
 * for the chat import graph (M4 frontier edge `routes/chat.ts -> intake/`).
 *
 * [COMP:api/charter-intake]
 */
import type { AssistantCharter } from '@use-brian/shared'

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
