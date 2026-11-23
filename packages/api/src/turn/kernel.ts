/**
 * The turn kernel: ONE lifecycle for every assistant turn (unified-sessions
 * D14). Every runner (web chat, messaging channels, the public API, A2A /
 * workflow `assistant_call`, resume replay) is a thin adapter: it parses its
 * inbound request, names its principal, assembles its prompt and tools, and
 * hands the kernel a SINK. The kernel owns everything else:
 *
 *   1. admission + the turn lease, per `sessionPolicy(kind).admission`,
 *      heart-beaten and released in `finally` on success, throw and abort;
 *   2. the budget gate;
 *   3. model servability (`ensureServableModel` against the deployment's
 *      configured providers, unless a workspace custom endpoint serves);
 *   4. `queryLoop` under the stall watchdog (`stallIdleMs`, never a wall
 *      clock; CLAUDE.md "Bounding agentic work");
 *   5. final-text selection (`TurnOutputCollector`), sanitized with
 *      `sanitizeDeliveryText` for final-only sinks;
 *   6. the payer/actor of every usage row (`turnUsageRow`).
 *
 * Sinks:
 *   - `sse`     the web chat stream (renders every event itself);
 *   - `adapter` a messaging channel (final text only, sanitized);
 *   - `json`    the public API response (final text only, sanitized);
 *   - `return`  an A2A / workflow callee (final text returned, sanitized);
 *   - `none`    resume replay (persists, delivers nothing).
 *
 * `queryLoop(` is called from here and nowhere else a turn runs (graded by
 * `invariants/turn-kernel`).
 *
 * Spec: docs/architecture/engine/turn-kernel.md.
 *
 * [COMP:api/turn-kernel]
 */
import { z } from 'zod'
import { NO_TOOL_TIMEOUT } from '@use-brian/agent-runtime/engine/tool-executor.js'
import type { DiscoveredQueryContext } from '@use-brian/agent-runtime/engine/query-loop.js'
import type { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import { queryLoop } from '@use-brian/core/engine/query-loop-defaults.js'
import type { SessionContextAuthority } from '@use-brian/core/memory/session-state-types.js'
import type { QueryOutputProvenance } from '@use-brian/agent-runtime/engine/output-provenance.js'
import {
  assertModelOutputAuthority,
  CONVERSATION_CONTEXT_TOOL,
  type QueryEvent,
  type QueryLoopOptions,
  type QueryUsageSnapshot,
} from '@use-brian/agent-runtime/engine/query-loop.js'
import { DEFAULT_STALL_IDLE_MS } from '@use-brian/agent-runtime/engine/stall-watchdog.js'
import {
  createTurnOutputCollector,
  type TurnOutputCollector,
  type TurnOutputFormat,
  type TurnOutputSelection,
  type FinalizedOutputSelection,
} from '@use-brian/agent-runtime/engine/turn-output.js'
import type { ContentBlock, Message } from '@use-brian/agent-runtime/providers/types.js'
import { inheritScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import type { ToolContext, Tool } from '@use-brian/agent-runtime/tools/types.js'
import {createTerminalPublicationOwner} from './terminal-publication.js'
import { committedTurnCompletion, type BufferedWebPublication } from '../db/conversation-publication-recovery.js'
import { sanitizeDeliveryText } from '@use-brian/shared'
import type { ProviderAvailability } from '@use-brian/shared/model-registry'
import type { ResolvedWorkspaceCustomLlm } from '../custom-llm-runtime.js'
import { ensureServableModel } from '../model-resolution.js'
import { admitModelSourceEvidence } from '../application-platform/model-source-authority.js'
import type { SessionPolicy } from '../session-kind.js'
import { ownsTurnDeliveryAdmission, type TurnDeliveryAdmission } from '../context-scope/admission.js'
import { openTurnAdmissionClosure, type AdmissionClosureStats, type TurnAdmissionClosure } from '../context-scope/admission-closure.js'
import { registerTurnAbort, releaseTurn, startLeaseHeartbeat, takeTurnLease, unregisterTurnAbort,TurnLeaseLostError,TurnStoppedError,turnAbortKind } from './lease.js'
import { captureTurnUsageBilling, type TurnBilling, type TurnUsageBilling, type TurnUsageSettlement, type PriorTurnSpend } from './billing.js'
import { bindSessionTurnAuthority,isAuthorityChangedError } from '../context-scope/authority-lease.js'
import { bindVerifiedResumeEvidence } from '../context-scope/native-invocation-evidence.js'
import { findSessionTurnLeaseState, type TurnEndReason, type RecoveredTurn } from '../db/sessions.js'
import { registerTurnInbox, type TurnInboxHandle } from '../turn-inbox.js'
import { randomUUID } from 'node:crypto'
import { currentTurnFrame, readTurnSqlLedger, turnSqlRecordingEnabled, withTurnFrame, type TurnSqlLedger } from '../db/turn-sql-accounting.js'
import type { SessionMessage } from '../db/sessions.js'
import { writeTurnPublication, type TurnPublicationRequest } from './publication.js'
import { captureCapabilityComposition, type TurnCapabilityProfile, type TurnCapabilityRequest, type TurnCapabilityResult } from './capabilities.js'
import { captureTurnHistory, type CapturedTurnHistory, type TurnHistoryRequest } from './history.js'
import { resumePredecessorSlotWait, type ResumeSlotWaitOptions } from './resume-recovery.js'
import { composeRecoveryMessage, type ComposeRecoveryMessageResult, type RecoveryPendingTurn } from './recovery-message.js'
import { captureTurnModelPreparation, type TurnModelInvocation, type TurnModelServices, type TurnMainModelRequest, type PreparedTurnModel,
  type TurnRunPreparationInput, type PreparedTurnRun, type PreparedBackgroundModel } from './prepare.js'

export type TurnSinkKind = 'sse' | 'adapter' | 'json' | 'return' | 'none'

/** Sinks that deliver only the final text, outside any client render layer. */
const FINAL_ONLY_SINKS: ReadonlySet<TurnSinkKind> = new Set(['adapter', 'json', 'return'])

export type TurnSink = {
  kind: TurnSinkKind
  /** Host-only complete admission: live authority, sources and actual recipient.
   * It must validate all accumulated evidence, not only recipient identity.
   * An adapter receives the event kind to identify private processing before
   * its external send. Outward events still require the destination proof.
   * Omission keeps the kernel's current source-delivery validator.
   */
  admitOutput?: (context: ToolContext, eventKind?: QueryEvent['type']) => Promise<void>
  /** Exact destination owner for this turn; no permission selections or receipts.
   * Input and writer authority retain their independent guards.
   */
  permissionContext?: TurnDeliveryAdmission
  /** Observational timing only; mutation of authority/evidence refuses output. */
  onOutputAuthorityTiming?: (milliseconds:number)=>void
  /** Every engine event, in order. The `sse` sink renders them; others may observe. */
  onEvent?: (event: QueryEvent, provenance?: QueryOutputProvenance) => void | Promise<void>
  /** SSE display only: final text is selected, but cleanup/publication still follow. */
  onReplyTextComplete?: () => void
  /**
   * Runs after a clean loop while the lease is still held: flush buffered
   * turns, persist the reply. A throw here still releases the lease.
   */
  afterLoop?: (result: TurnLoopResult) => void | Promise<void>
}

/** The kernel's typed refusal: render it on the sink; nothing ran. */
export class TurnRefusal extends Error {
  constructor(readonly code: 'turn_in_flight' | 'room_turn_wait_timeout' | 'budget_blocked', message?: string) {
    super(message ?? code)
    this.name = 'TurnRefusal'
  }
}

export type TurnModel = {
  provider: QueryLoopOptions['provider']
  model: string
  /**
   * The deployment's configured providers, or `undefined` in a test harness.
   * A REQUIRED key: a runner that forgets it lets the kernel serve a model no
   * configured provider can serve (the executor's hard-coded `gemini-flash`).
   */
  configuredProviders: ProviderAvailability | undefined
  /**
   * What `resolveWorkspaceCustomLlm` returned for this turn (`null` = none
   * applies). A REQUIRED key, so a runner cannot silently skip the workspace
   * custom endpoint (CLAUDE.md "Workspace custom LLM must reach every channel
   * turn").
   */
  customLlm: ResolvedWorkspaceCustomLlm | null
}

export type TurnLoopResult = {
  /** The final-text selection, before sanitization. */
  selection: TurnOutputSelection
  /** The sanitized final text for a final-only sink; null otherwise or when empty. */
  finalText: string | null
  aborted: boolean
}

const finalizedOutputs = new WeakMap<TurnLoopResult, { output: FinalizedOutputSelection; signal: AbortSignal }>()
/** Actual kernel result only. Metadata is not a terminal intent or publication grant. */
export function finalizedTurnOutput(result: TurnLoopResult): FinalizedOutputSelection | null {
  const bound = finalizedOutputs.get(result)
  return bound && !bound.signal.aborted ? structuredClone(bound.output) : null
}

export type AssistantTurnLoopInput = {
  sessionId: string
  policy: Pick<SessionPolicy, 'admission'>
  sink: TurnSink
  abortController: AbortController
  model: TurnModel
  /** The assembled loop, minus what the kernel owns (model, liveness, abort). */
  loop: Omit<QueryLoopOptions, 'provider' | 'model' | 'stallIdleMs' | 'dispatchOutput' | 'observeUsage'>
  /** Throws `TurnRefusal('budget_blocked')` (or anything) to stop before the loop. */
  budget?: () => Promise<void>
  /** Output collector format for the final-only selection. */
  outputFormat?: TurnOutputFormat
  /** The stall window; defaults to `DEFAULT_STALL_IDLE_MS`. Derived, never an env knob. */
  stallIdleMs?: number
}

/** The served model: the custom endpoint as resolved, else a servable registry model. */
export function servedTurnModel(model: TurnModel): string {
  if (model.customLlm || !model.configuredProviders) return model.model
  return ensureServableModel(model.model, model.configuredProviders)
}

type OpenAssistantTurnParams = Pick<AssistantTurnLoopInput, 'sessionId' | 'policy' | 'abortController'> & {
  waitForSlot?: (sessionId: string, opts?:{signal?:AbortSignal}) => Promise<boolean>
  resumeRecovery?: { workspaceId: string; approvalId: string; options?: ResumeSlotWaitOptions }
  assistantId?: string
  startedAt?: Date
  /** Notification after an actual atomic stale takeover; never a claim decision. */
  onReclaimed?: (outcome:RecoveredTurn) => void
  /** The adapter's request ledger; the first owner it opens adopts its identity. */
  sqlScope?: TurnSqlScope
}
/** Durable completion state of the owner's reply publication (plan section 3.3). */
export type TurnCompletionState = Readonly<{
  /** One completion identity per owner, bound to its session and lease token.
   * The shared-web buffered root's operation id, which SQL persists with the
   * terminal fact; otherwise minted by the owner and persisted by the 8277
   * completion header when the reply publication carries its lane and input. */
  operationId: string
  durable: boolean
  state: 'unpublished' | 'committed' | 'refused' | 'uncertain'
  publishedReply: boolean
}>
/** The owner's closed set of SQL accounting frame ids (turn-kernel.md
 * "Per-turn SQL accounting phases"). Ids are fixed so fingerprints compare
 * across turns; nesting records where a nested effect ran. */
export const TURN_SQL_FRAMES = ['admission', 'lease_heartbeat', 'preparation', 'provider_loop', 'model_input',
  'output_admission', 'tool_effect', 'publication', 'follow_up', 'settlement'] as const
export type TurnSqlFrameId = typeof TURN_SQL_FRAMES[number]
type TurnSqlFrame = <T>(frameId: TurnSqlFrameId, fn: () => T) => T
/** Enter a frame only while recording is enabled; otherwise run `fn` directly. */
function turnSqlFrame(turnId: string): TurnSqlFrame {
  return (frameId, fn) => turnSqlRecordingEnabled() ? withTurnFrame({ turnId, frameId }, fn) : fn()
}
/** The adapter's own frame around the owner (request parsing, session lookup,
 * authored input, classification, delivery). Not an owner phase. */
export const TURN_SQL_ADAPTER_FRAME = 'adapter'
/** One request's SQL ledger identity, minted before the owner exists so the
 * adapter's work and the owner's phases share one ledger. Data, never authority. */
export type TurnSqlScope = Readonly<{ sqlTurnId: string; run<T>(fn: () => T): T }>
const consumedSqlScopes = new WeakSet<TurnSqlScope>()
export function openTurnSqlScope(): TurnSqlScope {
  const sqlTurnId = randomUUID()
  return Object.freeze({ sqlTurnId,
    run: <T>(fn: () => T): T => turnSqlRecordingEnabled() ? withTurnFrame({ turnId: sqlTurnId, frameId: TURN_SQL_ADAPTER_FRAME }, fn) : fn() })
}

/** Values only the original owner's `prepareRun` supplies to its run. */
const PREPARED_RUN_KEYS = ['systemPrompt', 'runtimeSystemContext', 'messages', 'tools', 'maxTokens', 'inputTokenLimit', 'takeDiscoveredContext'] as const
type PreparedRunKey = typeof PREPARED_RUN_KEYS[number]
type KernelLoop = AssistantTurnLoopInput['loop']
/** A prepared run's loop: the owner supplies tools, prompt, messages, runtime
 * context and model limits. `routineCalendarRead.calendarTools` names bound
 * candidates; the owner substitutes their adopted snapshots. */
export type PreparedOwnedLoop = Omit<KernelLoop, PreparedRunKey> & { [K in PreparedRunKey]?: never }
export type OwnedLoopParams = Omit<AssistantTurnLoopInput, 'sessionId' | 'policy' | 'abortController' | 'model' | 'loop'> & {
  /** Every lane, durable resume included, runs only its owner's prepared run. */
  loop: PreparedOwnedLoop
}
/** What an adapter may observe of its private prepared run. Data only; no
 * authority, no adopted tool Map and nothing `run` would accept back. */
export type PreparedTurnRunView = Readonly<{
  /** Existing reply-grounding seed material (web/channel ordering preserved). */
  grounding: PreparedTurnRun['grounding']
  /** True only when the adopted tool derives unchanged from exactly this bound candidate. */
  adoptsTool(name: string, candidate: Tool): boolean
  /** Analytics-only copy of the adopted provider messages, without source bindings. */
  messageSnapshot(): Message[]
}>

function adoptedRoutine(routine: QueryLoopOptions['routineCalendarRead'], prepared: PreparedTurnRun) {
  if (!routine) return undefined
  return { ...routine, calendarTools: new Map([...routine.calendarTools].map(([name, candidate]) => {
    if (!prepared.adoptsTool(name, candidate)) throw Object.assign(new Error('The routine calendar tool is not the adopted original.'), { reason: 'authority_changed' as const, retrySafe: false })
    return [name, prepared.tools.get(name)!] as const
  })) }
}

/** The existing kernel owns the complete lease lifetime, including recovery.
 * The token identifies writes; it never proves permission to perform them. */
class AssistantTurnOwner {
  private readonly terminal
  private readonly stopHeartbeat: () => void
  private closing: Promise<boolean> | undefined
  private closed = false
  private ran = false
  private finalizingReply = false
  private finalizationBegun = false
  private publishedReply = false
  private bufferedPublicationBound=false
  private publicationOperationId: string = randomUUID()
  private publicationState: TurnCompletionState['state'] = 'unpublished'
  private replyPublicationStarted = false
  private completionRecorded = false
  private sinkKind: TurnSinkKind | undefined
  private lastResult: TurnLoopResult | undefined
  private outputCollector: TurnOutputCollector | undefined
  private readonly results=new WeakSet<TurnLoopResult>()
  private modelPreparation: ReturnType<typeof captureTurnModelPreparation> | undefined
  private modelPreparations: Promise<unknown>[] = []
  private preparedMainModel: PreparedTurnModel | undefined
  private mainPreparationStarted = false
  private backgroundPreparationStarted = false
  private preparedBackgroundModel: PreparedBackgroundModel | undefined
  private recoveryContext: ToolContext | undefined
  private recoveryMessage: Promise<ComposeRecoveryMessageResult | null> | undefined
  bindModelPreparation(invocation: TurnModelInvocation, services: TurnModelServices): void {
    if (this.modelPreparation || this.ran || this.closed) throw new Error('Model preparation must bind once before running.')
    this.disposeSessionTurnAuthority=bindSessionTurnAuthority(invocation.execution.security.authority,
      {sessionId:this.params.sessionId,assistantId:invocation.execution.assistant.id,token:this.token})
    const recovery = this.params.resumeRecovery
    const execution = invocation.execution
    this.retainedPreparationAccumulator = invocation.scopeAccumulator
    if (recovery && invocation.toolProfile === 'resume' && execution.identity.kind === 'system'
      && execution.identity.purpose === 'session_resume' && execution.identity.jobId === recovery.approvalId
      && execution.security.access.workspaceId === recovery.workspaceId
      && execution.lifecycle.sessionId === this.params.sessionId && execution.assistant.id === this.params.assistantId) {
      bindVerifiedResumeEvidence(execution, this.token, async () => {
        const signal = this.params.abortController.signal
        signal.throwIfAborted()
        const lease = await findSessionTurnLeaseState(this.params.sessionId)
        if (this.didRelease || lease?.status !== 'running' || lease.turnLeaseToken !== this.token) throw new TurnLeaseLostError()
        signal.throwIfAborted()
      })
    }

    this.modelPreparation = captureTurnModelPreparation(invocation, services,
      { sessionId: this.params.sessionId, assistantId: this.params.assistantId, signal: this.params.abortController.signal,
        effect: operation => {
          if (this.didRelease || this.closed && (!this.ran || this.runDrained)) return Promise.reject(new Error('The original turn is closed.'))
          const effect = this.frame('tool_effect', () => Promise.resolve().then(operation))
          this.modelPreparations.push(effect)
          return effect
        } })
    // A callee composes its roster before binding; the profile must match the lane.
    if (this.capabilityProfile && this.capabilityProfile !== this.modelPreparation.lane) throw capabilityProfileChanged()
    // The turn's admission closure, bound to this invocation's lease and
    // disposed with the turn (turn-kernel.md "Per-turn admission closure").
    this.admissionClosure = openTurnAdmissionClosure(invocation.execution)
    this.preBindCapabilities()
  }
  private admissionClosure: TurnAdmissionClosure | undefined
  private disposeSessionTurnAuthority:(()=>void)|undefined
  /** What the turn's admission closure proved and shared; data, never authority. */
  admissionClosureStats(): AdmissionClosureStats | undefined { return this.admissionClosure?.stats() }
  private capabilityProfile: TurnCapabilityProfile | undefined
  private capabilityTools: Map<string, Tool> | null = null
  /** The turn's capability roster under the original owner (M3 catalog port).
   * Today it delegates unchanged to the entrypoint's existing composition. */
  prepareCapabilities(request: TurnCapabilityRequest): Promise<TurnCapabilityResult> {
    if (this.capabilityProfile || this.preparationLocked || this.closed) throw new Error('Capability preparation is unavailable or already started.')
    if (this.modelPreparation && this.modelPreparation.lane !== request.profile) throw capabilityProfileChanged()
    this.capabilityProfile = request.profile
    const { tools, compose } = captureCapabilityComposition(request)
    const prepared = this.frame('preparation', () => Promise.resolve().then(compose)).then(result => {
      this.capabilityTools = tools
      this.preBindCapabilities()
      return result
    })
    this.modelPreparations.push(prepared)
    return prepared
  }
  /** Opportunistic: `prepareRun` reuses these original-invocation wrappers. A
   * Stop or authority change here leaves binding (and refusal) to `prepareRun`. */
  private preBindCapabilities(): void {
    if (!this.modelPreparation || !this.capabilityTools || this.params.abortController.signal.aborted) return
    try { this.modelPreparation.tools(this.capabilityTools) } catch { /* prepareRun refuses */ }
  }
  /** Bind tools created after preparation (a later activation) through the
   * same captured invocation and tool scope; allowed while the owner is open. */
  activateAndBind(candidates: ReadonlyMap<string, Tool>): Map<string, Tool> {
    if (!this.modelPreparation || this.closed) throw new Error('Activation binding requires the open original turn.')
    return this.modelPreparation.tools(candidates)
  }
  prepareBackgroundModel(request: { model?: string; configuredDefault?: boolean }) {
    if (!this.modelPreparation || this.backgroundPreparationStarted || this.closed) throw new Error('Background model preparation is unavailable or already started.')
    this.backgroundPreparationStarted = true
    const preparation = this.modelPreparation, original = { ...request }
    const prepared = this.frame('preparation', () => Promise.resolve().then(() => preparation.background(original)).then(background => {
      this.preparedBackgroundModel = background
      return background
    }))
    this.modelPreparations.push(prepared)
    return prepared
  }
  prepareMainModel(request: TurnMainModelRequest): Promise<PreparedTurnModel> {
    if (!this.modelPreparation || this.mainPreparationStarted || this.ran || this.closed) throw new Error('Main model preparation is unavailable or already started.')
    this.mainPreparationStarted = true
    const preparation = this.modelPreparation, original = structuredClone(request)
    const prepared = this.frame('preparation', () => Promise.resolve().then(() => preparation.main(original)).then(value => {
      if (!value.refusal && value.imageRoute !== 'refuse') this.preparedMainModel = value
      return value
    }))
    this.modelPreparations.push(prepared)
    return prepared
  }
  /** The selection used by the suspended call, including a discovered Research route. */
  checkpointModelSelection() {
    const model = this.preparedMainModel
    if (!model) throw new Error('A checkpoint requires a prepared main model.')
    return { selectedTier: model.logicalTier, selectedCustomModel: model.customLlm?.selector,
      selectedLegacyByo: model.usedLegacyByoKey }
  }
  prepareTools(candidates: ReadonlyMap<string, Tool>): Map<string, Tool> {
    if (!this.modelPreparation || this.ran && !this.discovering || this.closed) throw new Error('Tool preparation requires the original prepared turn.')
    return this.modelPreparation.tools(candidates)
  }
  private retainedPreparationAccumulator: ContextScopeAccumulator | undefined
  private historyPreparationStarted = false
  /** The main-turn history read under the original invocation: once per owner,
   * before run preparation. Returns one captured admitted history frame (data,
   * never a permission); the reader's own admitted query decides visibility. */
  prepareHistory(request: TurnHistoryRequest): Promise<CapturedTurnHistory> {
    const preparation = this.modelPreparation
    if (!preparation || this.historyPreparationStarted || this.preparationLocked || this.closed) {
      throw new Error('History preparation is unavailable or already started.')
    }
    preparation.assertHistoryAuthority(request.native)
    // History may confirm the original binding, never replace it. Lanes without
    // history retain the accumulator adopted with their model invocation.
    const accumulator = request.native?.accumulator ?? request.evidence
    if (accumulator && this.retainedPreparationAccumulator && accumulator !== this.retainedPreparationAccumulator) {
      throw new Error('History must retain the original turn accumulator.')
    }
    this.retainedPreparationAccumulator ??= accumulator
    this.historyPreparationStarted = true
    const read = captureTurnHistory(preparation.sessionId, request), native = request.native
    const prepared = this.frame('preparation', () => Promise.resolve().then(read).then(history => {
      // A replaced authority or a Stop during the read refuses its result.
      preparation.assertHistoryAuthority(native)
      return history
    }))
    this.modelPreparations.push(prepared)
    return prepared
  }
  private discovering = false
  private get preparationLocked(): boolean {
    return (this.runPreparationStarted || this.ran) && !this.discovering
  }
  private takeDiscoveredContext: (() => DiscoveredQueryContext | undefined) | undefined
  private runPreparationStarted = false
  private preparedRun: PreparedTurnRun | undefined
  /** Final assembly under the original invocation and prepared main model. The
   * input is captured synchronously; admission, Brief and placement follow.
   * The adopted run stays private and is consumed only by `run`. */
  prepareRun(input: TurnRunPreparationInput): Promise<PreparedTurnRunView> {
    if (!this.modelPreparation || this.runPreparationStarted || this.ran || this.closed) throw new Error('Run preparation is unavailable or already started.')
    const model = this.preparedMainModel
    if (!model) throw new Error('The original main model has not been prepared.')
    this.runPreparationStarted = true
    const preparation = this.modelPreparation
    const discover = input.contextDiscovery
    let initial = input
    if (discover) {
      if (input.messages.length !== 1 || input.messages[0]?.role !== 'user') {
        throw new Error('The initial context-discovery frame requires one current user message.')
      }
      if (!['web', 'channel', 'public'].includes(preparation.lane) || input.candidateTools.size) {
        throw new Error('Context discovery requires an attended turn with only its discovery tool.')
      }
      let ready: DiscoveredQueryContext | undefined
      let continuationModel: PreparedTurnModel | undefined
      let loading: Promise<void> | undefined
      let failure: { error: unknown } | undefined
      this.takeDiscoveredContext = () => {
        if (failure) throw failure.error
        const next = ready
        if (next && continuationModel) {
          const previous = this.preparedMainModel!
          // A newly selected route can fall back to a different payer later,
          // even if its current model label and key source still match.
          if (this.usageSnapshot && continuationModel !== previous) {
            this.priorSpend = { spend: structuredClone(this.usageSnapshot), keySource: previous.providerKeySource, nextTier: continuationModel.logicalTier }
          }
          this.preparedMainModel = continuationModel
        }
        ready = undefined
        return next
      }
      const discoveryTool: Tool = {
        name: CONVERSATION_CONTEXT_TOOL,
        description: 'Load the permitted conversation history, referenced material, and tools for this request. Use for follow-ups, earlier work, personal facts or actions before replying. Answer self-contained requests directly.',
        inputSchema: z.object({}).strict(), isReadOnly: true, isConcurrencySafe: false, requiresConfirmation: false,
        timeoutMs: NO_TOOL_TIMEOUT,
        execute: async (_input, toolContext) => {
          const signal = toolContext.abortSignal
          signal.throwIfAborted()
          loading ??= this.frame('preparation', async () => {
            this.discovering = true
            try {
              const frame = await discover(signal)
              signal.throwIfAborted()
              // Snapshot the adapter's messages, scoped tools and prompt now, before
              // a model promotion can yield to another task.
              const assemble = preparation.captureRun(frame, model, this.retainedPreparationAccumulator)
              const readers = frame.context?.requestTools && preparation.captureWorkerReaders(frame.context.requestTools)
              const nextModel = frame.mainModel ? await preparation.main(structuredClone(frame.mainModel)) : model
              if (nextModel.refusal || nextModel.imageRoute === 'refuse') throw new Error('The discovered turn model is unavailable.')
              const run = await assemble()
              signal.throwIfAborted()
              preparation.assertLoopContext(toolContext)
              const context = frame.context
              const previousWorker = toolContext.workerRuntime
              const inheritsWorkspaceRoute = !previousWorker || (previousWorker.provider === model.customLlm?.provider
                && previousWorker.model === model.customLlm.selector)
              // A spawned worker inherits the promoted workspace selection. An
              // Auto continuation clears its old pin and restores worker defaults.
              let workerRuntime = previousWorker
              if (frame.mainModel && inheritsWorkspaceRoute) {
                const promoted = nextModel.customLlm
                workerRuntime = promoted ? {
                  provider: promoted.provider, model: promoted.selector, modelTier: promoted.modelTier,
                  providerKeySource: promoted.providerKeySource, inputTokenLimit: promoted.inputTokenLimit,
                  maxTokens: promoted.maxTokens,
                } : undefined
              }
              ready = {
                provider: nextModel.provider, model: servedTurnModel(nextModel), systemPrompt: run.systemPrompt,
                runtimeSystemContext: run.runtimeSystemContext, messages: run.messages, tools: new Map(run.tools),
                maxTokens: nextModel.maxTokens, inputTokenLimit: nextModel.inputTokenLimit,
                maxTurns: frame.maxTurns, maxToolCalls: frame.maxToolCalls, suppressIntermediateText: frame.suppressIntermediateText,
                workerDrainPrompt: frame.workerDrainPrompt, planNudgeCap: frame.planNudgeCap, groundingGate: frame.groundingGate,
                toolSelection: frame.toolSelection, routineCalendarRead: adoptedRoutine(frame.routineCalendarRead, run),
                context: {
                  ...(readers ? { requestTools: readers } : {}),
                  ...(context?.activeCapabilities ? { activeCapabilities: new Set(context.activeCapabilities) } : {}),
                  ...(context?.preferredChannel !== undefined ? { preferredChannel: context.preferredChannel } : {}),
                  ...(context?.workflowProposalReceipt ? { workflowProposalReceipt: context.workflowProposalReceipt } : {}),
                  ...(context?.researchMode !== undefined ? { researchMode: context.researchMode } : {}),
                  workerRuntime: context?.workerRuntime ?? workerRuntime,
                },
              }
              this.preparedRun = run
              continuationModel = nextModel
            } catch (error) {
              failure = { error }
              throw error
            } finally { this.discovering = false }
          })
          await loading
          signal.throwIfAborted()
          return { data: 'The permitted conversation context and available tools are ready.' }
        },
      }
      initial = { ...input, candidateTools: new Map([[discoveryTool.name, discoveryTool]]),
        trustedContributions: [...input.trustedContributions ?? [], { name: 'context_discovery',
          content: `You have the current user message. Answer directly when it is self-contained. Call ${CONVERSATION_CONTEXT_TOOL} before answering from earlier exchanges or private workspace material, resolving references, or taking an action. Use the resulting evidence and tools to complete the request.` }] }
    }
    const assemble = preparation.captureRun(initial, model, this.retainedPreparationAccumulator, Boolean(discover))
    const prepared = this.frame('preparation', () => Promise.resolve().then(assemble).then((run): PreparedTurnRunView => {
      this.preparedRun = run
      const current = () => this.preparedRun!
      return Object.freeze({ get grounding() { return current().grounding },
        adoptsTool: (name: string, candidate: Tool) => current().adoptsTool(name, candidate),
        messageSnapshot: () => structuredClone(current().messages) })
    }))
    this.modelPreparations.push(prepared)
    return prepared
  }
  private priorSpend: PriorTurnSpend | undefined
  private billing: ReturnType<typeof captureTurnUsageBilling> | undefined
  private usageSettlement: Promise<TurnUsageSettlement> | undefined
  private running: Promise<TurnLoopResult> | undefined
  private runDrained = false
  private producerTerminal = false
  registerUsageBilling(registration: TurnUsageBilling): void {
    if (this.billing || this.ran || this.closed) throw new Error('Turn billing must be registered once before running.')
    // Main selection binds once. Read only that original producer's live key
    // fact at settlement; route/store/registration mutations cannot redirect it.
    this.billing = captureTurnUsageBilling(registration, () => this.preparedMainModel?.providerKeySource)
  }
  settleUsage(): Promise<TurnUsageSettlement> {
    if ((this.ran && !this.runDrained && !this.producerTerminal) || (!this.ran && !this.closed)) {
      return Promise.reject(new Error('Turn usage is not terminal yet.'))
    }
    return this.usageSettlement ??= Promise.resolve().then(() => this.billing?.(this.usage, this.priorSpend) ?? { status: this.usage ? 'not_configured' as const : 'no_usage' as const })
  }
  private usageSnapshot:QueryUsageSnapshot|null=null
  get usage():QueryUsageSnapshot|null{return this.usageSnapshot?structuredClone(this.usageSnapshot):null}
  private textComplete = false
  private didRelease = false
  private endReason: TurnEndReason | undefined
  private input: TurnInboxHandle | undefined
  private readonly frame: TurnSqlFrame
  constructor(private readonly params: OpenAssistantTurnParams, readonly token: string,readonly turnId:string|null,
    /** Opaque SQL-accounting ledger identity; not the lease token and never a permission. */
    readonly sqlTurnId: string = randomUUID()) {
    this.frame = turnSqlFrame(sqlTurnId)
    this.terminal=createTerminalPublicationOwner(token,params.abortController.signal)
    const stop = () => params.abortController.abort(new TurnStoppedError())
    const lost = () => params.abortController.abort(new TurnLeaseLostError())
    registerTurnAbort(params.sessionId, token, stop)
    // Timers keep the frame they were created in: every tick is liveness work.
    this.stopHeartbeat = this.frame('lease_heartbeat', () => startLeaseHeartbeat({ sessionId: params.sessionId, token,
      onLost: lost, onCancelRequested: stop }))
  }
  /** Immutable per-turn SQL ledger snapshot (recording on only); data, never authority. */
  sqlLedger(): TurnSqlLedger | undefined { return readTurnSqlLedger(this.sqlTurnId) }
  get released(): boolean { return this.didRelease }
  get completionReason():TurnEndReason|undefined{return this.endReason}
  get abortKind():'stop'|'lease_lost'|'abort'|null{
    return this.terminal.isStopped() ? 'stop' : turnAbortKind(this.params.abortController.signal)
  }
  openInput(): Pick<TurnInboxHandle, 'port'> {
    if (this.closed) throw new Error('This turn has already closed.')
    this.input ??= registerTurnInbox(this.params.sessionId, { assistantId: this.params.assistantId })
    return { port: this.input.port }
  }
  async run(params: OwnedLoopParams): Promise<TurnLoopResult> {
    if (this.closed || this.ran) throw new Error('This turn has already run or closed.')
    if ('model' in params) throw new Error('The original owner supplies the prepared main model.')
    const model = this.preparedMainModel
    if (!model || !this.modelPreparation) throw new Error('The original main model has not been prepared.')
    const supplied: PreparedOwnedLoop = params.loop, prepared = this.preparedRun
    if (!this.runPreparationStarted) throw new Error('The original run has not been prepared.')
    if (!prepared) throw new Error('The original run preparation has not finished.')
    if (PREPARED_RUN_KEYS.some(key => key in supplied)) throw new Error('The original owner supplies the prepared run.')
    this.modelPreparation.assertLoopContext(supplied.context)
    const take = this.takeDiscoveredContext
    const takeDiscoveredContext = take && (() => {
      const next = take()
      if (!next) return undefined
      next.routineCalendarRead ??= adoptedRoutine(supplied.routineCalendarRead, this.preparedRun!)
      next.toolSelection ??= supplied.toolSelection
      return next
    })
    const routine = !take ? adoptedRoutine(supplied.routineCalendarRead, prepared) : undefined
    const loop: KernelLoop = { ...supplied, routineCalendarRead: routine, toolSelection: take ? undefined : supplied.toolSelection, takeDiscoveredContext, systemPrompt: prepared.systemPrompt, runtimeSystemContext: prepared.runtimeSystemContext,
      messages: inheritScopeSources([...prepared.messages], prepared.messages), tools: new Map(prepared.tools),
      ...(prepared.maxTokens !== undefined ? { maxTokens: prepared.maxTokens } : {}),
      ...(prepared.inputTokenLimit !== undefined ? { inputTokenLimit: prepared.inputTokenLimit } : {}) }
    this.ran = true
    this.sinkKind = params.sink.kind
    this.recoveryContext = { ...supplied.context }
    const collector = createTurnOutputCollector({ format: params.outputFormat })
    this.outputCollector = collector
    // Install the drain promise before a synchronous budget/host hook can finish.
    this.running = Promise.resolve().then(() => runAssistantTurnLoop(collector, { ...params,
      model: { provider: model.provider, model: model.model, configuredProviders: model.configuredProviders, customLlm: model.customLlm },
      loop, sessionId: this.params.sessionId,
      policy: this.params.policy, abortController: this.params.abortController },
      result => { this.results.add(result); this.lastResult = result }, snapshot => { this.usageSnapshot = structuredClone(snapshot) },
      () => { this.producerTerminal = true }, this.frame)).finally(() => { this.runDrained = true })
    return this.running
  }

  /** Reconcile the original approval after claim and before replaying its outcome. */
  async hasCommittedResumePublication(): Promise<boolean> {
    const recovery = this.params.resumeRecovery
    if (!recovery || this.closed || this.ran) throw new Error('Resume recovery requires its original turn owner before execution.')
    const signal = this.params.abortController.signal
    signal.throwIfAborted()
    const completed = await this.frame('admission', () => committedTurnCompletion({
      workspaceId: recovery.workspaceId,
      sessionId: this.params.sessionId,
      input: { kind: 'approval', ref: recovery.approvalId },
    }))
    signal.throwIfAborted()
    return completed !== null
  }

  /** A presentation view of this owner's admitted events, never a delivery grant. */
  selectedOutput(format?: TurnOutputFormat): TurnOutputSelection {
    const selection = this.outputCollector?.select(format)
    return selection ? structuredClone(selection) : { kind: 'empty', reason: 'no_model_output' }
  }

  /** One interactive synthesis, from this turn's already paired tool results. */
  recoverInteractiveReply(request: {
    reason: 'failed' | 'empty'
    pendingAssistantTurns: readonly RecoveryPendingTurn[]
    userText: string
    channelType: string
    authorizeDestination: () => Promise<void>
    recordUsage: (result: ComposeRecoveryMessageResult) => Promise<void>
  }): Promise<ComposeRecoveryMessageResult | null> {
    const { reason, pendingAssistantTurns, userText, channelType, authorizeDestination, recordUsage } = request
    const signal = this.params.abortController.signal
    const model = this.preparedBackgroundModel, context = this.recoveryContext
    if (this.closed || this.abortKind || this.recoveryMessage || !model || !context
      || (this.sinkKind !== 'sse' && this.sinkKind !== 'adapter')) return Promise.resolve(null)
    if (reason === 'empty') {
      const selection = this.selectedOutput()
      if (selection.kind !== 'empty' || selection.reason !== 'tools_only') return Promise.resolve(null)
    }
    const assertDestination = async () => {
      signal.throwIfAborted()
      await authorizeDestination()
      signal.throwIfAborted()
    }
    this.recoveryMessage = this.frame('follow_up', () => composeRecoveryMessage({
      provider: model.provider, pendingAssistantTurns, userText, channelType, signal,
      beforeDispatch: () => this.frame('model_input', async () => {
        signal.throwIfAborted()
        await admitModelSourceEvidence(context, 'context')
        await assertDestination()
      }),
    }).then(async recovered => {
      if (!recovered) return null
      await recordUsage(recovered)
      await assertDestination()
      return recovered
    }))
    return this.recoveryMessage
  }

  /** Presentation is distinct from durable publication. */
  announceTextCompletion(announce: () => void): void {
    if (this.textComplete) return
    this.textComplete = true
    announce()
  }
  beginFinalization(result: TurnLoopResult, providerFailed: boolean): boolean {
    this.finalizationBegun = true
    this.finalizingReply = result.selection.kind === 'text' && !result.aborted && !providerFailed
    const actual=finalizedOutputs.get(result)
    this.terminal.finalize(this.finalizingReply&&this.results.has(result)&&actual&&actual.signal===this.params.abortController.signal&&!actual.signal.aborted?actual.output:null)
    return this.finalizingReply && !this.params.abortController.signal.aborted
  }
  bindBufferedPublication(root:BufferedWebPublication,authority:SessionContextAuthority):void {
    if (this.replyPublicationStarted) throw new Error('The buffered root must bind before reply publication.')
    this.terminal.bindRoot(root,authority.execution)
    this.bufferedPublicationBound=true
    this.publicationOperationId = root.operationId
  }
  hasCommittedTerminalReply():boolean{return this.terminal.isCommitted()}
  /** The owner's one publication path for every lane (turn-kernel.md "Reply
   * publication"). The owner pins its lease token (or the stopped token for a
   * stopped streaming buffer), binds the terminal fact and records completion
   * state; the adapter supplies rows, its write and its authority bracket.
   * `afterCommit` runs the adapter's fresh post-commit delivery check and saved
   * events; a reply counts as published only after it returns. */
  async publish(request: TurnPublicationRequest & {
    /** Index of the reply row in `rows`; default the last assistant row, `null` none. */
    replyRowIndex?: number | null
    afterCommit?: (rows: SessionMessage[]) => Promise<void>
  }): Promise<SessionMessage[]> {
    if (this.didRelease || this.closed) throw new Error('The original turn is closed.')
    if (request.disposition === 'reply') {
      if (this.replyPublicationStarted) throw new Error('This turn has already published its reply.')
      this.replyPublicationStarted = true
      if (!this.finalizationBegun && this.lastResult) this.beginFinalization(this.lastResult, false)
    }
    const signal = this.params.abortController.signal
    // A final-only or persisted-only sink delivered nothing; a stopped buffer is
    // never published for it. A streaming sink finalizes under the stopped token.
    if (signal.aborted && this.sinkKind && this.sinkKind !== 'sse') signal.throwIfAborted()
    const write = () => writeTurnPublication({ sessionId: this.params.sessionId, token: this.token, stopped: signal.aborted,
      operationId: this.publicationOperationId,
      bindTerminal: (root, authority, values, ordinals) => this.terminal.bind(root, authority.execution, values, ordinals) }, request)
    const inPublication = () => { const frame = currentTurnFrame(); return frame?.turnId === this.sqlTurnId && frame.frameId === 'publication' }
    let rows: SessionMessage[]
    try {
      rows = await (inPublication() ? write() : this.frame('publication', write))
    } catch (error) {
      if (request.disposition === 'reply') {
        this.publicationState = (error as { operationMayHaveExecuted?: unknown })?.operationMayHaveExecuted === true ? 'uncertain' : 'refused'
      }
      throw error
    }
    if (request.disposition !== 'reply') return rows
    this.publicationState = 'committed'
    // The 8277 header committed with these rows: the identity is now durable.
    if (request.completion && rows.length) this.completionRecorded = true
    if (rows.length && request.afterCommit) {
      if (request.measure) await request.measure('publication_after_commit_delivery', () => request.afterCommit!(rows))
      else await request.afterCommit(rows)
    }
    if (!this.bufferedPublicationBound) {
      let index = request.replyRowIndex
      if (index === undefined) { index = null; for (let i = request.rows.length - 1; i >= 0; i--) if (request.rows[i]!.role === 'assistant') { index = i; break } }
      const content = index === null ? null : rows[index]?.content as ContentBlock[] | undefined
      this.publishedReply = !!content && this.finalizingReply && !content.some(block => block.type === 'tool_use')
        && content.some(block => block.type === 'text' && block.text.trim().length > 0)
    }
    return rows
  }
  /** Completion identity and state of the reply publication; data, never authority. */
  get completion(): TurnCompletionState {
    return Object.freeze({ operationId: this.publicationOperationId, durable: this.bufferedPublicationBound || this.completionRecorded,
      state: this.publicationState, publishedReply: this.isPublishedReply() })
  }
  isPublishedReply(): boolean { return (this.bufferedPublicationBound?this.terminal.isCommitted():this.publishedReply) && !this.params.abortController.signal.aborted }
  notice(error: unknown): { code: string; message: string } | null {
    if (!this.isPublishedReply() || !isAuthorityChangedError(error) || error.operationMayHaveExecuted !== false) return null
    return { code: 'post_reply_authority_changed',
      message: 'Your reply was saved. Some follow-up processing stopped because access changed. Your next message will use the current permissions.' }
  }
  /** Source-proof reads also lock rows; follow-up starts only after commit. */
  async afterReplyPublication<T>(publish: () => Promise<void>, followUp: () => Promise<T>): Promise<T> {
    await publish()
    return this.frame('follow_up', followUp)
  }
  private disposeAdmissionClosure(): void {
    const closure = this.admissionClosure
    if (!closure) return
    this.admissionClosure = undefined
    const stats = closure.stats()
    closure.dispose()
    if (stats.proofs || stats.sharedProofs || stats.discoveries) console.info('[turn-owner] admission closure', { sessionId: this.params.sessionId, ...stats })
  }
  finish(reason: TurnEndReason = 'completed'): Promise<boolean> {
    if (this.closing) return this.closing
    if (this.didRelease) return this.settleUsage().then(() => true)
    this.closed = true
    this.endReason ??= this.abortKind === 'stop' ? 'stopped_by_user' : reason
    this.closing = this.frame('settlement', async () => {
      try {
        // Configuration preparation belongs to this same operation lifetime.
        await Promise.allSettled(this.modelPreparations)
        // Failure of output/run cannot discard already observed spend.
        await this.running?.catch(() => {})
        await this.recoveryMessage?.catch(() => {})
        this.terminal.close()
        this.input?.close()
        this.input = undefined
        await this.settleUsage()
      } finally {
        this.disposeAdmissionClosure()
        this.disposeSessionTurnAuthority?.();this.disposeSessionTurnAuthority=undefined
        this.stopHeartbeat()
        unregisterTurnAbort(this.params.sessionId, this.token)
        // A Stop may arrive while producer cleanup/accounting is awaited.
        // It remains distinct from lease loss and the database classifies final state.
        if (this.abortKind === 'stop') this.endReason = 'stopped_by_user'
        // A failed database release retains exact-token retry ownership.
        this.didRelease = await releaseTurn(this.params.sessionId, this.token, this.endReason!, result => { this.endReason = result.reason })
      }
      return this.didRelease
    }).finally(() => { this.closing = undefined })
    return this.closing
  }
}
export type AssistantTurn = AssistantTurnOwner

export async function openAssistantTurn(params: OpenAssistantTurnParams): Promise<AssistantTurn> {
  const scope = params.sqlScope && !consumedSqlScopes.has(params.sqlScope) ? params.sqlScope : undefined
  const sqlTurnId = scope?.sqlTurnId ?? randomUUID(), frame = turnSqlFrame(sqlTurnId)
  const recovery = params.resumeRecovery
  const resumeRecovery = recovery && { ...recovery, options: { ...recovery.options } }
  const onReclaimed = (recovered: RecoveredTurn) => {
    try { frame('admission', () => params.onReclaimed?.(recovered)) }
    catch (error) { console.error('[turn-owner] stale recovery notification failed:', error) }
  }
  const waitForSlot = resumeRecovery
    ? resumePredecessorSlotWait({ approvalId: resumeRecovery.approvalId, options: resumeRecovery.options, onReclaimed })
    : params.waitForSlot
  const slot = await frame('admission', () => takeTurnLease({ sessionId: params.sessionId, admission: params.policy.admission,
    waitForSlot, idleOnly: !!resumeRecovery, assistantId: params.assistantId, startedAt: params.startedAt, signal: params.abortController.signal }))
  if (!slot.taken) throw new TurnRefusal(slot.code)
  const owner = new AssistantTurnOwner({ ...params, resumeRecovery }, slot.token, slot.turnId ?? null, sqlTurnId)
  if (scope) consumedSqlScopes.add(scope)
  if (slot.reclaimed && slot.recovered) onReclaimed(slot.recovered)
  if(params.abortController.signal.aborted){await owner.finish('failed');params.abortController.signal.throwIfAborted()}
  return owner
}

async function runAssistantTurnLoop(collector: TurnOutputCollector, params: AssistantTurnLoopInput,onResult?:(result:TurnLoopResult)=>void,observeUsage?:(snapshot:QueryUsageSnapshot)=>void,onProducerTerminal?:()=>void,
  frame: TurnSqlFrame = (_id, fn) => fn()): Promise<TurnLoopResult> {
  const original = {
    execution: params.loop.context.executionContext,
    authority: params.loop.context.authority,
    accumulator: params.loop.context.scopeAccumulator,
  }
  const recordOutputTiming=(context:ToolContext,started:number)=>{
    const evidence=JSON.stringify(context.scopeAccumulator?.evidence)
    params.sink.onOutputAuthorityTiming?.(Date.now()-started)
    if(context.executionContext!==original.execution||context.authority!==original.authority
      ||context.scopeAccumulator!==original.accumulator||JSON.stringify(context.scopeAccumulator?.evidence)!==evidence){
      throw Object.assign(new Error('The output timing observer changed authority.'),{reason:'authority_changed' as const,retrySafe:false})
    }
  }
  const permissions = params.sink.permissionContext
  const assertPermissionContextBinding = (context: ToolContext) => {
    if (permissions && (params.sink.kind !== 'sse'
      || params.sink.permissionContext !== permissions
      || params.sink.admitOutput !== permissions.authorizeDelivery
      || !ownsTurnDeliveryAdmission(permissions, context))) {
      throw Object.assign(new Error('The request permission context changed.'), { reason: 'authority_changed' as const, retrySafe: false })
    }
  }
  const assertSinkOutputAuthority = async (context: ToolContext, admitted?: () => void, eventKind?: QueryEvent['type']): Promise<void> => {
    assertPermissionContextBinding(context)
    const started=Date.now()
    if (!params.sink.admitOutput) {
      await admitModelSourceEvidence(context, params.sink.kind === 'return' || params.sink.kind === 'none' ? 'context' : 'deliver')
      admitted?.(); return
    }
    const assertIdentity = () => {
      if (!original.execution || !original.authority || !original.accumulator
        || original.authority !== original.execution.security.authority
        || context.executionContext !== original.execution || context.authority !== original.authority
        || context.scopeAccumulator !== original.accumulator) {
        throw Object.assign(new Error('The sink context authority changed.'), { reason: 'authority_changed' as const, retrySafe: false })
      }
    }
    assertIdentity()
    try {
      if (params.sink.kind === 'adapter' && eventKind) await params.sink.admitOutput(context, eventKind)
      else await params.sink.admitOutput(context)
      admitted?.()
    } finally { recordOutputTiming(context,started) }
    assertIdentity()
    assertPermissionContextBinding(context)
  }
  // Text of the current model round that was admitted AND delivered to the
  // streaming sink. A Stop closes the producer mid-round, so the loop never
  // yields that round's `assistant_turn`; the owner records it at the Stop exit.
  let deliveredRoundText = ''
  const result = await frame('provider_loop', async (): Promise<TurnLoopResult> => {
    if (params.budget) await params.budget()
    // Loop and sink failures propagate unchanged: the runner's own error path
    // renders them. The lease is released in `finally` either way.
    const admitOutput = async (current: ToolContext, admitted?: () => void, eventKind?: QueryEvent['type']) => {
      const execution = current.executionContext, accumulator = current.scopeAccumulator
      if(params.loop.context.admitModelOutput){
        await current.authority?.assertCurrent()
        await params.loop.context.admitModelOutput(current)
      }
      if (current.executionContext !== execution || current.scopeAccumulator !== accumulator) {
        throw Object.assign(new Error('The model context authority changed.'), { reason: 'authority_changed' as const,retrySafe: false })
      }
      // Covered web output uses its request-owned delivery admission.
      // The owner evaluates the complete source/recipient requirements for
      // this physical output. Input and publication remain separate effects.
      await assertSinkOutputAuthority(current, admitted, eventKind)
    }
    const context = { ...params.loop.context,
      abortSignal: params.loop.context.abortSignal
        ? AbortSignal.any([params.loop.context.abortSignal, params.abortController.signal])
        : params.abortController.signal,
      admitModelInput: (current: ToolContext) => frame('model_input', async () => {
        const execution = current.executionContext, accumulator = current.scopeAccumulator
        if (permissions?.authorizePageModelInput) {
          assertPermissionContextBinding(current)
          const at = Date.now()
          const admitted = await permissions.authorizePageModelInput(current)
          if (admitted) {
            recordOutputTiming(current, at)
            assertPermissionContextBinding(current)
            return
          }
        }
        if(params.loop.context.admitModelInput){
          await current.authority?.assertCurrent()
          await params.loop.context.admitModelInput(current)
        }
        if (current.executionContext !== execution || current.scopeAccumulator !== accumulator) {
          throw Object.assign(new Error('The model context authority changed.'), { reason: 'authority_changed' as const,retrySafe: false })
        }
        await admitModelSourceEvidence(current, 'context')
      }),admitModelOutput: admitOutput }
    const deliver = (current: ToolContext, event?: QueryEvent, provenance?: QueryOutputProvenance): Promise<void> => frame('output_admission', async () => {
      if (params.abortController.signal.aborted) return
      const callback = params.sink.admitOutput
      const sink = params.sink.onEvent
      const outputHook = params.loop.context.admitModelOutput
      let evidence: string | undefined
      const checked = { ...current, admitModelOutput: async (value: ToolContext) => {
        const capture = () => { evidence = JSON.stringify(value.scopeAccumulator?.evidence) }
        await admitOutput(value, capture, event?.type)
      } }
      await assertModelOutputAuthority(checked, {
        assertCurrent() {
          assertPermissionContextBinding(current)
          if (current.executionContext !== original.execution || current.authority !== original.authority
            || checked.executionContext !== original.execution || checked.authority !== original.authority
            || checked.scopeAccumulator !== original.accumulator
            || original.execution && original.execution.security.authority !== original.authority
            || current.scopeAccumulator !== original.accumulator || JSON.stringify(current.scopeAccumulator?.evidence) !== evidence
            || params.sink.admitOutput !== callback || params.sink.onEvent !== sink
            || params.loop.context.admitModelOutput !== outputHook) {
            throw Object.assign(new Error('The output context changed during admission.'), { reason: 'authority_changed' as const, retrySafe: false })
          }
        },
        dispatch() {
          if (!event || params.abortController.signal.aborted) return
          collector.observe(event, provenance)
          if (event.type === 'turn_complete') onProducerTerminal?.()
          return Promise.resolve(sink?.(event, provenance)).then(() => {
            if (event.type === 'text_delta') deliveredRoundText += event.text
            else if (event.type === 'assistant_turn' || event.type === 'tool_start') deliveredRoundText = ''
            if (event.type === 'turn_complete' && params.sink.kind === 'sse'
              && !params.abortController.signal.aborted && collector.select().kind === 'text') {
              params.sink.onReplyTextComplete?.()
            }
          })
        },
      })
    })
    try {
      for await (const _event of queryLoop({
        ...params.loop,
        context,
        observeUsage,
        dispatchOutput: deliver,
        provider: params.model.provider,
        model: servedTurnModel(params.model),
        stallIdleMs: params.stallIdleMs ?? DEFAULT_STALL_IDLE_MS,
      })) {
        throw new Error('A kernel-owned loop must dispatch through its output operation.')
      }
    } catch (error) {
      // A Stop that lands inside an awaited output admission surfaces as that
      // admission's refusal (the admission refuses an aborted lifecycle). It is
      // the same Stop exit, not a failure: the delivered round is still recorded
      // below and publication runs its own fresh checks. An effect that may have
      // executed keeps its uncertainty and propagates unchanged.
      const uncertain = (error as { operationMayHaveExecuted?: unknown } | null)?.operationMayHaveExecuted === true
      if (turnAbortKind(params.abortController.signal) !== 'stop' || uncertain) throw error
    }
    const selection = collector.select()
    const finalText = FINAL_ONLY_SINKS.has(params.sink.kind) && selection.kind === 'text'
      ? sanitizeDeliveryText(selection.text) || null
      : null
    const result: TurnLoopResult = { selection, finalText, aborted: params.abortController.signal.aborted }
    // Stop exit (chat-app.md "Stopping a turn": streamed text is kept): hand the
    // streaming sink the record of the round it already delivered, so its
    // stopped buffer publishes it as the stopped reply. Content-free of anything
    // new: exactly the admitted, delivered text. Not a terminal or success fact.
    if (result.aborted && params.sink.kind === 'sse' && turnAbortKind(params.abortController.signal) === 'stop'
      && deliveredRoundText.trim() && params.sink.onEvent) {
      await params.sink.onEvent({ type: 'assistant_turn', toolResults: [],
        response: { content: [{ type: 'text', text: deliveredRoundText }], stopReason: 'incomplete',
          usage: { inputTokens: 0, outputTokens: 0 }, model: servedTurnModel(params.model) } })
      deliveredRoundText = ''
    }
    if (!result.aborted) {
      await deliver(context)
      const finalized = collector.finalizedSelection()
      if (!params.abortController.signal.aborted && finalized) finalizedOutputs.set(result, { output: finalized, signal: params.abortController.signal })
    }
    return result
  })
  onResult?.(result)
  const afterLoop = params.sink.afterLoop
  if (afterLoop) await frame('publication', () => afterLoop(result))
  return result
}

function capabilityProfileChanged(): Error {
  return Object.assign(new Error('The capability profile does not match the original turn invocation.'), { reason: 'authority_changed' as const, retrySafe: false })
}

/** A usage row's identity columns, from the turn's resolved billing (D2). */
export function turnUsageIdentity(billing: TurnBilling): { userId: string; actorUserId?: string } {
  return billing.actorUserId
    ? { userId: billing.payerUserId, actorUserId: billing.actorUserId }
    : { userId: billing.payerUserId }
}
