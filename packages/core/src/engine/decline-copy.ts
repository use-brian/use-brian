/**
 * Canonical tool_result copy for a confirmation the user declined or let
 * expire — `[COMP:engine/decline-copy]`.
 *
 * These strings are MODEL-facing. They exist in one place because the same
 * three sentences are emitted from two modules (`engine/tool-executor.ts`
 * for direct tool calls, `mcp/tool-search.ts` for `mcp_call`-dispatched
 * ones) and drift between them is what produced the 2026-07-21 incident.
 *
 * **The incident.** The old text read "Capability unavailable for this
 * conversation." That claim was false: the block sets that back it
 * (`deniedTools` in the executor, `blockedTools` in tool-search) are
 * constructed per turn — the executor defaults `deniedTools` to a fresh
 * `Set` on every `executeTools()` call and no caller passes one in, and
 * `injectMcpTools()` rebuilds the tool-search closure on every turn. A
 * decline blocks the tool for the REST OF THAT TURN and nothing more.
 *
 * But the sentence was persisted into `session_messages`, so it outlived
 * the condition it described. On the next turn Gmail was injected and
 * usable, the model read "unavailable for this conversation" in history,
 * concluded the capability was gone, and — finding a fill-in-the-blank
 * refusal script in an `unavailable[]` notice — told the user to run
 * `/connect gmail`. Wrong diagnosis, wrong remedy, and `/connect` was
 * itself dead-ending at the time.
 *
 * So every string here must hold three properties:
 *   1. **True scope.** Say "this turn", never "this conversation".
 *   2. **Right diagnosis.** State plainly that this is not a connection,
 *      authorization, or setup problem, so the model does not reach for a
 *      reconnect remedy.
 *   3. **Right remedy.** Ask the user; retry on a yes.
 *
 * The phrase "for this conversation" is banned from these results and is
 * graded by `pnpm check` (`invariants/decline-copy`).
 *
 * Spec: `docs/architecture/engine/tool-executor.md` → "Declined confirmations".
 */

/**
 * Shared tail: kills the reconnect misdiagnosis and names the real remedy.
 * Every decline string ends with this.
 */
const STILL_CONNECTED =
  'This is NOT a connection, authorization, or setup problem: the connector is connected and the tool is available again on the next turn. ' +
  'Do NOT tell the user to reconnect, re-authorize, or run a /connect command.'

/**
 * The user tapped Deny on the confirmation prompt.
 *
 * `comment` is the optional "Deny with comment" note (web chat card /
 * approvals panel reason box). When present it is surfaced as the user's
 * reason and framed as an instruction: the model must address it and
 * re-propose, not merely re-ask. A bare deny keeps the ask-and-retry tail.
 * The note is arbitrary user text; callers cap its length before it
 * reaches here (`packages/api/src/routes/chat.ts` /confirm slices to 1000).
 */
export function declinedToolResult(toolName: string, comment?: string): string {
  const note = comment?.trim()
  if (note) {
    return (
      `ERROR: "${toolName}" was not run because the user declined the confirmation prompt for this attempt ` +
      `and left a note explaining why: "${note}". ` +
      `${STILL_CONNECTED} ` +
      'Treat the note as an instruction: address it, then propose the action again (confirming the revised plan with the user first).'
    )
  }
  return (
    `ERROR: "${toolName}" was not run because the user declined the confirmation prompt for this attempt. ` +
    `${STILL_CONNECTED} ` +
    'Ask whether they want you to proceed, and call the tool again if they say yes.'
  )
}

/** The confirmation prompt expired before the user answered. */
export function timedOutToolResult(toolName: string): string {
  return (
    `ERROR: "${toolName}" was not run because the confirmation prompt expired before the user answered. ` +
    `${STILL_CONNECTED} ` +
    'Ask whether they still want it done, and call the tool again if they say yes.'
  )
}

/**
 * A second call to a tool already declined/expired earlier in the SAME turn.
 * Re-prompting here would spam the user, so the call is refused — but the
 * model still must not conclude the capability is gone.
 */
export function alreadyDeclinedToolResult(toolName: string): string {
  return (
    `ERROR: "${toolName}" was declined or timed out earlier in this same turn, so it will not be retried right now. ` +
    `${STILL_CONNECTED} ` +
    'Stop retrying and ask the user how they want to proceed.'
  )
}
