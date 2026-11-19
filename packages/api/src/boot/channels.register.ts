/**
 * BYO channel runtime routes (after BootContext, before mountExtraRoutes).
 *
 * Boot register module registerChannels: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`ChannelsScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { LAYER_1_SYSTEM_PROMPT } from '@use-brian/core/system-prompt.js'
import { postPassiveChannelMessage } from '../channel-room/room.js'
import { findUserById } from '../db/users.js'
import { isOssEdition } from '../routes/local-session.js'
import { EXTRACTION_MODEL } from '../build-episode-ingestors.js'
import { publishSessionEvent } from '../session-event-bus.js'
import { appendInboundChatArchive } from '../chat-archive/live-writer.js'
import { resolveChannelUser } from '../db/channel-user-store.js'
import { createDiscordConnectorClient } from '../discord/connector-client.js'
import { createWhatsappConnectorClient } from '../whatsapp/connector-client.js'
import { createWechatConnectorClient } from '../wechat/connector-client.js'
import { createFeishuConnectorClient } from '../feishu/connector-client.js'
import { createWhatsappByonRuntime } from '../whatsapp/byon-runtime.js'
import { resolveWhatsappByonTurnIdentity } from '../whatsapp/byon-identity.js'
import { processChannelMessage } from '../routes/channel-pipeline.js'
import { requireAuth } from '../auth/middleware.js'
import { createTaskAdmissionPort } from '../db/task-admission-store.js'
import { getPool } from '../db/client.js'
import type { ChannelHostHooks } from '../boot.js'
import { lazyRoutes } from './lazy.js'
import type { ChannelsScope } from './scope.js'

// Router modules that load on their mount's first request (deployment.md ->
// "Boot composition" -> "Lazy routers and workers"); the mounts below are unchanged.
const feishuNotificationRoutes = lazyRoutes(() => import('../routes/feishu-notifications.js'), 'feishuNotificationRoutes')
const channelsRoutes = lazyRoutes(() => import('../routes/channels.js'), 'channelsRoutes')
const whatsappByonRoutes = lazyRoutes(() => import('../routes/whatsapp-byon.js'), 'whatsappByonRoutes')
const whatsappCloudRoutes = lazyRoutes(() => import('../routes/whatsapp-cloud.js'), 'whatsappCloudRoutes')
const whatsappIngestAdminRoutes = lazyRoutes(() => import('../routes/whatsapp-byon-admin.js'), 'whatsappIngestAdminRoutes')
const telegramByoRoutes = lazyRoutes(() => import('../routes/telegram-byo.js'), 'telegramByoRoutes')
const slackRoutes = lazyRoutes(() => import('../routes/slack.js'), 'slackRoutes')
const discordRoutes = lazyRoutes(() => import('../routes/discord.js'), 'discordRoutes')
const feishuRoutes = lazyRoutes(() => import('../routes/feishu.js'), 'feishuRoutes')
const msteamsRoutes = lazyRoutes(() => import('../routes/msteams.js'), 'msteamsRoutes')
const telegramLinkingRoutes = lazyRoutes(() => import('../routes/telegram-linking.js'), 'telegramLinkingRoutes')
const slackLinkingRoutes = lazyRoutes(() => import('../routes/slack-linking.js'), 'slackLinkingRoutes')
const wechatRoutes = lazyRoutes(() => import('../routes/wechat.js'), 'wechatRoutes')
const customChannelBridgeRoutes = lazyRoutes(() => import('../routes/custom-channel-bridge.js'), 'customChannelBridgeRoutes')

export async function registerChannels(scope: ChannelsScope) {
  const {
    ports, env, messageStoreClient, app, configuredProviders, provider, analytics, integrationStore,
    crmStore, entityLinksStore, entitiesStore, usageStore, decisionRuntime, connectorInstanceStore,
    workspaceSkillStore, workspaceSkillFilesStore, skillStore, workflowStore, resolveWorkspaceCustomLlm,
    linkedAccountStore, connectorGrantStore, episodesStore, workspaceStore, knowledgeStore,
    ingestApplicationService, workerManager, backgroundModel, channelQuestionStore, customChannelStore,
    fileStore, workspaceFilesStore, allTools, filesResolver, mcpSettingsStore, memoryStore, taskStore,
    resolveWorkspaceExtractionLlm, sessionStateStore, filesApi, connectorStore, assistantConnectorStore,
    workspaceToolPolicyStore, gdriveFilesStore, capabilityStore, episodicStore, deferredConfirmationStore,
    workspaceSkillEnablementStore, realtimeThreadTargetStore, crmEmailDraftStore, artifactPromoter,
    knowledgeCaptureRuleStore, voiceTranscription, connectorActionStore, linkCodeStore, channelIdentityStore,
    workflowEventDispatcher, ingestRulesStore, channelUserStore, ctx, ingestRuleEditorStore,
    chatArchiveLiveMedia,
  } = scope
  // ════════════════════════════════════════════════════════════════
  // BYO channel runtime (open for both editions since the channels
  // open-core move; docs/architecture/channels/adapter-pattern.md).
  // Mounted here — after BootContext assembly, before mountExtraRoutes —
  // which is the same effective position the closed app mounted them from
  // before the move, so the Express `/api` guard ordering is unchanged.
  // Hosted-only enrichments (Pipeline-C Slack ingest, GCS media intake,
  // recording surcharge) arrive via `ports.buildChannelHosts`.
  // ════════════════════════════════════════════════════════════════
  {
    const channelHosts: ChannelHostHooks = ports.buildChannelHosts
      ? await ports.buildChannelHosts(ctx)
      : {}
    const discordConnector =
      env.DISCORD_CONNECTOR_URL && env.DISCORD_CONNECTOR_SECRET
        ? createDiscordConnectorClient({
            connectorUrl: env.DISCORD_CONNECTOR_URL,
            connectorSecret: env.DISCORD_CONNECTOR_SECRET,
          })
        : undefined
    const whatsappConnector =
      env.WA_CONNECTOR_URL && env.WA_CONNECTOR_SECRET
        ? createWhatsappConnectorClient({
            connectorUrl: env.WA_CONNECTOR_URL,
            connectorSecret: env.WA_CONNECTOR_SECRET,
          })
        : undefined
    const wechatConnector =
      env.WECHAT_CONNECTOR_URL && env.WECHAT_CONNECTOR_SECRET
        ? createWechatConnectorClient({
            connectorUrl: env.WECHAT_CONNECTOR_URL,
            connectorSecret: env.WECHAT_CONNECTOR_SECRET,
          })
        : undefined
    const feishuConnector =
      env.FEISHU_CONNECTOR_URL && env.FEISHU_CONNECTOR_SECRET
        ? createFeishuConnectorClient({
            connectorUrl: env.FEISHU_CONNECTOR_URL,
            connectorSecret: env.FEISHU_CONNECTOR_SECRET,
          })
        : undefined

    // Workspace channels operator surface (Studio → Channels).
    app.use('/api', requireAuth(env.JWT_SECRET), channelsRoutes({
      workspaceStore,
      skillStore,
      workflowStore,
      integrationStore: integrationStore ?? undefined,
      apiUrl: env.API_URL,
      discordConnector,
      whatsappConnector,
      wechatConnector,
      identityStore: channelIdentityStore ?? undefined,
      analytics,
      feishuConnector,
      customChannelStore,
      // Fallback bot for naming sessions-derived telegram delivery destinations.
      telegramBotToken: env.TELEGRAM_BOT_TOKEN,
      ownerPairing: {
        enabled: true,
        requiredOnConnect: isOssEdition(),
        linkCodeStore,
      },
    }))

    if (integrationStore && env.WA_CONNECTOR_URL && env.WA_CONNECTOR_SECRET) {
      const whatsapp = createWhatsappByonRuntime({
        connectorUrl: env.WA_CONNECTOR_URL,
        connectorSecret: env.WA_CONNECTOR_SECRET,
        integrationStore,
        provider,
        model: EXTRACTION_MODEL,
        resolveLlm: resolveWorkspaceExtractionLlm,
        crm: crmStore,
        entities: entitiesStore,
        entityLinks: entityLinksStore,
        memories: memoryStore,
        tasks: taskStore,
        taskAdmission: createTaskAdmissionPort(),
        application: ingestApplicationService,
        episodes: episodesStore,
        ingestRulesStore,
        analytics,
        usageStore,
        ingestCharge: ports.ingestCharge,
        scheduledBatching: ports.whatsappScheduledBatching,
        // D4: an un-triggered message in a bound group is a room post.
        postPassive: async ({ ctx: channel, input, postNotice }) => {
          if (!channel.assistantId || !input.isGroup || !input.text.trim()) return
          const integration = await integrationStore.getByChannelForWebhook(input.channelId, 'whatsapp')
          if (!integration) return
          const identity = await resolveWhatsappByonTurnIdentity(input, channel.assistantId, {
            findLinkedAccount: (provider, providerId) => linkedAccountStore.findByProvider(provider, providerId),
            findUser: findUserById,
            resolveShadow: (providerUserId, assistantId, displayName) => resolveChannelUser(
              channelUserStore, 'whatsapp', providerUserId, assistantId,
              async () => ({ providerUserId, email: null, displayName }),
            ),
          })
          await postPassiveChannelMessage({
            assistant: { id: channel.assistantId, name: channel.assistantName, workspaceId: channel.workspaceId },
            channelType: 'whatsapp',
            channelIntegrationId: integration.id,
            isGroupChat: true,
            sessionChannelId: input.chatJid,
            senderUserId: identity.userId,
            senderName: input.senderName ?? null,
            text: input.text,
            channelMessageId: input.messageId,
            postNotice,
          })
        },
        runPipeline: async ({ ctx: channel, input, hooks, abortController }) => {
          if (!channel.assistantId) return
          const identity = await resolveWhatsappByonTurnIdentity(input, channel.assistantId, {
            findLinkedAccount: (provider, providerId) => linkedAccountStore.findByProvider(provider, providerId),
            findUser: findUserById,
            resolveShadow: (providerUserId, assistantId, displayName) => resolveChannelUser(
              channelUserStore, 'whatsapp', providerUserId, assistantId,
              async () => ({ providerUserId, email: null, displayName }),
            ),
          })
          const integration = await integrationStore.getByChannelForWebhook(input.channelId, 'whatsapp')
          await processChannelMessage({
            userId: identity.userId,
            isIdentified: identity.isIdentified,
            actorChannelId: identity.actorChannelId,
            interactionScope: identity.interactionScope,
            questionIntegrationId: integration?.id,
            channelIntegrationId: integration?.id,
            backgroundModel,
            decisionRuntime,
            ownerId: channel.ownerUserId,
            assistant: {
              id: channel.assistantId,
              name: channel.assistantName,
              ownerUserId: channel.ownerUserId,
              workspaceId: channel.workspaceId,
              systemPrompt: channel.persona,
              clearance: channel.assistantClearance,
              kind: channel.assistantKind,
            },
            channelType: 'whatsapp',
            channelId: input.chatJid,
            mediaEpisodeId: input.mediaEpisodeId,
            messageText: input.text,
            rawUserText: input.text,
            artifactPromoter,
            userContentBlocks: [{ type: 'text', text: input.text }],
            isGroupChat: input.isGroup,
            incomingChannelMessageId: input.messageId,
            archiveIncoming: {
              userId: input.senderPnJid ?? input.senderJid,
              senderDisplay: input.senderName,
              channelId: input.chatJid,
              messageId: input.messageId,
              text: /^<media:[^>]+>$/.test(input.text.trim()) ? '' : input.text,
              mediaType: input.archiveMediaType,
              mediaMime: input.archiveMediaMime,
              mediaName: input.archiveMediaName,
              mediaSizeBytes: input.archiveMediaSizeBytes,
              archiveMediaRef: input.archiveMediaRef,
              archiveMediaAvailability: input.archiveMediaAvailability,
              isGroupChat: input.isGroup,
              timestamp: input.timestamp,
              raw: null,
            },
            archiveConnectorInstanceId: channel.connectorInstanceId,
            archiveInboundAlreadyPersisted: input.archiveInboundPersisted,
            modelAlias: undefined,
            adaptiveResearchEnabled: true,
            abortController,
            provider,
            configuredProviders,
            resolveWorkspaceCustomLlm,
            publishSessionEvent,
            systemPrompt: LAYER_1_SYSTEM_PROMPT,
            tools: allTools,
            memoryStore,
            usageStore,
            analytics,
            connectorStore,
            mcpSettingsStore,
            checkCreditBudget: ports.checkCreditBudget,
            assistantConnectorStore,
            connectorGrantStore,
            connectorInstanceStore,
            knowledgeStore,
            knowledgeCaptureRuleStore,
            gdriveFilesStore,
            workspaceFilesStore,
            filesApi: filesApi ?? undefined,
            skillStore,
            workspaceSkillStore,
            workspaceSkillEnablementStore,
            workspaceSkillFilesStore,
            workerManager,
            episodicStore,
            sessionStateStore,
            crmEmailDraftStore,
            capabilityStore,
            hooks,
          })
        },
      })
      app.use('/api', requireAuth(env.JWT_SECRET), whatsappIngestAdminRoutes({
        workspaceStore,
        integrationStore,
        ruleEditor: ingestRuleEditorStore,
        waConnectorUrl: env.WA_CONNECTOR_URL,
        waConnectorSecret: env.WA_CONNECTOR_SECRET,
        scheduledBatching: ports.whatsappScheduledBatching,
      }))
      app.use('/internal/whatsapp', whatsappByonRoutes({
        connectorSecret: env.WA_CONNECTOR_SECRET,
        integrationStore,
        ingestor: whatsapp.ingestor,
        bot: whatsapp.bot,
        filesResolver: filesResolver ?? undefined,
        archiveIncoming: (input) => appendInboundChatArchive({
          source: 'whatsapp',
          workspaceId: input.workspaceId,
          ownerUserId: input.ownerUserId,
          connectorInstanceId: input.connectorInstanceId,
          assistantId: '',
          assistantName: '',
          conversationId: input.message.channelId,
          message: input.message,
        }),
        passUnknownToFallback: ports.whatsappOfficialFallback,
        archiveMedia: chatArchiveLiveMedia,
        archiveContacts: messageStoreClient
          ? (input) => messageStoreClient.upsertContacts(input)
          : undefined,
      }))
    }

    // Telegram / Slack / Feishu-Lark account linking — web-side of the link-code handshake.
    app.use('/api/assistants/:assistantId/telegram', requireAuth(env.JWT_SECRET),
      telegramLinkingRoutes({ linkedAccountStore, linkCodeStore }))
    app.use('/api/assistants/:assistantId/slack', requireAuth(env.JWT_SECRET),
      slackLinkingRoutes({ linkedAccountStore, linkCodeStore }))

    // Inbound webhooks — self-authenticating (per-integration secrets), so no
    // JWT guard. All gated on the integration store (CHANNEL_CREDENTIAL_KEY).
    if (integrationStore) {
      app.use('/webhook/telegram', telegramByoRoutes({
        archiveMedia: chatArchiveLiveMedia,
        questionStore: channelQuestionStore,
        backgroundModel,
        decisionRuntime,
        provider, configuredProviders, resolveWorkspaceCustomLlm, publishSessionEvent, systemPrompt: LAYER_1_SYSTEM_PROMPT, tools: allTools, capabilityStore,
        memoryStore, usageStore, checkCreditBudget: ports.checkCreditBudget,
        appUrl: env.APP_URL, apiUrl: env.API_URL, integrationStore,
        linkedAccountStore, ownerPairing: {
          enabled: true,
          standaloneOnboarding: isOssEdition(),
          linkCodeStore,
        },
        channelUserStore, workerManager, connectorStore, mcpSettingsStore,
        assistantConnectorStore, connectorGrantStore, connectorInstanceStore, knowledgeStore,
        knowledgeCaptureRuleStore,
        gdriveFilesStore, workspaceFilesStore, filesApi: filesApi ?? undefined, analytics,
        skillStore, workflowStore, workspaceSkillStore, workspaceSkillEnablementStore, workspaceSkillFilesStore,
        deferredConfirmationStore, episodicStore,
        sessionStateStore, crmEmailDraftStore, voiceTranscription, workspaceToolPolicyStore,
        recordingIngest: channelHosts.recordingIngest,
        ingestChannelMediaRef: channelHosts.telegramIngestChannelMediaRef,
        artifactPromoter, fileStore,
      }))
      app.use('/webhook/slack', slackRoutes({
        backgroundModel,
        decisionRuntime,
        ingestChannelMediaRef: channelHosts.slackIngestChannelMediaRef,
        artifactPromoter,
        provider, configuredProviders, resolveWorkspaceCustomLlm, publishSessionEvent, systemPrompt: LAYER_1_SYSTEM_PROMPT, tools: allTools, capabilityStore,
        memoryStore, usageStore, checkCreditBudget: ports.checkCreditBudget,
        integrationStore, channelUserStore, linkedAccountStore, linkCodeStore,
        workerManager, connectorStore, mcpSettingsStore, assistantConnectorStore, connectorGrantStore,
        connectorInstanceStore, knowledgeStore, knowledgeCaptureRuleStore, gdriveFilesStore, workspaceFilesStore,
        realtimeThreadTargetStore,
        filesApi: filesApi ?? undefined, analytics, skillStore,
        workflowStore, workspaceSkillStore, workspaceSkillEnablementStore, workspaceSkillFilesStore,
        deferredConfirmationStore, episodicStore, sessionStateStore, crmEmailDraftStore, workflowEventDispatcher,
        slackWebhookIngestor: channelHosts.slackWebhookIngestor, connectorActionStore, episodesStore,
        buildConnectorActionAudit: ports.buildConnectorActionAudit,
        fileStore,
      }))
      app.use('/webhook/whatsapp', whatsappCloudRoutes({
        backgroundModel,
        decisionRuntime,
        provider, configuredProviders, resolveWorkspaceCustomLlm, publishSessionEvent, systemPrompt: LAYER_1_SYSTEM_PROMPT, tools: allTools, capabilityStore,
        memoryStore, usageStore, checkCreditBudget: ports.checkCreditBudget,
        integrationStore, channelUserStore,
        workerManager, connectorStore, mcpSettingsStore, assistantConnectorStore, connectorGrantStore,
        connectorInstanceStore, workspaceToolPolicyStore, knowledgeStore, knowledgeCaptureRuleStore, gdriveFilesStore, workspaceFilesStore,
        filesApi: filesApi ?? undefined, analytics, skillStore,
        workflowStore, workspaceSkillStore, workspaceSkillEnablementStore, workspaceSkillFilesStore,
        episodicStore, sessionStateStore, crmEmailDraftStore, artifactPromoter, fileStore, workflowEventDispatcher,
      }))
      // Microsoft Teams — public Bot Framework messaging endpoint, per-channel
      // JWT-verified. No connector app (webhook transport). See
      // docs/architecture/channels/msteams.md.
      app.use('/webhook/msteams', msteamsRoutes({
        backgroundModel,
        decisionRuntime,
        provider, configuredProviders, resolveWorkspaceCustomLlm, publishSessionEvent, systemPrompt: LAYER_1_SYSTEM_PROMPT, tools: allTools, capabilityStore,
        memoryStore, usageStore, checkCreditBudget: ports.checkCreditBudget,
        integrationStore, channelUserStore,
        workerManager, connectorStore, mcpSettingsStore, assistantConnectorStore, connectorGrantStore,
        connectorInstanceStore, knowledgeStore, knowledgeCaptureRuleStore, gdriveFilesStore, workspaceFilesStore,
        analytics, skillStore, workflowStore, workspaceSkillStore, workspaceSkillEnablementStore, workspaceSkillFilesStore,
        episodicStore, sessionStateStore, crmEmailDraftStore, artifactPromoter,
        msteamsWebhookIngestor: channelHosts.msteamsWebhookIngestor,
        fileStore,
      }))
      if (env.DISCORD_CONNECTOR_SECRET) {
        app.use('/internal/discord', discordRoutes({
        backgroundModel,
          decisionRuntime,
          ingestChannelMediaRef: channelHosts.discordIngestChannelMediaRef,
          artifactPromoter,
          connectorSecret: env.DISCORD_CONNECTOR_SECRET, provider, configuredProviders, resolveWorkspaceCustomLlm, publishSessionEvent, systemPrompt: LAYER_1_SYSTEM_PROMPT,
          tools: allTools, capabilityStore, memoryStore, usageStore,
          checkCreditBudget: ports.checkCreditBudget, integrationStore, channelUserStore,
          workerManager, connectorStore, mcpSettingsStore, assistantConnectorStore, connectorGrantStore,
          connectorInstanceStore, knowledgeStore, knowledgeCaptureRuleStore, gdriveFilesStore, workspaceFilesStore, analytics,
          skillStore, workflowStore, workspaceSkillStore, workspaceSkillEnablementStore, workspaceSkillFilesStore,
          episodicStore, sessionStateStore, crmEmailDraftStore, fileStore,
        }))
      }
      if (env.WECHAT_CONNECTOR_SECRET) {
        app.use('/internal/wechat', wechatRoutes({
          backgroundModel,
          decisionRuntime,
          artifactPromoter,
          connectorSecret: env.WECHAT_CONNECTOR_SECRET, provider, configuredProviders, resolveWorkspaceCustomLlm, publishSessionEvent, systemPrompt: LAYER_1_SYSTEM_PROMPT,
          tools: allTools, capabilityStore, memoryStore, usageStore,
          checkCreditBudget: ports.checkCreditBudget, integrationStore, channelUserStore,
          workerManager, connectorStore, mcpSettingsStore, assistantConnectorStore, connectorGrantStore,
          connectorInstanceStore, knowledgeStore, knowledgeCaptureRuleStore, gdriveFilesStore, workspaceFilesStore, analytics,
          skillStore, workflowStore, workspaceSkillStore, workspaceSkillEnablementStore, workspaceSkillFilesStore,
          episodicStore, sessionStateStore, crmEmailDraftStore, fileStore,
          // Without this the route's staging block is unreachable and every
          // inbound attachment archives as `availability: 'missing'` — the
          // message row lands, the bytes are lost, and nothing says so. iLink
          // CDN media is short-lived and AES-encrypted, so it cannot be
          // re-fetched later; this is the only moment those bytes exist.
          archiveMedia: chatArchiveLiveMedia,
          }))
      }
      app.use('/internal/notifications/feishu', feishuNotificationRoutes({ pool: getPool(), integrations: integrationStore }))
      if (env.FEISHU_CONNECTOR_SECRET) {
        app.use('/internal/feishu', feishuRoutes({
          backgroundModel,
          decisionRuntime,
          artifactPromoter,
          connectorSecret: env.FEISHU_CONNECTOR_SECRET,
          provider,
          configuredProviders,
          resolveWorkspaceCustomLlm,
          publishSessionEvent,
          systemPrompt: LAYER_1_SYSTEM_PROMPT,
          tools: allTools,
          capabilityStore,
          memoryStore,
          usageStore,
          checkCreditBudget: ports.checkCreditBudget,
          integrationStore,
          channelUserStore,
          linkedAccountStore,
          linkCodeStore,
          deferredConfirmationStore,
          workflowEventDispatcher,
          feishuWebhookIngestor: channelHosts.feishuWebhookIngestor,
          workerManager,
          connectorStore,
          mcpSettingsStore,
          assistantConnectorStore,
          connectorGrantStore,
          connectorInstanceStore,
          workspaceToolPolicyStore,
          knowledgeStore,
          knowledgeCaptureRuleStore,
          gdriveFilesStore,
          workspaceFilesStore,
          filesApi: filesApi ?? undefined,
          readCachedFile: (id, access) => fileStore.get(id, access),
          analytics,
          skillStore,
          workflowStore,
          workspaceSkillStore,
          workspaceSkillEnablementStore,
          workspaceSkillFilesStore,
          episodicStore,
          sessionStateStore,
          crmEmailDraftStore,
          fileStore,
          archiveMedia: chatArchiveLiveMedia,
          voiceTranscription,
        }))
      }
      // Custom (bridge-driven) channels. Unconditional: auth is the per-channel
      // bridge token, not an env secret. Mounted OUTSIDE /api on purpose so no
      // bare `app.use('/api', requireAuth(…))` guard can 401 the bridge.
      // See docs/architecture/channels/custom-channel.md.
      app.use('/bridge/v1/channels', customChannelBridgeRoutes({
        backgroundModel,
        decisionRuntime,
        artifactPromoter,
        provider, configuredProviders, resolveWorkspaceCustomLlm, publishSessionEvent, systemPrompt: LAYER_1_SYSTEM_PROMPT,
        tools: allTools, capabilityStore, memoryStore, usageStore,
        checkCreditBudget: ports.checkCreditBudget, integrationStore, customChannelStore, channelUserStore,
        workerManager, connectorStore, mcpSettingsStore, assistantConnectorStore, connectorGrantStore,
        connectorInstanceStore, knowledgeStore, knowledgeCaptureRuleStore, gdriveFilesStore, workspaceFilesStore, analytics,
        skillStore, workflowStore, workspaceSkillStore, workspaceSkillEnablementStore, workspaceSkillFilesStore,
        episodicStore, sessionStateStore, crmEmailDraftStore, fileStore,
        archiveMedia: chatArchiveLiveMedia,
        voiceTranscription,
        deferredConfirmationStore,
      }))
    }
  }
}
