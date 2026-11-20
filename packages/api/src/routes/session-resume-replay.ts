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

import { withTurnInference } from '../turn/runtime.js'
import { renderCharterBlock, resolveCharter } from '@use-brian/shared'
import { openAssistantTurn, openTurnSqlScope, turnUsageIdentity, type TurnSqlScope } from '../turn/kernel.js'
import { resolveTurnBilling } from '../turn/billing.js'
import type { ResumeSlotWaitOptions } from '../turn/resume-recovery.js'
import type { ResumeCapabilityParams } from '../turn/capabilities.js'
import { createTurnLedger } from '../ledger/recorder.js'
import { noopPublishSessionEvent, type PublishSessionEvent } from '../session-event-port.js'
import { createTurnStreamPublisher, publishTurnCompleted } from '../session-live-publisher.js'
import { getLedgerPayloadStore } from '../ledger/runtime.js'
import type { AnalyticsLogger } from '@use-brian/core/analytics/logger.js'
import { calculateCost, type UsageStore } from '@use-brian/agent-runtime/billing/cost-tracker.js'
import { ensureToolResultPairing } from '@use-brian/agent-runtime/engine/tool-pairing.js'
import type {
  LLMProvider,
  ContentBlock,
  Message,
} from '@use-brian/agent-runtime/providers/types.js'
import {
  accessCeilingContains,
  intersectAccessCeilings,
  pinAccessCeiling,
  type AccessCeiling,
} from '@use-brian/agent-runtime/security/access-ceiling.js'
import {
  ContextScopeAccumulator,
  scopeGrantContains,
} from '@use-brian/agent-runtime/security/context-scope.js'
import {
  createExecutionContext,
  executionToolContext,
  type ExecutionContext,
} from '@use-brian/agent-runtime/security/execution-context.js'
import { SensitivityAccumulator } from '@use-brian/agent-runtime/security/sensitivity.js'
import { boundScopeSource } from '@use-brian/agent-runtime/security/source-evidence.js'
import type { Tool, ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import { classifySession, normalizeSessionVisibility, policyFor, sessionAuthorityDestinationMatches, usesStoredPrivateChat } from '../session-kind.js'
import {
  findSessionById,
  addSessionMessage,
  toStampedMessages,
  type Session,
} from '../db/sessions.js'
import {
  createDeliveryAudienceAuthorizer,
  DeliveryAudienceUnverifiedError,
} from '../context-scope/delivery-authority.js'
import { roomAudienceCeiling } from './_room-binding.js'
import { admitVerifiedPersonalResumeAudience, admitVerifiedSharedRoomResumeEvidence } from '../context-scope/native-invocation-evidence.js'
import { findAssistantById } from '../db/users.js'
import type { SessionResumeReplay, ResumeReplayParams } from './chat.js'
import { MODEL_MAP, chatTierBudget, tierForModel } from '../model-resolution.js'
import {
  formatActiveWorkspaceContext,
  resolveLiveAccessCeilingSystem,
  resolveTurnScopeSystem,
  sessionMessageInputScope,
  turnOutputWrite,
  type ResolvedTurnScope,
} from '../context-scope/resolve-turn-scope.js'
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
  /** The deployment's configured providers; the turn kernel serves the continuation through `ensureServableModel`. */
  configuredProviders?: import('@use-brian/shared/model-registry').ProviderAvailability
  resolveWorkspaceByoGeminiKey: ((workspaceId: string) => Promise<string | null>) | null
  buildWorkspaceProvider: ((apiKey: string) => LLMProvider) | null
  usageStore?: UsageStore
  /** Boot-time tool registry — the base candidates; the suspended tool is resolved from here. */
  tools: Map<string, Tool>
  /**
   * Connector stores for the `resume` capability profile (M3 catalog). The owner
   * prepares the roster through `prepareCapabilities`, which activates exactly
   * the suspended tool. Absent on a deployment with no connector stores: the
   * candidates are the boot registry only, still bound by the same owner.
   */
  capabilityStores?: Omit<ResumeCapabilityParams, 'userId' | 'assistantId' | 'tools' | 'executionContext' | 'scopeAccumulator'
    | 'contextScope' | 'assistantTeamId' | 'suspendedToolName' | 'connectorTarget'>
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
  workerManager?: import('@use-brian/core/workers/worker.js').WorkerManager
  workerRunsStore?: import('@use-brian/core/workers/worker.js').WorkerRunsStore
  /**
   * Session live-event bus. Resume has no direct client stream, so it mirrors
   * `turn_started`, throttled `turn_stream` snapshots and `turn_completed`
   * (with reason) for every resumed session, personal included. Default no-op;
   * the composition root passes the real bus.
   */
  publishSessionEvent?: PublishSessionEvent
  /**
   * Predecessor-lease slot wait tuning. Production omits it: the staleness
   * window is `TURN_LEASE_STALE_AFTER_MS`, the bound `TURN_SLOT_WAIT_TIMEOUT_MS`.
   */
  resumeSlotWait?: ResumeSlotWaitOptions
}

type AssistantRow = NonNullable<Awaited<ReturnType<typeof findAssistantById>>>


/**
 * The resumed suspension's canonical execution (D9): a system `session_resume`
 * execution keyed by its approval, over the stored starting ceiling intersected
 * with the current one (`bounded`), bound to the replay's live authority lease.
 * Nothing is widened or fabricated: the human is not re-attended, the ceiling is
 * the one already checked against the saved suspension, and every effect keeps
 * its fresh lease check. Web, channel, public and callee bind their own
 * canonical executions the same way; the owner prepares and runs all of them.
 */
function resumeExecution(
  session: Session,
  assistant: AssistantRow & { workspaceId: string },
  approvalId: string,
  turnScope: ResolvedTurnScope,
  bounded: AccessCeiling,
  lease: ReturnType<typeof createAuthorityLease>,
  abortSignal: AbortSignal,
): ExecutionContext {
  return createExecutionContext({
    identity: { kind: 'system', purpose: 'session_resume', jobId: approvalId },
    ownership: { kind: 'workspace', workspaceId: assistant.workspaceId },
    access: {
      ...turnScope.access,
      ...bounded,
      workspaceId: assistant.workspaceId,
      userId: session.userId,
      assistantId: assistant.id,
      assistantKind: assistant.kind,
      clearance: bounded.clearance,
      compartments: bounded.compartments,
      mutationCompartments: bounded.mutationCompartments,
      projectIds: bounded.projectIds,
      visibilityAssistantIds: bounded.visibilityAssistantIds
        ?? (assistant.kind === 'primary' ? null : [assistant.id]),
      // A resumed room, doc-thread or draft turn keeps the shared-audience
      // read rule the original turn ran under (decision D4).
      sharedAudience: turnScope.access.sharedAudience,
    },
    writeDefaults: { compartments: turnScope.writeCompartments, projectIds: turnScope.writeProjectIds },
    authority: lease,
    lifecycle: { abortSignal, sessionId: session.id, channelType: session.channelType, channelId: session.channelId,
      transport: classifySession(session).transport },
  })
}

/** The `ToolContext` shared by the suspended-tool run and the continuation:
 * the execution's canonical projection plus the per-turn accumulators. */
function buildContext(session: Session, turnScope: ResolvedTurnScope, execution: ExecutionContext): ToolContext {
  return {
    ...executionToolContext(execution, { appId: 'Use Brian' }),
    // The session's own human is the actor when the conversation is one a
    // person drives; a machine lane has no workspace actor.
    workspaceActorUserId: classifySession(session).lane === 'conversation' ? session.userId : undefined,
    activeGroupId: turnScope.activeGroupId,
    activeProjectId: turnScope.activeProjectId,
    sensitivity: new SensitivityAccumulator(),
    scopeAccumulator: new ContextScopeAccumulator({
      compartments: turnScope.writeCompartments,
      projectIds: turnScope.writeProjectIds,
    }),
  }
}

/** The closing row a terminal resume failure leaves in the conversation. */
export const RESUME_FAILED_TEXT = "I couldn't continue this conversation after your response, so no reply was written. Send a message to pick up from here."

/** SQLSTATEs PostgreSQL reports only for a transaction it aborted and rolled
 * back: deadlock_detected and serialization_failure. */
const TRANSIENT_TRANSACTION_CODES: ReadonlySet<string> = new Set(['40P01', '40001'])
/** Attempts per resume write transaction, the bound the history reader uses for 40001. */
export const RESUME_WRITE_ATTEMPTS = 4

function transientTransactionCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && TRANSIENT_TRANSACTION_CODES.has(code) ? code : null
}

/**
 * Re-enter one whole resume write transaction after PostgreSQL aborted it for a
 * lock conflict (M5Q-14). `write` is exactly one transaction (the outcome row,
 * the reply publication with its 8277 completion header, or the closing failure
 * row), so the aborted attempt committed nothing and re-entry is idempotent: the
 * same owner, lease token and completion identity write the same rows, and the
 * authority bracket inside `write` is asserted again on every attempt. Any other
 * failure, an uncertain authority outcome or Stop propagates unchanged.
 */
async function retryTransientWrite<T>(signal: AbortSignal, sessionId: string, write: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write()
    } catch (error) {
      const code = transientTransactionCode(error)
      if (!code || attempt >= RESUME_WRITE_ATTEMPTS || signal.aborted) throw error
      console.warn(`[session-resume] ${code} aborted a write for ${sessionId} (attempt ${attempt}); retrying`)
      await new Promise(resolve => setTimeout(resolve, 25 * 2 ** (attempt - 1) + Math.floor(Math.random() * 25)))
      signal.throwIfAborted()
    }
  }
}

function resumeDestinationCurrent(expected: Session, current: Session): boolean {
  return sessionAuthorityDestinationMatches(expected, current)
    && normalizeSessionVisibility(current.visibility) === normalizeSessionVisibility(expected.visibility)
    && current.mode === expected.mode
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
  > & Partial<Pick<ResumeReplayParams, 'approvalId'>>,
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
    const approvedToolInvocation = params.approvalId
      ? { approvalId: params.approvalId, approverUserId: context.userId, toolName }
      : undefined
    const result = await tool.execute(input, {
      ...context,
      approvedToolInvocation,
    })
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
  const model = deps.model ?? MODEL_MAP.pro

  return function replay(params: ResumeReplayParams): Promise<'completed' | 'deferred'> {
    // One request SQL ledger before the owner exists, as on every lane: the
    // replay's own lookups land in the `adapter` frame of the owner's ledger.
    const sqlScope = openTurnSqlScope()
    return sqlScope.run(() => replayInScope(params, sqlScope))
  }

  async function replayInScope(params: ResumeReplayParams, sqlScope: TurnSqlScope): Promise<'completed' | 'deferred'> {
    params = structuredClone(params)
    // Inference wiring through the turn kernel's boot registration.
    const turnDeps = withTurnInference(deps)
    const { sessionId, suspendedToolName, startingAccessCeiling: storedStarting } = params

    if (!storedStarting) throw authorityUnavailable()
    let starting: AccessCeiling
    try {
      if (!storedStarting.workspaceId || !storedStarting.userId) throw authorityUnavailable()
      starting = intersectAccessCeilings(storedStarting, storedStarting)
    } catch {
      throw authorityUnavailable()
    }

    const initialSession = await findSessionById(sessionId)
    if (!initialSession) {
      // Session vanished — nothing to resume. 'completed' so the
      // resume_point is cleaned up rather than retried forever.
      return 'completed'
    }
    const initialAssistant = await findAssistantById(initialSession.assistantId)
    if (!initialAssistant) return 'completed'

    if (!initialAssistant.workspaceId
      || initialSession.userId !== starting.userId
      || initialAssistant.workspaceId !== starting.workspaceId) throw authorityUnavailable()

    const abortController = new AbortController()
    const resumePolicy = policyFor(initialSession)
    const publishSessionEvent = deps.publishSessionEvent ?? noopPublishSessionEvent
    const owner = await openAssistantTurn({
      sessionId,
      policy: resumePolicy,
      abortController,
      resumeRecovery: { workspaceId: initialAssistant.workspaceId, approvalId: params.approvalId, options: deps.resumeSlotWait },
      assistantId: initialAssistant.id,
      // Same stale-takeover notice as web and channel: the reclaimed
      // predecessor's followers see its terminal outcome, never this turn's.
      onReclaimed: recovered => publishTurnCompleted({ sessionId, senderUserId: null, publishSessionEvent,
        turnId: recovered.turnId, reason: recovered.reason }),
      sqlScope,
    })
    // The session's human owns the suspended turn; the bus carries ids only.
    const senderUserId = initialSession.userId
    publishSessionEvent({ kind: 'turn_started', sessionId,
      payload: { senderUserId, assistantId: initialAssistant.id, turnId: owner.turnId } })
    const turnStream = createTurnStreamPublisher({ sessionId, turnId: () => owner.turnId, publishSessionEvent,
      attribution: () => ({ senderUserId, assistantId: initialAssistant.id }) })
    let completed = false
    // Set once the replay holds a live lease: the user-visible outcome of a
    // resume that cannot continue (the job is terminal; nothing retries it).
    let publishFailureOutcome: (() => Promise<void>) | undefined
    try {
      abortController.signal.throwIfAborted()
      // Restart rule (8277): a continuation whose reply already committed (its
      // acknowledgement or resume-point deletion was lost) is never replayed;
      // 'completed' lets the caller delete the resume point. Read after this
      // owner holds the lease, so no predecessor can still be publishing.
      if (await owner.hasCommittedResumePublication()) { completed = true; return 'completed' }
      // A queued replay resumes the current stored destination and scope, after
      // obtaining its slot, rather than preparing against its pre-wait snapshot.
      const admittedSession = await findSessionById(sessionId)
      if (!admittedSession) { completed = true; return 'completed' }
      const admittedAssistant = await findAssistantById(admittedSession.assistantId)
      if (!admittedAssistant) { completed = true; return 'completed' }
      if (admittedSession.userId !== starting.userId
        || admittedSession.assistantId !== initialAssistant.id
        || !resumeDestinationCurrent(initialSession, admittedSession)
        || admittedAssistant.workspaceId !== starting.workspaceId) throw authorityUnavailable()
      const session = admittedSession
      const assistant = admittedAssistant
      abortController.signal.throwIfAborted()
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
          // A resumed room, doc-thread or draft turn keeps the shared-audience
          // read rule the original turn ran under (decision D4).
          access: { ...resolved.access, ...bounded, ...(!policyFor(session).context.personalMemory ? { sharedAudience: true } : {}) },
          effectiveCompartments: bounded.compartments,
          effectiveProjectIds: bounded.projectIds,
        }
      } catch {
        abortController.signal.throwIfAborted()
        throw authorityUnavailable()
      }

      abortController.signal.throwIfAborted()
      const bounded = pinAccessCeiling(turnScope.access)
      // The bounded ceiling stays inside the saved suspension and its actor/workspace.
      if (!accessCeilingContains(starting, bounded) || bounded.userId !== session.userId
        || bounded.workspaceId !== assistant.workspaceId) throw authorityUnavailable()
      const lease = createAuthorityLease(bounded, async () => {
        const [freshSession, freshAssistant] = await Promise.all([
          findSessionById(sessionId),
          findAssistantById(session.assistantId),
        ])
        if (!freshSession || !freshAssistant
          || freshSession.userId !== starting.userId
          || freshSession.assistantId !== assistant.id
          || !resumeDestinationCurrent(session, freshSession)
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

      const assertReplayCurrent = async () => {
        abortController.signal.throwIfAborted()
        await assertCurrentAuthority()
        abortController.signal.throwIfAborted()
      }
      const resumeEnvelope = sessionMessageInputScope({
        scope: turnScope,
        workspaceId: assistant.workspaceId,
        userId: session.userId,
        sharedAudience: !policyFor(session).context.personalMemory,
      })
      const execution = resumeExecution(session, { ...assistant, workspaceId: assistant.workspaceId! }, params.approvalId,
        turnScope, bounded, lease, abortController.signal)
      const context = buildContext(session, turnScope, execution)
      const sessionKind = classifySession(session)
      const roomRecipient = session.channelType === 'web' && sessionKind.audience === 'workspace'
        && sessionKind.anchor.kind === 'none' && sessionKind.surface === 'chat'
        ? roomAudienceCeiling(assistant.workspaceId, session) : undefined
      const personalWebChat = usesStoredPrivateChat(session)
      const bindFailureOutcome = (evidence?: import('@use-brian/agent-runtime/security/context-scope.js').ScopeEvidence) => {
        if (!resumeEnvelope) return
        publishFailureOutcome = async () => {
          await owner.publish({ disposition: 'closing', native: null, write: { scope: resumeEnvelope },
            ...(roomRecipient && evidence ? { sharedRoomResume: { execution, evidence, recipient: roomRecipient } } : {}),
            execute: operation => retryTransientWrite(abortController.signal, sessionId, () => lease.execute(operation)),
            rows: [{ role: 'assistant', senderAssistantId: assistant.id, content: [{ type: 'text', text: RESUME_FAILED_TEXT }] }] })
        }
      }
      if (!roomRecipient) bindFailureOutcome()
      owner.bindModelPreparation({ kind: 'execution', toolProfile: 'resume', execution, assertCurrent: assertReplayCurrent }, {
        provider: deps.provider, configuredProviders: turnDeps.configuredProviders,
        resolveWorkspaceCustomLlm: turnDeps.resolveWorkspaceCustomLlm?.bind(turnDeps) ?? null,
        resolveLegacyByoKey: deps.resolveWorkspaceByoGeminiKey?.bind(deps) ?? null,
        buildLegacyByoProvider: deps.buildWorkspaceProvider?.bind(deps) ?? null,
      })
      const executeReplay = async (): Promise<'completed' | 'deferred'> => {
        await assertReplayCurrent()
        const preparedModel = await owner.prepareMainModel({ kind: 'resume', fallbackModel: model,
          selectedTier: params.selectedTier, selectedCustomModel: params.selectedCustomModel,
          selectedLegacyByo: params.selectedLegacyByo, selectedMeteredModel: params.selectedMeteredModel })
        const policy = { logicalModel: preparedModel.logicalModel, logicalTier: preparedModel.logicalTier, budget: preparedModel.budget }
        const customLlm = preparedModel.customLlm
        const providerKeySource = preparedModel.providerKeySource
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
                params.workerRunIds,
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
        // The roster comes from the owner's capability port (profile `resume`,
        // exactly the suspended tool), then binds through the same invocation.
        const candidates = new Map(deps.tools)
        if (deps.capabilityStores && params.approvalStatus === 'approved' && params.approvalKind !== 'question') {
          await owner.prepareCapabilities({ profile: 'resume', composition: { kind: 'resume', params: {
            ...deps.capabilityStores, userId: session.userId, assistantId: assistant.id, tools: candidates,
            executionContext: execution, scopeAccumulator: context.scopeAccumulator as ContextScopeAccumulator,
            assistantTeamId: assistant.workspaceId ?? null, contextScope: turnScope, suspendedToolName,
            connectorTarget: params.connectorTarget } } })
          await assertReplayCurrent()
        } else if (params.connectorTarget) {
          candidates.delete(suspendedToolName)
        }
        const scopedTools = owner.prepareTools(candidates)
        await assertReplayCurrent()
        const scopeAccumulator = context.scopeAccumulator as ContextScopeAccumulator
        // A shared room checks the original checkpoint and retained dialogue
        // before the approved tool can produce an effect.
        const readHistory = async () => {
          const { messages } = await owner.prepareHistory({ native: null, evidence: scopeAccumulator })
          await assertReplayCurrent()
          return messages
        }
        const roomHistory = roomRecipient ? await readHistory() : undefined
        if (roomRecipient) {
          scopeAccumulator.note(await admitVerifiedSharedRoomResumeEvidence(execution, scopeAccumulator.evidence, bounded, 'caller'))
          bindFailureOutcome(scopeAccumulator.evidence)
        }
        const outcomeNote = await resolveResumeOutcomeNote(scopedTools, params, context)
        await assertReplayCurrent()

        // ── 2. Rebuild the conversation, append the outcome note ──
        const dbMessages = roomHistory ?? await readHistory()
        const history = ensureToolResultPairing(toStampedMessages(dbMessages, 'UTC') as Message[])
        const messages: Message[] = [
          ...history,
          { role: 'user', content: [{ type: 'text', text: outcomeNote }] },
        ]

        // A shared room records the answer note with its admitted reply. The
        // publication transaction supplies its durable source edge.
        if (!roomRecipient) {
          const outcomeWrite = turnOutputWrite({
            producer: 'turn:resume-outcome',
            accumulator: scopeAccumulator,
            envelope: resumeEnvelope,
          })
          const storedOutcome = await retryTransientWrite(abortController.signal, sessionId, () => executeWithCurrentAuthority(() => addSessionMessage({
            sessionId,
            role: 'system',
            content: [{ type: 'text', text: outcomeNote }],
            ...outcomeWrite,
          })))
          const outcomeSource = boundScopeSource(storedOutcome)
          if (outcomeSource) scopeAccumulator.noteSource(outcomeSource)
        }

        // ── 3. Drive the continuation turn ──
        // Layer 2 is the charter block every runner renders, not the legacy
        // `system_prompt` column (which a post-418 write no longer updates).
        const charterBlock = renderCharterBlock(resolveCharter(assistant))
        const baseSystemPrompt = charterBlock
          ? `${deps.systemPrompt}\n\n${charterBlock}`
          : deps.systemPrompt
        const activeWorkspaceContext = formatActiveWorkspaceContext(turnScope)
        const systemPrompt = activeWorkspaceContext
          ? `${baseSystemPrompt}\n\n${activeWorkspaceContext}`
          : baseSystemPrompt

        const authorizeResumeAudience = createDeliveryAudienceAuthorizer(roomRecipient ? {
          validateEvidence: (evidence, recipient) => admitVerifiedSharedRoomResumeEvidence(execution, evidence, recipient, 'audience'),
        } : personalWebChat ? {
          validateEvidence: (evidence, recipient) => admitVerifiedPersonalResumeAudience(execution, evidence, recipient),
        } : {})
        const admitResumeAudience = async () => {
          const audience = await authorizeResumeAudience({
            workspaceId: assistant.workspaceId!, assistantId: assistant.id,
            userId: session.userId, channelType: session.channelType, channelId: session.channelId,
            sessionId, scopeEvidence: scopeAccumulator.evidence,
          })
          if (!audience.allowed) throw new DeliveryAudienceUnverifiedError(audience.detail, audience.diagnostic)
          return audience.evidence
        }
        // D2: the continuation bills like the turn it resumes.
        const resumeBilling = await resolveTurnBilling({
          policy: resumePolicy,
          assistant: { id: assistant.id, ownerUserId: assistant.ownerUserId, workspaceId: assistant.workspaceId },
          actorUserId: session.userId,
        })
        if (deps.usageStore) owner.registerUsageBilling({
          metadata: {
            ...turnUsageIdentity(resumeBilling), assistantId: assistant.id, workspaceId: assistant.workspaceId!,
            sessionId, modelTier: policy.logicalTier, source: 'included', triggerKey: 'session_resume',
            providerKeySource: customLlm?.providerKeySource ?? providerKeySource,
          },
          costPolicy: 'reported_or_calculated', recordUsage: deps.usageStore.recordUsage.bind(deps.usageStore),
          onError: error => console.error('[session-resume] usage tracking failed:', error),
        })
        await assertReplayCurrent()
        // Final assembly belongs to the original owner, as on every lane: its
        // canonical execution, captured admission and the accepted Brief. The
        // owner supplies the prompt, messages, adopted tools and model limits.
        await owner.prepareRun({ systemPrompt, messages, candidateTools: scopedTools })
        let finalContent: ContentBlock[] | null = null
        await owner.run({

          loop: {
          ledger: createTurnLedger({
            workspaceId: runtimeContext.workspaceId ?? null,
            assistantId: runtimeContext.assistantId,
            sessionId: runtimeContext.sessionId,
            payloads: getLedgerPayloadStore(),
          }).ledger,
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
          },
          sink: { kind: 'none', ...(personalWebChat ? { admitOutput: async () => {
            scopeAccumulator.note(await admitResumeAudience())
          } } : {}), onEvent: async (event) => {
          // The replay is not an interactive stream. No generated event may be
          // accepted or persisted after authority changes.
          await assertReplayCurrent()
          // Mirror the admitted event for a following client (throttled snapshot).
          if (event.type === 'text_delta') turnStream.onTextDelta(event.text)
          else if (event.type === 'thinking_delta') turnStream.onReasoningDelta(event.text)
          else if (event.type === 'tool_start') turnStream.onToolStart(event.name)
          if (event.type === 'turn_complete') {
            turnStream.setReplyPhase('saving')
            // The continuation's output reaches the session's audience like any
            // turn's: judge its evidence against that audience first.
            if (!personalWebChat) await admitResumeAudience()
            finalContent = event.response.content
          } else if (event.type === 'error') {
            throw event.error
          }
          }, afterLoop: async () => {
            // The owner's one reply publication, as on every lane (turn-kernel.md
            // "Reply publication"). A system execution holds no native
            // transcript authority, so the owner uses its stored writer.
            if (!finalContent) return
            await owner.publish({ disposition: 'reply', rows: [{ role: 'assistant', content: finalContent, senderAssistantId: assistant.id }],
              ...(roomRecipient ? { sharedRoomResume: { execution, evidence: scopeAccumulator.evidence, recipient: roomRecipient, outcomeNote } } : {}),
              completion: { lane: 'resume', input: { kind: 'approval', ref: params.approvalId }, assistantId: assistant.id },
              write: turnOutputWrite({ producer: 'turn:resume-output', accumulator: scopeAccumulator, envelope: resumeEnvelope }),
              native: null,
              // One transaction with its completion header: a lock-conflict abort committed nothing.
              execute: operation => retryTransientWrite(abortController.signal, sessionId, () => executeWithCurrentAuthority(operation)) })
          } },
        })

        await assertReplayCurrent()
        return 'completed'
      }
      const result = await runWithAgentAccess(bounded, () => runWithAuthorityLease(lease, executeReplay))
      completed = result === 'completed'
      return result
    } catch (error) {
      // A stopped continuation is consumed without producing another outcome or
      // automatically replaying its approved action. Structural/uncertain tool
      // failures retain their existing withholding and retry contract.
      if (owner.abortKind === 'stop' && error === abortController.signal.reason) return 'completed'
      // A resume that cannot continue is terminal (the job is not retried; its
      // own writes already re-entered lock-conflict aborts, `retryTransientWrite`),
      // so the conversation records that no reply follows instead of going silent.
      // Lease loss, Stop and a refused or uncertain authority write nothing.
      // A committed or possibly committed reply is never followed by this note.
      const state = owner.completion.state
      const authorityRefused = error instanceof AuthorityChangedError || error instanceof DeliveryAudienceUnverifiedError
        || (error as { reason?: unknown } | null)?.reason === 'authority_changed'
      if (publishFailureOutcome && !authorityRefused && owner.abortKind === null && (state === 'unpublished' || state === 'refused')) {
        try { await publishFailureOutcome() }
        catch (noteError) { console.warn(`[session-resume] failure outcome not recorded for ${sessionId}: ${noteError instanceof Error ? noteError.message : String(noteError)}`) }
      }
      throw error
    } finally {
      try {
        await owner.finish(owner.abortKind === 'stop' ? 'stopped_by_user' : completed && !abortController.signal.aborted ? 'completed' : 'failed')
      } finally {
        // Only a confirmed exact-owner release emits lifecycle completion.
        if (owner.released) publishTurnCompleted({ sessionId, senderUserId, publishSessionEvent, turnId: owner.turnId,
          ...(owner.completionReason && owner.completionReason !== 'completed' ? { reason: owner.completionReason } : {}) })
      }
    }
  }
}
