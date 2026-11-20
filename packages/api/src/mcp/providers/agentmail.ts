/**
 * Assistant Email (agentmail) provider (M3 WP2).
 *
 * The injector body below moved verbatim from `mcp/inject.ts`. It builds the
 * family's tools into a provider-local map (never the turn's shared map):
 * credentials bound per lane, build-time action-grant gate, health probe,
 * policy (`applyPolicyOrSkip`) and instance variants. The lane function and
 * `ProviderModule` at the end are the family's activation surface.
 *
 * See docs/architecture/integrations/mcp.md → "Provider activation".
 */
import { createAgentmailTools, type AgentmailToolApi } from '@use-brian/core/tools/base/agentmail.js'
import type { McpSettingsStore } from '@use-brian/agent-runtime/mcp/types.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import type { EmailInboxProvider } from '../../agentmail/provider.js'
import { renderEmailBody } from '@use-brian/channels'
import type { ConnectorActionAudit, ConnectorActionPreflight } from '../../connector-action-port.js'
import { parseConnectorInstanceGovernanceId } from '../../db/connector-instance-store.js'
import { applyPolicyOrSkip } from '../activation.js'
import type { ProviderModule, ProviderActivationContext } from './types.js'
import { describeFactoryTools, inertPort, memoDescribe } from './describe.js'
import { runLanes } from './lanes.js'

// ── Assistant Email (agentmail) injection ─────────────────────
//
// The assistant's OWN mailbox tools (agentmail.md → "Connector tools").
// One tool set covers every inbox handled by this assistant (decision D1): the
// tools take an optional `fromInbox` and default to its first (oldest) inbox.
// Sends and drafts reuse the Gmail governance chain — `ask` classification
// (OFFICIAL_CONNECTOR_TOOLS), exact inbox grants, then advisory
// connector_actions classification + audit.

async function collectAgentmailTools(params: {
  provider: EmailInboxProvider
  /** Handled inboxes, oldest first — the first is the default sender. */
  inboxes: Array<{ address: string; governanceId: string; instanceId: string }>
  currentInboxIds: () => Promise<string[]>
  settingsStore: McpSettingsStore
  userId: string
  workspaceId?: string
  assistantId: string
  tools: Map<string, Tool>
  unavailable?: string[]
  connectorActionAudit?: ConnectorActionAudit
  /** Exact per-inbox write grants, edited from Studio → Channels. */
  assistantConnectorGrantsStore?: import('../../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore
}): Promise<void> {
  const { provider, inboxes, settingsStore, userId, assistantId, tools, unavailable, connectorActionAudit, assistantConnectorGrantsStore } = params

  const auditedEgress = async <T>(
    actionKind: 'send_email' | 'draft_email',
    auditPayload: Record<string, unknown>,
    classifierPayload: Record<string, unknown>,
    run: () => Promise<T>,
    externalIdOf: (result: T) => string | null,
  ): Promise<T> => {
    let preflight: ConnectorActionPreflight | undefined
    if (connectorActionAudit) {
      preflight = connectorActionAudit.preflight({
        audienceClearance: 'public',
        payload: classifierPayload,
        enforcement: 'advisory',
      })
    }
    try {
      const result = await run()
      if (connectorActionAudit) {
        try {
          await connectorActionAudit.emit(
            { userId, assistantId },
            { connectorId: 'agentmail', actionKind, audienceClearance: 'public', status: 'executed', externalId: externalIdOf(result), payload: auditPayload, preflight },
          )
        } catch (auditErr) {
          console.warn('[mcp-inject] agentmail connector_action audit emit failed (best-effort, suppressed):', auditErr instanceof Error ? auditErr.message : String(auditErr))
        }
      }
      return result
    } catch (err) {
      if (connectorActionAudit) {
        try {
          await connectorActionAudit.emit(
            { userId, assistantId },
            {
              connectorId: 'agentmail', actionKind, audienceClearance: 'public', status: 'failed',
              payload: { ...auditPayload, error: err instanceof Error ? err.message : String(err) },
              preflight,
            },
          )
        } catch (auditErr) {
          console.warn('[mcp-inject] agentmail connector_action audit emit failed (failure path, suppressed):', auditErr instanceof Error ? auditErr.message : String(auditErr))
        }
      }
      throw err
    }
  }

  const governanceByAddress = new Map(
    inboxes.map((inbox) => [inbox.address.toLowerCase(), inbox.governanceId]),
  )
  const assertInboxCurrent = async (address: string) => {
    const inbox = inboxes.find(candidate => candidate.address === address)
    if (!inbox || !(await params.currentInboxIds()).includes(inbox.instanceId)) {
      throw new Error('The assistant no longer handles this inbox.')
    }
  }
  const assertInboxAction = async (
    inboxAddress: string,
    action: 'agentmailSendMessage' | 'agentmailCreateDraft',
  ): Promise<void> => {
    await assertInboxCurrent(inboxAddress)
    if (!assistantConnectorGrantsStore) return
    const governanceId = governanceByAddress.get(inboxAddress.toLowerCase())
    if (!governanceId) {
      throw new Error(`This assistant does not handle ${inboxAddress}.`)
    }
    const grant = await assistantConnectorGrantsStore.getForAssistantSystem(
      assistantId,
      governanceId,
    )
    if (!grant?.allowedActions.includes(action)) {
      throw new Error(
        `This assistant is not allowed to use ${action} for ${inboxAddress}. Enable it from the inbox in Studio → Channels.`,
      )
    }
  }

  const deliveryContext = (address: string) => ({
    userId, workspaceId: params.workspaceId,
    connectorInstanceId: parseConnectorInstanceGovernanceId(governanceByAddress.get(address.toLowerCase()) ?? '')?.instanceId,
  })

  const api: AgentmailToolApi = {
    async listInboxes() {
      const current = new Set(await params.currentInboxIds())
      // The default is pinned when the family activates. A reassignment
      // cannot silently use another sender for the same invocation.
      if (!current.has(inboxes[0]!.instanceId)) throw new Error('The assistant inbox assignment changed.')
      return inboxes.flatMap((inbox, i) => current.has(inbox.instanceId)
        ? [{ address: inbox.address, isDefault: i === 0 }] : [])
    },
    async send(p) {
      await assertInboxAction(p.inboxAddress, 'agentmailSendMessage')
      const auditPayload = {
        from: p.inboxAddress,
        to: p.to,
        cc: p.cc ?? [],
        bcc: p.bcc ?? [],
        subject: p.subject,
        has_body: Boolean(p.body),
        body_length: p.body.length,
      }
      // The model composes `body` in markdown; render the
      // multipart/alternative pair at this egress boundary. Classification
      // sees the raw markdown transiently; the persisted audit omits it.
      const rendered = renderEmailBody(p.body)
      return auditedEgress(
        'send_email',
        auditPayload,
        { ...auditPayload, body: p.body },
        () =>
          provider.sendMessage(p.inboxAddress, {
            crmPurposeKey: p.crmPurposeKey,
            crmTemplateKey: p.crmTemplateKey,
            to: p.to,
            cc: p.cc,
            bcc: p.bcc,
            subject: p.subject,
            text: rendered.text,
            html: rendered.html,
          }, deliveryContext(p.inboxAddress)),
        (r) => r.messageId,
      )
    },
    async searchThreads(p) {
      await assertInboxCurrent(p.inboxAddress)
      const result = await provider.listThreads(p.inboxAddress, {
        limit: p.limit,
        senders: p.senders,
        subject: p.subjectContains,
      })
      // Projection (connector-result rule): documented fields only, never
      // raw vendor JSON.
      return result.threads.map((t) => ({
        threadId: t.threadId,
        inbox: t.inboxId,
        subject: t.subject,
        preview: t.preview,
        senders: t.senders,
        timestamp: t.timestamp,
        messageCount: t.messageCount,
      }))
    },
    async createDraft(p) {
      await assertInboxAction(p.inboxAddress, 'agentmailCreateDraft')
      const auditPayload = {
        from: p.inboxAddress,
        to: p.to,
        cc: p.cc ?? [],
        bcc: p.bcc ?? [],
        subject: p.subject,
        has_body: Boolean(p.body),
        body_length: p.body.length,
        send_at: p.sendAt ?? null,
      }
      // Same markdown → text+html rendering as send — a draft (scheduled or
      // human-sent) leaves as the exact bodies stored here.
      const rendered = renderEmailBody(p.body)
      const draft = await auditedEgress(
        'draft_email',
        auditPayload,
        { ...auditPayload, body: p.body },
        () =>
          provider.createDraft(p.inboxAddress, {
            crmPurposeKey: p.crmPurposeKey,
            crmTemplateKey: p.crmTemplateKey,
            to: p.to,
            cc: p.cc,
            bcc: p.bcc,
            subject: p.subject,
            text: rendered.text,
            html: rendered.html,
            sendAt: p.sendAt,
            inReplyTo: p.inReplyTo,
          }, deliveryContext(p.inboxAddress)),
        (r) => r.draftId,
      )
      return { draftId: draft.draftId, sendAt: draft.sendAt }
    },
  }

  try {
    const grantedActions = new Set<string>()
    if (assistantConnectorGrantsStore) {
      const grants = await Promise.all(
        inboxes.map((inbox) =>
          assistantConnectorGrantsStore.getForAssistantSystem(
            assistantId,
            inbox.governanceId,
          ),
        ),
      )
      for (const grant of grants) {
        for (const action of grant?.allowedActions ?? []) grantedActions.add(action)
      }
    }
    for (const tool of createAgentmailTools(api)) {
      if (
        assistantConnectorGrantsStore
        && (tool.name === 'agentmailSendMessage' || tool.name === 'agentmailCreateDraft')
        && !grantedActions.has(tool.name)
      ) {
        continue
      }
      if (await applyPolicyOrSkip(tool, 'agentmail', settingsStore, assistantId, userId, unavailable) === 'include') {
        tools.set(tool.name, tool)
      }
    }
    console.debug(`[mcp-inject] Assistant Email: injected tools over ${inboxes.length} inbox(es)`)
  } catch (err) {
    console.error('[mcp-inject] Assistant Email injection failed:', err)
  }
}

// ── Provider module ───────────────────────────────────────────

/** The Assistant Email lane: the handled inboxes, oldest first, under the workspace policy. */
export type AgentmailLane = {
  provider: EmailInboxProvider
  inboxes: Array<{ address: string; governanceId: string; instanceId: string }>
  currentInboxIds: () => Promise<string[]>
  settingsStore: McpSettingsStore
  userId: string
  reportUnavailable?: boolean
  supersedes?: readonly string[]
}

export async function activateAgentmailLane(ctx: ProviderActivationContext, lane: AgentmailLane): Promise<Tool[]> {
  const tools = new Map<string, Tool>()
  await collectAgentmailTools({
    workspaceId: ctx.assistantTeamId ?? undefined,
    provider: lane.provider,
    inboxes: lane.inboxes,
    currentInboxIds: lane.currentInboxIds,
    settingsStore: lane.settingsStore,
    userId: lane.userId,
    assistantId: ctx.assistantId,
    tools,
    unavailable: lane.reportUnavailable ? ctx.unavailable : undefined,
    connectorActionAudit: ctx.hosted.connectorActionAudit,
    assistantConnectorGrantsStore: ctx.stores.assistantConnectorGrantsStore,
  })
  return [...tools.values()]
}

export const agentmailProvider: ProviderModule<readonly AgentmailLane[]> = {
  family: 'agentmail',
  describe: memoDescribe(() => describeFactoryTools('agentmail', { agentmail: () => createAgentmailTools(inertPort('agentmail')) })),
  activate: (ctx, lanes) => runLanes(lanes, (lane) => activateAgentmailLane(ctx, lane)),
}
