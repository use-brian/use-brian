/**
 * `assertActionAllowed` — the runtime gate for connector write actions.
 *
 * Every model-visible connector write has already passed the injection-time
 * filter below. Its execute callback still calls this *before* it touches the
 * network, closing the race where a grant is revoked after injection. On
 * rejection: the action never starts and NO audit row is written (per
 * `docs/architecture/integrations/connector-actions.md` §"Per-assistant
 * capability grants").
 *
 * The grant lookup is system-level (`getForAssistantSystem`) — the
 * acting user is whoever sent the message that triggered the tool, not
 * the assistant's owner, so the decision must apply equally across
 * callers (team members, inter-assistant consults, scheduled jobs).
 *
 * Two semantically-correct outcomes:
 *   - `{ ok: true }`                              — grant exists AND the
 *                                                   actionKind is in
 *                                                   `allowed_actions[]`.
 *   - `{ ok: false, reason: 'action_not_granted', details }` — the exact row
 *                                                   disappeared or no longer
 *                                                   names the action.
 *
 * [COMP:safety/assert-action-allowed]
 */

import { OFFICIAL_CONNECTOR_TOOLS } from '@use-brian/shared'
import type { Tool } from '@use-brian/core'
import type {
  AssistantConnectorGrant,
  AssistantConnectorGrantsStore,
} from '../db/assistant-connector-grants-store.js'

export type ActionAllowedResult =
  | { ok: true }
  | { ok: false; reason: 'action_not_granted'; details: string }

export async function assertActionAllowed(
  store: AssistantConnectorGrantsStore,
  assistantId: string,
  connectorId: string,
  actionKind: string,
  displayConnectorId: string = connectorId,
): Promise<ActionAllowedResult> {
  const grant = await store.getForAssistantSystem(assistantId, connectorId)
  if (!grant) {
    return {
      ok: false,
      reason: 'action_not_granted',
      details: `This assistant has no grant for ${displayConnectorId}. Ask the assistant's owner to enable ${actionKind} in Studio → Assistants → Tools.`,
    }
  }
  if (!grant.allowedActions.includes(actionKind)) {
    return {
      ok: false,
      reason: 'action_not_granted',
      details: `This assistant cannot perform ${actionKind} on ${displayConnectorId}. Ask the assistant's owner to enable it in Studio → Assistants → Tools.`,
    }
  }
  return { ok: true }
}

const ACTION_GRANT_METADATA = Symbol('actionGrantMetadata')

type ActionGrantMetadata = {
  actionKind: string
  loadGrantForInjection: () => Promise<AssistantConnectorGrant | null>
}

type ActionGrantTool = Tool & {
  [ACTION_GRANT_METADATA]?: ActionGrantMetadata
}

/**
 * Remove ungranted connector actions before either direct injection or the
 * local `mcp_search` index is built. The execution wrapper remains on every
 * retained write tool and performs a fresh lookup, closing the race where a
 * grant is revoked after this per-turn visibility snapshot.
 */
export async function filterToolsByActionGrants(
  tools: Map<string, Tool>,
): Promise<Map<string, Tool>> {
  const decisions = await Promise.all(
    [...tools.entries()].map(async ([name, tool]): Promise<[string, Tool] | null> => {
      const metadata = (tool as ActionGrantTool)[ACTION_GRANT_METADATA]
      if (!metadata) return [name, tool]
      const grant = await metadata.loadGrantForInjection()
      return grant?.allowedActions.includes(metadata.actionKind) ? [name, tool] : null
    }),
  )
  return new Map(decisions.filter((entry): entry is [string, Tool] => entry !== null))
}

/**
 * `gateToolsOnActionGrants` — mark + execute-gate a built-in connector's
 * write tool set.
 *
 * Wraps every tool whose name is classified `write` or `destructive` in
 * `OFFICIAL_CONNECTOR_TOOLS[connectorId]` (the registry is the single
 * source of truth — never a hardcoded tool list). The metadata drives
 * `filterToolsByActionGrants`; the wrapper runs `assertActionAllowed` again at
 * execute time. Read tools and tools unknown to the registry pass through
 * untouched. With no store wired (legacy call sites, tests) the set is
 * returned unchanged.
 *
 * Apply inside each injector's `buildTools` closure, before instance
 * renaming, so multi-account variants gate on their canonical names.
 */
export function gateToolsOnActionGrants(
  tools: Tool[],
  connectorId: string,
  store: AssistantConnectorGrantsStore | undefined,
  assistantId: string,
  grantConnectorId: string = connectorId,
): Tool[] {
  if (!store) return tools
  const gated = new Set(
    (OFFICIAL_CONNECTOR_TOOLS[connectorId] ?? [])
      .filter((t) => t.classification === 'write' || t.classification === 'destructive')
      .map((t) => t.name),
  )
  if (gated.size === 0) return tools
  let injectionGrant: Promise<AssistantConnectorGrant | null> | undefined
  const loadGrantForInjection = () => {
    injectionGrant ??= store.getForAssistantSystem(assistantId, grantConnectorId)
    return injectionGrant
  }
  return tools.map((tool): Tool => {
    if (!gated.has(tool.name)) return tool
    const gatedTool: ActionGrantTool = {
      ...tool,
      [ACTION_GRANT_METADATA]: {
        actionKind: tool.name,
        loadGrantForInjection,
      },
      execute: async (input, context) => {
        const allowed = await assertActionAllowed(
          store,
          assistantId,
          grantConnectorId,
          tool.name,
          connectorId,
        )
        if (!allowed.ok) throw new Error(allowed.details)
        return tool.execute(input, context)
      },
    }
    return gatedTool
  })
}
