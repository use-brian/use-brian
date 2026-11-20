/**
 * Channel rooms, session, distribution, campaign, analytics, files, home-app and account routes.
 *
 * Boot register module registerSessionRoutes: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`SessionRoutesScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { calculateCost } from '@use-brian/agent-runtime/billing/cost-tracker.js'
import { transcribeAudio as transcribeWatchAudio } from '@use-brian/core/media/transcribe.js'
import { captureApplicationHomeBinding } from '../application-platform/home-auth.js'
import { configureChannelRooms } from '../channel-room/room.js'
import { getWorkspaceMembershipWithClearanceSystem } from '../db/workspace-store.js'
import { initializeConversationVisibility } from '../db/conversation-visibility.js'
import { createLocalLinkedInCloud } from '../content-planning/linkedin-cloud.js'
import {
  setFeedLinkedInTargetAuthority, setFeedLinkedInPublisher, setFeedLinkedInRecovery,
} from '../content-planning/linkedin-authority.js'
import { usesOpenStandaloneRoutes } from '../edition.js'
import { isOssEdition } from '../routes/local-session.js'
import type { ContentPlanningRouteOptions } from '../routes/content-planning.js'
import { configureFeedLinkedInFiles } from '../content-planning/linkedin-payload.js'
import {
  createSelfHostFeedCloudPublisher, selfHostFeedCloudRoutes, selfHostFeedOAuthRelayRoutes,
  selfHostFeedManagedDistributionRoutes,
} from '../routes/self-host-feed-cloud.js'
import { createSelfHostFeedCloudLinkStore } from '../db/self-host-feed-cloud-link-store.js'
import { tryResolveLiveToolApproval } from '../routes/chat.js'
import { sessionRoutes } from '../routes/sessions.js'
import { createSessionChannelNameResolver } from '../session-channel-names.js'
import { createRoomIngestor } from '../ingest/room-ingest.js'
import { sessionQuestionRoutes } from '../routes/sessions-questions.js'
import { deleteBundle, bundleStoragePath, homeAppRoutes } from '../routes/home-apps.js'
import { type SyncDeps as HomeAppSyncDeps, syncHomeAppFromGitHub } from '../home-apps/sync.js'
import { enqueueRecordingJob, hasCompletedRecordingJob } from '../db/recording-jobs-store.js'
import { getBranchHead, getRepoTree, getFileContents } from '../github/client.js'
import {
  publishSessionEvent, subscribeSessionEvents, setSessionTyping, getSessionPresence,
} from '../session-event-bus.js'
import { createTransactionalConnectorSetup } from '../connectors/transactional-setup.js'
import { connectorSetupProviders } from '../connectors/setup-providers.js'
import { optionalAuth, requireAuth } from '../auth/middleware.js'
import { answerRoutineQuestion } from '../tasks/routine-execution.js'
import { getWorkspaceFileReadProjection } from '../db/workspace-files.js'
import { authorizeWatchDestination, createWatchService } from '../recordings/watch-service.js'
import { startWatchCleanup } from '../recordings/watch-maintenance.js'
import { createLiveInteractionRuntime } from '../recordings/live-interaction-runtime.js'
import { createLedgerPayloadStore } from '../ledger/payload-store.js'
import { datedRecordingTitle } from '../recordings/auto-title.js'
import { runDocAutoTitle } from '../doc/auto-title.js'
import { notifyRoomMentionRecorded, notifyWorkspaceChange } from '../brain-stream/notify.js'
import { query, getPool } from '../db/client.js'
import {
  SupportDiagnosticsCaptureManager, createSupportDiagnosticsStore, supportDiagnosticRoutes,
  SupportCapsuleBuilder,
} from '../support-diagnostics/index.js'
import { lazyRoutes } from './lazy.js'
import type { SessionRoutesScope } from './scope.js'

// Router modules that load on their mount's first request (deployment.md ->
// "Boot composition" -> "Lazy routers and workers"); the mounts below are unchanged.
const contentPlanningRoutes = lazyRoutes(() => import('../routes/content-planning.js'), 'contentPlanningRoutes')
const contentPlanRoutes = lazyRoutes(() => import('../routes/content-plan.js'), 'contentPlanRoutes')
const contentIdeasRoutes = lazyRoutes(() => import('../routes/content-ideas.js'), 'contentIdeasRoutes')
const postWorkingCopiesRoutes = lazyRoutes(() => import('../routes/post-working-copies.js'), 'postWorkingCopiesRoutes')
const campaignRoutes = lazyRoutes(() => import('../routes/campaigns.js'), 'campaignRoutes')
const feedCollaborationRoutes = lazyRoutes(() => import('../routes/feed-collaboration.js'), 'feedCollaborationRoutes')
const analyticsRoutes = lazyRoutes(() => import('../routes/analytics.js'), 'analyticsRoutes')
const fileRoutes = lazyRoutes(() => import('../routes/files.js'), 'fileRoutes')
const linkedinImportRoutes = lazyRoutes(() => import('../routes/linkedin-imports.js'), 'linkedinImportRoutes')
const docFilesRoutes = lazyRoutes(() => import('../routes/doc-files.js'), 'docFilesRoutes')
const feedbackRoutes = lazyRoutes(() => import('../routes/feedback.js'), 'feedbackRoutes')
const accountAvatarPublicRoutes = lazyRoutes(() => import('../routes/account.js'), 'accountAvatarPublicRoutes')
const accountRoutes = lazyRoutes(() => import('../routes/account.js'), 'accountRoutes')
const workspaceIconPublicRoutes = lazyRoutes(() => import('../routes/workspace-icon.js'), 'workspaceIconPublicRoutes')
const connectorRoutes = lazyRoutes(() => import('../routes/connectors.js'), 'connectorRoutes')
const openRecordingsRoutes = lazyRoutes(() => import('../routes/recordings.js'), 'openRecordingsRoutes')
const recordingRecoveryRoutes = lazyRoutes(() => import('../recordings/recovery-routes.js'), 'recordingRecoveryRoutes')
const recordingLiveRoutes = lazyRoutes(() => import('../routes/recording-live.js'), 'recordingLiveRoutes')
const watchRecordingRoutes = lazyRoutes(() => import('../routes/watch-recording.js'), 'watchRecordingRoutes')
const recordingInteractionRoutes = lazyRoutes(() => import('../routes/recording-interaction.js'), 'recordingInteractionRoutes')

export async function registerSessionRoutes(scope: SessionRoutesScope) {
  await initializeConversationVisibility()
  const {
    ports, env, app, provider, integrationStore, campaignEmailService, sharedEmbedder, analyticsStore,
    usageStore, credKey, connectorInstanceStore, profile, linkedAccountStore, connectorGrantStore,
    workspaceStore, savedViewStore, knowledgeStore, syncCredentials, backgroundModel, jobStore,
    resolveBackgroundRuntime, fileStore, campaignDispatchService, campaignService, allTools, filesResolver,
    mcpSettingsStore, brainEpisodeIngestor, runWorkers, pendingApprovalsStore, workerRunsStore, filesApi,
    connectorStore, capabilityStore, executionControlEffects, filesBlobClient, chunkedFileUploads,
    docPageStore, fileIngestor, feedReviewContext, feedGeneration, artifactPromoter, sessionResumeStore,
    voiceTranscription, docGateway, linkCodeStore, channelIdentityStore, getTelegramBotUsername,
    connectorAppCredentialStore,
  } = scope
  // Room ambient capture (multiplayer chat P2/D9): every accepted room post
  // routes through the room ingest engine — hosted batches hourly digest
  // windows (`roomScheduledBatching`), OSS runs inline over the same
  // brain-episode seam. Fire-and-forget at the route; absent without a
  // Pipeline-B impl (tests, stripped deploys).
  const roomIngestor = brainEpisodeIngestor
    ? createRoomIngestor({
        brainEpisodeIngestor,
        scheduledBatching: ports.roomScheduledBatching,
      })
    : undefined
  // Channel rooms (unified-sessions §4.4) capture and fan out their posts on
  // the same seams as web rooms.
  configureChannelRooms({
    publishSessionEvent,
    ...(roomIngestor
      ? {
          capturePost: (post) => {
            void roomIngestor.ingestPost(post).catch((err) => {
              console.error('[room-ingest] channel room capture failed:', err)
            })
          },
        }
      : {}),
  })
  app.use('/api/sessions', optionalAuth(env.JWT_SECRET), sessionRoutes({
    resolveChannelNames: createSessionChannelNameResolver({
      integrationStore: integrationStore ?? undefined,
      telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    }),
    subscribeSessionEvents,
    publishSessionEvent,
    setSessionTyping,
    getSessionPresence,
    // A decided suspension whose durable resume has not started yet: the
    // reconnect stream waits for the resumed owner's turn_started.
    pendingSessionResume: async (sessionId) => {
      const point = await sessionResumeStore.getBySessionId(sessionId)
      const approval = point ? await pendingApprovalsStore.getByIdSystem(point.approvalId) : null
      return !!approval && (approval.status === 'approved' || approval.status === 'rejected' || approval.status === 'expired')
    },
    // T-H8 (docs/plans/room-human-mentions.md) — same emitter + reasoning as
    // the chatRoutes wiring above; this covers the silent-post and edit
    // call sites that live in sessions.ts rather than chat.ts.
    onRoomMentionRecorded: (input) => notifyRoomMentionRecorded(input.workspaceId),
    ...(roomIngestor
      ? {
          onRoomPost: (post) => {
            void roomIngestor.ingestPost(post).catch((err) => {
              console.error('[room-ingest] post capture failed:', err)
            })
          },
        }
      : {}),
  }))
  app.use('/api/sessions', requireAuth(env.JWT_SECRET), sessionQuestionRoutes({
    approvalsStore: pendingApprovalsStore,
    answerTaskQuestion: approval => answerRoutineQuestion(approval, executionControlEffects),
    resumeDeps: {
      approvalsStore: pendingApprovalsStore,
      sessionResumeStore,
      jobStore,
      tryResolveLive: tryResolveLiveToolApproval,
    },
    workerRunsStore,
    capabilityStore,
    connectorInstanceStore,
    connectorGrantStore,
  }))

  let supportDiagnosticsManager: SupportDiagnosticsCaptureManager | undefined
  if (env.SUPPORT_DIAGNOSTICS_ENABLED) {
    const supportDiagnosticsStore = createSupportDiagnosticsStore()
    supportDiagnosticsManager = new SupportDiagnosticsCaptureManager(supportDiagnosticsStore)
    await supportDiagnosticsManager.start()
    app.use(
      '/api/support-diagnostics',
      requireAuth(env.JWT_SECRET),
      supportDiagnosticRoutes({
        store: supportDiagnosticsStore,
        captureManager: supportDiagnosticsManager,
        capsuleBuilder: new SupportCapsuleBuilder(supportDiagnosticsStore),
      }),
    )
  }

  // A self-hosted deployment may opt into the hosted provider plane through
  // a paid Cloud Link. Mount its exact managed routes before the open planning
  // routers so connected profiles/settings resolve remotely while drafts,
  // plans, ideas, and approvals keep falling through to local storage.
  let feedCloudPublisher: ContentPlanningRouteOptions['publishApproved']
  if (isOssEdition() && env.MANAGED_FEED_CLOUD_URL && credKey) {
    const feedCloudStore = createSelfHostFeedCloudLinkStore(credKey)
    const linkedinCloud = createLocalLinkedInCloud({store:feedCloudStore})
    setFeedLinkedInTargetAuthority(linkedinCloud.authorize)
    setFeedLinkedInPublisher(linkedinCloud.publish)
    setFeedLinkedInRecovery(linkedinCloud)
    feedCloudPublisher = createSelfHostFeedCloudPublisher({ store: feedCloudStore })
    app.use(
      '/api/self-host-feed',
      requireAuth(env.JWT_SECRET),
      selfHostFeedCloudRoutes({
        cloudBaseUrl: env.MANAGED_FEED_CLOUD_URL,
        localAppUrl: env.APP_URL,
        store: feedCloudStore,
      }),
    )
    app.use('/api/linkedin-oauth',requireAuth(env.JWT_SECRET),selfHostFeedOAuthRelayRoutes('linkedin',{store:feedCloudStore}))
    app.use(
      '/api/threads-oauth',
      requireAuth(env.JWT_SECRET),
      selfHostFeedOAuthRelayRoutes('threads', { store: feedCloudStore }),
    )
    app.use(
      '/api/twitter-oauth',
      requireAuth(env.JWT_SECRET),
      selfHostFeedOAuthRelayRoutes('twitter', { store: feedCloudStore }),
    )
    app.use(
      '/api/distribution',
      requireAuth(env.JWT_SECRET),
      selfHostFeedManagedDistributionRoutes({ store: feedCloudStore }),
    )
  }

  // Marketing plan (slots + month brief) is open in BOTH editions: it needs
  // no credential and no distribution profile, so it must not join the
  // `/api/distribution` fork that already 404s edition-specific routes.
  // Mounted first; unmatched paths fall through to whichever planning router
  // the edition mounts below. Spec: docs/plans/feed-revamp.md §6.
  app.use('/api/distribution', requireAuth(env.JWT_SECRET), contentPlanRoutes())

  // The idea backlog rides the same open mount for the same reason: capturing
  // and developing an idea must never require a credential in either edition.
  app.use('/api/distribution', requireAuth(env.JWT_SECRET), contentIdeasRoutes())
  app.use('/api/distribution', requireAuth(env.JWT_SECRET), postWorkingCopiesRoutes())
  configureFeedLinkedInFiles(filesApi ?? undefined)
  app.use('/api/distribution', requireAuth(env.JWT_SECRET), feedCollaborationRoutes({ generation: feedGeneration, reviewContext: feedReviewContext, files: filesApi ?? undefined }))
  app.use('/api/campaigns', requireAuth(env.JWT_SECRET), campaignRoutes({
    emailService: campaignEmailService,
    dispatchService: campaignDispatchService,
    service: campaignService,
  }))

  // Standalone content planning reuses the app-web `/api/distribution/*` wire
  // contract but contains no provider integration. Hosted mounts its
  // provider-backed distribution routers later through mountExtraRoutes.
  if (usesOpenStandaloneRoutes(profile)) {
    app.use(
      '/api/distribution',
      requireAuth(env.JWT_SECRET),
      contentPlanningRoutes({ publishApproved: feedCloudPublisher }),
    )
  }

  app.use('/api/analytics', optionalAuth(env.JWT_SECRET), analyticsRoutes(analyticsStore))

  app.use('/api/feedback', optionalAuth(env.JWT_SECRET), feedbackRoutes())

  app.use(
    '/api/files',
    optionalAuth(env.JWT_SECRET),
    fileRoutes(fileStore, fileIngestor as never, artifactPromoter, undefined, chunkedFileUploads),
  )
  if (filesApi) {
    app.use(
      '/api/imports/linkedin',
      requireAuth(env.JWT_SECRET),
      linkedinImportRoutes({ filesApi }),
    )
  }
  if (filesApi && filesBlobClient) {
    app.use('/api/doc-files', requireAuth(env.JWT_SECRET), docFilesRoutes({
      filesApi,
      membership: getWorkspaceMembershipWithClearanceSystem,
      readProjection: getWorkspaceFileReadProjection,
    }))
  }
  // Custom Home app bundles + bridge KV. Mounted HERE, well before the bare
  // `app.use('/api', requireAuth(...))` guards further down: `/bundle/*` and
  // `/state` are reached by an opaque-origin iframe that carries no session,
  // so a bare guard registered earlier would 401 them before their own
  // capability check ran (the Mini-App sign-in outage, CLAUDE.md → route mount
  // order). Auth is applied per-route inside the router instead.
  // Custom Home app GitHub sync. Reuses the `syncCredentials` resolver the KB
  // poller already uses, so an app's PAT resolves through its connector
  // instance and revoking the connector revokes the sync — never a stored PAT.
  const homeAppSyncDeps: HomeAppSyncDeps | null = filesApi
    ? {
        api: {
          getBranchHead,
          getRepoTree: async (pat, owner, repo, sha) =>
            (await getRepoTree(pat, owner, repo, sha)) as Array<{
              path: string
              type: string
              size?: number
            }>,
          getFileText: async (pat, owner, repo, path, ref) => {
            const data = (await getFileContents(pat, owner, repo, path, ref)) as {
              content?: string
              encoding?: string
            }
            if (typeof data.content !== 'string') {
              throw new Error(`${path} is not a file`)
            }
            return Buffer.from(data.content, 'base64').toString('utf8')
          },
        },
        getPat: (workspaceId, connectorInstanceId) =>
          syncCredentials.getPat(workspaceId, connectorInstanceId),
        writeBundle: async (workspaceId, appId, files) => {
          await deleteBundle(filesApi, workspaceId, appId)
          for (const file of files) {
            await filesApi.write(
              { workspaceId, userId: '', system: true } as never,
              { path: bundleStoragePath(appId, file.path), content: file.content },
            )
          }
        },
      }
    : null

  if (filesApi) {
    app.use('/api/home-apps', homeAppRoutes({
      requireAuth: requireAuth(env.JWT_SECRET),
      filesApi,
      signingSecret: env.JWT_SECRET,
      applicationBinding: captureApplicationHomeBinding,
      apiOrigin: env.API_URL ?? '',
      // The frame lives in app-web, on a DIFFERENT origin from this API — so
      // the bundle CSP has to name it explicitly or the browser blocks it.
      // `AUTHED_APP_URL` first (the authenticated app is what frames a Home
      // app; `APP_URL` is the marketing origin), the same resolution the
      // agent-surface appOrigin uses above.
      appOrigin: env.AUTHED_APP_URL ?? env.APP_URL ?? '',
      ...(homeAppSyncDeps
        ? { syncNow: (row) => syncHomeAppFromGitHub(homeAppSyncDeps, row) }
        : {}),
    }))
  }
  let stopWatchCleanup: (() => Promise<void>) | undefined
  // Dedicated opaque device credentials must mount before the broad human /api guards.
  if (process.env.WATCH_RECORDING_ENABLED === 'true' && filesApi && filesResolver) {
    app.use('/api/watch/v1', watchRecordingRoutes({
      provisioningKey: env.JWT_SECRET,
      humanAuth: requireAuth(env.JWT_SECRET), authorize: authorizeWatchDestination,
      service: createWatchService({ pages: savedViewStore, files: filesApi,
        ...(voiceTranscription.enabled ? { transcribe: async (buffer: Buffer) => (await transcribeWatchAudio(
          { buffer, mime: 'audio/mp4' }, { apiKey: voiceTranscription.apiKey, backend: voiceTranscription.backend, model: voiceTranscription.model },
        )).text } : {}),
      }),
    }))
    stopWatchCleanup = startWatchCleanup()
  }
  // Shared by hosted and standalone: interaction answers are independent of
  // the batch recording worker and the currently streaming chat turn.
  const liveInteraction = filesBlobClient ? createLiveInteractionRuntime({
    provider, model: backgroundModel, tools: allTools, embedder: sharedEmbedder,
    savedViewStore, workspaceStore, knowledgeStore, usageStore,
    payloads: createLedgerPayloadStore(filesBlobClient),
    voiceTranscriptionEnabled: voiceTranscription.enabled,
    onError: () => console.error('[live-interaction] background operation failed'),
  }) : null
  if (liveInteraction) {
    app.use('/api/recordings/interaction', requireAuth(env.JWT_SECRET), recordingInteractionRoutes({ service: liveInteraction }))
    if (runWorkers) liveInteraction.start()
  }

  // Recovery is a shared OSS capability in both editions; hosted keeps its
  // processing overlay but uses the same authorized preparation operation.
  if (filesResolver && filesBlobClient) {
    app.use('/api/recordings', requireAuth(env.JWT_SECRET), recordingRecoveryRoutes())
  }

  if (usesOpenStandaloneRoutes(profile) && filesResolver && filesBlobClient) {
    app.use('/api/recordings', requireAuth(env.JWT_SECRET), openRecordingsRoutes({
      filesResolver,
      chunkedFileUploads,
      getRole: (userId, workspaceId) => workspaceStore.getRole(userId, workspaceId),
      enqueueJob: enqueueRecordingJob,
      hasProcessed: hasCompletedRecordingJob,
      resolvePageWorkspace: async (userId, pageId) =>
        (await savedViewStore.getById(userId, pageId))?.workspaceId ?? null,
    }))
    app.use('/api/recordings', requireAuth(env.JWT_SECRET), recordingLiveRoutes({
      getRole: (userId, workspaceId) => workspaceStore.getRole(userId, workspaceId),
      savedViewStore,
      docGateway,
      docPageStore,
      provider,
      backgroundModel,
      voiceTranscription,
      usageStore,
      autoTitleNotes: async ({ userId, workspaceId, pageId, assistantId }) => {
        const view = await savedViewStore.getById(userId, pageId)
        if (!view || view.workspaceId !== workspaceId || view.nameOrigin !== 'placeholder') return
        const runtime = await resolveBackgroundRuntime(workspaceId)
        const timezone = (await query<{ timezone: string }>('SELECT timezone FROM users WHERE id=$1', [userId])).rows[0]?.timezone ?? 'UTC'
        const result = await runDocAutoTitle({
          userId, pageId, provider: runtime?.provider ?? provider,
          backgroundModel: runtime?.selector ?? backgroundModel,
          docPageStore, savedViewStore, minChars: 80,
          formatTitle: topic => datedRecordingTitle(view.createdAt, timezone, topic),
        })
        if (result.applied) notifyWorkspaceChange(workspaceId, 'file', 'update')
        if (result.usage && usageStore) await usageStore.recordUsage({
          userId, assistantId, workspaceId, sessionId: null, model: result.model ?? backgroundModel,
          modelTier: 'standard', ...result.usage, source: 'overhead:title',
          actualCostUsd: runtime?.providerKeySource === 'user' ? 0 : calculateCost(result.model ?? backgroundModel, result.usage),
          providerKeySource: runtime?.providerKeySource ?? 'platform',
        })
      },
      // Window-audio persistence + the assembled-windows finalize fallback.
      filesResolver,
      filesApi,
      liveInteraction: liveInteraction ?? undefined,
    }))
  }

  if (filesBlobClient && filesResolver) {
    app.use('/api/account/avatar', accountAvatarPublicRoutes({
      blobClient: filesBlobClient,
      filesResolver,
    }))
    app.use('/api/workspace-icons', workspaceIconPublicRoutes({
      blobClient: filesBlobClient,
      filesResolver,
    }))
  }
  app.use('/api/account', requireAuth(env.JWT_SECRET), accountRoutes({
    linkedAccountStore,
    linkCodeStore,
    wechatIdentityStore: channelIdentityStore ?? undefined,
    getTelegramBotUsername,
    getWhatsappOfficialNumber: ports.getWhatsappOfficialNumber,
    teardownRules: ports.accountTeardownRules,
    blobClient: filesBlobClient ?? undefined,
    filesResolver: filesResolver ?? undefined,
    workspaceMembership: getWorkspaceMembershipWithClearanceSystem,
    publicApiUrl: env.API_URL,
  }))

  // Built-in connector lifecycle (list / store-credentials / disconnect /
  // rename / delete). Both standalone profiles own this open route; hosted
  // mounts its richer closed `/api/connectors` route instead, so mounting this
  // one there would shadow it. See routes/connectors.ts.
  if (usesOpenStandaloneRoutes(profile)) {
    app.use('/api/connectors', requireAuth(env.JWT_SECRET), connectorRoutes({
      setupService: credKey ? createTransactionalConnectorSetup({
        pool: getPool(), encryptionKey: credKey, adapters: connectorSetupProviders(),
      }) : undefined,
      shopifySetupRedirectUri: new URL('/api/auth/callback/shopify', env.AUTHED_APP_URL ?? env.APP_URL).toString(),
      connectorStore,
      connectorInstanceStore,
      connectorGrantStore,
      mcpSettingsStore,
      gcsByo: {
        requireWorkspaceAdmin: async (userId, workspaceId) => {
          const m = await getWorkspaceMembershipWithClearanceSystem(userId, workspaceId)
          return m?.role === 'owner' || m?.role === 'admin'
        },
      },
      s3Byo: {
        requireWorkspaceAdmin: async (userId, workspaceId) => {
          const m = await getWorkspaceMembershipWithClearanceSystem(userId, workspaceId)
          return m?.role === 'owner' || m?.role === 'admin'
        },
      },
      localStorage: {
        requireWorkspaceAdmin: async (userId, workspaceId) => {
          const m = await getWorkspaceMembershipWithClearanceSystem(userId, workspaceId)
          return m?.role === 'owner' || m?.role === 'admin'
        },
      },
      connectorAppCredentialStore,
      ...(filesApi ? { filesApi } : {}),
    }))
  }

  return { supportDiagnosticsManager, homeAppSyncDeps, stopWatchCleanup, liveInteraction } as const
}
