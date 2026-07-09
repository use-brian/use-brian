/**
 * Workflow authoring-time external-dependency preflight — the implementations
 * behind the core authoring tools' `validateDeliveryTarget` (fix A) and
 * `preflightConnectorTool` (fix B) ports.
 *
 * Both are best-effort *authoring-time* checks: they run a single cheap call
 * against the real provider so a workflow can't be persisted against a delivery
 * channel the bot can't post to, or a connector whose token is missing/revoked.
 * They never throw — a probe failure that isn't a clear "not reachable" answer
 * degrades to "ok" so a flaky network never blocks authoring; the executor's
 * runtime guards (best-effort delivery soft-fail; `tool_call` halt-on-error)
 * stay authoritative for live runs.
 *
 * Why this exists: a "deliver to Slack" workflow authored from a non-Slack
 * session stamped a web/Telegram session id as the Slack channel and failed
 * `channel_not_found` on every fire; a GitHub-summary workflow ran against a
 * revoked PAT, got `Bad credentials` (401), and the model fabricated a summary
 * from memory. Catching both at create time is the fix.
 *
 * Spec: docs/architecture/features/workflow.md → "Authoring validation"
 *        docs/architecture/engine/scheduled-jobs.md → "Channel delivery".
 *
 * [COMP:workflow/dependency-preflight]
 */

import { createSlackApi } from '@sidanclaw/channels'
import { APP_LEVEL_ASSISTANT_ID, OFFICIAL_CONNECTOR_TOOLS } from '@sidanclaw/shared'
import type { ChannelIntegrationStore } from '../db/channel-integrations.js'
import type { ConnectorStore } from '../db/connector-store.js'
import { getAuthenticatedUser } from '../github/client.js'

/**
 * Minimal structural slice of the MCP settings store — only the policy
 * lookup the preflight needs. Kept structural (not the concrete store type)
 * so tests can hand in a two-line stub.
 */
export type PreflightPolicyStore = {
  getPolicy(params: {
    assistantId: string
    userId: string
    serverName: string
    toolName: string
  }): Promise<{ policy: string } | null>
}

export type WorkflowDependencyPreflightOptions = {
  /** BYO Telegram + Slack credentials — same store channel-delivery uses. */
  integrationStore?: ChannelIntegrationStore
  /** Shared official Telegram bot — a Telegram target is reachable if either a BYO row or this exists. */
  defaultTelegramBotToken?: string
  /** WhatsApp delivery via the wa-connector — presence makes a WhatsApp target reachable. */
  waConnectorUrl?: string
  waConnectorSecret?: string
  /** Built-in connector credentials, for the connector preflight. */
  connectorStore?: ConnectorStore
  /**
   * L1/L2 tool-policy rows (`mcp_tool_settings`) — powers the preflight's
   * `policy` answer so authoring can reject an `ask`-policy tool pinned on an
   * `assistant_call` step (it can never execute there — the callee surface
   * drops ask-policy tools; a `tool_call` step is the approved path, pausing
   * in the unified Approvals queue). Absent → `defaultPolicy` from
   * `OFFICIAL_CONNECTOR_TOOLS` still applies; user overrides are just unseen.
   */
  mcpSettingsStore?: PreflightPolicyStore
}

/** Reverse map: built-in connector tool name → owning connectorId + registry
 *  entry. Derived from OFFICIAL_CONNECTOR_TOOLS so the two can never drift. */
const TOOL_TO_CONNECTOR: Record<string, string> = {}
const TOOL_DEFAULT_POLICY: Record<string, 'allow' | 'ask' | 'block'> = {}
for (const [connectorId, tools] of Object.entries(OFFICIAL_CONNECTOR_TOOLS)) {
  for (const t of tools) {
    TOOL_TO_CONNECTOR[t.name] = connectorId
    TOOL_DEFAULT_POLICY[t.name] = t.defaultPolicy
  }
}

const POLICY_STRICTNESS: Record<string, number> = { allow: 0, ask: 1, block: 2 }
type ToolPolicy = 'allow' | 'ask' | 'block'
function asPolicy(v: string | undefined, fallback: ToolPolicy): ToolPolicy {
  return v === 'allow' || v === 'ask' || v === 'block' ? v : fallback
}
function strictest(a: ToolPolicy, b: ToolPolicy): ToolPolicy {
  return (POLICY_STRICTNESS[a] ?? 0) >= (POLICY_STRICTNESS[b] ?? 0) ? a : b
}

/** Display name per connectorId for user-facing messages. */
const CONNECTOR_LABEL: Record<string, string> = {
  github: 'GitHub',
  gmail: 'Gmail',
  gcal: 'Google Calendar',
  gdrive: 'Google Drive',
  notion: 'Notion',
  fathom: 'Fathom',
  files: 'Workspace Files',
}

export type ValidateDeliveryTarget = (args: {
  assistantId: string
  channelType: 'telegram' | 'slack' | 'whatsapp'
  channelId: string
}) => Promise<{ ok: boolean; reason?: string }>

export type PreflightConnectorTool = (args: {
  userId: string
  toolName: string
  /**
   * The assistant the step executes as (`step.target.assistantId`) — resolves
   * the L2 per-assistant policy row. Absent → L1 (app-level) + registry
   * default only.
   */
  assistantId?: string
}) => Promise<{
  ok: boolean
  provider: string
  reason?: string
  /**
   * Effective tool policy: strictest of the registry `defaultPolicy` and the
   * user's L1/L2 `mcp_tool_settings` rows. The authoring layer errors when an
   * `ask`/`block` tool is pinned on an `assistant_call` step (see
   * `dependencyIssues` — such a tool is dropped from the callee surface at
   * run time, so the step as authored can never execute it).
   */
  policy?: 'allow' | 'ask' | 'block'
} | null>

/**
 * Enumerate the Slack channels the BYO bot can see, so the authoring model can
 * target a real channel id (`C…`/`G…`) instead of guessing — the discovery
 * half of the `channel_not_found` cross-wiring fix. Member channels first (the
 * ones the bot can post to without a join). `ok:false` when Slack is not
 * connected or the enumeration fails (e.g. `missing_scope`).
 */
export type ListSlackChannels = (args: {
  assistantId: string
}) => Promise<
  | { ok: true; channels: Array<{ id: string; name: string; isMember: boolean }> }
  | { ok: false; reason: string }
>

/**
 * Enumerate the Slack workspace's human members (id + handle + names) so the
 * authoring model can embed real `<@U…>` mention ids in step prompts — Slack
 * only notifies on real member ids, and without a directory the model
 * improvises broken forms (`<@handle>`, plain `@name`). The membership half
 * of the mention-configuration fix; `ok:false` when Slack is not connected
 * or the enumeration fails (e.g. `missing_scope`).
 */
export type ListSlackMembers = (args: {
  assistantId: string
}) => Promise<
  | { ok: true; members: Array<{ id: string; handle: string; displayName: string; realName: string }> }
  | { ok: false; reason: string }
>

export function createWorkflowDependencyPreflight(options: WorkflowDependencyPreflightOptions): {
  validateDeliveryTarget: ValidateDeliveryTarget
  preflightConnectorTool: PreflightConnectorTool
  listSlackChannels: ListSlackChannels
  listSlackMembers: ListSlackMembers
} {
  const validateDeliveryTarget: ValidateDeliveryTarget = async ({ assistantId, channelType, channelId }) => {
    if (channelType === 'slack') {
      if (!options.integrationStore) return { ok: true } // can't check → don't block
      const integ = await options.integrationStore.getCredentialsForAssistantSystem(assistantId, 'slack')
      if (!integ) return { ok: false, reason: 'Slack is not connected for this assistant' }
      const botToken = (integ.credentials as { bot_token?: string }).bot_token
      if (!botToken) return { ok: false, reason: 'Slack is not connected for this assistant' }
      try {
        const res = await createSlackApi({ botToken }).conversationsInfo(channelId)
        if (res.channel?.is_archived) return { ok: false, reason: `channel "${channelId}" is archived` }
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // `Slack API conversations.info: channel_not_found` (or invalid_auth) →
        // the exact misconfiguration we are guarding against. Surface it.
        if (/channel_not_found|invalid_auth|not_in_channel|account_inactive|missing_scope/.test(msg)) {
          return { ok: false, reason: msg.replace(/^Slack API conversations\.info:\s*/, 'Slack: ') }
        }
        // Anything else (network blip, rate limit) → don't block authoring.
        return { ok: true }
      }
    }

    if (channelType === 'telegram') {
      let hasToken = !!options.defaultTelegramBotToken
      if (!hasToken && options.integrationStore) {
        const integ = await options.integrationStore.getCredentialsForAssistantSystem(assistantId, 'telegram')
        hasToken = !!integ
      }
      return hasToken ? { ok: true } : { ok: false, reason: 'Telegram is not connected for this assistant' }
    }

    if (channelType === 'whatsapp') {
      return options.waConnectorUrl && options.waConnectorSecret
        ? { ok: true }
        : { ok: false, reason: 'WhatsApp is not connected' }
    }

    return { ok: true }
  }

  const preflightConnectorTool: PreflightConnectorTool = async ({ userId, toolName, assistantId }) => {
    const connectorId = TOOL_TO_CONNECTOR[toolName]
    if (!connectorId || connectorId === 'files') return null // not a (probeable) connector tool
    const provider = CONNECTOR_LABEL[connectorId] ?? connectorId

    // Effective policy — EXACTLY the runtime rule (`applyPolicyOrSkip` /
    // `resolveEffectivePolicy` in mcp/inject.ts): strictest of the L1
    // (app-level) and L2 (per-assistant) rows, each falling back to the
    // registry `defaultPolicy` when absent. An explicit allow on BOTH levels
    // loosens an ask-default, matching what dispatch would do — authoring
    // must never reject a workflow the runtime would run. Without an
    // `assistantId` the L2 arm stays at the default (conservative: can only
    // be stricter than runtime, never looser). Fail-open on lookup errors.
    const defaultPolicy: ToolPolicy = TOOL_DEFAULT_POLICY[toolName] ?? 'allow'
    let policy: ToolPolicy = defaultPolicy
    if (options.mcpSettingsStore) {
      try {
        const l1 = await options.mcpSettingsStore.getPolicy({
          assistantId: APP_LEVEL_ASSISTANT_ID, userId, serverName: connectorId, toolName,
        })
        let l2Policy: ToolPolicy = defaultPolicy
        if (assistantId) {
          const l2 = await options.mcpSettingsStore.getPolicy({
            assistantId, userId, serverName: connectorId, toolName,
          })
          l2Policy = asPolicy(l2?.policy, defaultPolicy)
        }
        policy = strictest(asPolicy(l1?.policy, defaultPolicy), l2Policy)
      } catch (err) {
        console.warn('[workflow/dependencyIssues] policy lookup threw (using registry default):', err)
      }
    }

    if (!options.connectorStore) return { ok: true, provider, policy } // can't check → don't block

    const creds = await options.connectorStore.getCredentials(userId, connectorId)
    if (!creds) {
      return { ok: false, provider, reason: `${provider} is not connected in this workspace`, policy }
    }

    // GitHub gets a real token probe (the incident). Other connectors are
    // recognized but not yet probed here — a live token-refresh probe per
    // provider is a tracked follow-up; presence of credentials is the check.
    if (connectorId === 'github') {
      const pat = (creds as { client_secret?: string }).client_secret
      if (!pat) return { ok: false, provider, reason: 'GitHub credentials are incomplete', policy }
      try {
        await getAuthenticatedUser(pat)
        return { ok: true, provider, policy }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/invalid or revoked|401/.test(msg)) {
          return { ok: false, provider, reason: 'its access token is invalid or revoked', policy }
        }
        return { ok: true, provider, policy } // transient → don't block
      }
    }

    return { ok: true, provider, policy }
  }

  const listSlackChannels: ListSlackChannels = async ({ assistantId }) => {
    if (!options.integrationStore) {
      return { ok: false, reason: 'Slack channel listing is unavailable in this context' }
    }
    const integ = await options.integrationStore.getCredentialsForAssistantSystem(assistantId, 'slack')
    const botToken = integ && (integ.credentials as { bot_token?: string }).bot_token
    if (!botToken) return { ok: false, reason: 'Slack is not connected for this assistant' }
    try {
      const { channels } = await createSlackApi({ botToken }).conversationsList()
      const usable = channels
        .filter((c) => !c.isArchived)
        // Member channels first (postable without a join), then by name.
        .sort((a, b) => (a.isMember === b.isMember ? a.name.localeCompare(b.name) : a.isMember ? -1 : 1))
        .map((c) => ({ id: c.id, name: c.name, isMember: c.isMember }))
      return { ok: true, channels: usable }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, reason: msg.replace(/^Slack API conversations\.list:\s*/, 'Slack: ') }
    }
  }

  const listSlackMembers: ListSlackMembers = async ({ assistantId }) => {
    if (!options.integrationStore) {
      return { ok: false, reason: 'Slack member listing is unavailable in this context' }
    }
    const integ = await options.integrationStore.getCredentialsForAssistantSystem(assistantId, 'slack')
    const botToken = integ && (integ.credentials as { bot_token?: string }).bot_token
    if (!botToken) return { ok: false, reason: 'Slack is not connected for this assistant' }
    try {
      const { members } = await createSlackApi({ botToken }).usersList()
      return {
        ok: true,
        members: members
          .slice()
          .sort((a, b) => (a.handle || a.realName).localeCompare(b.handle || b.realName)),
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, reason: msg.replace(/^Slack API users\.list:\s*/, 'Slack: ') }
    }
  }

  return { validateDeliveryTarget, preflightConnectorTool, listSlackChannels, listSlackMembers }
}
