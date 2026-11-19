/**
 * Recording transcription, processing and auto-title workers.
 *
 * Boot register module registerRecordingWorkers: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`RecordingWorkersScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { calculateCost } from '@use-brian/agent-runtime/billing/cost-tracker.js'
import { distillFileToText } from '@use-brian/core/files/distill.js'
import { qwenAsrTranscriber } from '@use-brian/core/media/qwen-asr.js'
import { qwenFiletransTranscriber } from '@use-brian/core/media/qwen-filetrans.js'
import {
  type RecordingTranscriber,
  geminiTranscriber,
  withTranscriberFallback,
} from '@use-brian/core/media/recording-transcriber.js'
import { randomUUID } from 'node:crypto'
import {
  claimNextRecordingJob, markRecordingJobDone, markRecordingJobFailed, getRecordingJob,
} from '../db/recording-jobs-store.js'
import { createExtractService } from '../chat-archive/extract-service.js'
import { type RecordingSynthesizeFn, createRecordingSynthesizer } from '../synthesis/recording-synthesizer.js'
import { processOpenRecordingWithBookkeeping } from '../recordings/process-recording.js'
import { createRecordingFrameAnalyzer } from '../recordings/frame-analysis.js'
import { updateRecording } from '../db/recordings-store.js'
import { createDbDocPageStore } from '../db/doc-page-store.js'
import { lazyRoutes, lazyWorker } from './lazy.js'
import type { RecordingWorkersScope } from './scope.js'

// Router modules that load on their mount's first request (deployment.md ->
// "Boot composition" -> "Lazy routers and workers"); the mounts below are unchanged.
const chatArchiveExtractRoutes = lazyRoutes(() => import('../chat-archive/extract-routes.js'), 'chatArchiveExtractRoutes')

// Worker modules that load when the worker starts (deployment.md -> "Boot
// composition" -> "Lazy routers and workers"); `--no-workers` never loads them.
const createRecordingAutoTitleWorker = lazyWorker(() => import('../recordings/auto-title.js'), 'createRecordingAutoTitleWorker', '[recording-auto-title]')
const createOpenRecordingProcessWorker = lazyWorker(() => import('../recordings/recording-process-worker.js'), 'createOpenRecordingProcessWorker', '[recording-process-worker]')

export function registerRecordingWorkers(scope: RecordingWorkersScope) {
  const {
    ports, env, app, vertexTx, geminiTransport, dashscopeBaseUrl, dashscopeMediaKey, configuredProviders,
    provider, selectKeyedMediaBackend, providerMediaBackend, crmStore, sharedEmbedder, selectMediaBackend,
    usageStore, savedViewStore, backgroundModel, resolveBackgroundRuntime, filesResolver, memoryStore,
    taskStore, brainEpisodeIngestor, runWorkers, synthesisModel, workflowRunStore, workspaceDirectoryStore,
    pageTemplateStore, blueprintRecordStore, filesApi, gcsBucket, filesBlobClient,
  } = scope
  // ── Recording worker ──
  // Structural synthesis uses the already-resolved extraction model rather than
  // assuming Gemini. This keeps the hosted callback reusable in OSS and allows
  // Qwen-only deployments when their configured model supports tool calls.
  const recordingSynthesize: RecordingSynthesizeFn = createRecordingSynthesizer({
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

  // Always construct the drain when storage exists. If ffmpeg/ffprobe or a
  // transcriber is unavailable, the claimed job is retried then parked FAILED
  // with that explicit prerequisite error instead of remaining pending forever.
  const googleRecordingTranscribers: RecordingTranscriber[] = []
  const dashscopeRecordingTranscribers: RecordingTranscriber[] = []
  const recordingTranscriptionModel = env.RECORDING_TRANSCRIPTION_MODEL ?? env.VOICE_TRANSCRIPTION_MODEL
  if (vertexTx && gcsBucket && filesBlobClient) {
    googleRecordingTranscribers.push(geminiTranscriber({
      transport: vertexTx,
      ...(recordingTranscriptionModel ? { model: recordingTranscriptionModel } : {}),
      uploadAudio: async ({ buffer, mime }) => {
        const key = `recording-transcription/${randomUUID()}`
        await filesBlobClient.writeBlob(key, buffer, {
          workspaceId: 'recording-transcription',
          mime,
        })
        return {
          fileUri: `gs://${gcsBucket}/${key}`,
          cleanup: () => filesBlobClient.deleteBlob(key),
        }
      },
    }))
  } else if (geminiTransport) {
    googleRecordingTranscribers.push(geminiTranscriber({
      transport: geminiTransport,
      ...(recordingTranscriptionModel ? { model: recordingTranscriptionModel } : {}),
    }))
  }
  if (dashscopeMediaKey) {
    dashscopeRecordingTranscribers.push(qwenAsrTranscriber({
      apiKey: dashscopeMediaKey,
      baseUrl: dashscopeBaseUrl,
      ...(env.DASHSCOPE_ASR_MODEL ? { model: env.DASHSCOPE_ASR_MODEL } : {}),
    }))
    dashscopeRecordingTranscribers.push(qwenFiletransTranscriber({
      apiKey: dashscopeMediaKey,
      baseUrl: dashscopeBaseUrl,
      ...(env.DASHSCOPE_FILETRANS_MODEL ? { model: env.DASHSCOPE_FILETRANS_MODEL } : {}),
    }))
  }
  const selectRecordingTranscriber = (): RecordingTranscriber | undefined => {
    const preferred = configuredProviders.preferredProvider
    const transcribers = preferred === 'dashscope-intl' || preferred === 'openai-compat:dashscope-intl'
      ? [...dashscopeRecordingTranscribers, ...googleRecordingTranscribers]
      : [...googleRecordingTranscribers, ...dashscopeRecordingTranscribers]
    return transcribers.length === 0
      ? undefined
      : transcribers.length === 1
        ? transcribers[0]
        : withTranscriberFallback(transcribers[0], ...transcribers.slice(1))
  }
  const recordingTranscriber: RecordingTranscriber | undefined =
    googleRecordingTranscribers.length + dashscopeRecordingTranscribers.length === 0
      ? undefined
      : {
          get name() { return selectRecordingTranscriber()!.name },
          transcribe: (request) => selectRecordingTranscriber()!.transcribe(request),
        }

  // Extraction is a toolchain — ffmpeg, a SILK decoder, a cloud ASR fallback
  // chain, Office/PDF parsing, a vision model — so it stays here. Only the
  // control moved: the store owns the bytes and the queue and calls this as a
  // stateless function, which is why there is no worker and no job table left.
  if (env.BRIAN_MESSAGE_STORE_HMAC_SECRET) {
    app.use('/internal', chatArchiveExtractRoutes({
      service: createExtractService({
        transcriber: recordingTranscriber,
        distill: async ({ buffer, mime, prompt }) =>
          (await distillFileToText(
            { buffer, mime },
            { backend: selectMediaBackend(mime), prompt },
          )).text,
      }),
      secret: env.BRIAN_MESSAGE_STORE_HMAC_SECRET,
      allowRemote: env.BRIAN_MESSAGE_STORE_ALLOW_REMOTE === 'true',
    }))
  }

  const recordingProcessWorker = filesResolver && filesBlobClient && filesApi
    ? createOpenRecordingProcessWorker({
        claim: claimNextRecordingJob,
        process: async (job) => {
          await processOpenRecordingWithBookkeeping(job, {
            filesResolver,
            fallbackStorage: filesBlobClient,
            transcriber: recordingTranscriber,
            brainIngestor: brainEpisodeIngestor,
            filesApi,
            synthesize: recordingSynthesize,
            // Video keyframe analysis rides whichever vision-capable media
            // backend the box holds (google / dashscope / the deployment's own
            // chat provider). The unavailable fallback is deliberately NOT
            // used: no vision capability means the step is skipped, not failed.
            analyzeFrames: createRecordingFrameAnalyzer({
              backend: () => selectKeyedMediaBackend() ?? providerMediaBackend,
            }),
          })
        },
        markDone: markRecordingJobDone,
        markFailed: async (id, error) => {
          const result = await markRecordingJobFailed(id, error)
          const job = await getRecordingJob(id).catch(() => null)
          if (job) {
            const status = result.retrying ? 'queued' : 'failed'
            await updateRecording(job.recordingId, { status, lastError: error }).catch(() => null)
          }
          return result
        },
      })
    : null
  if (runWorkers && ports.runOpenRecordingWorker !== false && recordingProcessWorker) recordingProcessWorker.start()

  // Shared by both recording processors; also names existing completed media.
  const recordingAutoTitleWorker = createRecordingAutoTitleWorker({
    resolveRuntime: async workspaceId => {
      const runtime = await resolveBackgroundRuntime(workspaceId)
      return runtime ? {
        provider: runtime.provider, model: runtime.selector, maxTokens: runtime.maxTokens, inputTokenLimit: runtime.inputTokenLimit,
        providerKeySource: runtime.providerKeySource,
      } : configuredProviders.size ? { provider, model: backgroundModel, providerKeySource: 'platform' } : null
    },
    recordUsage: async (candidate, result) => {
      if (!result.usage || !usageStore) return
      await usageStore.recordUsage({
        userId: candidate.userId, workspaceId: candidate.workspaceId, assistantId: '', sessionId: null,
        model: result.model, modelTier: 'standard', ...result.usage,
        actualCostUsd: result.providerKeySource === 'user' ? 0 : calculateCost(result.model, result.usage),
        source: 'overhead:title', providerKeySource: result.providerKeySource ?? 'platform',
      })
    },
  })
  if (runWorkers) recordingAutoTitleWorker.start()

  return { recordingSynthesize, recordingProcessWorker, recordingAutoTitleWorker } as const
}
