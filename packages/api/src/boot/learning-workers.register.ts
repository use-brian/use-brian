/**
 * Consolidation, skill review, reflection, sandbox reaper and classifier self-heal workers.
 *
 * Boot register module registerLearningWorkers: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`LearningWorkersScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { calculateCost } from '@use-brian/agent-runtime/billing/cost-tracker.js'
import { collectStream } from '@use-brian/agent-runtime/providers/accumulator.js'
import { sanitize as sanitizeAnalytics } from '@use-brian/core/analytics/logger.js'
import { createCircuitBreaker } from '@use-brian/core/classification/circuit-breaker.js'
import { createClassifierSelfHealWorker } from '@use-brian/core/classification/self-heal/worker.js'
import { createConsolidationWorker } from '@use-brian/core/consolidation/worker.js'
import type { EntityRecord } from '@use-brian/core/entities/types.js'
import { createSandboxReaper } from '@use-brian/core/sandbox/reaper.js'
import {
  reclassifyEntityKind as reclassifyEntityKindFn, promoteEntityToCrm as promoteEntityToCrmFn,
} from '../db/entities-store.js'
import { createFeedLearningHandler, reconcileFeedLearning } from '../content-planning/learning.js'
import {
  createFeedLearningModelResolver, createFeedEditorialModelResolver,
} from '../content-planning/editorial-model.js'
import { createFeedReviewHandler } from '../content-planning/review.js'
import { BACKGROUND_MODEL } from '../model-resolution.js'
import { createGeminiSkillReviewLLM } from '../workers/skill-review-llm.js'
import { createDecisionReflectionWorker } from '../workers/decision-reflection-worker.js'
import { createResearchReflectionWorker } from '../research/learning.js'
import { buildWorkspaceCuratorScope } from '../workers/workspace-curator-scope.js'
import { sweepStaleByoBindings } from '../files/byo-staleness.js'
import { query, getPool } from '../db/client.js'
import { backgroundWorkspaceFilter } from '../background-inference-policy.js'
import { lazyWorker } from './lazy.js'
import type { LearningWorkersScope } from './scope.js'

// Worker modules that load when the worker starts (deployment.md -> "Boot
// composition" -> "Lazy routers and workers"); `--no-workers` never loads them.
const createFeedEditorialWorker = lazyWorker(() => import('../workers/feed-editorial-worker.js'), 'createFeedEditorialWorker', '[feed-editorial]')
const createSkillReviewWorker = lazyWorker(() => import('../workers/skill-review-worker.js'), 'createSkillReviewWorker', '[skill-review]')
const createPlaybookReflectionWorker = lazyWorker(() => import('../workers/playbook-reflection-worker.js'), 'createPlaybookReflectionWorker', '[playbook-reflection]')

export function registerLearningWorkers(scope: LearningWorkersScope) {
  const {
    ports, env, configuredProviders, provider, analytics, resolvePrimaryAssistantForWorkspace,
    entityLinksStore, entitiesStore, analyticsStore, usageStore, decisionRuntime, connectorInstanceStore,
    workspaceSkillStore, workspaceSkillFilesStore, workflowStore, resolveWorkspaceCustomLlm,
    resolveBackgroundRuntime, workspaceFilesStore, memoryStore, taskStore, runWorkers, pendingApprovalsStore,
    entityKindClassifier, brainCandidateStore, filesBlobClient, sandboxOrchestrator, feedReviewContext,
    feedGeneration, workspaceForAssistant, ownerForWorkspace, skillCuratorDigestStore, curatorEmbedder,
    skillReviewLeaseHolderId,
  } = scope
  const excludedBackgroundWorkspaceIdsSql = ports.backgroundInferencePolicy?.excludedWorkspaceIdsSql
  // Ingest batch worker is closed (Pipeline B processor lives in api-platform).
  // The platform starts it via mountExtraRoutes; the open build skips it.
  const classifierCircuitBreaker = createCircuitBreaker(
    // The DB circuit-breaker counter store is closed; the open build uses an
    // in-memory counter so the classifier still has a breaker. (Stateless,
    // process-local — acceptable for single-instance local dev.)
    {
      async increment() { return 1 },
      async reset() {},
      async get() { return 0 },
    } as never,
    { analytics },
  )

  // ── Consolidation worker (dreaming) ──
  // Background lane, not chat lane. cost-and-pricing.md → "Standard-tier
  // routing" names consolidation as Flash-Lite work; it had drifted onto the
  // Flash 3 chat alias, which is 2x the input rate and 2x the output rate for
  // invisible background summarization. `backgroundModel` is the boot-resolved
  // id (falls back when Flash Lite isn't servable for the configured provider).
  const CONSOLIDATION_MODEL = BACKGROUND_MODEL
  const consolidationCallModel = async (
    prompt: string,
    ctx: { assistantId: string; userId: string | null; workspaceId: string | null; phase: string },
  ): Promise<string> => {
    const workspaceId = ctx.workspaceId ?? await workspaceForAssistant(ctx.assistantId)
    const customRuntime = await resolveBackgroundRuntime(workspaceId)
    const callProvider = customRuntime?.provider ?? provider
    const callModel = customRuntime?.selector ?? CONSOLIDATION_MODEL
    const response = await collectStream(callProvider.stream({
      model: callModel,
      messages: [{ role: 'user', content: prompt }],
      systemPrompt: 'You are a memory consolidation assistant. Follow the user instructions exactly. Output plain text only.',
      maxTokens: 4096,
    }))
    const attributionUserId = ctx.userId ?? (workspaceId ? await ownerForWorkspace(workspaceId) : null)
    if (response.usage && attributionUserId && usageStore) {
      const servedModel = response.model || callModel
      const cost = customRuntime?.providerKeySource === 'user'
        ? 0
        : calculateCost(servedModel, response.usage)
      usageStore.recordUsage({
        userId: attributionUserId,
        assistantId: ctx.assistantId,
        workspaceId: workspaceId ?? undefined,
        sessionId: null,
        model: servedModel,
        modelTier: 'standard',
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheReadTokens: response.usage.cacheReadTokens,
        cacheWriteTokens: response.usage.cacheWriteTokens,
        actualCostUsd: cost,
        source: 'overhead:consolidation',
        providerKeySource: customRuntime?.providerKeySource ?? 'platform',
      }).catch((err) => console.error('[consolidation] usage tracking failed:', err))
    }
    return response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
  }

  const consolidationWorker = createConsolidationWorker({
    store: memoryStore,
    callModel: consolidationCallModel,
    listReflectionWorkspaces: async () => (await query<{ workspaceId: string }>(`
      SELECT eligible.workspace_id AS "workspaceId" FROM (
        SELECT workspace_id FROM memory_verifications
        WHERE source_scope IS NOT NULL AND NOT scope_held AND action<>'confirm' AND created_at>now()-interval '14 days'
        UNION SELECT workspace_id FROM brain_verifications
        WHERE source_scope IS NOT NULL AND NOT scope_held AND action<>'confirm' AND created_at>now()-interval '14 days'
        UNION SELECT workspace_id FROM correction_audit
        WHERE source_scope IS NOT NULL AND NOT scope_held AND action IN('retract','soft_delete') AND created_at>now()-interval '14 days'
      ) eligible
      WHERE TRUE ${backgroundWorkspaceFilter('eligible.workspace_id', excludedBackgroundWorkspaceIdsSql)}
    `)).rows.map(row=>row.workspaceId),
    resolveReflectionPrincipal: async workspaceId => {
      const [assistantId,userId] = await Promise.all([
        resolvePrimaryAssistantForWorkspace(workspaceId),ownerForWorkspace(workspaceId),
      ])
      return assistantId && userId ? {assistantId,userId} : null
    },
    onEvent: (event) => {
      if (event.type === 'consolidation_completed') {
        analytics.logEvent({
          userId: event.userId,
          assistantId: event.assistantId,
          eventName: 'consolidation_completed',
          metadata: {
            phase: sanitizeAnalytics(event.phase),
            memories_affected: event.memoriesAffected,
            merged: event.merged,
            patterns_found: event.patternsFound,
            pruned: event.pruned ?? 0,
            promoted: event.promoted ?? 0,
            domains_summarized: event.domainsSummarized ?? 0,
          },
        })
      } else if (event.type === 'soul_updated') {
        analytics.logEvent({
          userId: event.userId,
          assistantId: event.assistantId,
          eventName: 'soul_updated',
          metadata: {
            previous_length: event.previousLength,
            new_length: event.newLength,
            change_magnitude: event.changeMagnitude,
          },
        })
      }
    },
    // Post-REM reclassification needs the closed brainCandidateStore. Omitted
    // (open) when no candidate store is wired.
    reclassification: brainCandidateStore
      ? {
          entityStore: entitiesStore,
          entityLinks: entityLinksStore,
          tasks: taskStore,
          candidates: brainCandidateStore,
          provider,
          model: BACKGROUND_MODEL,
          decisionRuntime,
          resolveLlm: async (workspaceId: string) => {
            const runtime = await resolveBackgroundRuntime(workspaceId)
            return runtime
              ? {
                  provider: runtime.provider,
                  model: runtime.selector,
                  modelTier: 'standard',
                  providerKeySource: 'user' as const,
                }
              : {
                  provider,
                  model: BACKGROUND_MODEL,
                  modelTier: 'standard',
                  providerKeySource: 'platform' as const,
                }
          },
          onUsage: ({ workspaceId, userId, assistantId, model, modelTier, providerKeySource, usage }) => {
            if (!usageStore) return
            void usageStore.recordUsage({
              workspaceId,
              userId,
              assistantId,
              sessionId: null,
              model,
              modelTier,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
              actualCostUsd: providerKeySource === 'user' ? 0 : calculateCost(model, usage),
              source: 'overhead:consolidation',
              triggerKey: 'memory_reclassification',
              providerKeySource,
            }).catch((err) => console.error('[reclassifier] usage tracking failed:', err))
          },
          resolveWorkspaceId: async (assistantId: string) => {
            const r = await query<{ workspaceId: string }>(
              `SELECT workspace_id AS "workspaceId" FROM assistants WHERE id = $1`,
              [assistantId],
            )
            return r.rows[0]?.workspaceId ?? null
          },
          isV2Enabled: async (workspaceId: string) => {
            const r = await query<{ enabled: boolean }>(
              `SELECT brain_extraction_v2_enabled AS "enabled" FROM workspaces WHERE id = $1`,
              [workspaceId],
            )
            return r.rows[0]?.enabled ?? true
          },
        }
      : undefined,
    workspaceCuratorScope: env.SKILLS_AUTO_GEN_ENABLED
      ? buildWorkspaceCuratorScope({
          workspaceSkillStore,
          digestStore: skillCuratorDigestStore,
          excludedBackgroundWorkspaceIdsSql,
          getEmbeddings: (texts) => curatorEmbedder.embed(texts),
        })
      : undefined,
  })
  if (runWorkers) consolidationWorker.start()

  // ── BYO storage staleness GC (scheduled maintenance, daily) ──
  // Soft-disconnected GCS bindings keep read access through a grace window;
  // once past it they are stale — wipe the key + retract the orphaned files.
  // Runs only where the workspace-files byte layer is active.
  if (runWorkers && filesBlobClient) {
    const BYO_STALENESS_INTERVAL_MS = 24 * 60 * 60 * 1000
    const runByoStalenessSweep = () => {
      void sweepStaleByoBindings({
        connectorInstanceStore,
        workspaceFilesStore,
        nowMs: Date.now(),
        log: (m) => console.log(m),
      }).catch((err) => console.error('[byo-staleness] sweep failed:', err))
    }
    const byoStalenessTimer = setInterval(runByoStalenessSweep, BYO_STALENESS_INTERVAL_MS)
    if (typeof byoStalenessTimer.unref === 'function') byoStalenessTimer.unref()
  }

  // ── Skill-review worker ──
  const SKILL_REVIEW_MODEL = BACKGROUND_MODEL
  const skillReviewLLM = createGeminiSkillReviewLLM(
    async ({ systemPrompt, prompt, maxTokens, attribution }) => {
      const workspaceId = await workspaceForAssistant(attribution.assistantId)
      const customRuntime = await resolveBackgroundRuntime(workspaceId)
      const callProvider = customRuntime?.provider ?? provider
      const callModel = customRuntime?.selector ?? SKILL_REVIEW_MODEL
      const response = await collectStream(callProvider.stream({
        model: callModel,
        messages: [{ role: 'user', content: prompt }],
        systemPrompt,
        maxTokens,
      }))
      if (response.usage && usageStore) {
        const servedModel = response.model || callModel
        const cost = customRuntime?.providerKeySource === 'user'
          ? 0
          : calculateCost(servedModel, response.usage)
        usageStore.recordUsage({
          userId: attribution.userId,
          assistantId: attribution.assistantId,
          sessionId: null,
          model: servedModel,
          modelTier: 'standard',
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          cacheReadTokens: response.usage.cacheReadTokens,
          cacheWriteTokens: response.usage.cacheWriteTokens,
          actualCostUsd: cost,
          source: 'overhead:skill-review',
          providerKeySource: customRuntime?.providerKeySource ?? 'platform',
        }).catch((err) => console.error('[skill-review] usage tracking failed:', err))
      }
      return response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
    },
  )
  const skillReviewWorker = createSkillReviewWorker({
    workspaceSkillStore,
    fileStore: workspaceSkillFilesStore,
    approvalsStore: pendingApprovalsStore,
    analyticsStore,
    reviewLLM: skillReviewLLM,
    // Origin-aware induction: the workflow read port gives workflow-origin
    // review cycles their source definition (deviation objective +
    // refinement staging) and the active-workflow subsumption corpus.
    workflowPort: {
      async getWorkflowForReview(userId, workspaceId, workflowId) {
        const wf = await workflowStore.getById(userId, workflowId)
        if (!wf || wf.workspaceId !== workspaceId) return null
        return {
          id: wf.id,
          name: wf.name,
          description: wf.description ?? null,
          steps: wf.definition.steps.map((s) => ({
            id: s.id,
            kind: s.type,
            prompt: s.type === 'assistant_call' ? s.prompt : null,
          })),
        }
      },
      async listActiveWorkflows(userId, workspaceId) {
        const rows = await workflowStore.list(userId, workspaceId)
        return rows.map((w) => ({ id: w.id, name: w.name }))
      },
    },
    leaseHolderId: skillReviewLeaseHolderId,
    enabled: env.SKILLS_AUTO_GEN_ENABLED ?? false,
    onEvent: (event) => {
      if (event.type === 'tick_complete') {
        console.log(`[skill-review] tick complete — reviewed:${event.reviewed} skipped:${event.skipped} failed:${event.failed}`)
      }
    },
  })
  if (runWorkers) skillReviewWorker.start()

  // ── Playbook reflection worker (growth loop Phase 3) ──
  // Weekly per-assistant reflection: grades recent work against
  // `charter.success` and proposes playbook rules as suggestions the owner
  // admits on the assistant detail page. Cost rides
  // `overhead:playbook-reflection` (migration 420). See
  // docs/architecture/context-engine/assistant-playbook.md.
  const playbookReflectionWorker = createPlaybookReflectionWorker({
    modelCall: async ({ systemPrompt, prompt, maxTokens, attribution }) => {
      const workspaceId = await workspaceForAssistant(attribution.assistantId)
      const customRuntime = await resolveBackgroundRuntime(workspaceId)
      const callProvider = customRuntime?.provider ?? provider
      const callModel = customRuntime?.selector ?? BACKGROUND_MODEL
      const response = await collectStream(callProvider.stream({
        model: callModel,
        messages: [{ role: 'user', content: prompt }],
        systemPrompt,
        maxTokens,
      }))
      if (response.usage && usageStore) {
        const servedModel = response.model || callModel
        const cost = customRuntime?.providerKeySource === 'user'
          ? 0
          : calculateCost(servedModel, response.usage)
        usageStore.recordUsage({
          userId: attribution.userId,
          assistantId: attribution.assistantId,
          sessionId: null,
          model: servedModel,
          modelTier: 'standard',
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          cacheReadTokens: response.usage.cacheReadTokens,
          cacheWriteTokens: response.usage.cacheWriteTokens,
          actualCostUsd: cost,
          source: 'overhead:playbook-reflection',
          providerKeySource: customRuntime?.providerKeySource ?? 'platform',
        }).catch((err) => console.error('[playbook-reflection] usage tracking failed:', err))
      }
      return response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
    },
    onEvent: (event) => {
      if (event.type === 'assistant_processed' && event.activated + event.suggested > 0) {
        console.log(`[playbook-reflection] auto-admitted ${event.activated} rule(s) (+${event.suggested} overflow) for assistant ${event.assistantId}`)
      } else if (event.type === 'error') {
        console.error(`[playbook-reflection] error for assistant ${event.assistantId ?? '<global>'}: ${event.error}`)
      } else if (event.type === 'tick_complete') {
        console.log(`[playbook-reflection] tick complete: processed=${event.processedCount} suggested=${event.suggestedCount} skipped=${event.skippedCount} errors=${event.errorCount}`)
      }
    },
  })
  if (runWorkers) playbookReflectionWorker.start()

  // ── Decision reflection worker (human-decision learning Phase 4) ──
  // Daily user-scoped projection from minimized, deliberate decision evidence.
  // The store independently enforces thresholds and prohibited output.
  const feedEditorialWorker = createFeedEditorialWorker({ handlers: {
    confirmation_learning: createFeedLearningHandler(createFeedLearningModelResolver({ provider, configuredProviders, resolveBackgroundRuntime, usageStore })),
    reconcile: reconcileFeedLearning,
    text_generation: feedGeneration.handler,
    image_generation: feedGeneration.handler,
    review: createFeedReviewHandler(createFeedEditorialModelResolver({ provider, configuredProviders, resolveWorkspaceCustomLlm, usageStore, checkCreditBudget: ports.checkCreditBudget }), feedReviewContext),
  } })
  if (runWorkers) feedEditorialWorker.start()

  const decisionReflectionWorker = createDecisionReflectionWorker({
    modelCall: async ({ systemPrompt, prompt, maxTokens, attribution }) => {
      const workspaceId = await workspaceForAssistant(attribution.assistantId)
      const customRuntime = await resolveBackgroundRuntime(workspaceId)
      const callProvider = customRuntime?.provider ?? provider
      const callModel = customRuntime?.selector ?? BACKGROUND_MODEL
      const response = await collectStream(callProvider.stream({
        model: callModel,
        messages: [{ role: 'user', content: prompt }],
        systemPrompt,
        maxTokens,
      }))
      if (response.usage && usageStore) {
        const servedModel = response.model || callModel
        const cost = customRuntime?.providerKeySource === 'user'
          ? 0
          : calculateCost(servedModel, response.usage)
        usageStore.recordUsage({
          userId: attribution.userId,
          assistantId: attribution.assistantId,
          sessionId: null,
          model: servedModel,
          modelTier: 'standard',
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          cacheReadTokens: response.usage.cacheReadTokens,
          cacheWriteTokens: response.usage.cacheWriteTokens,
          actualCostUsd: cost,
          source: 'overhead:playbook-reflection',
          providerKeySource: customRuntime?.providerKeySource ?? 'platform',
        }).catch((err) => console.error('[decision-reflection] usage tracking failed:', err))
      }
      return response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.type === 'text' ? block.text : '')
        .join('')
    },
    onEvent: (event) => {
      if (event.type === 'subject_processed'
        && event.activated + event.suggested + event.rejected > 0) {
        analytics.logEvent({
          userId: event.actorUserId,
          actorUserId: event.actorUserId,
          assistantId: event.assistantId,
          eventName: 'decision_rule_created',
          channelType: 'worker',
          metadata: {
            activated_count: event.activated,
            suggested_count: event.suggested,
            rejected_count: event.rejected,
            deduped_count: event.deduped,
          },
        })
        console.log(
          `[decision-reflection] assistant=${event.assistantId} actor=${event.actorUserId} active=${event.activated} suggested=${event.suggested} rejected=${event.rejected} deduped=${event.deduped}`,
        )
      } else if (event.type === 'error') {
        console.error(
          `[decision-reflection] error assistant=${event.assistantId ?? '<global>'} actor=${event.actorUserId ?? '<global>'}: ${event.error}`,
        )
      } else if (event.type === 'tick_complete') {
        console.log(
          `[decision-reflection] tick complete: processed=${event.processed} skipped=${event.skipped} errors=${event.errors}`,
        )
      }
    },
  })
  if (runWorkers) decisionReflectionWorker.start()

  // ── Research reflection (features/research.md -> "Scoped lessons"): the
  //    same daily, bounded background lane as decision reflection, metered
  //    as the same playbook-reflection overhead (attributed to the owner).
  const researchReflectionWorker = createResearchReflectionWorker({
    modelCall: async ({ workspaceId, system, prompt }) => {
      const customRuntime = await resolveBackgroundRuntime(workspaceId)
      const callProvider = customRuntime?.provider ?? provider
      const callModel = customRuntime?.selector ?? BACKGROUND_MODEL
      const response = await collectStream(callProvider.stream({
        model: callModel, messages: [{ role: 'user', content: prompt }], systemPrompt: system, maxTokens: 1200,
      }))
      if (response.usage && usageStore) {
        const owner = (await getPool().query<{ userId: string; assistantId: string | null }>(
          `SELECT w.owner_user_id AS "userId",
                  (SELECT a.id FROM assistants a WHERE a.workspace_id = w.id ORDER BY (a.kind = 'primary') DESC, a.created_at LIMIT 1) AS "assistantId"
             FROM workspaces w WHERE w.id = $1`, [workspaceId])).rows[0]
        const servedModel = response.model || callModel
        if (owner?.userId && owner.assistantId) {
          usageStore.recordUsage({
            userId: owner.userId,
            assistantId: owner.assistantId,
            sessionId: null,
            model: servedModel,
            modelTier: 'standard',
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            cacheReadTokens: response.usage.cacheReadTokens,
            cacheWriteTokens: response.usage.cacheWriteTokens,
            actualCostUsd: customRuntime?.providerKeySource === 'user' ? 0 : calculateCost(servedModel, response.usage),
            source: 'overhead:playbook-reflection',
            providerKeySource: customRuntime?.providerKeySource ?? 'platform',
          }).catch((err) => console.error('[research-reflection] usage tracking failed:', err))
        }
      }
      return response.content.filter((block) => block.type === 'text').map((block) => block.type === 'text' ? block.text : '').join('')
    },
    onEvent: (event) => {
      if (event.type === 'subject_processed') {
        console.log(`[research-reflection] workspace=${event.workspaceId} created=${event.result.created} active=${event.result.activated} suggested=${event.result.suggested} rejected=${event.result.rejected} deduped=${event.result.deduped}`)
      } else if (event.type === 'error') {
        console.error(`[research-reflection] error workspace=${event.workspaceId ?? '<global>'}: ${event.error}`)
      }
    },
  })
  if (runWorkers) researchReflectionWorker.start()

  // ── Sandbox lifecycle reaper (computer-use.md §7) — kills tasks idle past
  //    the Take-Over abandonment window + runs the vault's per-plan purge.
  //    Only exists when a sandbox provider is configured. ──
  if (sandboxOrchestrator) {
    const sandboxReaper = createSandboxReaper({
      orchestrator: sandboxOrchestrator,
      vault: ports.browserSessionVault ?? null,
      onEvent: (event) => {
        if (event.reaped > 0 || event.purged > 0) {
          console.log(`[sandbox-reaper] tick — reaped:${event.reaped} purged:${event.purged}`)
        }
      },
    })
    if (runWorkers) sandboxReaper.start()
  }

  // ── Classifier self-heal worker — needs the closed pending-classification
  //    queue. Only started when injected (platform); open omits it. ──
  if (ports.pendingClassificationStore) {
    const pendingQueue = ports.pendingClassificationStore
    const classifierSelfHealWorker = createClassifierSelfHealWorker({
      classifier: entityKindClassifier,
      entities: entitiesStore,
      scanner: {
        async scanByCentrality(workspaceId, opts) {
          const { rows } = await query<EntityRecord & { centrality: number | string }>(
            `SELECT
               id, kind, display_name AS "displayName",
               canonical_id AS "canonicalId", aliases, attributes, sensitivity,
               workspace_id AS "workspaceId", user_id AS "userId",
               assistant_id AS "assistantId",
               created_by_user_id AS "createdByUserId",
               created_by_assistant_id AS "createdByAssistantId",
               source_episode_id AS "sourceEpisodeId", source,
               verified_by_user_id AS "verifiedByUserId",
               verified_at AS "verifiedAt",
               valid_from AS "validFrom", valid_to AS "validTo",
               superseded_by AS "supersededBy",
               retracted_at AS "retractedAt",
               retracted_reason AS "retractedReason",
               retracted_by AS "retractedBy",
               centrality, centrality_computed_at AS "centralityComputedAt",
               created_at AS "createdAt", updated_at AS "updatedAt"
             FROM entities
             WHERE workspace_id = $1 AND valid_to IS NULL AND retracted_at IS NULL
             ORDER BY centrality DESC NULLS LAST, created_at DESC
             LIMIT $2`,
            [workspaceId, opts.limit],
          )
          return rows.map((r) => ({
            ...r,
            centrality: typeof r.centrality === 'string' ? Number(r.centrality) : r.centrality,
          })) as EntityRecord[]
        },
      },
      reclassifier: {
        async reclassifyEntityKind(actorUserId, id, newKind) {
          return reclassifyEntityKindFn(actorUserId, id, { kind: newKind })
        },
        async promoteEntityToCrm(actorUserId, id, targetKind) {
          const out = await promoteEntityToCrmFn(actorUserId, id, { kind: targetKind })
          return out.entity
        },
      },
      pendingQueue,
      workspaces: async () => {
        const { rows } = await query<{ workspace_id: string; owner_user_id: string }>(
          `SELECT DISTINCT e.workspace_id, w.owner_user_id
             FROM entities e
             JOIN workspaces w ON w.id = e.workspace_id
             WHERE e.valid_to IS NULL AND e.retracted_at IS NULL`,
        )
        return rows.map((r) => ({ workspaceId: r.workspace_id, actorUserId: r.owner_user_id }))
      },
      circuitBreaker: classifierCircuitBreaker,
    })
    if (runWorkers) classifierSelfHealWorker.start()
  }

  return {
    consolidationWorker, skillReviewWorker, playbookReflectionWorker, feedEditorialWorker,
    decisionReflectionWorker, researchReflectionWorker,
  } as const
}
