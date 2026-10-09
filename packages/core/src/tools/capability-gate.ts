import { homeAppToolRequirements } from '@use-brian/shared'
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
    if (missingToolCapability(tool, activeCapabilities)) continue
    filtered.set(name, tool)
  }
  return filtered
}

/** Shared by discovery, the executor, and gateways calling execute directly. */
export function missingToolCapability(tool: Tool, activeCapabilities?: ReadonlySet<string>): string | undefined {
  const requirements = [tool.requiresCapability, ...homeAppToolRequirements(tool)]
  return requirements.find((cap): cap is string => !!cap && !activeCapabilities?.has(cap))
}

/**
 * Is an attended human driving this turn (unified-sessions D13)? The Tier-C
 * write-gate (Posture A, `docs/architecture/engine/tool-executor.md` section
 * 3) keys off the inverse: a destructive-but-recoverable tool
 * (`deleteEntity`, `healMemories`, ...) gates ONLY on an unattended turn, so a
 * person who sees the turn is never parked in Approvals, while a cron or
 * workflow loop deleting entities with no human present is.
 *
 * Interactivity comes from the PRINCIPAL, never from the channel. The
 * retired channel allowlists left humans in doc, Office and feed threads
 * treated as autonomous (their sessions carried an anchor channel type) and
 * disagreed with each other about Teams and Feishu. Fail-closed: a context
 * with no attended identity is unattended.
 */
export function isAttendedTurn(context: Pick<ToolContext, 'attended' | 'executionContext'>): boolean {
  if (context.attended !== undefined) return context.attended
  return context.executionContext?.identity.kind === 'attended'
}

/** The wire carrying this turn: `transport` when stamped, else `channelType`. */
export function toolTransport(context: Pick<ToolContext, 'transport' | 'channelType'>): string {
  return context.transport ?? context.channelType
}
