/**
 * Base tool set (allTools) and campaign tools.
 *
 * Boot register module registerTools: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`ToolsScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { calculateCost } from '@use-brian/agent-runtime/billing/cost-tracker.js'
import { createCacheTool } from '@use-brian/agent-runtime/compaction/cache-tool.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import { createCampaignTools } from '@use-brian/core/campaigns/tools.js'
import type { EnginesEnv } from '@use-brian/core/engines/ask-engines.js'
import { createReadFileTool } from '@use-brian/core/files/tool.js'
import { createIngestApplicationTools } from '@use-brian/core/ingest/tools.js'
import { createSchedulingTools } from '@use-brian/core/scheduling/tools.js'
import {
  createConfirmRecordingProcessingTool,
} from '@use-brian/core/tools/base/confirm-recording-processing.js'
import {
  createGoogleMapsTools,
  GOOGLE_MAPS_GROUNDING_MCP_URL,
} from '@use-brian/core/tools/base/google-maps.js'
import { createBaseTools } from '@use-brian/core/tools/base/index.js'
import { createIngestStoredFileTool } from '@use-brian/core/tools/base/ingest-stored-file.js'
import { createReportBugTool } from '@use-brian/core/tools/base/report-bug.js'
import { createReprocessRecordingTool } from '@use-brian/core/tools/base/reprocess-recording.js'
import { createWorkerTools } from '@use-brian/core/workers/tools.js'
import { createWorkerManager } from '@use-brian/core/workers/worker.js'
import { resolveCurrentRecordingId, createRecoverRecordingTool } from '../recordings/recovery.js'
import { getWorkspaceMembershipSystem } from '../db/workspace-store.js'
import { randomUUID } from 'node:crypto'
import { recordingIdFromAnchorKey } from '@use-brian/shared'
import { findUserById } from '../db/users.js'
import { createUpdateViewedSkillTool } from '../skills/update-viewed-skill-tool.js'
import { BACKGROUND_MODEL } from '../model-resolution.js'
import { createChatArchiveTools } from '../chat-archive/chat-tools.js'
import { campaignReadActor } from '../content-planning/email.js'
import { createDbCampaignStore } from '../db/campaign-store.js'
import { createCampaignTrackingStore } from '../db/campaign-tracking-store.js'
import { createCampaignService } from '../campaigns/service.js'
import {
  buildChannelSessionKey, getPendingRecordingConfirmation, deletePendingRecordingConfirmation,
} from '../db/pending-recording-confirmations-store.js'
import { enqueueRecordingJob, hasCompletedRecordingJob } from '../db/recording-jobs-store.js'
import { getWorkspaceFileById } from '../db/workspace-files.js'
import { createMeetingTagsTool } from '../recordings/meeting-tags-tool.js'
import { createSearchFileContentTool } from '../files/file-artifact-tools.js'
import {
  createChatSearchRecordingTool, createListRecordingsTool, createAssignRecordingSpeakersTool,
} from '../recordings/recording-chat-tools.js'
import { enqueueFileIngestJob } from '../db/file-ingest-jobs-store.js'
import { callRemoteMcpTool } from '../mcp/client.js'
import { createWorkflowChannelDelivery } from '../workflow/channel-delivery.js'
import { createDeliveryTargetResolver } from '../scheduling/delivery-target.js'
import { updateRecording, getRecording } from '../db/recordings-store.js'
import type { ToolsScope } from './scope.js'

export function registerTools(scope: ToolsScope) {
  const {
    ports, env, messageStoreClient, externalCredentialPool, provider, integrationStore, campaignEmailService,
    crmStore, sharedEmbedder, usageStore, workspaceSkillStore, workflowStore, savedViewStore,
    ingestApplicationService, backgroundModel, jobStore, resolveBackgroundRuntime, channelQuestionStore,
    customChannelStore, cacheStore, fileStore, workspaceFilesStore, campaignDispatchService,
  } = scope
  // ════════════════════════════════════════════════════════════════
  // Tool set
  // ════════════════════════════════════════════════════════════════
  let workerManager!: ReturnType<typeof createWorkerManager>

  function buildAllTools(): Map<string, Tool> {
    const tools = createBaseTools(process.env as EnginesEnv, externalCredentialPool)

    const ingestApplicationTools = createIngestApplicationTools({
      get: (toolContext, episodeId) => ingestApplicationService.get({
        workspaceId: toolContext.workspaceId!,
        userId: toolContext.userId,
        assistantId: toolContext.assistantId,
        assistantKind: toolContext.assistantKind ?? 'standard',
        clearance: toolContext.clearance,
        compartments: toolContext.compartments === undefined ? [] : toolContext.compartments,
        mutationCompartments: toolContext.mutationCompartments === undefined
          ? toolContext.compartments === undefined ? [] : toolContext.compartments
          : toolContext.mutationCompartments,
        projectIds: toolContext.projectIds === undefined ? [] : toolContext.projectIds,
      }, episodeId),
      retry: (toolContext, input) => ingestApplicationService.retry({
        ctx: {
          workspaceId: toolContext.workspaceId!,
          userId: toolContext.userId,
          assistantId: toolContext.assistantId,
          assistantKind: toolContext.assistantKind ?? 'standard',
          clearance: toolContext.clearance,
          compartments: toolContext.compartments === undefined ? [] : toolContext.compartments,
          mutationCompartments: toolContext.mutationCompartments === undefined
            ? toolContext.compartments === undefined ? [] : toolContext.compartments
            : toolContext.mutationCompartments,
          projectIds: toolContext.projectIds === undefined ? [] : toolContext.projectIds,
        },
        ...input,
      }),
    })
    tools.set(ingestApplicationTools.getIngestApplication.name, ingestApplicationTools.getIngestApplication)
    tools.set(ingestApplicationTools.retryIngestApplication.name, ingestApplicationTools.retryIngestApplication)

    // Google Maps is an env-gated first-party read capability, not a personal
    // Google connector. Core owns the typed tool contract; this API seam owns
    // the MCP SDK and the secret-bearing transport. Interactive turns fold
    // these tools into mcp_search later; workflows keep their canonical names.
    // See docs/architecture/integrations/google-maps.md.
    const googleMapsApiKey = env.GOOGLE_MAPS_SERVER_API_KEY?.trim()
    if (googleMapsApiKey) {
      for (const tool of createGoogleMapsTools({
        callTool: (providerTool, input) =>
          callRemoteMcpTool(
            GOOGLE_MAPS_GROUNDING_MCP_URL,
            providerTool,
            input,
            { 'X-Goog-Api-Key': googleMapsApiKey },
          ),
      })) {
        tools.set(tool.name, tool)
      }
    }

    workerManager = createWorkerManager({
      provider,
      // Keep the persisted worker model logical. Routing resolves the live
      // background provider at execution/rehydration time.
      model: BACKGROUND_MODEL,
      tools: new Map([...tools].filter(([_, t]) => t.isReadOnly)),
      // Record worker LLM COGS — the WorkerManager metering gap. COGS-only
      // (source 'included', no userMessageId → not credit-bearing), mirroring
      // workflow `assistant_call` turns. Guarded on usageStore for bespoke
      // compositions; hosted and normal standalone both record. Return the
      // accounting promise so the worker retains ownership through settlement.
      onUsage: usageStore
        ? (u) => {
            return usageStore
              .recordUsage({
                userId: u.userId,
                assistantId: u.assistantId,
                sessionId: u.sessionId,
                model: u.model,
                modelTier: u.modelTier,
                inputTokens: u.usage.inputTokens,
                outputTokens: u.usage.outputTokens,
                cacheReadTokens: u.usage.cacheReadTokens,
                cacheWriteTokens: u.usage.cacheWriteTokens,
                actualCostUsd: u.providerKeySource === 'user' ? 0 : calculateCost(u.model, u.usage),
                source: 'included',
                triggerKey: 'worker_run',
                providerKeySource: u.providerKeySource,
              })
              .catch((err) => console.error('[workers] usage tracking failed:', err))
          }
        : undefined,
    })
    const { spawnWorker, sendWorkerMessage, stopWorker } = createWorkerTools(workerManager)
    tools.set('spawnWorker', spawnWorker)
    tools.set('sendWorkerMessage', sendWorkerMessage)
    tools.set('stopWorker', stopWorker)

    const { createScheduledJob, updateScheduledJob, searchScheduledJobs, deleteScheduledJob } = createSchedulingTools({
      backgroundModel,
      jobStore,
      workflowStore,
      provider,
      resolveLlm: async (workspaceId) => {
        const runtime = await resolveBackgroundRuntime(workspaceId)
        return runtime ? { provider: runtime.provider, model: runtime.selector } : null
      },
      resolveDeliveryTarget: createDeliveryTargetResolver(integrationStore ?? undefined),
      deliverToChannel: createWorkflowChannelDelivery({
        questionStore: channelQuestionStore,
        integrationStore: integrationStore ?? undefined,
        defaultTelegramBotToken: env.TELEGRAM_BOT_TOKEN,
        waConnectorUrl: env.WA_CONNECTOR_URL,
        waConnectorSecret: env.WA_CONNECTOR_SECRET,
        customChannelStore,
      }),
      resolveViewWorkspace: async ({ userId, viewId }) =>
        (await savedViewStore.getById(userId, viewId))?.workspaceId ?? null,
    })
    tools.set('createScheduledJob', createScheduledJob)
    tools.set('updateScheduledJob', updateScheduledJob)
    tools.set('searchScheduledJobs', searchScheduledJobs)
    tools.set('deleteScheduledJob', deleteScheduledJob)

    tools.set('retrieveCachedResults', createCacheTool(cacheStore))
    tools.set('readFileContent', createReadFileTool(fileStore))
    // Per-file segment retrieval over stored artifacts (large-content-artifacts
    // §Phase 1.4). Registered in the base toolset so chat, the callee executor,
    // and workflows all carry it by construction; the actor is rebuilt from the
    // ToolContext per call, so read ceilings hold on every path.
    tools.set(
      'searchFileContent',
      createSearchFileContentTool({
        embedder: sharedEmbedder,
        getFile: async (actor, fileId) => {
          const file = await workspaceFilesStore.getById(actor, fileId)
          return file ? { id: file.id, name: file.name, mime: file.mime } : null
        },
      }),
    )

    // The recording surface for chat, registered at the same seam and for the
    // same reason: chat, the callee executor, and workflows all carry it by
    // construction, and the actor is rebuilt from the ToolContext per call so
    // read ceilings hold everywhere.
    //
    // Two axes, neither redundant: listRecordings is TEMPORAL ("Tuesday's
    // call" — semantic search structurally cannot answer that), searchRecording
    // is PRECISION inside one recording (what was said, by whom, and WHEN, so
    // the model can cite the moment). Note this searchRecording takes
    // `recordingId` as a model INPUT — unlike the synthesis-loop twin in
    // recordings/recording-search-tool.ts, which pins it in the closure so that
    // loop cannot pivot off the recording it was told to summarize.
    tools.set(
      'searchRecording',
      createChatSearchRecordingTool({ embedder: sharedEmbedder }),
    )
    tools.set('listRecordings', createListRecordingsTool())
    tools.set('manageMeetingTags', createMeetingTagsTool(savedViewStore))
    tools.set(
      'assignRecordingSpeakers',
      createAssignRecordingSpeakersTool({
        resolvePageRecording: async (actorUserId, pageId) => {
          const page = await savedViewStore.getById(actorUserId, pageId)
          if (!page) return null
          const recordingId = recordingIdFromAnchorKey(page.anchorKey) ?? page.linkedRecordingId
          const currentId = recordingId ? await resolveCurrentRecordingId({ actorUserId }, page.workspaceId, recordingId) : null
          return currentId ? { recordingId: currentId, workspaceId: page.workspaceId } : null
        },
        getContact: (ctx, contactId) => crmStore.getContactById(ctx, contactId),
        getSelf: async (userId) => {
          const user = await findUserById(userId)
          return user ? { name: user.name, email: user.email } : null
        },
        updateParticipants: async (recordingId, participants) => {
          const updated = await updateRecording(recordingId, { participants })
          if (!updated) throw new Error(`Recording ${recordingId} disappeared before its participants could be saved.`)
        },
      }),
    )

    // Provider-neutral local chat history. These are base read tools rather
    // than connector API tools: the archive remains available when a live
    // WhatsApp / WeChat connection is offline, and every call owner-binds from
    // ToolContext. The same instances are bridged into native agent surfaces.
    // Raw query text crosses the wire, never a vector: the store embeds the
    // query with the same client that embedded the stored segments, so both
    // sides of every cosine comparison come from one implementation.
    if (messageStoreClient) {
      for (const tool of createChatArchiveTools({ client: messageStoreClient })) {
        tools.set(tool.name, tool)
      }
    }

    // Bug report tool — the create sink is a port; open default returns a
    // synthetic id (no persistence). The platform injects its bug-report store.
    const reportBugTool = createReportBugTool({
      create: ports.createBugReport ?? (async () => ({ id: randomUUID() })),
    })
    tools.set('reportBug', reportBugTool)

    // Channel recording pre-flight confirm (channel-recording-preflight-confirm
    // §5). The agent-native commit for a BIG recording held at intake: the user
    // replies, the model calls this to enqueue (or cancel) via the existing
    // recording-jobs queue. A base engine tool, NOT an MCP connector tool.
    tools.set(
      'confirmRecordingProcessing',
      createConfirmRecordingProcessingTool({
        buildChannelSessionKey,
        getPending: async (recordingId) => {
          const row = await getPendingRecordingConfirmation(recordingId)
          return row
            ? {
                recordingId: row.recordingId,
                channelSessionKey: row.channelSessionKey,
                defaultBlueprintSlug: row.defaultBlueprintSlug,
              }
            : null
        },
        deletePending: deletePendingRecordingConfirmation,
        enqueueRecordingJob,
      }),
    )

    // Existing-file re-ingest + recording re-process — the user-reachable
    // recovery affordances (file-artifacts.md §"Re-ingest", transcription.md
    // §"Re-processing"). Both are thin wrappers over the EXISTING job queues;
    // both refuse to double-ingest silently: an already-ingested/processed
    // target requires a user-approved confirm relayed by the model.
    tools.set(
      'ingestFile',
      createIngestStoredFileTool({
        getFile: async (actor, fileId) => {
          const f = await getWorkspaceFileById(actor, fileId)
          return f
            ? {
                id: f.id,
                name: f.name,
                mime: f.mime,
                sizeBytes: f.sizeBytes,
                sourceEpisodeId: f.sourceEpisodeId,
              }
            : null
        },
        enqueue: enqueueFileIngestJob,
      }),
    )
    tools.set('recoverRecording', createRecoverRecordingTool())
    tools.set(
      'reprocessRecording',
      createReprocessRecordingTool({
        getRecording: async (actorUserId, recordingId) => {
          const recording = await getRecording(actorUserId, recordingId)
          return recording
            ? {
                id: recording.id,
                workspaceId: recording.workspaceId,
                // An existing recording: its `recordings` row (createRecording in
                // db/recordings-store.ts, at upload) already indexes this Episode.
                sourceKind: 'recording',
                sourceRef: {
                  gcsKey: recording.gcsKey,
                  fileName: recording.fileName,
                },
                durationMs: recording.durationMs,
              }
            : null
        },
        hasProcessed: hasCompletedRecordingJob,
        enqueue: enqueueRecordingJob,
        surchargeCredits: ports.recordingSurchargeCredits,
      }),
    )

    // Closed capability-gated tools (triage / product-sentiment / analytics-query).
    // Open omits them; the platform injects via buildClosedTools.
    if (ports.buildClosedTools) {
      for (const tool of ports.buildClosedTools()) tools.set(tool.name, tool)
    }

    return tools
  }

  const allTools = buildAllTools()
  const campaignStore = createDbCampaignStore()
  const campaignTrackingStore = createCampaignTrackingStore()
  const campaignService = createCampaignService(campaignStore, campaignTrackingStore, campaignEmailService, campaignDispatchService)
  const campaignTools = createCampaignTools({
    service: campaignService,
    reads: {
      listCampaigns: (workspaceId, filters) => campaignStore.listCampaigns(workspaceId, filters),
      getCampaign: (workspaceId, campaignId) => campaignStore.getCampaign(workspaceId, campaignId),
      listLinks: (workspaceId, campaignId) => campaignStore.listLinks(workspaceId, campaignId),
      getTrackingSetup: (workspaceId, siteId) => campaignTrackingStore.trackingSetup(workspaceId, siteId),
      getResults: (workspaceId, campaignId, filters) => campaignTrackingStore.results(workspaceId, campaignId, filters),
      getAttribution: (workspaceId, campaignId, filters) => campaignTrackingStore.attribution(workspaceId, campaignId, filters),
      previewAudience: (workspaceId, input, actor) => campaignEmailService.audience(workspaceId, String(input.placement_id), campaignReadActor(actor)),
      previewEmail: (workspaceId, input) => campaignEmailService.preview(workspaceId, String(input.placement_id),
        (input.values ?? {}) as Record<string, string>, Number(input.revision)),
    },
    resolveContext: async (toolContext) => {
      if (!toolContext.workspaceId || !toolContext.userId) return null
      const membership = await getWorkspaceMembershipSystem(toolContext.userId, toolContext.workspaceId)
      if (!membership) return null
      return {
        workspaceId: toolContext.workspaceId,
        actor: {
          kind: 'assistant',
          userId: toolContext.userId,
          assistantId: toolContext.assistantId,
          sessionId: toolContext.sessionId,
        },
        authority: {
          role: membership.role,
          canRead: true,
          canWrite: membership.canDraft,
          canConfigure: membership.role !== 'member',
          canSend: membership.canDraft && membership.role !== 'member',
        },
      }
    },
  })
  for (const tool of Object.values(campaignTools)) allTools.set(tool.name, tool)
  // Hidden during ordinary turns; the skill-editor route replaces it with an
  // RLS-scoped visible instance. Keeping the same implementation in the boot
  // registry lets an approved call replay safely after a process restart.
  allTools.set('updateViewedSkill', createUpdateViewedSkillTool({ workspaceSkillStore }))

  return { workerManager, campaignService, allTools } as const
}
