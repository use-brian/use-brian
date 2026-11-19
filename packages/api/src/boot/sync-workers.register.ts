/**
 * Reapers, knowledge/home-app/mailbox sync, external sinks and sweepers.
 *
 * Boot register module registerSyncWorkers: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`SyncWorkersScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { sanitize as sanitizeAnalytics } from '@use-brian/core/analytics/logger.js'
import { createIngestWorkflowTrigger } from '@use-brian/core/ingest/workflow-trigger.js'
import { createKnowledgeSyncWorker } from '@use-brian/core/knowledge/sync-worker.js'
import { startJitteredInterval } from '@use-brian/core/scheduling/jitter.js'
import { usesOpenStandaloneRoutes } from '../edition.js'
import { createMailboxSyncWorker } from '../mailbox/sync-worker.js'
import { setGlobalMailboxArchiveDeps } from '../mailbox/archive-search-tool.js'
import { setGlobalMailboxSyncDeps } from '../mailbox/sync-tool.js'
import { createMailboxIdleWatcher } from '../mailbox/idle-watcher.js'
import { resolveIngestPlaceholders } from '../ingest/placeholder-resolver.js'
import { createHomeAppSyncWorker } from '../home-apps/sync.js'
import { listHomeApps as listHomeAppRows } from '../db/home-apps-store.js'
import {
  getBranchHead, getRepoTree, getFileContents, compareCommits, getRepoPermissions,
} from '../github/client.js'
import { publishSessionEvent } from '../session-event-bus.js'
import { createIngestSinkStore } from '../db/ingest-sink-store.js'
import { createIngestOutboxStore } from '../db/ingest-outbox-store.js'
import { createExternalSinkFanout } from '../ingest/external-sink-fanout.js'
import { setGlobalLiveChatArchiveWriter, createLiveChatArchiveWriter } from '../chat-archive/live-writer.js'
import { requireAuth } from '../auth/middleware.js'
import { createTaskAdmissionPort } from '../db/task-admission-store.js'
import { INITIAL_GOAL_LOOP_STATE } from '../goals/driver.js'
import { getGoalByIdSystem } from '../db/goals.js'
import { sweepExpiredApprovals, sweepExpiredQuestions } from '../workflow/approval.js'
import { sweepStaleWorkerRuns } from '../workers/worker-runs-cleanup.js'
import { query } from '../db/client.js'
import { lazyRoutes, lazyWorker } from './lazy.js'
import type { SyncWorkersScope } from './scope.js'

// Router modules that load on their mount's first request (deployment.md ->
// "Boot composition" -> "Lazy routers and workers"); the mounts below are unchanged.
const ingestRoutes = lazyRoutes(() => import('../routes/ingest.js'), 'ingestRoutes')

// Worker modules that load when the worker starts (deployment.md -> "Boot
// composition" -> "Lazy routers and workers"); `--no-workers` never loads them.
const createExternalSinkRelay = lazyWorker(() => import('../ingest/external-sink-relay.js'), 'createExternalSinkRelay', '[external-sink-relay]')
const createGoalStallReaper = lazyWorker(() => import('../goals/reaper.js'), 'createGoalStallReaper', '[goal-reaper]')
const createStuckSessionSweeper = lazyWorker(() => import('../scheduling/stuck-session-sweeper.js'), 'createStuckSessionSweeper', '[stuck-session-sweeper]')
const createViewsPruneWorker = lazyWorker(() => import('../scheduling/views-prune-worker.js'), 'createViewsPruneWorker', '[views-prune-worker]')

export async function registerSyncWorkers(scope: SyncWorkersScope) {
  const {
    ports, env, app, provider, analytics, crmStore, resolvePrimaryAssistantForWorkspace, entityLinksStore,
    entitiesStore, sharedEmbedder, extractionModel, usageStore, credKey, connectorInstanceStore, profile,
    connectorGrantStore, episodesStore, workspaceStore, savedViewStore, knowledgeStore, syncCredentials,
    ingestApplicationService, jobStore, fileStore, memoryStore, taskStore, resolveWorkspaceExtractionLlm,
    runWorkers, pendingApprovalsStore, workerRunsStore, approvalBridgeDeps, scheduleGoalTick,
    chunkedFileUploads, sessionResumeStore, homeAppSyncDeps, workflowEventDispatcher, ingestRulesStore, late,
  } = scope
  // ── file_cache reaper ──
  // Cached files are read with an `expires_at > now()` filter, so a lapsed row
  // is already invisible; this jittered 6h sweep reclaims its storage. Gated on
  // `runWorkers` and wrapped so a failing tick never crashes boot. Stopped in
  // `shutdown()` like the workers above.
  const fileCacheReaper = runWorkers
    ? startJitteredInterval(() => {
        void Promise.resolve(fileStore.sweepExpired?.())
          .then((n) => { if (n && n > 0) console.log(`[file-cache-reaper] deleted ${n} expired file(s)`) })
          .catch((err) => console.error('[file-cache-reaper] sweep failed:', err))
      }, 6 * 60 * 60 * 1000)
    : null

  // ── chunked workspace-file upload reaper ──
  // Expired sessions are no longer completable. Reclaim their direct-upload
  // parts, plus any completed-session parts whose immediate cleanup retried.
  const chunkedUploadReaper = runWorkers && chunkedFileUploads
    ? startJitteredInterval(() => {
        void chunkedFileUploads!.sweepExpired()
          .then((n) => { if (n > 0) console.log(`[chunked-upload-reaper] cleaned ${n} upload(s)`) })
          .catch((err) => console.error('[chunked-upload-reaper] sweep failed:', err))
      }, 60 * 60 * 1000)
    : null

  // ── Knowledge sync worker ──
  // Uses the `syncCredentials` resolver built once above (platform closed
  // factory, or the open resolver over the connector stores).
  const knowledgeSyncWorker = createKnowledgeSyncWorker({
    store: knowledgeStore as never,
    api: {
      getBranchHead,
      getRepoTree,
      getFileContents: async (pat, owner, repo, path, ref) => {
        const data = await getFileContents(pat, owner, repo, path, ref)
        return data as { content?: string }
      },
      compareCommits,
      getRepoPermissions,
    },
    credentials: syncCredentials,
    intervalMs: 15 * 60 * 1000,
    onEvent: (event) => {
      console.log(`[knowledge-sync] ${event.type}: ${event.repo}`, event)
    },
  })
  late.syncWorkerRef = knowledgeSyncWorker
  if (runWorkers) knowledgeSyncWorker.start()

  // ── Custom Home app sync worker ──
  // Same 15-min cadence and the same credential resolver as the KB poller. The
  // due-list is every github-kind app that is not disabled; the per-app HEAD
  // early return keeps a quiet tick cheap.
  if (homeAppSyncDeps) {
    const homeAppSyncWorker = createHomeAppSyncWorker({
      deps: homeAppSyncDeps,
      getAppsDue: async () => {
        const workspaces = await query<{ id: string }>(`SELECT id FROM workspaces`)
        const due = []
        for (const ws of workspaces.rows) {
          for (const row of await listHomeAppRows(ws.id)) {
            if (row.kind === 'github' && row.status !== 'disabled') due.push(row)
          }
        }
        return due
      },
      onEvent: ({ repo, outcome }) => {
        if (outcome.status === 'failed') {
          console.warn(`[home-app-sync] ${repo}: ${outcome.error}`)
        }
      },
    })
    if (runWorkers) homeAppSyncWorker.start()
  }

  // ── Mailbox sync worker (imap connector — mailbox-imap.md §Phase 2) ──
  // Archive is unconditional per connected instance; brain routing rides the
  // instance's `ingestion_enabled` toggle + seeded imap rules. The archive
  // search tool's late-bound seam is armed here (embedder optional — the
  // vector arm soft-fails to ILIKE until embeddings are configured).
  setGlobalMailboxArchiveDeps({ ...(sharedEmbedder ? { embedder: sharedEmbedder } : {}) })
  const mailboxSyncWorker = createMailboxSyncWorker({
    connectorInstanceStore,
    resolveDefaultWorkspaceId: async (userId) => {
      // A default is only an ingestion target while the account still owns it.
      const r = await query<{ id: string }>(
        `SELECT id FROM workspaces
          WHERE owner_user_id = $1 AND id = (SELECT default_workspace_id FROM users WHERE id = $1)
          ORDER BY created_at LIMIT 1`,
        [userId],
      )
      return r.rows[0]?.id ?? null
    },
    resolveAssistantId: resolvePrimaryAssistantForWorkspace,
    brain: {
      provider,
      model: extractionModel,
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
      resolvePlaceholders: resolveIngestPlaceholders,
      analytics,
      usageStore,
      ingestCharge: ports.ingestCharge,
      scheduledBatching: ports.mailboxScheduledBatching,
    },
    // Workflow event port - the SAME shared dispatcher every connector poller
    // feeds (`createIngestWorkflowTrigger`), so an `event` workflow subscribed
    // to an imap instance fires on rule-matched new mail once ingestion is on
    // (mailbox-imap.md → "Event trigger"). Before this wire an imap event
    // subscription saved fine and never fired.
    onEvent: createIngestWorkflowTrigger(workflowEventDispatcher),
  })
  if (runWorkers) mailboxSyncWorker.start()
  // IDLE watcher (mailbox-imap.md → "IDLE watcher"): one dedicated IMAP
  // connection per connected mailbox that turns the server's `exists` push
  // into `syncInstanceById` within seconds - a wake-up for the SAME sync the
  // tick runs, never a second ingest path (D6). Runs where the sync worker
  // runs (workers service hosted; the one process on OSS).
  const mailboxIdleWatcher = createMailboxIdleWatcher({
    connectorInstanceStore,
    syncInstanceById: (id) => mailboxSyncWorker.syncInstanceById(id),
  })
  if (runWorkers) mailboxIdleWatcher.start()
  // Arm the on-demand sync seam in EVERY process (not just the workers
  // service): the connect route's sync-on-connect and the `syncMailboxNow`
  // tool both run in the API process, and single-instance sync needs no
  // running poll timer. See mailbox-imap.md §Phase 2 → "On-demand sync".
  // `watchInstance` is armed only where the watcher runs; elsewhere the
  // watcher's reconcile pass picks a freshly connected mailbox up itself.
  setGlobalMailboxSyncDeps({
    syncInstanceById: (id) => mailboxSyncWorker.syncInstanceById(id),
    ...(runWorkers ? { watchInstance: (id) => mailboxIdleWatcher.watchInstance(id) } : {}),
  })

  // ── External-sink relay (ingest outbox → ub.ingest.append.v1) ──
  // Drains ingest_outbox to each attached external sink; the sink cursor
  // advances only on ack (X3). See ingest-external-sink.md.
  const ingestSinkStore = createIngestSinkStore(credKey)
  const ingestOutboxStore = createIngestOutboxStore()
  const externalSinkFanout = createExternalSinkFanout({
    sinks: ingestSinkStore,
    outbox: ingestOutboxStore,
  })
  if (
    env.BRIAN_MESSAGE_STORE_URL
    && env.BRIAN_MESSAGE_STORE_HMAC_SECRET
    && credKey
  ) {
    setGlobalLiveChatArchiveWriter(createLiveChatArchiveWriter({
      endpointUrl: env.BRIAN_MESSAGE_STORE_URL,
      secret: env.BRIAN_MESSAGE_STORE_HMAC_SECRET,
      sinks: ingestSinkStore,
      fanout: externalSinkFanout,
    }))
  } else {
    setGlobalLiveChatArchiveWriter(null)
    const disabled = await ingestSinkStore.disableManagedLocalChatArchive()
    if (disabled > 0) {
      console.log(`[chat-archive] disabled ${disabled} stale managed sink(s)`)
    }
    if (env.BRIAN_MESSAGE_STORE_URL || env.BRIAN_MESSAGE_STORE_HMAC_SECRET) {
      console.warn(
        '[chat-archive] disabled: URL, HMAC secret, and CHANNEL_CREDENTIAL_KEY are all required',
      )
    }
  }
  const externalSinkRelay = createExternalSinkRelay({
    outbox: ingestOutboxStore,
    sinks: ingestSinkStore,
    analytics,
  })
  if (runWorkers) externalSinkRelay.start()

  // Hosted keeps its platform route; both standalone profiles mount the open
  // implementation against this composition root's shared store instances.
  if (usesOpenStandaloneRoutes(profile)) {
    app.use('/api/ingest', requireAuth(env.JWT_SECRET), ingestRoutes({
      connectorInstanceStore,
      ingestRulesStore,
      workspaceStore,
      connectorGrantStore,
      ingestSinkStore,
      application: ingestApplicationService,
    }))
  }

  // ── Stuck-session sweeper ──
  const stuckSessionSweeper = createStuckSessionSweeper({
    publishDraftTurnCompleted: (sessionId,outcome) =>
      publishSessionEvent({ kind: 'turn_completed', sessionId, payload: { senderUserId: null,turnId:outcome.turnId,reason:outcome.reason } }),
  })
  if (runWorkers) stuckSessionSweeper.start()

  // ── Goal stall reaper ──
  // The acting loop's external watchdog: recovers goals wedged `running` by a
  // crash mid-tick and confirmed acting goals whose re-arm chain died. See
  // goals.md → "Stall recovery — the goal reaper".
  const goalStallReaper = createGoalStallReaper({
    rearm: async (goalId) => {
      const goal = await getGoalByIdSystem(goalId)
      if (goal) await scheduleGoalTick(goal, new Date(), INITIAL_GOAL_LOOP_STATE)
    },
    onRecovered: ({ id, sweep }) => {
      void getGoalByIdSystem(id).then((goal) => {
        if (!goal?.createdByUserId) return
        analytics.logEvent({
          userId: goal.createdByUserId,
          channelType: 'workflow',
          eventName: 'goal_stall_recovered',
          metadata: { goal_id: sanitizeAnalytics(id), sweep: sanitizeAnalytics(sweep) },
        })
      }).catch(() => {})
    },
  })
  if (runWorkers) goalStallReaper.start()

  // ── Views auto-prune worker ──
  const viewsPruneWorker = createViewsPruneWorker({ savedViewStore })
  if (runWorkers) viewsPruneWorker.start()
  const conversationRecordConversionWorker = runWorkers
    ? await import('../workers/conversation-record-conversion.js').then(module => module.startConversationRecordConversionWorker())
    : null

  // The hosted composition starts anonymous shadow-user pruning from
  // mountExtraRoutes; the open store itself is exposed on BootContext.

  // ── Hourly approval / question / worker-run sweeps ──
  if (runWorkers) {
    startJitteredInterval(() => {
      sweepExpiredApprovals(approvalBridgeDeps)
        .then((n) => { if (n > 0) console.log(`[approvals] expired ${n} pending approvals`) })
        .catch((err) => console.error('[approvals] sweep failed:', err))
    }, 60 * 60 * 1000)
    startJitteredInterval(() => {
      sweepExpiredQuestions({ approvalsStore: pendingApprovalsStore, jobStore, sessionResumeStore })
        .then((n) => { if (n > 0) console.log(`[approvals] expired ${n} pending questions`) })
        .catch((err) => console.error('[approvals] question sweep failed:', err))
    }, 15 * 60 * 1000)
    startJitteredInterval(() => {
      sweepStaleWorkerRuns(workerRunsStore)
        .then((n) => { if (n > 0) console.log(`[worker-runs] cleaned up ${n} stale rows`) })
        .catch((err) => console.error('[worker-runs] cleanup sweep failed:', err))
    }, 24 * 60 * 60 * 1000)
  }

  return {
    knowledgeSyncWorker, mailboxSyncWorker, mailboxIdleWatcher, externalSinkRelay, stuckSessionSweeper, conversationRecordConversionWorker,
    fileCacheReaper, chunkedUploadReaper,
  } as const
}
