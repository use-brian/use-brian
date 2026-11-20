import { inheritRoutineCalendarRead } from '@use-brian/core/engine/routine-read-ownership.js'
import type { LLMProvider, Message } from '@use-brian/agent-runtime/providers/types.js'
import type { ExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { inheritScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import type { CurrentAuthorityBoundary, Tool, ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import { MODEL_REGISTRY, registryRow, isRegistryModelAvailable, type ProviderAvailability } from '@use-brian/shared/model-registry'
import { MODEL_MAP, resolveModel, resolveChatModelSelection, ensureServableModel, tierForModel, backgroundModelFor, chatTierBudget } from '../model-resolution.js'
import { decideImageTurnRoute, type ResolvedWorkspaceCustomLlm, type WorkspaceCustomLlmResolver } from '../custom-llm-runtime.js'
import { bindToolsToAgentAccess } from '../context-scope/agent-access-tools.js'
import { AuthorityChangedError } from '../context-scope/authority-lease.js'
import { runWithAgentAccess, currentAgentAccess } from '../db/agent-access-context.js'
import { attachUserVisibleContext, formatUserVisibleContext } from './user-visible-context.js'
import { captureHarnessRunPreparation } from '../project-harness/turn-context.js'
import type { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import { captureBriefRunPreparation } from '../briefs/context.js'

export type PreparedModelSelection = {
  provider: LLMProvider
  model: string
  maxTokens?: number
  inputTokenLimit?: number
}

export type NamedRunContribution = {
  name: string
  content: string
}

export type TurnRunPreparationInput = {
  systemPrompt: string
  messages: Message[]
  candidateTools: ReadonlyMap<string, Tool>
  trustedContributions?: readonly NamedRunContribution[]
  userVisibleContributions?: readonly NamedRunContribution[]
}

/** Copy data while retaining the canonical reader's private source bindings.
 * No JSON property can mint those bindings, and structured cloning alone drops
 * them. Every nested row/block/array keeps the binding of its original. */
function snapshotMessageData<T extends object>(original: T): T {
  const copied = structuredClone(original)
  const seen = new WeakSet<object>()
  const visit = (source: unknown, target: unknown) => {
    if (!source || !target || typeof source !== 'object' || typeof target !== 'object' || seen.has(source)) return
    seen.add(source)
    inheritScopeSources(target, source)
    for (const key of Object.keys(source)) visit((source as Record<string, unknown>)[key], (target as Record<string, unknown>)[key])
  }
  visit(original, copied)
  return copied
}

const TOOL_METADATA = ['isConcurrencySafe', 'isReadOnly', 'requiresConfirmation', 'requiresCapability', 'homeAppToolSet',
  'hiddenFromModel', 'deferredSchemaOnly', 'allowPersistentApproval', 'confirmationMode', 'allowsRepeatCalls',
  'abortSiblingsOnError', 'interruptBehavior', 'timeoutMs', 'maxResultSizeChars'] as const

/** Frozen private copy: implementation and confirmation callbacks are captured
 * from the original object now, so replacing them on that object later cannot
 * redirect the adopted run. Symbol-keyed adapter metadata is retained. */
function snapshotTool(tool: Tool): Tool {
  const snapshot: Record<PropertyKey, unknown> = {
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema, execute: tool.execute.bind(tool),
  }
  for (const key of TOOL_METADATA) if (tool[key] !== undefined) snapshot[key] = tool[key]
  if (tool.resolveConfirmation) snapshot.resolveConfirmation = tool.resolveConfirmation.bind(tool)
  if (tool.describeConfirmation) snapshot.describeConfirmation = tool.describeConfirmation.bind(tool)
  for (const key of Object.getOwnPropertySymbols(tool)) {
    if (Object.prototype.propertyIsEnumerable.call(tool, key)) snapshot[key] = (tool as unknown as Record<symbol, unknown>)[key]
  }
  return Object.freeze(inheritRoutineCalendarRead(tool, snapshot as unknown as Tool))
}

function assemble(contributions: readonly NamedRunContribution[]): string {
  return contributions.map(({ content }) => content.trim()).filter(Boolean).join('\n\n')
}

/** Private to the original turn owner; never returned to an adapter. */
export type PreparedTurnRun = Readonly<{
  systemPrompt: string
  messages: Message[]
  tools: ReadonlyMap<string, Tool>
  runtimeSystemContext: string
  maxTokens?: number
  inputTokenLimit?: number
  grounding: Readonly<{ runtimeContext: string; userVisibleContext: string }>
  /** Identity query: the adopted tool derives unchanged from exactly this bound candidate. */
  adoptsTool(name: string, candidate: Tool): boolean
}>

/** Model configuration is captured by the existing turn owner. It never grants
 * provider input/output authority. Every lane, durable resume included, binds
 * its canonical ExecutionContext: resume's is the system `session_resume`
 * execution its adapter builds from the stored starting ceiling intersected
 * with the current one (turn-kernel.md "Model preparation under the original
 * turn owner"). There is no flat-context invocation. */
export type TurnModelInvocation =
  { kind: 'execution'; toolProfile: 'web' | 'channel' | 'public' | 'callee' | 'resume'; execution: ExecutionContext; scopeAccumulator?: ContextScopeAccumulator; assertCurrent: () => Promise<void> }

export type TurnModelServices = {
  provider: LLMProvider
  configuredProviders: ProviderAvailability | undefined
  resolveWorkspaceCustomLlm: WorkspaceCustomLlmResolver | null
  resolveLegacyByoKey: ((workspaceId: string) => Promise<string | null>) | null
  buildLegacyByoProvider: ((apiKey: string) => LLMProvider) | null
}
export type ValidatedMeteredTurn = { alias: string; profileId: string | null; toolRounds: number; thinking: boolean | null }
export type TurnMainModelRequest =
  | { kind: 'web'; requestedModel?: string; plan: string; budgetStatus: BudgetStatus; researchMode: boolean;
      metered: ValidatedMeteredTurn | null; hasImage: boolean }
  | { kind: 'channel'; requestedAlias?: string; plan: string; budgetStatus: BudgetStatus; hasImage?: boolean }
  | { kind: 'public'; requestedAlias?: string; plan: string; budgetStatus: BudgetStatus; hasImage?: boolean }
  | { kind: 'callee'; modelAlias?: string; researchFanout: boolean }
  | { kind: 'resume'; selectedTier?: string; selectedCustomModel?: string; selectedLegacyByo?: boolean;
      selectedMeteredModel?: string; fallbackModel: string }

export type PreparedTurnModel = PreparedModelSelection & {
  logicalModel: string
  logicalTier: string
  configuredProviders: ProviderAvailability | undefined
  customLlm: ResolvedWorkspaceCustomLlm | null
  providerKeySource: 'platform' | 'user'
  usedLegacyByoKey: boolean
  imageRoute: 'serve_on_route' | 'fall_back_to_builtin' | 'refuse'
  refusal?: 'custom_model_unavailable'
  budget?: { maxTurns: number; maxToolCalls: number } | null
}
export type PreparedBackgroundModel = Omit<PreparedModelSelection, 'model'> & {
  model: string | undefined
  customLlm: ResolvedWorkspaceCustomLlm | null
  providerKeySource: 'platform' | 'user'
}

type BudgetStatus = 'ok' | 'downgraded' | 'blocked'
const snapshotRuntime = (runtime: ResolvedWorkspaceCustomLlm | null): ResolvedWorkspaceCustomLlm | null => {
  if (!runtime) return null
  let descriptor: PropertyDescriptor | undefined, receiver: object | null = runtime
  while (receiver && !descriptor) {
    descriptor = Object.getOwnPropertyDescriptor(receiver, 'providerKeySource')
    receiver = Object.getPrototypeOf(receiver)
  }
  const accessor = descriptor?.get
  const keySource = runtime.providerKeySource, browser = runtime.browserUse
  const snapshot: ResolvedWorkspaceCustomLlm = {
    provider: runtime.provider, selector: runtime.selector, fallback: runtime.fallback,
    profileId: runtime.profileId, modelTier: runtime.modelTier,
    inputTokenLimit: runtime.inputTokenLimit, maxTokens: runtime.maxTokens,
    routeKind: runtime.routeKind, supportsVision: runtime.supportsVision, providerKeySource: keySource,
    ...(browser ? { browserUse: Object.freeze({ apiKeyEnvName: browser.apiKeyEnvName, apiKey: browser.apiKey,
      model: browser.model, baseUrl: browser.baseUrl }) } : {}),
  }
  // Keep the ORIGINAL producer fallback state's accessor. Copying its current
  // scalar would make an opted-in platform fallback look like BYO success.
  Object.defineProperty(snapshot, 'providerKeySource', { enumerable: true,
    get: accessor ? () => accessor.call(runtime) : () => keySource })
  return Object.freeze(snapshot)
}

export function captureTurnModelPreparation(invocation: TurnModelInvocation, input: TurnModelServices,
  owner: { sessionId: string; assistantId?: string; signal: AbortSignal; effect: <T>(operation: () => Promise<T>) => Promise<T> }) {
  const services = Object.freeze({ ...input, configuredProviders: snapshotModelAvailability(input.configuredProviders) })
  const execution = invocation.execution
  const authority = execution.security.authority
  const assertAuthority = authority.assertCurrent, executeAuthority = authority.execute
  const dispatchAuthority: CurrentAuthorityBoundary['execute'] = executeAuthority.bind(authority)
  const assertCurrent = invocation.assertCurrent
  const sessionId = execution.lifecycle.sessionId
  const assistantId = execution.assistant.id
  const assistantKind = execution.security.access.assistantKind
  const workspaceId = execution.security.access.workspaceId
  const actorUserId = execution.security.access.userId
  const security = execution.security, lifecycle = execution.lifecycle
  const originalAccess = execution.security.access
  const canonicalAccess = structuredClone(originalAccess)
  const originalAccessValue = JSON.stringify(originalAccess)
  const toolLane = invocation.toolProfile
  const boundTools = new WeakMap<Tool, Tool>()
  let retainedRunAccumulator: ContextScopeAccumulator | undefined
  let harnessRun = false
  if (owner.sessionId !== sessionId || owner.assistantId && owner.assistantId !== assistantId) throw modelInvocationChanged()
  const assertBinding = () => {
    if (authority.assertCurrent !== assertAuthority || authority.execute !== executeAuthority
      || execution.security !== security || execution.security.authority !== authority || execution.lifecycle !== lifecycle
      || execution.security.access !== originalAccess || JSON.stringify(execution.security.access) !== originalAccessValue
      || execution.lifecycle.sessionId !== sessionId || execution.assistant.id !== assistantId
      || execution.security.access.userId !== actorUserId || execution.security.access.workspaceId !== workspaceId) throw modelInvocationChanged()
  }
  const current = async () => {
    owner.signal.throwIfAborted(); assertBinding(); await assertCurrent(); assertBinding(); owner.signal.throwIfAborted()
  }
  const resolveCustom = async (request: Parameters<WorkspaceCustomLlmResolver>[0], enabled = true) => {
    if (!enabled || !services.resolveWorkspaceCustomLlm) return null
    await current()
    const resolved = await services.resolveWorkspaceCustomLlm(request)
    await current()
    return snapshotRuntime(resolved)
  }
  const legacyKey = async () => {
    if (!workspaceId || !services.resolveLegacyByoKey) return null
    await current(); const key = await services.resolveLegacyByoKey(workspaceId); await current()
    return key
  }
  const legacy = async () => {
    if (!services.buildLegacyByoProvider) return null
    const key = await legacyKey()
    return key ? services.buildLegacyByoProvider(key) : null
  }
  const builtInAvailable = (model: string) => !services.configuredProviders
    || (() => { const row = registryRow(model); return row ? isRegistryModelAvailable(row, services.configuredProviders) : false })()
  const bindTools = (candidates: ReadonlyMap<string, Tool>): Map<string, Tool> => {
      assertBinding(); owner.signal.throwIfAborted()
      if (!toolLane) throw modelInvocationChanged()
      const access = canonicalAccess
      const axes = { clearance: access.clearance, compartments: access.compartments,
        mutationCompartments: access.mutationCompartments, projectIds: access.projectIds }
      // Resume keeps its saved bounded ceiling (already the execution's access)
      // and the original turn's shared-audience rule (decision D4).
      const projection = toolLane === 'channel' ? canonicalAccess
        : toolLane === 'web' ? { ...axes, sharedAudience: canonicalAccess.sharedAudience }
        : toolLane === 'callee' ? { ...axes, clearance: access.clearance ?? 'public', visibilityAssistantIds: access.visibilityAssistantIds }
        : toolLane === 'resume' ? { ...axes, visibilityAssistantIds: access.visibilityAssistantIds, sharedAudience: canonicalAccess.sharedAudience }
        : axes
      const unbound = new Map([...candidates].filter(([, tool]) => !boundTools.has(tool)))
      const prepared = bindToolsToAgentAccess(unbound, projection, {
        assertContext(candidate, operationMayHaveExecuted = false) {
          try {
            assertBinding(); owner.signal.throwIfAborted(); candidate.abortSignal.throwIfAborted()
            if (candidate.userId !== actorUserId || candidate.assistantId !== assistantId || candidate.assistantKind !== assistantKind || candidate.sessionId !== sessionId
            || (candidate.workspaceId ?? '') !== (workspaceId ?? '')
            || candidate.executionContext !== execution || candidate.authority !== authority) throw modelInvocationChanged()
          } catch (error) { if (operationMayHaveExecuted) throw new AuthorityChangedError(true); throw error }
        },
        execute(operation, effect) {
          const enclosing = currentAgentAccess()
          const originalEnclosing = enclosing ? structuredClone(enclosing) : undefined
          return owner.effect(async () => {
            const check = () => {
              try { owner.signal.throwIfAborted(); assertBinding() }
              catch (error) { if (effect.started) throw new AuthorityChangedError(true); throw error }
            }
            check()
            try {
              const result = await dispatchAuthority(async () => {
                check()
                // Retained authority can restore parent ALS; reapply the actual
                // effect's narrower enclosing scope and original child ceiling.
                const invoke = () => runWithAgentAccess(canonicalAccess, operation)
                return originalEnclosing ? runWithAgentAccess({ ...originalEnclosing, compartments: originalEnclosing.compartments }, invoke) : invoke()
              })
              check(); return result
            } catch (error) { check(); throw error }
          })
        },
      })
      for (const [name, bound] of prepared) {
        boundTools.set(unbound.get(name)!, bound); boundTools.set(bound, bound)
      }
      return new Map([...candidates].map(([name, tool]) => [name, boundTools.get(tool)!]))
  }
  return {
    tools: bindTools,
    /** Synchronous capture, then the returned operation performs admission,
     * Brief and final assembly. Nothing the adapter supplied is read after this call. */
    captureRun(input: TurnRunPreparationInput, model: PreparedTurnModel, accumulator?: ContextScopeAccumulator): () => Promise<PreparedTurnRun> {
      assertBinding(); owner.signal.throwIfAborted()
      const systemPrompt = String(input.systemPrompt)
      const messages = snapshotMessageData(input.messages)
      const copy = (contributions: readonly NamedRunContribution[] | undefined) =>
        (contributions ?? []).map(({ name, content }) => Object.freeze({ name: String(name), content: String(content) }))
      const trusted = copy(input.trustedContributions), visible = copy(input.userVisibleContributions)
      // Bind through this same owner (an already bound candidate is reused, not
      // rebound), then capture each implementation before any await.
      const adopted = new Map([...bindTools(input.candidateTools)].map(([name, candidate]) =>
        [name, { candidate, snapshot: snapshotTool(candidate) }] as const))
      const briefPreparation = captureBriefRunPreparation()
      const harnessPreparation = captureHarnessRunPreparation()
      harnessRun = harnessPreparation.appliesTo(execution, input.candidateTools)
      retainedRunAccumulator = accumulator
      const maxTokens = model.maxTokens, inputTokenLimit = model.inputTokenLimit
      return async () => {
        // Channel keeps its existing lease-only assembly boundary. Other
        // surfaces first require their captured full admission.
        if (toolLane !== 'channel') await current()
        await assertAuthority.call(authority)
        assertBinding(); owner.signal.throwIfAborted()
        const snapshots = new Map([...adopted].map(([name, entry]) => [name, entry.snapshot]))
        // Accepted Brief grounding for a Project-bound execution, below runtime
        // policy, on every lane: resume's system execution freezes its basis
        // under its approval job like any unattended run.
        const brief = await briefPreparation(execution, snapshots)
        assertBinding(); owner.signal.throwIfAborted()
        const harness = harnessRun ? await harnessPreparation.apply(execution, brief.tools, accumulator) : null
        if (harnessRun) {
          await current()
          await assertAuthority.call(authority)
          assertBinding(); owner.signal.throwIfAborted()
        }
        const userVisibleContext = assemble(visible)
        const attached = attachUserVisibleContext(messages, userVisibleContext)
        // The single fallback branch: no plain trailing user turn can carry it.
        const fallback = !attached && userVisibleContext ? formatUserVisibleContext(userVisibleContext) : ''
        const [primary, ...supplementary] = trusted
        const runtime = primary?.content ?? ''
        const runtimeWithFallback = fallback ? `${runtime}\n\n${fallback}` : runtime
        const runtimeSystemContext = assemble([{ name: primary?.name ?? 'runtime', content: runtimeWithFallback }, ...supplementary,
          ...(brief.contribution ? [brief.contribution] : []), ...(harness ? [harness] : [])])
        const tools = new Map<string, Tool>(), unwrapped = new Set<string>()
        for (const [name, tool] of brief.tools) {
          if (tool === adopted.get(name)?.snapshot) { tools.set(name, tool); unwrapped.add(name) }
          else tools.set(name, snapshotTool(tool))
        }
        return Object.freeze({ systemPrompt, messages: attached ?? messages, tools, runtimeSystemContext, maxTokens, inputTokenLimit,
          // Existing reply-grounding seeds: channel seeds before placement.
          grounding: Object.freeze({ runtimeContext: toolLane === 'channel' ? runtime : runtimeWithFallback, userVisibleContext }),
          adoptsTool: (name: string, candidate: Tool) => unwrapped.has(name) && adopted.get(name)?.candidate === candidate })
      }
    },
    get lane() { return toolLane },
    get sessionId() { return sessionId },
    /** History acquisition binding: a native authority must be this invocation's
     * own execution; a stored read (resume) carries none. No I/O, no allow result. */
    assertHistoryAuthority(native: { execution: ExecutionContext } | null) {
      assertBinding(); owner.signal.throwIfAborted()
      if (native && (native.execution !== execution || native.execution.lifecycle.sessionId !== sessionId)) throw modelInvocationChanged()
    },
    assertLoopContext(candidate: ToolContext) {
      assertBinding()
      if (candidate.executionContext !== execution || harnessRun && candidate.scopeAccumulator !== retainedRunAccumulator) throw modelInvocationChanged()
    },
    async background(fallback: { model?: string; configuredDefault?: boolean }): Promise<PreparedBackgroundModel> {
      const original = { ...fallback }
      await current()
      const runtime = workspaceId ? await resolveCustom({ workspaceId, requestedTier: 'standard', allowDefault: true, allowAnyDefault: true }) : null
      return Object.freeze({ provider: runtime?.provider ?? services.provider,
        model: runtime?.selector ?? (original.configuredDefault ? backgroundModelFor(services.configuredProviders) : original.model),
        maxTokens: runtime?.maxTokens, inputTokenLimit: runtime?.inputTokenLimit,
        customLlm: runtime, get providerKeySource() { return runtime?.providerKeySource ?? 'platform' } })
    },
    async main(inputRequest: TurnMainModelRequest): Promise<PreparedTurnModel> {
      const request = structuredClone(inputRequest)
      if (request.kind !== toolLane) throw modelInvocationChanged()
      await current()
      let logicalModel: string, logicalTier: string, model: string
      let runtime: ResolvedWorkspaceCustomLlm | null = null, provider = services.provider
      let keySource: 'user' | 'platform' = 'platform', usedLegacyByoKey = false
      let imageRoute: PreparedTurnModel['imageRoute'] = 'serve_on_route'
      let refusal: PreparedTurnModel['refusal']
      let budget: PreparedTurnModel['budget']
      if (request.kind === 'web') {
        const explicit = request.requestedModel?.startsWith('custom:') ? request.requestedModel : undefined
        logicalModel = request.metered ? request.metered.alias : request.researchMode && request.budgetStatus !== 'downgraded'
          ? resolveModel('research', 'max_5x', request.budgetStatus) : resolveModel(explicit ? undefined : request.requestedModel, request.plan, request.budgetStatus)
        logicalTier = tierForModel(logicalModel)
        model = services.configuredProviders ? ensureServableModel(logicalModel, services.configuredProviders) : logicalModel
        if (workspaceId && !request.metered) {
          const resolved = await resolveWorkspaceTurnLlm({ workspaceId, requestedModel: explicit, requestedTier: logicalTier,
            platformProvider: services.provider, resolveWorkspaceCustomLlm: request => resolveCustom(request),
            resolveLegacyByoKey: services.resolveLegacyByoKey ? legacyKey : null, buildLegacyByoProvider: services.buildLegacyByoProvider })
          runtime = resolved.customRuntime; provider = resolved.provider; keySource = resolved.providerKeySource; usedLegacyByoKey = resolved.usedLegacyByoKey
          if (explicit && !runtime) refusal = 'custom_model_unavailable'
          imageRoute = decideImageTurnRoute({ route: runtime, turnHasImage: request.hasImage,
            explicitCustomSelection: Boolean(explicit), builtInServable: builtInAvailable(model) })
          if (imageRoute === 'fall_back_to_builtin') {
            runtime = null
            const byo = await legacy(); provider = byo ?? services.provider; keySource = byo ? 'user' : 'platform'; usedLegacyByoKey = Boolean(byo)
          } else if (runtime) { provider = runtime.provider; keySource = runtime.providerKeySource }
        }
      } else if (request.kind === 'channel' || request.kind === 'public') {
        const selected = resolveChatModelSelection(request.requestedAlias, request.plan, request.budgetStatus, services.configuredProviders)
        logicalModel = selected.logicalModel; logicalTier = selected.logicalTier; model = selected.servingModel
        runtime = workspaceId ? await resolveCustom({ workspaceId, requestedTier: logicalTier, allowDefault: true,
          ...(request.kind === 'channel' ? { allowFailureFallback: true } : {}) }) : null
        if (request.kind === 'channel') {
          imageRoute = decideImageTurnRoute({ route: runtime, turnHasImage: Boolean(request.hasImage), explicitCustomSelection: false,
            builtInServable: builtInAvailable(model) })
          if (imageRoute !== 'serve_on_route') runtime = null
        }
        provider = runtime?.provider ?? services.provider; keySource = runtime?.providerKeySource ?? 'platform'
      } else if (request.kind === 'callee') {
        logicalModel = request.researchFanout ? MODEL_MAP.research : request.modelAlias ? MODEL_MAP[request.modelAlias] ?? MODEL_MAP.standard : 'gemini-3.6-flash-pro'
        logicalTier = tierForModel(logicalModel); model = logicalModel
        runtime = workspaceId ? await resolveCustom({ workspaceId, requestedTier: logicalTier, allowDefault: true }) : null
        provider = runtime?.provider ?? services.provider; keySource = runtime?.providerKeySource ?? 'platform'
      } else {
        const policy = resolveDurableResumePolicy(request, request.fallbackModel)
        logicalTier = policy.logicalTier; logicalModel = policy.logicalModel; budget = policy.budget
        runtime = request.selectedCustomModel && !request.selectedLegacyByo && workspaceId
          ? await resolveCustom({ workspaceId, requestedModel: request.selectedCustomModel, requestedTier: logicalTier }) : null
        if (request.selectedCustomModel && !runtime) throw new Error('The custom model selected for this suspended turn is no longer available.')
        provider = runtime?.provider ?? services.provider; keySource = runtime ? 'user' : 'platform'
        if (request.selectedLegacyByo) {
          if (!services.resolveLegacyByoKey || !services.buildLegacyByoProvider) throw new Error('The legacy BYO Gemini runtime for this suspended turn is unavailable.')
          const byo = await legacy()
          if (!byo) throw new Error('The legacy BYO Gemini key for this suspended turn is unavailable.')
          provider = byo; keySource = 'user'; usedLegacyByoKey = true
        }
        model = runtime?.selector ?? logicalModel
      }
      await current()
      return Object.freeze({ provider, model, logicalModel, logicalTier, configuredProviders: services.configuredProviders,
        customLlm: runtime, get providerKeySource() { return runtime?.providerKeySource ?? keySource }, usedLegacyByoKey, imageRoute, refusal, budget,
        maxTokens: runtime?.maxTokens, inputTokenLimit: runtime?.inputTokenLimit })
    },
  }
}
function modelInvocationChanged(): Error {
  return Object.assign(new Error('The original turn-preparation invocation changed.'), { reason: 'authority_changed', retrySafe: false })
}

/** Finite source-registry entitlement snapshot; never retain a mutable catalog
 * function as the model-selection answer across an admission await. */
function snapshotModelAvailability(input: ProviderAvailability | undefined): ProviderAvailability | undefined {
  if (!input) return undefined
  const providers = new Set(input), preferredProvider = input.preferredProvider
  const modelKey = (provider: string, model: string) => JSON.stringify([provider, model])
  const byModel = input.isModelAvailable ? new Map(MODEL_REGISTRY.map(row =>
    [modelKey(row.provider, row.apiModelId), Boolean(input.isModelAvailable!(row.provider, row.apiModelId))] as const)) : null
  const snapshot: ProviderAvailability = {
    get size() { return providers.size }, has(value) { return providers.has(value) },
    entries() { return providers.entries() }, keys() { return providers.keys() }, values() { return providers.values() },
    [Symbol.iterator]() { return providers.values() },
    forEach(callback, thisArg) { providers.forEach(value => callback.call(thisArg, value, value, snapshot)) },
    preferredProvider,
    ...(byModel ? { isModelAvailable: (provider: string, model: string) => byModel.get(modelKey(provider, model)) ?? false } : {}),
  }
  return Object.freeze(snapshot)
}

export async function resolveWorkspaceTurnLlm(params: {
  workspaceId: string
  requestedModel?: string
  requestedTier: string
  platformProvider: LLMProvider
  resolveWorkspaceCustomLlm: import('../custom-llm-runtime.js').WorkspaceCustomLlmResolver | null
  resolveLegacyByoKey: (() => Promise<string | null>) | null
  buildLegacyByoProvider: ((apiKey: string) => LLMProvider) | null
}): Promise<{
  customRuntime: import('../custom-llm-runtime.js').ResolvedWorkspaceCustomLlm | null
  provider: LLMProvider
  providerKeySource: 'user' | 'platform'
  usedLegacyByoKey: boolean
}> {
  const customRuntime = params.resolveWorkspaceCustomLlm
    ? await params.resolveWorkspaceCustomLlm({
        workspaceId: params.workspaceId,
        requestedModel: params.requestedModel,
        requestedTier: params.requestedTier,
        allowDefault: true,
        // This is the main user-facing web turn, and it has a `notice` lane
        // to announce a fallback on. Background lanes below must NOT pass
        // this - see the resolver's `allowFailureFallback` docs.
        allowFailureFallback: true,
      })
    : null
  if (customRuntime) {
    return {
      customRuntime,
      provider: customRuntime.provider,
      providerKeySource: 'user',
      usedLegacyByoKey: false,
    }
  }
  if (params.requestedModel) {
    return {
      customRuntime: null,
      provider: params.platformProvider,
      providerKeySource: 'platform',
      usedLegacyByoKey: false,
    }
  }

  // Legacy Gemini settings are consulted only when no workspace custom
  // endpoint applies. A stale encrypted legacy row must not block a valid
  // custom selection, while legacy decrypt failures remain fail-closed here.
  if (params.resolveLegacyByoKey && params.buildLegacyByoProvider) {
    const byoKey = await params.resolveLegacyByoKey()
    if (byoKey) {
      return {
        customRuntime: null,
        provider: params.buildLegacyByoProvider(byoKey),
        providerKeySource: 'user',
        usedLegacyByoKey: true,
      }
    }
  }
  return {
    customRuntime: null,
    provider: params.platformProvider,
    providerKeySource: 'platform',
    usedLegacyByoKey: false,
  }
}

export function resolveDurableResumePolicy(
  params: { selectedTier?: string; selectedMeteredModel?: string },
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
