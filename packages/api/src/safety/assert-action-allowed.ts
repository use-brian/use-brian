/**
 * `assertActionAllowed` — the runtime gate for connector write actions.
 *
 * Every connector write tool's execute callback calls this *before* it
 * touches the network. On rejection: the tool returns the structured
 * envelope, the action never starts, and NO audit row is written (per
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
 *   - `{ ok: false, reason: 'action_not_granted', details }` — no row,
 *                                                   or row exists but
 *                                                   the action isn't in
 *                                                   the allow list. The
 *                                                   tool surfaces this
 *                                                   to the model as a
 *                                                   tool error so the
 *                                                   model can explain
 *                                                   to the user rather
 *                                                   than silently
 *                                                   stalling.
 *
 * [COMP:safety/assert-action-allowed]
 */

import { OFFICIAL_CONNECTOR_TOOLS } from '@use-brian/shared'
import type { Tool } from '@use-brian/core'
import type { AssistantConnectorGrantsStore } from '../db/assistant-connector-grants-store.js'

export type ActionAllowedResult =
  | { ok: true }
  | { ok: false; reason: 'action_not_granted'; details: string }

export async function assertActionAllowed(
  store: AssistantConnectorGrantsStore,
  assistantId: string,
  connectorId: string,
  actionKind: string,
): Promise<ActionAllowedResult> {
  const grant = await store.getForAssistantSystem(assistantId, connectorId)
  if (!grant) {
    return {
      ok: false,
      reason: 'action_not_granted',
      details: `This assistant has no grant for ${connectorId}. Ask the assistant's owner to enable ${actionKind} in Studio → Assistants → Tools.`,
    }
  }
  if (!grant.allowedActions.includes(actionKind)) {
    return {
      ok: false,
      reason: 'action_not_granted',
      details: `This assistant cannot perform ${actionKind} on ${connectorId}. Ask the assistant's owner to enable it in Studio → Assistants → Tools.`,
    }
  }
  return { ok: true }
}

/**
 * `gateToolsOnActionGrants` — the uniform grant gate for a built-in
 * connector's tool set.
 *
 * Wraps every tool whose name is classified `write` or `destructive` in
 * `OFFICIAL_CONNECTOR_TOOLS[connectorId]` (the registry is the single
 * source of truth — never a hardcoded tool list) so its `execute` runs
 * `assertActionAllowed` first. Read tools and tools unknown to the
 * registry pass through untouched. With no store wired (legacy call
 * sites, tests) the set is returned unchanged — same fail-open contract
 * as the audit port.
 *
 * Apply inside each injector's `buildTools` closure, before instance
 * renaming, so multi-account variants gate on their canonical names.
 */
export function gateToolsOnActionGrants(
  tools: Tool[],
  connectorId: string,
  store: AssistantConnectorGrantsStore | undefined,
  assistantId: string,
): Tool[] {
  if (!store) return tools
  const gated = new Set(
    (OFFICIAL_CONNECTOR_TOOLS[connectorId] ?? [])
      .filter((t) => t.classification === 'write' || t.classification === 'destructive')
      .map((t) => t.name),
  )
  if (gated.size === 0) return tools
  return tools.map((tool): Tool => {
    if (!gated.has(tool.name)) return tool
    return {
      ...tool,
      execute: async (input, context) => {
        const allowed = await assertActionAllowed(store, assistantId, connectorId, tool.name)
        if (!allowed.ok) throw new Error(allowed.details)
        return tool.execute(input, context)
      },
    }
  })
}
