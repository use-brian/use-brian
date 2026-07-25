/**
 * Per-consult tool filtering for inter-assistant communication.
 *
 * Workflow `assistant_call` steps can pin a `tools` allow-list on the
 * consult; this module applies it to the callee's tool surface. (The
 * destination-side "mode" filter that used to live here was retired
 * 2026-07-24 with the assistant_modes system — same-workspace consults run
 * with the full caller-visible tool surface unless a per-consult allow-list
 * narrows it.)
 *
 * [COMP:inter-assistant/mode-tools]
 */

import type { Tool } from '../tools/types.js'

/**
 * Filter a tool map to a per-consult allow-list. `allowed = undefined` means
 * no filter (every ordinary consult). When set, only tools whose `name` is in
 * the list survive; an empty list yields an empty map.
 *
 * Applied for workflow `assistant_call` steps that pin a `tools` restriction
 * — it is the final word on the callee's tool surface, overriding the
 * free-mode default tools.
 */
export function filterToolsByAllowList(
  tools: Map<string, Tool>,
  allowed: string[] | undefined,
): Map<string, Tool> {
  if (allowed === undefined) return new Map(tools)

  const allow = new Set(allowed)
  const filtered = new Map<string, Tool>()
  for (const [name, tool] of tools) {
    if (allow.has(name)) filtered.set(name, tool)
  }
  return filtered
}
