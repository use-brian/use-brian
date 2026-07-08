import type { Tool, ToolContext } from './types.js'

/**
 * The single **model-visibility gate**: filter a tool map down to what the
 * model is allowed to see this turn. Drops a tool when either holds:
 *   1. `hiddenFromModel` is set — a deprecated/internal tool kept callable for
 *      back-compat but never offered to the model (e.g. the scheduled-job
 *      verbs folded into the workflow surface). The model can't choose what it
 *      can't see, so this is what makes "callable but hidden" possible.
 *   2. `requiresCapability` is set and the caller lacks an active grant for it.
 *
 * This is the first of two enforcement points (the second is inside the tool
 * executor at invocation time — see `engine/tool-executor.ts`). Both exist on
 * purpose: removing the tool from the toolset means the model never sees it
 * and can't hallucinate a call; the executor check catches anything that
 * slipped through (e.g. a stale toolset reference).
 *
 * Tools without either flag pass through unchanged.
 */
export function filterToolsByCapabilities(
  tools: Map<string, Tool>,
  activeCapabilities: ReadonlySet<string>,
): Map<string, Tool> {
  const filtered = new Map<string, Tool>()
  for (const [name, tool] of tools) {
    if (tool.hiddenFromModel) continue
    const need = tool.requiresCapability
    if (need && !activeCapabilities.has(need)) continue
    filtered.set(name, tool)
  }
  return filtered
}

/**
 * The channels where a live human is on the other end and can answer a
 * confirmation prompt in-band (the tool executor wires a
 * `confirmationResolver` on exactly these turns). Everything NOT in this
 * set is an autonomous / headless path — a scheduled job (which runs
 * through the workflow executor with `channelType: 'workflow'`), a
 * workflow step, an A2A callee (`'assistant-call'`), a background worker
 * (`'system'` / `'synthesis'` / …), or a programmatic API caller
 * (`'api'` / `'programmatic'`), where no one can tap Allow.
 *
 * The allowlist is deliberately the SMALL, interactive side so the check
 * is fail-closed: a new headless channel added later defaults to
 * autonomous (gated) rather than silently slipping through as trusted.
 * The canonical channel union is `a2a/types.ts` → `ChannelType`.
 */
export const INTERACTIVE_CHANNEL_TYPES: ReadonlySet<string> = new Set([
  'web',
  'telegram',
  'slack',
  'whatsapp',
  'discord',
])

/**
 * True when this turn is running on an autonomous / headless path — no
 * live human to confirm a write. This is the honest discriminator the
 * Tier-C write-gate (Posture A, `docs/architecture/engine/tool-executor.md`
 * §3) keys off: a destructive-but-recoverable tool (`deleteEntity`,
 * `healMemories`, …) gates ONLY here — interactive chat stays silent
 * because the user sees the turn and the write is soft/reversible, but a
 * cron/workflow loop deleting entities with no human present is the
 * medication-storm shape and must park in Approvals.
 *
 * Derived from `context.channelType` alone — no new ToolContext field —
 * because the autonomous dispatchers already stamp a distinctive
 * channelType (`'workflow'`, `'assistant-call'`, `'system'`, …) and
 * scheduled jobs execute THROUGH the workflow executor, so they inherit
 * `'workflow'` too (they do NOT keep the originating messaging channel on
 * the ToolContext — that value only rides analytics events).
 */
export function isAutonomousToolContext(context: Pick<ToolContext, 'channelType'>): boolean {
  return !INTERACTIVE_CHANNEL_TYPES.has(context.channelType)
}
