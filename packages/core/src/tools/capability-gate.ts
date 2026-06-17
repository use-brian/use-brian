import type { Tool } from './types.js'

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
