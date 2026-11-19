/**
 * Lane plumbing shared by the built-in provider modules.
 *
 * A lane is one admitted source of a family's tools: the personal base load
 * (workspace-less assistants only), a member-exposure grant, or a
 * workspace-owned `connector_instance` row. Lanes of one family run in order
 * and the last writer of a tool name wins, which reproduces the historical
 * precedence (personal, then grant, then workspace-owned).
 *
 * See docs/architecture/integrations/mcp.md → "Provider activation".
 */
import type { McpSettingsStore } from '@use-brian/agent-runtime/mcp/types.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import { OFFICIAL_CONNECTOR_TOOLS } from '@use-brian/shared'
import { baseToolName } from '../tool-names.js'
import type { ProviderActivationContext } from './types.js'

export type BuiltinLane<Connector> = {
  /** Connector rows this lane injects from (personal list, grantor list, or a synthetic workspace row list). */
  connectors: Connector[]
  /** Policy authority: the acting user's L1/L2 store, or the workspace policy adapter. */
  settingsStore: McpSettingsStore
  /** Credential and policy principal (the grantor on a grant lane). */
  userId: string
  /** Whether this lane writes not-connected / blocked notices. Only the personal base lane does today. */
  reportUnavailable?: boolean
  /**
   * Official connector ids whose tools from earlier lanes this lane replaces
   * (workspace-owned precedence covers the whole provider, variants included).
   * A superseding lane may be empty: an `auth_failed` workspace row still
   * removes the lower-precedence grant tools.
   */
  supersedes?: readonly string[]
}

/** The unavailable sink for a lane: the turn sink when the lane reports, otherwise none. */
export function laneUnavailable(ctx: ProviderActivationContext, lane: { reportUnavailable?: boolean }): string[] | undefined {
  return lane.reportUnavailable ? ctx.unavailable : undefined
}

/** Run a family's lanes in order with last-writer-wins and `supersedes` semantics. */
export async function runLanes<L extends { supersedes?: readonly string[] }>(
  lanes: readonly L[],
  run: (lane: L) => Promise<Tool[]>,
): Promise<Tool[]> {
  const out = new Map<string, Tool>()
  for (const lane of lanes) {
    if (lane.supersedes?.length) {
      const names = new Set(lane.supersedes.flatMap((provider) => (OFFICIAL_CONNECTOR_TOOLS[provider] ?? []).map((tool) => tool.name)))
      for (const name of [...out.keys()]) {
        if (names.has(baseToolName(name))) out.delete(name)
      }
    }
    for (const tool of await run(lane)) out.set(tool.name, tool)
  }
  return [...out.values()]
}
