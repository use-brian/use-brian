/**
 * HTTP server start and ordered worker shutdown.
 *
 * Boot register module registerLifecycle: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`LifecycleScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { stopJitteredInterval } from '@use-brian/core/scheduling/jitter.js'
import type http from 'node:http'
import type { LifecycleScope } from './scope.js'

export function registerLifecycle(scope: LifecycleScope) {
  const {
    app, analytics, codexProviderManager, campaignDispatchService, allTools, programmaticBatchWorker,
    chatArchiveEnrichmentWorker, structuredDocumentRuntime, officeLifecycleWorker, workspaceMcpProfile,
    supportDiagnosticsManager, stopWatchCleanup, liveInteraction, officeSearchProjector, runQueueWorker,
    crmDomainEventWorker, campaignConversionWorker, crmRetentionWorker, crmIssueWorker, crmEntitlementWorker,
    crmFileCleanupWorker, pollWorker, sessionTitleWorker, sessionStateWorker, organizationUpgradeWorker,
    consolidationWorker, skillReviewWorker, playbookReflectionWorker, feedEditorialWorker,
    decisionReflectionWorker, researchReflectionWorker, embeddingWorker, fileIngestWorker,
    gdriveEnrichmentWorker, gdriveCatalogWorker, linkedinImportWorker, recordingProcessWorker,
    recordingAutoTitleWorker, knowledgeSyncWorker, mailboxSyncWorker, mailboxIdleWatcher, externalSinkRelay,
    stuckSessionSweeper, port, fileCacheReaper, chunkedUploadReaper,
    conversationRecordConversionWorker,
  } = scope
  // ════════════════════════════════════════════════════════════════
  // start / shutdown
  // ════════════════════════════════════════════════════════════════
  let server: http.Server | undefined

  async function start(): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve) => {
      server = app.listen(port, () => {
        console.log(`Use Brian api running on port ${port}`)
        console.log(`Tools loaded: ${allTools.size}`)
        resolve({ server: server!, port })
      })
    })
  }

  async function shutdown(): Promise<void> {
    await organizationUpgradeWorker.stop()
    await conversationRecordConversionWorker?.stop()
    await officeSearchProjector.stop()
    await stopWatchCleanup?.() // Watch boot lifecycle: stop and drain retention work.
    console.log('Shutting down — flushing analytics...')
    await sessionTitleWorker.stop()
    await workspaceMcpProfile.runWorker?.stop()
    await sessionStateWorker.stop()
    consolidationWorker.stop()
    skillReviewWorker.stop()
    playbookReflectionWorker.stop()
    decisionReflectionWorker.stop()
    researchReflectionWorker.stop()
    feedEditorialWorker.stop()
    embeddingWorker.stop()
    pollWorker.stop()
    programmaticBatchWorker?.stop()
    runQueueWorker.stop()
    crmDomainEventWorker.stop()
    campaignConversionWorker.stop()
    campaignDispatchService.stop()
    crmRetentionWorker.stop()
    crmIssueWorker.stop()
    crmEntitlementWorker.stop()
    crmFileCleanupWorker?.stop()
    knowledgeSyncWorker.stop()
    mailboxSyncWorker.stop()
    // Log out every IDLE socket - a SIGTERM must not leave a mailbox connection
    // dangling until the server's own timeout notices.
    await mailboxIdleWatcher.stop().catch(() => {})
    externalSinkRelay.stop()
    chatArchiveEnrichmentWorker?.stop()
    stuckSessionSweeper.stop()
    await fileIngestWorker?.stop()
    structuredDocumentRuntime?.stop()
    gdriveEnrichmentWorker?.stop()
    gdriveCatalogWorker?.stop()
    linkedinImportWorker?.stop()
    recordingProcessWorker?.stop()
    await recordingAutoTitleWorker.stop()
    await liveInteraction?.stop()
    officeLifecycleWorker.stop()
    await codexProviderManager?.close()
    if (fileCacheReaper) stopJitteredInterval(fileCacheReaper)
    if (chunkedUploadReaper) stopJitteredInterval(chunkedUploadReaper)
    await supportDiagnosticsManager?.stop()
    await analytics.shutdown()
    if (server) await new Promise<void>((res) => server!.close(() => res()))
  }

  return { start, shutdown } as const
}
