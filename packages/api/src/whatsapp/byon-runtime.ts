import { createWhatsAppAdapter } from '@use-brian/channels'
import type {
  AnalyticsLogger,
  ConfirmationDecision,
  ConfirmationResolver,
  CrmStore,
  EntityLinksStore,
  EntityStore,
  LLMProvider,
  MemoryStore,
  TaskStore,
  UsageStore,
} from '@use-brian/core'
import { getToolDisplayName } from '@use-brian/shared'
import { query } from '../db/client.js'
import type { DbEpisodesStore } from '../db/episodes-store.js'
import type { IngestRulesStore } from '../db/ingest-rules-store.js'
import type { ChannelIntegrationStore } from '../db/channel-integrations.js'
import { createWhatsappIngestor } from '../ingest/whatsapp-ingest.js'
import { recordSeenWhatsappGroup } from '../ingest/whatsapp-seen-groups.js'
import { createWhatsappBot, type BotChannelContext } from '../routes/whatsapp-bot-wiring.js'
import { normalizeWhatsappNumber, type WhatsappBotInput } from '../routes/whatsapp-bot-handler.js'
import type { ChannelHooks } from '../routes/channel-pipeline.js'

export type WhatsappByonRuntimeDeps = {
  connectorUrl: string
  connectorSecret: string
  integrationStore: ChannelIntegrationStore
  provider: LLMProvider
  crm: CrmStore
  entities: EntityStore
  entityLinks: EntityLinksStore
  memories: MemoryStore
  tasks: TaskStore
  episodes: DbEpisodesStore
  ingestRulesStore: IngestRulesStore
  analytics?: AnalyticsLogger
  usageStore?: UsageStore
  ingestCharge?: (episode: { id: string; workspaceId: string; sourceKind: string; createdByUserId: string }) => Promise<void>
  scheduledBatching?: boolean
  runPipeline: (args: {
    ctx: BotChannelContext
    input: WhatsappBotInput
    hooks: ChannelHooks
    abortController: AbortController
  }) => Promise<void>
}

export function createWhatsappByonRuntime(deps: WhatsappByonRuntimeDeps) {
  const resolveListenerChannel = async (channelId: string) => {
    const result = await query<{
      channelIntegrationId: string
      connectorInstanceId: string | null
      workspaceId: string
      assistantId: string | null
    }>(
      `SELECT ci.id AS "channelIntegrationId", ci.connector_instance_id AS "connectorInstanceId",
              c.workspace_id AS "workspaceId", ca.assistant_id AS "assistantId"
         FROM channel_integrations ci
         JOIN channels c ON c.id = ci.channel_id
         LEFT JOIN channel_assistants ca ON ca.channel_id = c.id AND ca.external_surface_id IS NULL
        WHERE ci.channel_id = $1 AND ci.channel_type = 'whatsapp'
          AND 'ingest' = ANY (c.enabled_capabilities)
        LIMIT 1`,
      [channelId],
    )
    const row = result.rows[0]
    if (!row?.connectorInstanceId) return null
    const owner = await query<{ userId: string }>(
      `SELECT user_id AS "userId" FROM workspace_members
        WHERE workspace_id = $1 AND role = 'owner' LIMIT 1`,
      [row.workspaceId],
    )
    if (!owner.rows[0]) return null
    return { ...row, connectorInstanceId: row.connectorInstanceId, userId: owner.rows[0].userId }
  }

  const ingestor = createWhatsappIngestor({
    provider: deps.provider,
    model: 'gemini-flash',
    crm: deps.crm,
    entities: deps.entities,
    entityLinks: deps.entityLinks,
    memories: deps.memories,
    tasks: deps.tasks,
    episodes: deps.episodes,
    ingestRulesStore: deps.ingestRulesStore,
    resolveChannel: resolveListenerChannel,
    recordSeenGroup: (input) => recordSeenWhatsappGroup(deps.integrationStore, input),
    analytics: deps.analytics,
    usageStore: deps.usageStore,
    ingestCharge: deps.ingestCharge,
    // OSS has no generic scheduled ingest worker. Execute enabled listener
    // messages in realtime instead of creating rows nobody will drain.
    scheduledBatching: deps.scheduledBatching,
  })

  const groupMembers = new Map<string, { at: number; values: string[] }>()
  async function loadGroupMembers(channelId: string): Promise<string[]> {
    const cached = groupMembers.get(channelId)
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.values
    try {
      const response = await fetch(`${deps.connectorUrl}/groups/${channelId}`, {
        headers: { 'X-Connector-Secret': deps.connectorSecret },
      })
      if (!response.ok) return cached?.values ?? []
      const body = await response.json() as { groups?: Array<{ participants?: string[] }> }
      const values = [...new Set((body.groups ?? []).flatMap((g) => g.participants ?? [])
        .map(normalizeWhatsappNumber).filter((v): v is string => v !== null))]
      groupMembers.set(channelId, { at: Date.now(), values })
      return values
    } catch {
      return cached?.values ?? []
    }
  }

  const pending = new Map<string, { resolver: ConfirmationResolver; toolCallId: string }>()
  const decisions: Record<string, ConfirmationDecision> = {
    allow: 'allow', yes: 'allow', y: 'allow', ok: 'allow',
    deny: 'deny', no: 'deny', n: 'deny',
    always: 'always_allow', never: 'always_deny',
  }

  const bot = createWhatsappBot({
    resolveBotChannel: async (channelId) => {
      const result = await query<{
        workspaceId: string
        connectorInstanceId: string | null
        assistantId: string | null
        assistantName: string | null
        persona: string | null
        sendScope: 'dm' | 'dm_and_groups' | null
        dual: boolean
        assistantKind: 'primary' | 'standard' | 'app' | null
        assistantClearance: 'public' | 'internal' | 'confidential' | null
        config: { userAccessMode?: string; allowedUserIds?: string[]; blockedUserIds?: string[]; ackReaction?: string; whatsappGroupOptIn?: string[] } | null
      }>(
        `SELECT c.workspace_id AS "workspaceId", ci.connector_instance_id AS "connectorInstanceId",
                ca.assistant_id AS "assistantId", a.name AS "assistantName", a.system_prompt AS persona,
                a.kind AS "assistantKind", a.clearance AS "assistantClearance",
                c.whatsapp_bot_send_scope AS "sendScope", ci.config,
                ('ingest' = ANY (c.enabled_capabilities)) AS dual
           FROM channels c
           JOIN channel_integrations ci ON ci.channel_id = c.id AND ci.channel_type = 'whatsapp'
           LEFT JOIN channel_assistants ca ON ca.channel_id = c.id AND ca.external_surface_id IS NULL
           LEFT JOIN assistants a ON a.id = ca.assistant_id
          WHERE c.id = $1 AND c.channel_type = 'whatsapp'
            AND 'chat' = ANY (c.enabled_capabilities)
          LIMIT 1`,
        [channelId],
      )
      const row = result.rows[0]
      if (!row?.connectorInstanceId) return null
      const owner = await query<{ userId: string }>(
        `SELECT user_id AS "userId" FROM workspace_members WHERE workspace_id = $1 AND role = 'owner' LIMIT 1`,
        [row.workspaceId],
      )
      if (!owner.rows[0]) return null
      const mode = row.config?.userAccessMode
      const accessMode = mode === 'allowlist' || mode === 'blocklist' || mode === 'group_members' ? mode : 'allow_all'
      const normalize = (values?: string[]) => (values ?? []).map(normalizeWhatsappNumber).filter((v): v is string => v !== null)
      return {
        workspaceId: row.workspaceId,
        connectorInstanceId: row.connectorInstanceId,
        assistantId: row.assistantId,
        assistantName: row.assistantName ?? 'Assistant',
        ownerUserId: owner.rows[0].userId,
        persona: row.persona,
        sendScope: row.sendScope ?? 'dm',
        groupOptIn: row.config?.whatsappGroupOptIn ?? [],
        ackReaction: row.config?.ackReaction ?? '',
        dual: row.dual,
        assistantKind: row.assistantKind ?? 'standard',
        assistantClearance: row.assistantClearance ?? 'internal',
        accessMode,
        allowedNumbers: normalize(row.config?.allowedUserIds),
        blockedNumbers: normalize(row.config?.blockedUserIds),
        groupMemberNumbers: accessMode === 'group_members' ? await loadGroupMembers(channelId) : [],
      }
    },
    loadRules: (id) => deps.ingestRulesStore.listByConnectorInstanceSystem(id),
    getRecentHistory: async () => '',
    generateReply: async () => '',
    send: async () => ({ messageId: '' }),
    runAssistant: async (ctx, input) => {
      if (!ctx.assistantId) return
      const adapter = createWhatsAppAdapter({
        connectorUrl: deps.connectorUrl,
        connectorSecret: deps.connectorSecret,
        connectionId: input.channelId,
      })
      const parked = pending.get(input.chatJid)
      const decision = parked && decisions[input.text.trim().toLowerCase()]
      if (parked && decision) {
        parked.resolver.resolve(parked.toolCallId, decision)
        pending.delete(input.chatJid)
        return
      }
      const hooks: ChannelHooks = {
        onProcessingStart: async () => {
          await adapter.sendTypingIndicator(input.chatJid).catch(() => {})
          if (ctx.ackReaction) await adapter.sendReaction(input.chatJid, input.messageId, ctx.ackReaction).catch(() => {})
        },
        onConfirmationRequired: async (request, resolver) => {
          pending.set(input.chatJid, { resolver, toolCallId: request.toolCallId })
          await adapter.sendMessage(input.chatJid, {
            text: `*${getToolDisplayName(request.toolName)}*\n\nAllow this action?\nReply: *allow* / *deny*`,
          })
        },
        sendResponse: async (text) => ({
          channelMessageId: await adapter.sendMessage(input.chatJid, { text: text.trim() || 'Please try again.' }),
        }),
        sendError: async () => { await adapter.sendMessage(input.chatJid, { text: 'Something went wrong. Please try again.' }) },
      }
      await deps.runPipeline({ ctx, input, hooks, abortController: new AbortController() })
    },
  })

  return { ingestor, bot }
}
