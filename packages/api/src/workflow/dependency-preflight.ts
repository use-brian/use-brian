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
import { OFFICIAL_CONNECTOR_TOOLS } from '@sidanclaw/shared'
import type { ChannelIntegrationStore } from '../db/channel-integrations.js'
import type { ConnectorStore } from '../db/connector-store.js'
import { getAuthenticatedUser } from '../github/client.js'

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
}

/** Reverse map: built-in connector tool name → owning connectorId. Derived
 *  from OFFICIAL_CONNECTOR_TOOLS so the two can never drift. */
const TOOL_TO_CONNECTOR: Record<string, string> = (() => {
  const m: Record<string, string> = {}
  for (const [connectorId, tools] of Object.entries(OFFICIAL_CONNECTOR_TOOLS)) {
    for (const t of tools) m[t.name] = connectorId
  }
  return m
})()

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
}) => Promise<{ ok: boolean; provider: string; reason?: string } | null>

export function createWorkflowDependencyPreflight(
  options: WorkflowDependencyPreflightOptions,
): { validateDeliveryTarget: ValidateDeliveryTarget; preflightConnectorTool: PreflightConnectorTool } {
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

  const preflightConnectorTool: PreflightConnectorTool = async ({ userId, toolName }) => {
    const connectorId = TOOL_TO_CONNECTOR[toolName]
    if (!connectorId || connectorId === 'files') return null // not a (probeable) connector tool
    const provider = CONNECTOR_LABEL[connectorId] ?? connectorId
    if (!options.connectorStore) return { ok: true, provider } // can't check → don't block

    const creds = await options.connectorStore.getCredentials(userId, connectorId)
    if (!creds) {
      return { ok: false, provider, reason: `${provider} is not connected in this workspace` }
    }

    // GitHub gets a real token probe (the incident). Other connectors are
    // recognized but not yet probed here — a live token-refresh probe per
    // provider is a tracked follow-up; presence of credentials is the check.
    if (connectorId === 'github') {
      const pat = (creds as { client_secret?: string }).client_secret
      if (!pat) return { ok: false, provider, reason: 'GitHub credentials are incomplete' }
      try {
        await getAuthenticatedUser(pat)
        return { ok: true, provider }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/invalid or revoked|401/.test(msg)) {
          return { ok: false, provider, reason: 'its access token is invalid or revoked' }
        }
        return { ok: true, provider } // transient → don't block
      }
    }

    return { ok: true, provider }
  }

  return { validateDeliveryTarget, preflightConnectorTool }
}
