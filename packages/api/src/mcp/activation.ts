/**
 * Connector activation (M3 WP2, capability routing).
 *
 * Owns everything between "the catalog admitted these bindings" and "the
 * model may call this tool":
 *
 * - policy (`applyToolPolicies`)
 *   and instance variants (`injectInstanceVariants`), called by the provider
 *   modules while they build a lane;
 * - binding fingerprints shared with the catalog (`connectorBindingKey`,
 *   `connectorBindingFingerprint`);
 * - the turn authority (`createTurnAuthority`): runtime authority, exposure
 *   gate with `bindingMaximum` and `onAdmittedBinding`, binding and auth pins,
 *   `assertBindingsCurrent` and the runtime-authority tool wrapper;
 * - lazy activation (`createActivation`): one memoized promise per family per
 *   turn, then `filterToolsByActionGrants` and the authority wrapper.
 *
 * Imports provider modules as types only; the registry is passed in, so the
 * providers can import the policy helpers from here without a cycle.
 *
 * See docs/architecture/integrations/mcp.md → "Provider activation".
 */
import { inheritRoutineCalendarRead } from '@use-brian/core/engine/routine-read-ownership.js'
import type { McpSettingsStore } from '@use-brian/agent-runtime/mcp/types.js'
import type { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import type { ExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import type { Tool, ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import { getSharedConnectorSourceRuntimeFactory, type ConnectorSourceRuntimeFactory, type ConnectorSourceRuntime } from '../application-platform/source-runtime.js'
import { SourceProtocolError } from '@use-brian/brian-app/connector'
import { projectMailboxAuthorityConfig } from '../mailbox/config-authority.js'
import type { AssistantConnectorStore } from '../db/assistant-connector-store.js'
import { filterToolsByActionGrants } from '../safety/assert-action-allowed.js'
import { buildConnectorAuthHeaders, type ActorIdentity } from './auth-headers.js'
import { hasToolConfirmation, readToolPolicies } from '@use-brian/agent-runtime/mcp/policy.js'
import { policyBlockedToolResult } from '@use-brian/agent-runtime/engine/decline-copy.js'
import { connectorInstanceGovernanceId, type ConnectorInstanceStore } from '../db/connector-instance-store.js'
import { CONNECTOR_SCOPE_RESTRICTION, CONNECTOR_SOURCE_RESTRICTION } from './discovery-diagnostics.js'
import { createConnectorRuntimeAuthority } from '../application-platform/connector-runtime-authority.js'
import { createHash } from 'node:crypto'
import { AuthorityChangedError } from '../context-scope/authority-lease.js'
import { connectorExposureAllowed, type ConnectorContextBinding, type ConnectorTurnGrant } from '../context-scope/connector-exposure.js'
import { instanceToolSuffix, type ConnectorInstanceRef } from './tool-names.js'
import type { ProviderModule, ProviderActivationContext, ActivationAuthority, ProviderFamily } from './providers/types.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'
import type { DescriptorRecord } from './descriptors.js'

/** Admit one instance's tool set, then re-read the selected tool at each use. */
export async function applyToolPolicies(
  candidates: Tool[],
  serverName: string,
  settingsStore: McpSettingsStore,
  assistantId: string,
  userId: string,
  unavailable?: string[],
  options: {
    canonicalName?: (tool: Tool) => string
    appServerName?: string
    assistantFallbackServerName?: string
  } = {},
): Promise<Tool[]> {
  const keys = { assistantId, userId, serverName, ...options }
  const policyTools = candidates.map(tool => ({
    name: options.canonicalName?.(tool) ?? tool.name,
    defaultPolicy: tool.requiresConfirmation ? 'ask' as const : 'allow' as const,
  }))
  const policies = await readToolPolicies(settingsStore, keys, policyTools)
  return candidates.filter((tool, index) => {
    if (policies[index]!.effectivePolicy === 'block') {
      unavailable?.push(`${tool.name} (blocked by policy)`)
      return false
    }
    const readCurrent = async () => (await readToolPolicies(settingsStore, keys, [policyTools[index]!]))[0]!.effectivePolicy
    tool.resolveConfirmation = async () => await readCurrent() === 'ask'
    const execute = tool.execute
    tool.execute = async (input, context) => {
      const current = await readCurrent()
      if (current === 'block') return { data: policyBlockedToolResult(tool.name), isError: true }
      if (current === 'ask' && !hasToolConfirmation(context, tool.name, input)) {
        return { data: `"${tool.name}" requires approval for this invocation. The tool did not run.`, isError: true }
      }
      return execute.call(tool, input, context)
    }
    return true
  })
}

/**
 * Inject label-qualified tool variants for each additional connector instance.
 * `buildToolsForInstance` returns the provider's canonical tool set already
 * bound to the given instance's credentials; this helper renames + tags them
 * and applies exact-instance enablement and policy with provider fallback.
 */
export async function injectInstanceVariants(opts: {
  provider: string
  extras: ConnectorInstanceRef[]
  settingsStore: McpSettingsStore
  assistantId: string
  userId: string
  assistantConnectorStore?: AssistantConnectorStore
  tools: Map<string, Tool>
  buildToolsForInstance: (instance: ConnectorInstanceRef, governanceId: string) => Tool[]
}): Promise<void> {
  for (const extra of opts.extras) {
    const governanceId = connectorInstanceGovernanceId(opts.provider, extra.id)
    const enabled = !opts.assistantConnectorStore
      || await opts.assistantConnectorStore.isEnabled(opts.assistantId, governanceId, opts.provider)
    if (!enabled) continue
    let variantTools: Tool[]
    try {
      variantTools = opts.buildToolsForInstance(extra, governanceId)
    } catch (err) {
      console.error(`[mcp-inject] ${opts.provider} instance ${extra.id} build failed:`, err)
      continue
    }
    const suffix = instanceToolSuffix(extra.id, extra.label)
    const variants = variantTools.map(tool => inheritRoutineCalendarRead(tool, {
      ...tool,
      name: `${tool.name}${suffix}`,
      description: `[${extra.label}] ${tool.description}`,
    }))
    for (const variant of await applyToolPolicies(variants, governanceId, opts.settingsStore, opts.assistantId, opts.userId, undefined, {
      canonicalName: tool => tool.name.slice(0, -suffix.length),
      appServerName: opts.provider,
      assistantFallbackServerName: opts.provider,
    })) {
      opts.tools.set(variant.name, variant)
    }
  }
}

// ── Binding fingerprints ──────────────────────────────────────
//
// One digest vocabulary for the catalog (`bindingMaximum` issuance,
// `onAdmittedBinding`) and for activation-time pins, so a binding admitted at
// catalog time is re-checked against exactly the fingerprint it was admitted
// with.

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Fingerprint of a `connector_instance` row's authority-bearing fields. */
export function instanceBindingFingerprint(instance: Record<string, unknown>): string {
  return digest([instance.id,instance.scope,instance.userId,instance.workspaceId,
    instance.provider,instance.connectedEmail,instance.connected,instance.url,instance.sensitivity,instance.compartments,instance.projectIds,projectMailboxAuthorityConfig(instance),
    instance.healthStatus === 'auth_failed'])
}

/** Fingerprint of a `connector_grant` row's authority-bearing fields. */
export function exposureBindingFingerprint(grant: Record<string, unknown>): string {
  return digest([grant.id,grant.connectorInstanceId,grant.targetType,grant.targetId,
    grant.grantedByUserId,grant.compartments,grant.projectIds])
}

/** Fingerprint of resolved auth headers (order-insensitive). */
export function authBindingFingerprint(headers: Record<string, string>): string {
  return digest(Object.entries(headers).sort(([left],[right]) => left.localeCompare(right)))
}

/** `instance:<id>` for a workspace-owned row, `grant:<id>` for a member exposure. */
export function connectorBindingKey(binding: ConnectorContextBinding): string {
  const row = binding as unknown as Record<string, unknown>
  return `${row.instance ? 'grant' : 'instance'}:${row.id}`
}

/** The fingerprint `bindingMaximum` must carry for `connectorBindingKey(binding)`. */
export function connectorBindingFingerprint(binding: ConnectorContextBinding): string {
  const row = binding as unknown as Record<string, unknown>
  const instance = (row.instance ?? row) as Record<string, unknown>
  return digest([instanceBindingFingerprint(instance), row.instance ? exposureBindingFingerprint(row) : null])
}

// ── Turn authority ────────────────────────────────────────────

type RuntimeAuthority = Awaited<ReturnType<typeof createConnectorRuntimeAuthority>>

export type TurnAuthorityParams = {
  assistantId: string
  assistantTeamId?: string | null
  actorIdentity?: ActorIdentity
  contextScope?: ConnectorTurnGrant
  executionContext?: ExecutionContext
  scopeAccumulator?: ContextScopeAccumulator
  /** Host-supplied protected source adapter; the boot-bound shared factory otherwise. */
  connectorSourceRuntimeFactory?: ConnectorSourceRuntimeFactory
  connectorInstanceStore?: ConnectorInstanceStore
  connectorGrantStore?: ConnectorGrantStore
  /** Issued account/exposure ceiling: binding key → admitted fingerprint. */
  bindingMaximum?: Readonly<Record<string, string>>
  /** Server-only observer of bindings admitted by current native policy. */
  onAdmittedBinding?: (key: string, fingerprint: string) => void
  /** The turn's unavailable sink (scope restriction and protected-source notices). */
  unavailable: string[]
  /**
   * The runtime authority the capability catalog already created for this
   * turn. Supplied, it is reused (one runtime authority per turn); absent, a
   * team assistant creates its own.
   */
  runtimeAuthority?: RuntimeAuthority
}

/**
 * Captured authority for one turn. Implements the provider-facing
 * {@link ActivationAuthority} and adds the transport ports the remote-MCP
 * provider and the composition need.
 */
export interface TurnAuthority extends ActivationAuthority {
  /** Connector runtime authority (team assistants only). */
  readonly runtimeAuthority?: RuntimeAuthority
  /** Connector types with an admitted current native account binding. */
  readonly admittedConnectorIds: Set<string>
  /**
   * Exposure gate. `scopeAllowed` is the caller's `connectorExposureAllowed`
   * verdict; omitted, it is computed here from the captured turn grant.
   */
  exposureAllowed(binding: ConnectorContextBinding, scopeAllowed?: boolean): boolean
  /** Protected source runtime for an exact instance (memoized per instance). */
  sourceRuntime(instanceId: string | null | undefined, headers: Record<string, string>): Promise<ConnectorSourceRuntime | null>
  noteProtectedUnavailable(): void
  /** Digest of the pins held for one instance; part of the discovery cache key. */
  bindingCacheKey(instanceId: string | null | undefined): string
  /** Runtime-authority wrapper for one activated tool (identity without a runtime authority). */
  wrapTool(tool: Tool, discoveryBindings?: readonly ConnectorContextBinding[]): Tool
  /**
   * Wrap every tool in `tools` that is not identical to its `originalTools`
   * entry, keep routine-calendar adapters pointing at the wrapped tool, then
   * re-check the runtime authority and every pin.
   */
  wrapToolMap(tools: Map<string, Tool>, originalTools: ReadonlyMap<string, Tool>, routineCalendarTools: Map<string, Tool>): Promise<void>
  /** Re-check the runtime authority and every pin after an activation. */
  assertActivationCurrent(): Promise<void>
  /** Run a confirmation enricher inside the runtime authority with pins checked before and after. */
  wrapEnricher<E extends (toolName: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>>(enricher: E): E
}

/**
 * Create the turn authority. Returns `null` when the connector runtime
 * authority cannot be created; the caller then exposes no connector tools and
 * reports `CONNECTOR_SCOPE_RESTRICTION`.
 */
export async function createTurnAuthority(params: TurnAuthorityParams): Promise<TurnAuthority | null> {
  const {
    assistantId, assistantTeamId, actorIdentity, contextScope, executionContext, scopeAccumulator,
    connectorSourceRuntimeFactory: suppliedSourceRuntimeFactory, connectorInstanceStore, connectorGrantStore,
    bindingMaximum, onAdmittedBinding, unavailable, runtimeAuthority: suppliedRuntimeAuthority,
  } = params

  const connectorSourceRuntimeFactory = suppliedSourceRuntimeFactory ?? getSharedConnectorSourceRuntimeFactory()
  const usingSharedSourceFactory = !suppliedSourceRuntimeFactory && !!connectorSourceRuntimeFactory
  const legacySourceAuthorities = new Set<() => Promise<void>>()
  const runtimeActorId = contextScope?.access?.userId ?? actorIdentity?.userId
  const protectedSources = new Set<ConnectorSourceRuntime>()
  const noteProtectedUnavailable = () => {
    if (!unavailable.includes(CONNECTOR_SOURCE_RESTRICTION)) unavailable.push(CONNECTOR_SOURCE_RESTRICTION)
  }
  const sourceRuntimes = new Map<string, Promise<ConnectorSourceRuntime | null>>()
  const sourceRuntime = (instanceId: string | null | undefined, headers: Record<string, string>) => {
    if (!instanceId || !assistantTeamId || !connectorSourceRuntimeFactory) return Promise.resolve(null)
    if (executionContext && (executionContext.assistant.id !== assistantId || executionContext.security.access.userId !== runtimeActorId)) throw new AuthorityChangedError()
    let pending = sourceRuntimes.get(instanceId)
    if (!pending) {
      pending = connectorSourceRuntimeFactory({ instanceId, workspaceId: assistantTeamId, execution: executionContext, accumulator: scopeAccumulator, headers, onLegacyAdmission: check => { legacySourceAuthorities.add(check) } })
        .then(runtime => { if (runtime) protectedSources.add(runtime); return runtime })
        .catch(error => {
          noteProtectedUnavailable()
          throw error
        })
      sourceRuntimes.set(instanceId, pending)
    }
    return pending
  }
  const pinnedBindings = new Map<string, { instanceId: string; instance: string; grant?: string }>()
  const pinnedAuth = new Map<string, string>()
  let bindingsInvalid = false
  const bindingCacheKey = (id: string | null | undefined) => digest([...pinnedBindings].filter(([, binding]) => binding.instanceId === id)
    .sort(([left],[right]) => left.localeCompare(right)))
  function pinBinding(binding: ConnectorContextBinding) {
    if (!assistantTeamId || !runtimeActorId || !connectorInstanceStore) return
    const row = binding as unknown as Record<string, unknown>
    const instance = (row.instance ?? row) as Record<string, unknown>
    if (typeof instance.id !== 'string' || typeof row.id !== 'string') return
    const key = connectorBindingKey(binding)
    const pinned = { instanceId: instance.id, instance: instanceBindingFingerprint(instance), ...(row.instance ? { grant: exposureBindingFingerprint(row) } : {}) }
    const prior = pinnedBindings.get(key)
    if (prior && JSON.stringify(prior) !== JSON.stringify(pinned)) bindingsInvalid = true
    else pinnedBindings.set(key, pinned)
  }
  function pinAuth(instanceId: string, headers: Record<string, string>) {
    if (!runtimeActorId) return
    const current = authBindingFingerprint(headers), prior = pinnedAuth.get(instanceId)
    if (prior && prior !== current) bindingsInvalid = true
    else pinnedAuth.set(instanceId, current)
  }
  async function assertBindingsCurrent(mayHaveExecuted = false) {
    if (bindingsInvalid) throw new AuthorityChangedError(mayHaveExecuted)
    if (usingSharedSourceFactory && (protectedSources.size > 0 || legacySourceAuthorities.size > 0)
      && getSharedConnectorSourceRuntimeFactory() !== connectorSourceRuntimeFactory) {
      bindingsInvalid = true; throw new AuthorityChangedError(mayHaveExecuted)
    }
    try {
      const grants = [...pinnedBindings.values()].some(binding => binding.grant)
        ? await connectorGrantStore!.listForTargetSystem('workspace', assistantTeamId!) : []
      await Promise.all([...pinnedBindings].map(async ([key, expected]) => {
        const current = await connectorInstanceStore!.getSystem(expected.instanceId)
        if (!current || instanceBindingFingerprint(current as unknown as Record<string, unknown>) !== expected.instance) throw new AuthorityChangedError(mayHaveExecuted)
        let binding: ConnectorContextBinding = current
        if (expected.grant) {
          const grant = grants.find(grant => `grant:${grant.id}` === key)
          if (!grant || exposureBindingFingerprint(grant as unknown as Record<string, unknown>) !== expected.grant) throw new AuthorityChangedError(mayHaveExecuted)
          binding = grant
        }
        // Fingerprints prove metadata identity, not the current reader/audience.
        // Recheck exposure at invocation and return, including ambient narrowing.
        if (!(runtimeAuthority?.allows(binding) ?? true) || !connectorExposureAllowed(contextScope, binding)) {
          throw new AuthorityChangedError(mayHaveExecuted)
        }
      }))
      await Promise.all([...pinnedAuth].map(async ([id, expected]) => {
        const headers = buildConnectorAuthHeaders(await connectorInstanceStore!.getAuthCredentialsSystem(id))
        if (authBindingFingerprint(headers) !== expected) throw new AuthorityChangedError(mayHaveExecuted)
      }))
      await Promise.all([...legacySourceAuthorities].map(check => check()))
      await Promise.all([...protectedSources].map(source => source.assertCurrent()))
    } catch (error) {
      if (error instanceof SourceProtocolError) noteProtectedUnavailable()
      bindingsInvalid = true
      throw new AuthorityChangedError(mayHaveExecuted)
    }
  }
  let runtimeAuthority: RuntimeAuthority | undefined = suppliedRuntimeAuthority
  if (assistantTeamId && !runtimeAuthority) {
    try {
      runtimeAuthority = await createConnectorRuntimeAuthority({ workspaceId: assistantTeamId, assistantId,
        initiatingUserId: runtimeActorId, identityUserId: actorIdentity?.userId })
    } catch {
      return null
    }
  }
  // Discovery visits the same bindings in multiple lanes. Report once per
  // injection, without exposing connector identity, scope values, or counts.
  const admittedConnectorIds = new Set<string>()
  let scopeRejectionReported = false
  const exposureAllowed = (binding: ConnectorContextBinding, scopeAllowed?: boolean): boolean => {
    const allowedByScope = (runtimeAuthority?.allows(binding) ?? true) && (scopeAllowed ?? connectorExposureAllowed(contextScope, binding))
    const row = binding as unknown as Record<string, unknown>
    const instance = (row.instance ?? row) as Record<string, unknown>
    const key = connectorBindingKey(binding)
    const fingerprint = connectorBindingFingerprint(binding)
    const allowed = allowedByScope
      && (bindingMaximum === undefined || bindingMaximum[key] === fingerprint)
    if (allowed) {
      onAdmittedBinding?.(key, fingerprint)
      if (typeof instance.provider === 'string' && instance.connected === true && instance.healthStatus !== 'auth_failed') admittedConnectorIds.add(instance.provider)
    }
    if (allowed) pinBinding(binding)
    if (!allowed && !scopeRejectionReported) {
      scopeRejectionReported = true
      unavailable.push(CONNECTOR_SCOPE_RESTRICTION)
      console.info('[mcp-inject] connector discovery scope restriction', {
        assistantId,
        workspaceId: assistantTeamId ?? null,
        reason: 'connector_exposure_outside_execution_scope',
      })
    }
    return allowed
  }

  // ── Runtime-authority wrapper ──
  // Every activated tool re-enters the captured authority: the tool context
  // must still be the original invocation's actor/assistant/workspace (and,
  // with protected sources bound, the same execution context and
  // accumulator); pins are re-checked before the effect and after it.
  function wrapTool(tool: Tool, discoveryBindings: readonly ConnectorContextBinding[] = []): Tool {
    if (!runtimeAuthority) return tool
    const authority = runtimeAuthority
    const assertActor = (context: ToolContext, mayHaveExecuted = false) => {
      if (protectedSources.size > 0 && (context.executionContext !== executionContext || context.scopeAccumulator !== scopeAccumulator)) {
        throw new AuthorityChangedError(mayHaveExecuted)
      }
      const canonical = context.executionContext?.security.access
      if (context.executionContext?.lifecycle.abortSignal.aborted || canonical && (canonical.userId !== context.userId
        || canonical.assistantId !== context.assistantId || canonical.workspaceId !== context.workspaceId)) {
        throw new AuthorityChangedError(mayHaveExecuted)
      }
      if (runtimeActorId && (context.userId !== runtimeActorId || context.assistantId !== assistantId
        || context.workspaceId !== assistantTeamId)) throw new AuthorityChangedError(mayHaveExecuted)
    }
    const invoke = <T>(context: ToolContext, operation: () => Promise<T>): Promise<T> => {
      assertActor(context)
      const admitted = async () => {
        // Discovery can serve catalog metadata without activating a family.
        // Pin its original bindings at the effect, before returning that metadata.
        for (const binding of discoveryBindings) pinBinding(binding)
        await assertBindingsCurrent()
        let result: T
        try { result = await operation() } catch (error) { await assertBindingsCurrent(true); throw error }
        await assertBindingsCurrent(true)
        assertActor(context, true)
        return result
      }
      return context.executionContext
        ? context.executionContext.security.authority.execute(() => authority.execute(admitted))
        : authority.execute(admitted)
    }
    const wrapped: Tool = { ...tool,
      execute: (input, context) => invoke(context, () => tool.execute(input, context)),
      ...(tool.resolveConfirmation ? { resolveConfirmation: (context: ToolContext, input?: unknown) => {
        return invoke(context, () => tool.resolveConfirmation!(context, input))
      } } : {}),
      ...(tool.describeConfirmation ? { describeConfirmation: (input: unknown, context: ToolContext) => {
        return invoke(context, () => tool.describeConfirmation!(input, context))
      } } : {}),
    }
    inheritRoutineCalendarRead(tool, wrapped)
    return wrapped
  }

  async function assertActivationCurrent(): Promise<void> {
    if (!runtimeAuthority) return
    await runtimeAuthority.assertCurrent()
    await assertBindingsCurrent()
  }

  async function wrapToolMap(tools: Map<string, Tool>, originalTools: ReadonlyMap<string, Tool>, routineCalendarTools: Map<string, Tool>): Promise<void> {
    if (!runtimeAuthority) return
    for (const [name, tool] of tools) {
      if (originalTools.get(name) === tool) continue
      tools.set(name, wrapTool(tool))
      if(routineCalendarTools.get(name)===tool)routineCalendarTools.set(name,tools.get(name)!)
    }
    await assertActivationCurrent()
  }

  function wrapEnricher<E extends (toolName: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>>(enricher: E): E {
    if (!runtimeAuthority) return enricher
    const authority = runtimeAuthority
    return ((tool: string, input: Record<string, unknown>) => authority.execute(async () => {
      await assertBindingsCurrent()
      const enriched = await enricher(tool, input)
      await assertBindingsCurrent()
      return enriched
    })) as E
  }

  return {
    executionContext,
    runtimeActorId,
    assistantTeamId,
    contextScope,
    scopeAccumulator,
    runtimeAuthority,
    admittedConnectorIds,
    exposureAllowed,
    pinBinding,
    pinAuth,
    assertBindingsCurrent,
    sourceRuntime,
    noteProtectedUnavailable,
    bindingCacheKey,
    wrapTool,
    wrapToolMap,
    assertActivationCurrent,
    wrapEnricher,
  }
}

// ── Lazy activation ───────────────────────────────────────────

/**
 * One family to activate with its admitted lanes (the catalog's instance
 * listing). The tool-name form (`toolNames`) still activates the whole family
 * once (memoized), but returns only the named tools (canonical or
 * instance-suffixed names), so a caller that selected one tool registers only
 * that tool.
 */
export type FamilySelection<F extends ProviderFamily = ProviderFamily> = {
  family: F
  sourceKey?: string
  instances: unknown
  toolNames?: readonly string[]
}

export type ActivationSelection = { families: readonly FamilySelection[] }

/** Activated tools plus the descriptor records dynamic families discovered on the way. */
export type ActivationOutcome = { tools: Tool[]; records: readonly DescriptorRecord[]; sourceTools?: Readonly<Record<string, Tool[]>> }

export type ProviderRegistry = Readonly<Partial<Record<ProviderFamily, ProviderModule<never>>>>

export type Activation = {
  /**
   * Memoize each selected native family or dynamic source for the turn.
   * A previously loaded full family can serve a selected source.
   */
  activate(selection: ActivationSelection): Promise<Tool[]>
  /** As `activate`, also returning the descriptor records the activated families produced. */
  activateWithRecords(selection: ActivationSelection): Promise<ActivationOutcome>
  /** Families activated so far this turn. */
  activatedFamilies(): ProviderFamily[]
}

/**
 * Per-turn activation over provider modules. Each family's tools pass the
 * provider's own policy, build-time grant gate, health probe and instance
 * variants, then `filterToolsByActionGrants` and the runtime-authority
 * wrapper, then a fresh authority/pin check.
 */
export function createActivation(params: {
  ctx: ProviderActivationContext
  authority: Pick<TurnAuthority, 'wrapTool' | 'assertActivationCurrent'>
  providers: ProviderRegistry
}): Activation {
  const { ctx, authority, providers } = params
  const memo = new Map<string, Promise<ActivationOutcome>>()
  const activatedFamilies = new Set<ProviderFamily>()

  function activateFamily({ family, sourceKey, instances }: FamilySelection): Promise<ActivationOutcome> {
    const key = sourceKey ?? family
    const memoized = memo.get(key) ?? memo.get(family)
    if (memoized) return memoized
    const provider = providers[family] as ProviderModule<unknown> | undefined
    const pending = (async () => {
      if (!provider) throw new Error(`No provider module is registered for connector family "${family}".`)
      const result = await provider.activate(ctx, instances)
      const built = Array.isArray(result) ? result : result.tools
      const records = Array.isArray(result) ? [] : result.records ?? []
      const byName = new Map<string, Tool>()
      for (const tool of built) byName.set(tool.name, tool)
      const granted = await filterToolsByActionGrants(byName)
      const wrapped = [...granted.values()].map((tool) => authority.wrapTool(tool))
      const sourceTools = Array.isArray(result) || !result.sourceTools ? undefined
        : Object.fromEntries(Object.entries(result.sourceTools).map(([source, tools]) => [source, tools.map((tool) => authority.wrapTool(tool))]))
      await authority.assertActivationCurrent()
      return { tools: wrapped, records, ...(sourceTools ? { sourceTools } : {}) }
    })()
    memo.set(key, pending)
    activatedFamilies.add(family)
    return pending
  }

  async function activateWithRecords(selection: ActivationSelection): Promise<ActivationOutcome> {
    const results = await Promise.all(selection.families.map(async (entry) => {
      const outcome = await activateFamily(entry)
      if (!entry.toolNames) return outcome
      const named = new Set(entry.toolNames)
      return { ...outcome, tools: outcome.tools.filter((tool) => named.has(tool.name)) }
    }))
    const sourceTools = Object.assign({}, ...results.map((result) => result.sourceTools ?? {})) as Record<string, Tool[]>
    return { tools: results.flatMap((result) => result.tools), records: results.flatMap((result) => result.records),
      ...(Object.keys(sourceTools).length > 0 ? { sourceTools } : {}) }
  }

  return {
    async activate(selection) {
      return (await activateWithRecords(selection)).tools
    },
    activateWithRecords,
    activatedFamilies: () => [...activatedFamilies],
  }
}
