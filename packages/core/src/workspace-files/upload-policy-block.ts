/**
 * The `# Saving uploaded files` dynamic prompt block.
 *
 * Shared by every surface that can receive an upload, because it lived in
 * `routes/chat.ts` alone for its whole life — so the guidance reached web
 * chat and NO channel. Telegram, Slack, WhatsApp, Discord, WeChat and MS
 * Teams turns ran without it, which is precisely where the failure it exists
 * to prevent actually happens: a user sends a photo to a messaging channel,
 * asks for it to be forwarded, and the model has to work out the
 * upload → save → send chain unaided.
 *
 * Two properties are load-bearing:
 *
 * 1. **Tool-agnostic.** It names no tool, per the Layer-1 tool-awareness rule
 *    (CLAUDE.md). It describes the OUTCOME required ("persist the file
 *    itself") and lets the injected tool list supply the means.
 * 2. **Capability-gated by the caller.** Only emitted when the assistant
 *    actually holds `files`, so it never advertises an affordance the turn's
 *    toolset cannot honor. Callers pass `activeCapabilities.has('files')`.
 *
 * [COMP:files/upload-policy-block]
 */

/**
 * Returns the block, or `''` when the assistant has no `files` capability
 * (so callers can append unconditionally).
 */
export function buildUploadPolicyBlock(hasFilesCapability: boolean): string {
  if (!hasFilesCapability) return ''
  return (
    '\n\n# Saving uploaded files\n' +
    'When the user asks to save, keep, or store an UPLOADED file (a chat, comment, or channel attachment, shown by an `<attached_file id="…">` tag in the conversation), persist the FILE ITSELF to the workspace files so the original image / PDF / document is kept — use the id from that tag. ' +
    'Do NOT record a memory as a substitute for the file, and never claim a file was saved when only a note was. ' +
    'If you cannot save the file, say plainly that it could not be saved.\n' +
    'An upload id is NOT a stored-file reference. Anything that acts on a file in the workspace — reading it back later, sending it to the user, attaching it to an email — takes the durable path or id that SAVING returns, never the `<attached_file>` id. ' +
    'So when the user asks you to forward, share, or attach a file they just sent, save it first and use what the save returns. ' +
    'If a send or attach step then reports that it could not resolve the file, relay that honestly and do not describe the file as attached.'
  )
}
