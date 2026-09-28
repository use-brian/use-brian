/**
 * Path B durable chat resume — the replay implementation (WU-6.4).
 *
 * `runSessionResume` (`chat.ts`) owns the resume-point + approval lookup
 * and the status gate; it delegates the actual turn replay to an injected
 * `SessionResumeReplay` callback. This file builds that callback.
 *
 * The replay runs after a Cloud Run restart killed the chat process that
 * suspended a `requiresConfirmation` tool. It:
 *   1. reloads the suspended session + its message history,
 *   2. runs the approved tool (or records the rejection / expiry),
 *   3. drives a fresh `queryLoop` turn so the model reports the outcome
 *      to the user and continues,
 *   4. persists the resulting assistant message(s).
 *
 * Robustness over fidelity: rather than reconstruct an exact
 * tool_use/tool_result pair across the restart boundary — the suspended
 * assistant turn is not persisted at suspension time — the outcome is
 * handed to the model as a self-contained note. `ensureToolResultPairing`
 * still repairs any dangling tool_use in the reloaded history so the
 * provider call is valid either way.
 *
 * Spec: docs/plans/company-brain/approvals.md → "Chat resume — Path B".
 *
 * [COMP:brain/session-resume-worker]
 */

import { createTurnLedger } from '../ledger/recorder.js'
import { getLedgerPayloadStore } from '../ledger/runtime.js'
import {
  queryLoop,
  calculateCost,
  ensureToolResultPairing,
  SensitivityAccumulator,
  ContextScopeAccumulator,
  INTERACTIVE_CHANNEL_TYPES,
  accessCeilingContains,
  intersectAccessCeilings,
  pinAccessCeiling,
  scopeGrantContains,
  type AccessCeiling,
  type LLMProvider,
  type Tool,
  type ToolContext,
  type Message,
  type AnalyticsLogger,
  type UsageStore,
} from '@use-brian/core'
import {
  findSessionById,
  getSessionMessages,
  addSessionMessage,
  toStampedMessages,
  type Session,
} from '../db/sessions.js'
import { findAssistantById } from '../db/users.js'
import type { SessionResumeReplay, ResumeReplayParams } from './chat.js'
import { MODEL_MAP, chatTierBudget, tierForModel } from '../model-resolution.js'
import {
  formatActiveWorkspaceContext,
  resolveLiveAccessCeilingSystem,
  resolveTurnScopeSystem,
  type ResolvedTurnScope,
} from '../context-scope/resolve-turn-scope.js'
import { bindToolsToAgentAccess } from '../context-scope/agent-access-tools.js'
import { runWithAgentAccess } from '../db/client.js'
import {
  assertCurrentAuthority,
  AuthorityChangedError,
  createAuthorityLease,
  executeWithCurrentAuthority,
  runWithAuthorityLease,
} from '../context-scope/authority-lease.js'

export type SessionResumeReplayDeps = {
  provider: LLMProvider
  /** Resolve the workspace default custom endpoint for the resumed user turn. */
  resolveWorkspaceCustomLlm: import('../custom-llm-runtime.js').WorkspaceCustomLlmResolver | null
  resolveWorkspaceByoGeminiKey: ((workspaceId: string) => Promise<string | null>) | null
  buildWorkspaceProvider: ((apiKey: string) => LLMProvider) | null
  usageStore?: UsageStore
  /** Boot-time tool registry — the suspended tool is resolved from here. */
  tools: Map<string, Tool>
  /** Base L1 system prompt. The assistant's L2 is appended per-session. */
  systemPrompt: string
  /** Model for the continuation turn. Defaults to `gemini-flash`. */
  model?: string
  analytics?: AnalyticsLogger
  /**
   * Phase 3 of askQuestion suspend-resume — rehydrate worker state from
   * `worker_runs` before the continuation turn. When both `workerManager`
   * and `workerRunsStore` are wired (workspace-scoped resumes), the
   * replay calls `workerManager.setPersistence(...)` + `rehydrate(...)`
   * so completed workers feed into Phase 4b's notifications queue and
   * any still-running rows respawn from their last turn boundary.
   * Both absent → legacy behavior (no rehydrate; the model synthesizes
   * with whatever the session history holds).
   *
   * See docs/architecture/engine/askquestion-suspend-resume.md.
   */
  workerManager?: import('@use-brian/core').WorkerManager
  workerRunsStore?: import('@use-brian/core').WorkerRunsStore
}

type AssistantRow = NonNullable<Awaited<ReturnType<typeof findAssistantById>>>

export function resolveDurableResumePolicy(
  params: Pick<ResumeReplayParams, 'selectedTier' | 'selectedMeteredModel'>,
  fallbackModel: string,
): {
  logicalModel: string
  logicalTier: string
  budget: { maxTurns: number; maxToolCalls: number } | null
} {
  if (params.selectedMeteredModel) {
    // Explicit metered turns require their accepted tool-round profile and
    // platform surcharge contract. That policy is intentionally not replayed
    // from a lightweight checkpoint: fail closed rather than silently serving
    // a Pro/default continuation without its confirmation or debit.
    throw new Error(`Durable replay does not support explicit metered model ${params.selectedMeteredModel}.`)
  }
  const logicalTier = params.selectedTier ?? tierForModel(fallbackModel)
  const logicalModel = logicalTier in MODEL_MAP ? MODEL_MAP[logicalTier]! : fallbackModel
  return {
    logicalModel,
    logicalTier,
    budget: chatTierBudget({
      model: logicalModel,
      researchMode: logicalTier === 'research',
    }),
  }
}

/** Build the `ToolContext` shared by the suspended-tool run and the queryLoop turn. */
function buildContext(
  session: Session,
  assistant: AssistantRow,
  turnScope: ResolvedTurnScope,
): ToolContext {
  return {
    userId: session.userId,
    workspaceActorUserId: INTERACTIVE_CHANNEL_TYPES.has(session.channelType) ? session.userId : undefined,
    assistantId: assistant.id,
    sessionId: session.id,
    appId: 'Use Brian',
    channelType: session.channelType,
    channelId: session.channelId,
    workspaceId: assistant.workspaceId ?? undefined,
    assistantKind: assistant.kind,
    clearance: turnScope.access.clearance,
    compartments: turnScope.effectiveCompartments,
    mutationCompartments: turnScope.access.mutationCompartments,
    projectIds: turnScope.effectiveProjectIds,
    activeGroupId: turnScope.activeGroupId,
    activeProjectId: turnScope.activeProjectId,
    assistantClearance: assistant.clearance,
    assistantCompartments: turnScope.effectiveCompartments,
    assistantDefaultCompartments: turnScope.writeCompartments,
    assistantProjectIds: turnScope.effectiveProjectIds,
    assistantDefaultProjectIds: turnScope.writeProjectIds,
    sensitivity: new SensitivityAccumulator(),
    scopeAccumulator: new ContextScopeAccumulator({
      compartments: turnScope.writeCompartments,
      projectIds: turnScope.writeProjectIds,
    }),
    abortSignal: new AbortController().signal,
  }
}

class SessionResumeAuthorityUnavailableError extends Error {
  readonly code = 'session_resume_authority_unavailable'
  readonly retrySafe = true
  constructor() {
    super('Access for this suspended turn can no longer be verified. Start a new request with the current permissions.')
    this.name = 'SessionResumeAuthorityUnavailableError'
  }
}

function authorityUnavailable(): SessionResumeAuthorityUnavailableError {
  return new SessionResumeAuthorityUnavailableError()
}

/**
 * Resolve the self-contained outcome note handed to the continuation
 * turn. For an approved action this runs the suspended tool with its
 * frozen input. Ordinary tool failures become a relayable note; live
 * authority loss is structural and propagates so no possibly executed result
 * reaches the model. Exported for direct unit testing.
 */
export async function resolveResumeOutcomeNote(
  tools: Map<string, Tool>,
  params: Pick<
    ResumeReplayParams,
    | 'suspendedToolName'
    | 'suspendedToolInput'
    | 'approvalStatus'
    | 'rejectReason'
    | 'answerText'
    | 'approvalKind'
  >,
  context: ToolContext,
): Promise<string> {
  const {
    suspendedToolName: toolName,
    approvalStatus,
    rejectReason,
    answerText,
    approvalKind,
  } = params

  // askQuestion suspend-resume — the suspended tool is the question itself.
  // The outcome note is the user's typed answer (NOT a tool execution
  // result). The queryLoop continuation turn reads this as user-role text
  // and can finish synthesis with worker findings + the answer. See
  // docs/architecture/engine/askquestion-suspend-resume.md.
  if (approvalKind === 'question') {
    if (approvalStatus === 'expired') {
      return (
        '[Resumed after question] The question expired before the user answered. ' +
        'Acknowledge that no answer came in, summarize what was found so far, and stop.'
      )
    }
    if (approvalStatus === 'rejected') {
      // Cancel pathway (Phase 2 maps cancel → status='rejected').
      return (
        '[Resumed after question] The user cancelled this research session. ' +
        'Acknowledge the cancellation. Do not continue research; surface any ' +
        'findings already gathered if useful, then stop.'
      )
    }
    // approvalStatus === 'approved' — the answer is in answerText.
    const answer = (answerText ?? '').trim()
    if (!answer) {
      // Defensive: route validation should reject empty answers; if one
      // sneaks through, fall through to a generic continuation note.
      return (
        '[Resumed after question] The user submitted an empty answer. ' +
        'Use the best inference from prior context and continue.'
      )
    }
    return (
      `[Resumed after question] The user answered: ${answer}\n\n` +
      'Continue from where you paused — synthesize the final reply using this ' +
      'answer plus any background worker results that have arrived.'
    )
  }

  if (approvalStatus === 'rejected') {
    return (
      `[Resumed after approval] The user declined the pending action "${toolName}". ` +
      (rejectReason ? `Reason: ${rejectReason}. ` : '') +
      'Acknowledge this and continue without performing it.'
    )
  }
  if (approvalStatus === 'expired') {
    return (
      `[Resumed after approval] The approval request for "${toolName}" expired before ` +
      'the user responded — the action was not performed. Let the user know.'
    )
  }

  // approvalStatus === 'approved' → run the frozen tool call.
  const tool = tools.get(toolName)
  if (!tool) {
    return (
      `[Resumed after approval] The approved action "${toolName}" could not run — ` +
      'the tool is no longer available. Tell the user the action did not complete.'
    )
  }
  let input: unknown
  try {
    input = tool.inputSchema.parse(params.suspendedToolInput)
  } catch (err) {
    return (
      `[Resumed after approval] The approved action "${toolName}" could not run — ` +
      `its arguments are no longer valid (${err instanceof Error ? err.message : String(err)}). ` +
      'Tell the user the action did not complete.'
    )
  }
  try {
    const result = await tool.execute(input, context)
    const resultText =
      typeof result.data === 'string' ? result.data : JSON.stringify(result.data)
    if (result.isError) {
      return (
        `[Resumed after approval] The user approved "${toolName}", but it failed: ` +
        `${resultText}. Tell the user it did not complete.`
      )
    }
    return (
      `[Resumed after approval] The user approved "${toolName}" and it executed ` +
      `successfully. Result:\n${resultText}\n\nReport the outcome to the user and continue.`
    )
  } catch (err) {
    // Live-authority loss is a structural withholding signal. Converting it
    // into ordinary prose would feed a possibly executed external action back
    // into the model and could invite an unsafe retry.
    if (err instanceof AuthorityChangedError) throw err
    return (
      `[Resumed after approval] The user approved "${toolName}" but it threw an error: ` +
      `${err instanceof Error ? err.message : String(err)}. Tell the user it did not complete.`
    )
  }
}

export function createSessionResumeReplay(deps: SessionResumeReplayDeps): SessionResumeReplay {
  const model = deps.model ?? 'gemini-flash'

  return async function replay(params: ResumeReplayParams): Promise<'completed' | 'deferred'> {
    const { sessionId, suspendedToolName, startingAccessCeiling: storedStarting } = params

    if (!storedStarting) throw authorityUnavailable()
    let starting: AccessCeiling
    try {
      if (!storedStarting.workspaceId || !storedStarting.userId) throw authorityUnavailable()
      starting = intersectAccessCeilings(storedStarting, storedStarting)
    } catch {
      throw authorityUnavailable()
    }

    const session = await findSessionById(sessionId)
    if (!session) {
      // Session vanished — nothing to resume. 'completed' so the
      // resume_point is cleaned up rather than retried forever.
      return 'completed'
    }
    const assistant = await findAssistantById(session.assistantId)
    if (!assistant) return 'completed'

    if (!assistant.workspaceId
      || session.userId !== starting.userId
      || assistant.workspaceId !== starting.workspaceId) throw authorityUnavailable()

    let current: AccessCeiling
    let turnScope: ResolvedTurnScope
    try {
      const live = await resolveLiveAccessCeilingSystem({
        userId: session.userId,
        assistant,
        workspaceId: assistant.workspaceId,
        session,
      })
      const resolved = await resolveTurnScopeSystem({
        userId: session.userId,
        assistant,
        workspaceId: assistant.workspaceId,
        session,
      })
      current = intersectAccessCeilings(live, pinAccessCeiling(resolved.access))
      if (!accessCeilingContains(current, starting)) throw authorityUnavailable()
      const bounded = intersectAccessCeilings(current, starting)
      if (!scopeGrantContains(bounded.mutationCompartments, resolved.writeCompartments)
        || !scopeGrantContains(bounded.projectIds, resolved.writeProjectIds)) throw authorityUnavailable()
      turnScope = {
        ...resolved,
        access: { ...resolved.access, ...bounded },
        effectiveCompartments: bounded.compartments,
        effectiveProjectIds: bounded.projectIds,
      }
    } catch {
      throw authorityUnavailable()
    }

    const bounded = pinAccessCeiling(turnScope.access)
    const context = buildContext(session, assistant, turnScope)
    const lease = createAuthorityLease(bounded, async () => {
      const [freshSession, freshAssistant] = await Promise.all([
        findSessionById(sessionId),
        findAssistantById(session.assistantId),
      ])
      if (!freshSession || !freshAssistant
        || freshSession.userId !== starting.userId
        || freshSession.assistantId !== assistant.id
        || freshAssistant.workspaceId !== starting.workspaceId) return null
      try {
        return await resolveLiveAccessCeilingSystem({
          userId: freshSession.userId,
          assistant: freshAssistant,
          workspaceId: freshAssistant.workspaceId,
          session: freshSession,
        })
      } catch {
        return null
      }
    })

    const executeReplay = async (): Promise<'completed' | 'deferred'> => {
      await assertCurrentAuthority()
      const policy = resolveDurableResumePolicy(params, model)
      const customLlm = params.selectedCustomModel && deps.resolveWorkspaceCustomLlm && !params.selectedLegacyByo
        ? await deps.resolveWorkspaceCustomLlm({
            workspaceId: assistant.workspaceId!,
            requestedModel: params.selectedCustomModel,
            requestedTier: policy.logicalTier,
          })
        : null
      await assertCurrentAuthority()
      if (params.selectedCustomModel && !customLlm) {
        throw new Error('The custom model selected for this suspended turn is no longer available.')
      }
      let continuationProvider = customLlm?.provider ?? deps.provider
      let providerKeySource: 'user' | 'platform' = customLlm ? 'user' : 'platform'
      if (params.selectedLegacyByo) {
        if (!deps.resolveWorkspaceByoGeminiKey || !deps.buildWorkspaceProvider) {
          throw new Error('The legacy BYO Gemini runtime for this suspended turn is unavailable.')
        }
        const key = await deps.resolveWorkspaceByoGeminiKey(assistant.workspaceId!)
        await assertCurrentAuthority()
        if (!key) throw new Error('The legacy BYO Gemini key for this suspended turn is unavailable.')
        continuationProvider = deps.buildWorkspaceProvider(key)
        providerKeySource = 'user'
      }
      const runtimeContext = customLlm
        ? {
            ...context,
            workerRuntime: {
              provider: customLlm.provider,
              model: customLlm.selector,
              modelTier: customLlm.modelTier,
              providerKeySource: customLlm.providerKeySource,
              inputTokenLimit: customLlm.inputTokenLimit,
              maxTokens: customLlm.maxTokens,
            },
          }
        : context

      // Phase 3 of askQuestion suspend-resume — rehydrate the worker
      // manager from `worker_runs` before any continuation output.
      if (deps.workerManager && deps.workerRunsStore) {
        deps.workerManager.setPersistence({
          store: deps.workerRunsStore,
          sessionId,
          workspaceId: assistant.workspaceId!,
        })
        try {
          const { respawned, notificationsReady } = await executeWithCurrentAuthority(() =>
            deps.workerManager!.rehydrate(
              sessionId,
              { ...runtimeContext, workerManager: undefined },
              deps.tools,
            ))
          if (respawned > 0 || notificationsReady > 0) {
            deps.analytics?.logEvent({
              userId: session.userId,
              sessionId,
              eventName: 'session_resume_workers_rehydrated',
              channelType: 'web',
              metadata: { respawned, notifications_ready: notificationsReady },
            })
          }
        } catch (err) {
          if (err instanceof AuthorityChangedError) throw err
          // A non-authority rehydration failure stays non-fatal: the user can
          // still receive a continuation without the missing worker findings.
          console.warn(
            `[session-resume] worker rehydrate failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }

      // ── 1. Resolve the outcome note (runs the approved tool) ──
      const scopedTools = bindToolsToAgentAccess(deps.tools, {
        clearance: bounded.clearance,
        compartments: bounded.compartments,
        mutationCompartments: bounded.mutationCompartments,
        projectIds: bounded.projectIds,
        visibilityAssistantIds: bounded.visibilityAssistantIds,
      })
      const outcomeNote = await resolveResumeOutcomeNote(scopedTools, params, context)
      await assertCurrentAuthority()

      // ── 2. Rebuild the conversation, append the outcome note ──
      const dbMessages = await getSessionMessages(sessionId)
      await assertCurrentAuthority()
      const history = ensureToolResultPairing(toStampedMessages(dbMessages, 'UTC') as Message[])
      const messages: Message[] = [
        ...history,
        { role: 'user', content: [{ type: 'text', text: outcomeNote }] },
      ]

      await executeWithCurrentAuthority(() => addSessionMessage({
        sessionId,
        role: 'system',
        content: [{ type: 'text', text: outcomeNote }],
      }))

      // ── 3. Drive the continuation turn ──
      const baseSystemPrompt = assistant.systemPrompt
        ? `${deps.systemPrompt}\n\n${assistant.systemPrompt}`
        : deps.systemPrompt
      const activeWorkspaceContext = formatActiveWorkspaceContext(turnScope)
      const systemPrompt = activeWorkspaceContext
        ? `${baseSystemPrompt}\n\n${activeWorkspaceContext}`
        : baseSystemPrompt

      for await (const event of queryLoop({
        ledger: createTurnLedger({
          workspaceId: runtimeContext.workspaceId ?? null,
          assistantId: runtimeContext.assistantId,
          sessionId: runtimeContext.sessionId,
          payloads: getLedgerPayloadStore(),
        }).ledger,
        provider: continuationProvider,
        model: customLlm?.selector ?? policy.logicalModel,
        maxTokens: customLlm?.maxTokens,
        inputTokenLimit: customLlm?.inputTokenLimit,
        systemPrompt,
        messages,
        tools: scopedTools,
        context: deps.workerManager
          ? { ...runtimeContext, workerManager: deps.workerManager }
          : runtimeContext,
        channelType: session.channelType,
        resumeContext: {
          approvalId: params.approvalId,
          suspendedToolName,
          loopStepIndex: params.loopStepIndex,
        },
        ...(policy.budget ?? {}),
      })) {
        // The replay is not an interactive stream. No generated event may be
        // accepted or persisted after authority changes.
        await assertCurrentAuthority()
        if (event.type === 'turn_complete') {
          await executeWithCurrentAuthority(() => addSessionMessage({
            sessionId,
            role: 'assistant',
            content: event.response.content,
          }))
          if (deps.usageStore && event.totalUsage) {
            const usage = event.totalUsage
            const turnKeySource: 'user' | 'platform' = customLlm?.providerKeySource ?? providerKeySource
            void deps.usageStore.recordUsage({
              userId: session.userId,
              assistantId: assistant.id,
              workspaceId: assistant.workspaceId!,
              sessionId,
              model: event.response.model,
              modelTier: policy.logicalTier,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
              actualCostUsd: turnKeySource === 'user'
                ? 0
                : calculateCost(event.response.model, usage),
              source: 'included',
              triggerKey: 'session_resume',
              providerKeySource: turnKeySource,
            }).catch((err) => console.error('[session-resume] usage tracking failed:', err))
          }
        } else if (event.type === 'error') {
          throw event.error
        }
      }

      await assertCurrentAuthority()
      return 'completed'
    }
    return runWithAgentAccess(bounded, () => runWithAuthorityLease(lease, executeReplay))
  }
}
