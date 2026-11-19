/**
 * Episode ingestors, engineering history, programmatic capture, synthesis and introspection tools.
 *
 * Boot register module registerCapture: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`CaptureScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { calculateCost } from '@use-brian/agent-runtime/billing/cost-tracker.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import { createIntrospectionTools } from '@use-brian/core/introspection/tools.js'
import { createBatchWorker } from '@use-brian/core/scheduling/poll-worker.js'
import type { createEngineeringArchivePublisher } from '../engineering-history/publisher.js'
import type { createEngineeringHistoryService } from '../engineering-history/service.js'
import { createCaptureConfigurationReader } from '../engineering-history/configuration.js'
import { createProgrammaticEpisodeTerminal } from '../ingest/programmatic-terminal.js'
import { registryRow } from '@use-brian/shared/model-registry'
import { EXTRACTION_MODEL } from '../build-episode-ingestors.js'
import { createTaskAdmissionPort } from '../db/task-admission-store.js'
import type { createFilesApi, FilesClientResolver } from '../files/files-api.js'
import type { ChunkedFileUploadService } from '../files/chunked-upload.js'
import { createResearchSynthesizer } from '../synthesis/research-synthesizer.js'
import { type GenerateSynthesizeFn, createGenerateSynthesizer } from '../synthesis/generate-synthesizer.js'
import { createGenerateBlueprintTool } from '../synthesis/generate-blueprint-tool.js'
import {
  createBlueprintRecordTools, buildBlueprintSurfacePrompt,
} from '../synthesis/blueprint-record-tools.js'
import { createDbDocPageStore } from '../db/doc-page-store.js'
import { createDbProgrammaticBatchStore } from '../db/pending-ingest-batches-store.js'
import {
  createProgrammaticCaptureRouter, createProgrammaticBatchProcessor,
} from '../ingest/programmatic-capture.js'
import type { ChatEpisodeInput, ChatEpisodeIngestor, BrainEpisodeIngestor } from '../ingest-port.js'
import { lazyWorker } from './lazy.js'
import type { CaptureScope } from './scope.js'

// Worker modules that load when the worker starts (deployment.md -> "Boot
// composition" -> "Lazy routers and workers"); `--no-workers` never loads them.
const createChatArchiveEnrichmentWorker = lazyWorker(() => import('../chat-archive/enrichment-worker.js'), 'createChatArchiveEnrichmentWorker', '[chat-archive]')

export async function registerCapture(scope: CaptureScope) {
  const {
    ports, messageStoreClient, provider, analytics, crmStore, resolvePrimaryAssistantForWorkspace,
    entityLinksStore, entitiesStore, sharedEmbedder, extractionModel, usageStore, decisionRuntime,
    episodesStore, savedViewStore, ingestApplicationService, backgroundModel, jobStore,
    resolveBackgroundRuntime, memoryStore, taskStore, programmaticCaptureStore, runWorkers, synthesisModel,
    workflowRunStore, workspaceDirectoryStore, pageTemplateStore, blueprintRecordStore,
    pendingApprovalsStore, workerRunsStore, late,
  } = scope
  const extractionRow = registryRow(EXTRACTION_MODEL)
  const resolveWorkspaceExtractionLlm = async (
    workspaceId: string,
  ): Promise<NonNullable<ChatEpisodeInput['llm']> & { inputTokenLimit: number; maxTokens: number }> => {
    const runtime = await resolveBackgroundRuntime(workspaceId)
    return runtime
      ? {
          provider: runtime.provider,
          model: runtime.selector,
          modelTier: 'standard',
          providerKeySource: 'user',
          inputTokenLimit: runtime.inputTokenLimit,
          maxTokens: runtime.maxTokens,
        }
      : {
          provider,
          // Keep this logical so routing reapplies the current application
          // preference for every Pipeline B operation.
          model: EXTRACTION_MODEL,
          modelTier: 'standard',
          providerKeySource: 'platform',
          inputTokenLimit: extractionRow?.contextWindow ?? 1_000_000,
          maxTokens: extractionRow?.maxOutput ?? 65_536,
        }
  }

  // ── Episode ingestors — built by the platform factory over boot's stores
  //    (open default: no-op chat ingest, undefined brain ingest). ──
  const builtIngestors = ports.buildEpisodeIngestors?.({
    provider, crmStore, entitiesStore, entityLinksStore, memoryStore, taskStore, episodesStore, analytics,
    decisionRuntime,
    resolveWorkspaceLlm: resolveWorkspaceExtractionLlm,
    usageStore,
    backgroundModel,
    extractionModel,
    ingestCharge: ports.ingestCharge,
    application: ingestApplicationService,
    taskAdmission: createTaskAdmissionPort(),
  })
  const chatEpisodeIngestor: ChatEpisodeIngestor =
    builtIngestors?.chatEpisodeIngestor ?? (async () => {})
  const brainEpisodeIngestor: BrainEpisodeIngestor | undefined = builtIngestors?.brainEpisodeIngestor
  late.engineeringArchive = null
  late.engineeringHistory = null
  const captureConfiguration=createCaptureConfigurationReader(programmaticCaptureStore,()=>late.engineeringArchive!==null)
  const programmaticCapture = createProgrammaticCaptureRouter({
        store: programmaticCaptureStore,
        ingest: brainEpisodeIngestor??(async()=>{throw new Error('capture_extraction_unavailable')}),
        archive:(...args)=>{if(!late.engineeringArchive)throw new Error('capture_archive_unavailable');return late.engineeringArchive.capture(...args)},
      })
  const programmaticBatchWorker = brainEpisodeIngestor
    ? createBatchWorker({
        store: createDbProgrammaticBatchStore(),
        processBatch: createProgrammaticBatchProcessor({
          store: programmaticCaptureStore,
          ingest: brainEpisodeIngestor,
          configuredIngest: createProgrammaticEpisodeTerminal({ provider, model: extractionModel ?? EXTRACTION_MODEL }),
        }),
      })
    : null
  if (runWorkers) programmaticBatchWorker?.start()
  // The message store owns the enrichment ledger — it builds and leases the
  // windows — so this worker pulls work rather than discovering it. That leaves
  // one owner of "which messages have been enriched", and a consumer that dies
  // mid-window strands nothing: the lease expires and the window is reclaimable.
  const chatArchiveEnrichmentWorker = brainEpisodeIngestor && messageStoreClient
    ? createChatArchiveEnrichmentWorker({
        client: messageStoreClient,
        ingest: brainEpisodeIngestor,
        resolveAssistantId: resolvePrimaryAssistantForWorkspace,
      })
    : null
  if (runWorkers) chatArchiveEnrichmentWorker?.start()

  // Structural-synthesis P4 — the RESEARCH fill. A research-tier `assistant_call`
  // step with a `blueprintId` + page anchor fills the blueprint into the anchored
  // page from the research gather. Built when the resolved application model has
  // tool capability (Google via AI Studio/Vertex, DashScope, or Codex). Same
  // stores as the recording/generate synthesizers.
  const researchSynthesize = createResearchSynthesizer({
        provider,
        model: synthesisModel,
        resolveLlm: async (workspaceId) => {
          const runtime = await resolveBackgroundRuntime(workspaceId)
          return runtime ? {
            provider: runtime.provider,
            model: runtime.selector,
            modelTier: runtime.modelTier,
            providerKeySource: runtime.providerKeySource,
            inputTokenLimit: runtime.inputTokenLimit,
            maxTokens: runtime.maxTokens,
          } : null
        },
        savedViewStore,
        docPageStore: createDbDocPageStore(),
        crmStore,
        taskStore,
        memoryStore,
        workflowRunStore,
        workspaceDirectory: workspaceDirectoryStore,
        usageStore,
        pageTemplateStore,
        blueprintRecordStore,
        computeCostUsd: (model, usage) => calculateCost(model, usage),
      })

  // Structural-synthesis GENERATE fill (brain → blueprint) + the in-chat /
  // in-workflow tool that wraps it. Built HERE (before the executor + chat route
  // consume it) with the provider-neutral embedder for brain vector search.
  // The standalone Blueprints-UI route meters its own credit
  // (synthesis_surcharge); the tool rides the chat turn's per-message credit.
  const generateSynthesize: GenerateSynthesizeFn = createGenerateSynthesizer({
        provider,
        model: synthesisModel,
        resolveLlm: async (workspaceId) => {
          const runtime = await resolveBackgroundRuntime(workspaceId)
          return runtime ? {
            provider: runtime.provider,
            model: runtime.selector,
            modelTier: runtime.modelTier,
            providerKeySource: runtime.providerKeySource,
            inputTokenLimit: runtime.inputTokenLimit,
            maxTokens: runtime.maxTokens,
          } : null
        },
        savedViewStore,
        docPageStore: createDbDocPageStore(),
        crmStore,
        taskStore,
        memoryStore,
        workflowRunStore,
        workspaceDirectory: workspaceDirectoryStore,
        embedder: sharedEmbedder,
        usageStore,
        pageTemplateStore,
        blueprintRecordStore,
        computeCostUsd: (model, usage) => calculateCost(model, usage),
      })
  const generateBlueprintTool: Tool = createGenerateBlueprintTool({ generateSynthesize, pageTemplateStore })

  // The blueprint output-contract direct surface: save/read records in-context
  // (no model run), define contracts from chat, discover what exists — plus
  // the dynamic "workspace blueprints" prompt section (closed-world: present
  // only when the workspace has blueprints, naming only what exists). Injected
  // into BOTH the chat route and the callee executor. Unlike the fill tool,
  // this needs no model key — records are plain rows.
  const blueprintRecordTools: Tool[] = createBlueprintRecordTools({
    pageTemplateStore,
    blueprintRecordStore,
    // Page-projection deps → builds `projectBlueprintRecordPage`, the one
    // workflow-reachable record→page linkage (page-actions buttons resolve
    // through `blueprint_records.page_id`).
    savedViewStore,
    docPageStore: createDbDocPageStore(),
  })
  const buildBlueprintPromptFragment = async (userId: string, workspaceId: string): Promise<string> => {
    try {
      const templates = await pageTemplateStore.list(userId, workspaceId)
      return buildBlueprintSurfacePrompt(templates)
    } catch (err) {
      console.warn('[boot] blueprint prompt fragment failed (skipped):', err)
      return ''
    }
  }

  // The on-demand introspection lane (ability audit §6-c/d): operational-
  // visibility reads for workspace primaries — pending approvals, scheduled
  // jobs, research runs, session history. The chat route passes these to
  // `applyMcpInjection` for primary turns only, where they become the
  // `introspection` mcp_search local source (discovered on demand, never
  // direct-injected). The platform build can append its closed-tree reads
  // (connector-actions audit, workspace-scoped analytics) to this array.
  // See docs/architecture/engine/introspection-tools.md.
  const { listSessionsForWorkspaceSystem, getSessionTranscriptForWorkspaceSystem } = await import(
    '../db/sessions.js'
  )
  const introspectionTools: Tool[] = createIntrospectionTools({
    pendingApprovals: pendingApprovalsStore,
    scheduledJobs: jobStore,
    workerRuns: workerRunsStore,
    sessionHistory: { listSessionsForWorkspaceSystem, getSessionTranscriptForWorkspaceSystem },
  })

  // Declared here (assigned in the workspace-filesystem block below) so the
  // lazy references in the callee executor + workflow tool registry are
  // TDZ-safe: pre-assignment access reads `null` and degrades honestly.
  late.filesApi = null
  late.filesResolver = null
  late.chunkedFileUploads = null

  return {
    resolveWorkspaceExtractionLlm, brainEpisodeIngestor, programmaticBatchWorker,
    chatArchiveEnrichmentWorker, generateSynthesize, chatEpisodeIngestor, researchSynthesize,
    generateBlueprintTool, blueprintRecordTools, buildBlueprintPromptFragment, introspectionTools,
    programmaticCapture, captureConfiguration,
  } as const
}
