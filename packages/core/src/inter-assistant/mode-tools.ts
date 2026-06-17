/**
 * Mode-based tool filtering for inter-assistant communication.
 *
 * Replaces the per-category filter (formerly category-tools.ts) with a
 * mode-bundle filter. When a callee assistant responds to a cross-assistant
 * query, it gets only the tools listed in the bound mode's `exposedTools`.
 * Mode = null means free mode (no filter applied — full caller-visible
 * tool surface).
 *
 * Background: the mode model replaces the per-category sharing_rules table.
 * See docs/architecture/integrations/a2a.md.
 *
 * [COMP:inter-assistant/mode-tools]
 */

import type { AssistantMode } from '../a2a/types.js'
import type { Tool } from '../tools/types.js'

/**
 * Filter a tool map to only include tools listed in the mode's exposed
 * tools. Mode = null means free — no filter.
 *
 * Tool name matching is exact: a tool is included iff its `name` is in
 * `mode.exposedTools`. (No prefix match — mode definitions name tools
 * explicitly so the owner sees exactly what's exposed.)
 */
export function filterToolsForMode(
  tools: Map<string, Tool>,
  mode: AssistantMode | null,
): Map<string, Tool> {
  if (mode === null) return new Map(tools)

  const allowed = new Set(mode.exposedTools)
  const filtered = new Map<string, Tool>()
  for (const [name, tool] of tools) {
    if (allowed.has(name)) filtered.set(name, tool)
  }
  return filtered
}

/**
 * Filter a tool map to a per-consult allow-list. `allowed = undefined` means
 * no filter (every ordinary consult). When set, only tools whose `name` is in
 * the list survive; an empty list yields an empty map.
 *
 * Applied *after* `filterToolsForMode` for workflow `assistant_call` steps
 * that pin a `tools` restriction — it is the final word on the callee's tool
 * surface, overriding both the mode filter and any free-mode default tools.
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
