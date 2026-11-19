/**
 * Memory/brain evolution, embedding, file-ingest, Drive and LinkedIn workers.
 *
 * Boot register module registerMemoryWorkers: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`MemoryWorkersScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import {
  createEmbeddingWorker,
  createEmbeddingUsageRecorder,
} from '@use-brian/core/embeddings/worker.js'
import { distillFileToText } from '@use-brian/core/files/distill.js'
import {
  createCommitmentLifecycleWorker,
} from '@use-brian/core/memory/commitment-lifecycle-worker.js'
import { createCompositeCommitmentResolver } from '@use-brian/core/memory/commitment-resolvers.js'
import { createSprintVarianceResolver } from '@use-brian/core/memory/sprint-variance-resolver.js'
import { getTaskByIdSystem } from '../db/tasks.js'
import { createFileIngestWorker } from '../files/file-ingest-worker.js'
import {
  claimNextFileIngestJob, markFileIngestJobDone, markFileIngestJobFailed,
} from '../db/file-ingest-jobs-store.js'
import { createDbEmbeddingStore } from '../db/embedding-store.js'
import { lazyWorker } from './lazy.js'
import type { MemoryWorkersScope } from './scope.js'

// Worker modules that load when the worker starts (deployment.md -> "Boot
// composition" -> "Lazy routers and workers"); `--no-workers` never loads them.
const createGDriveEnrichmentWorker = lazyWorker(() => import('../google/enrichment-worker.js'), 'createGDriveEnrichmentWorker', '[gdrive-enrichment-worker]')
const createGDriveCatalogWorker = lazyWorker(() => import('../google/catalog-worker.js'), 'createGDriveCatalogWorker', '[gdrive-catalog-worker]')
const createLinkedInImportWorker = lazyWorker(() => import('../linkedin-import/worker.js'), 'createLinkedInImportWorker', '[linkedin-import]')

export async function registerMemoryWorkers(scope: MemoryWorkersScope) {
  const {
    sharedEmbedder, selectMediaBackend, usageStore, connectorInstanceStore, memoryStore,
    brainEpisodeIngestor, runWorkers, filesApi, ports,
  } = scope
  // ── Commitment-memory lifecycle worker ──
  const commitmentLifecycleWorker = createCommitmentLifecycleWorker({
    store: memoryStore,
    resolver: createCompositeCommitmentResolver({
      resolvers: {
        sprint_variance: createSprintVarianceResolver({
          lookup: async (taskId) => {
            const task = await getTaskByIdSystem(taskId)
            return task ? { status: task.status, due: task.due } : null
          },
        }),
      },
    }),
  })
  if (runWorkers) commitmentLifecycleWorker.start()

  // ── Workspace-level prompt evolution worker ──
  const { createMemoryEvolutionWorker } = await import('../workers/memory-evolution-worker.js')
  const memoryEvolutionWorker = createMemoryEvolutionWorker({
    onEvent: (event) => {
      if (event.type === 'workspace_processed' && event.snippetEmitted) {
        console.log(`[memory-evolution] emitted snippet for workspace ${event.workspaceId} (${event.totalVerifications} verifications over ${event.totalSaves} model saves)`)
      } else if (event.type === 'error') {
        console.error(`[memory-evolution] error for workspace ${event.workspaceId ?? '<global>'}: ${event.error}`)
      } else if (event.type === 'tick_complete') {
        console.log(`[memory-evolution] tick complete: processed=${event.processedCount} emitted=${event.emittedCount} skipped=${event.skippedCount} errors=${event.errorCount}`)
      }
    },
  })
  if (runWorkers) memoryEvolutionWorker.start()

  // ── Brain-evolution worker ──
  const { createBrainEvolutionWorker } = await import('../workers/brain-evolution-worker.js')
  const brainEvolutionWorker = createBrainEvolutionWorker({
    onEvent: (event) => {
      if (event.type === 'workspace_processed' && event.snippetEmitted) {
        console.log(`[brain-evolution] emitted snippet for workspace ${event.workspaceId} (primitives above threshold: ${event.primitivesAboveThreshold.join(', ')})`)
      } else if (event.type === 'error') {
        console.error(`[brain-evolution] error for workspace ${event.workspaceId ?? '<global>'}: ${event.error}`)
      } else if (event.type === 'tick_start') {
        console.log(`[brain-evolution] tick start: scanning ${event.workspaceCount} workspaces`)
      }
    },
  })
  if (runWorkers) brainEvolutionWorker.start()

  // ── Embedding worker ──
  // primitivesWithVectorColumn is closed (api-platform/admin). Open uses the
  // default primitive set from the embedding store. `usage` records each
  // committed batch as `overhead:embedding` COGS (workspace-fallback
  // attribution). Normal standalone records to its local ledger; a bespoke
  // composition with no usageStore remains unmetered.
  const embeddingWorker = createEmbeddingWorker({
    store: createDbEmbeddingStore(ports.backgroundInferencePolicy?.excludedWorkspaceIdsSql),
    embedder: sharedEmbedder,
    ...(usageStore ? { usage: createEmbeddingUsageRecorder(usageStore, sharedEmbedder.model_id) } : {}),
  })
  if (runWorkers) embeddingWorker.start()

  // ── File-ingest worker (large-content-artifacts §Phase 2.2) ──
  // Drains file_ingest_jobs: readBytes → parse → chunk (idempotent) →
  // Pipeline B (when the platform passed an episode-ingestor port; OSS
  // without one runs store-only) → stamp source_episode_id + indexing status.
  // Same single-service model as every worker: runs only where runWorkers is
  // set (prod: brian-api-workers).
  const fileIngestWorker = filesApi
    ? createFileIngestWorker({
        claim: claimNextFileIngestJob,
        markDone: markFileIngestJobDone,
        markFailed: markFileIngestJobFailed,
        filesApi,
        // Spent only on `mode: 'explicit'` jobs — the queue now carries the
        // explicit POST /ingest path, which distilled PDFs/images back when it
        // ran inline. Silent promotion stays store-only (worker gates on mode).
        distill: async ({ buffer, mime }) =>
          (await distillFileToText({ buffer, mime }, { backend: selectMediaBackend(mime) })).text,
        ...(brainEpisodeIngestor ? { brainIngest: brainEpisodeIngestor } : {}),
      })
    : null
  if (runWorkers && fileIngestWorker) fileIngestWorker.start()

  // ── Progressive Google Drive enrichment worker ───────────────
  // A full-Drive content read inserts one version-idempotent row. The worker
  // re-opens that exact OAuth instance, materializes/indexes a workspace-file
  // derivative, and runs Pipeline B only for native lazy jobs. Offline bundle
  // rows are already enriched and deliberately bypass the model.
  const gdriveEnrichmentWorker = filesApi
    ? createGDriveEnrichmentWorker({
        filesApi,
        connectorInstanceStore,
        distill: async ({ buffer, mime }) =>
          (await distillFileToText({ buffer, mime }, { backend: selectMediaBackend(mime) })).text,
        ...(brainEpisodeIngestor ? { brainIngest: brainEpisodeIngestor } : {}),
      })
    : null
  if (runWorkers && gdriveEnrichmentWorker) gdriveEnrichmentWorker.start()

  // Metadata discovery is deliberately separate from deep enrichment. It
  // writes small Drive descriptors whose normal workspace-file embeddings
  // make names and folder paths searchable, without downloading content.
  const gdriveCatalogWorker = filesApi
    ? createGDriveCatalogWorker({ filesApi, connectorInstanceStore })
    : null
  if (runWorkers && gdriveCatalogWorker) gdriveCatalogWorker.start()

  // ── Lossless LinkedIn archive worker ──
  // Own deterministic queue: exact ZIP/member/row ledger first, conservative
  // identity + referral graph projection second. No Pipeline-B/model caps.
  const linkedinImportWorker = filesApi
    ? createLinkedInImportWorker({ filesApi })
    : null
  if (runWorkers && linkedinImportWorker) linkedinImportWorker.start()

  return {
    embeddingWorker, fileIngestWorker, gdriveEnrichmentWorker, gdriveCatalogWorker, linkedinImportWorker,
  } as const
}
