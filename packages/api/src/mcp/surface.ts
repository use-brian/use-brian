/**
 * Entrypoint capability surfaces (M3 WP5): the one composition every turn
 * entrypoint prepares its connector capabilities through.
 *
 * `composeSurfaceCapabilities(surface, options)` prepares the capability
 * catalog for a surface profile (`mcp/catalog.ts`, catalog-only metadata
 * work) with activation wired (`mcp/composition.ts`), then registers the
 * surface into the turn's tool map with `applySurfaceCapabilities`:
 *
 *   - folded surfaces (web, channel, public, unpinned callee) get the
 *     `mcp_search` / `mcp_call` pair over lazy native sources, the knowledge
 *     and introspection lanes, Assistant Email, deployment-keyed Google Maps
 *     reads and the dynamic (custom remote / CLI) sources, plus guarded
 *     read adapters where the profile exposes them. Nothing is built until a
 *     search hit is called or a read adapter runs;
 *   - built-in-direct surfaces (a pinned or consented callee, programmatic
 *     web chat, workspace MCP, resume) activate the catalog's direct
 *     descriptors by name and register them as themselves;
 *   - dynamic-direct surfaces activate the dynamic families for their
 *     canonical and legacy adapters.
 *
 * The options are the entrypoint parameter blocks the injector took (the
 * `mcp/inject.ts` composition this module replaced), so each entrypoint keeps
 * its stores, consent maxima, actor identity, media token, attachment ports
 * and knowledge-write policy exactly. The surface fixes the profile; an
 * option can only narrow it (`surfaceProfileFor`).
 *
 * `composeResumeCapabilities` serves a durable approval resume: the `resume`
 * profile, with exactly the suspended tool activated.
 *
 * [COMP:api/mcp-catalog]
 * See docs/architecture/integrations/mcp.md → "Entrypoint surfaces".
 */
import { ownsRoutineCalendarRead } from '@use-brian/core/engine/routine-read-ownership.js'
import type { CachedFile } from '@use-brian/core/files/types.js'
import type {
  KnowledgeRepoWriter,
  KnowledgeStoreInterface,
} from '@use-brian/core/knowledge/types.js'
import {
  buildToolIndex,
  createMcpSearchTools,
  legacyMcpToolName,
  type LocalSource,
} from '@use-brian/core/mcp/tool-search.js'
import type { GDriveFilesStore } from '@use-brian/core/tools/base/gdrive-files.js'
import type { FilesApi } from '@use-brian/core/workspace-files/api.js'
import { registerLazyCanonicalCalendarRead, type RoutineCalendarActivation } from '@use-brian/core/engine/routine-read-ownership.js'
import type { EngineHooks } from '@use-brian/agent-runtime/engine/hooks.js'
import type { McpSettingsStore } from '@use-brian/agent-runtime/mcp/types.js'
import type { AccessContext } from '@use-brian/agent-runtime/security/access-context.js'
import type { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import type { ExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import type { ConnectorResumeTarget, Tool, ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import { APP_LEVEL_ASSISTANT_ID, OFFICIAL_CONNECTORS } from '@use-brian/shared'
import type { EmailInboxProvider } from '../agentmail/provider.js'
import type { ConnectorSourceRuntimeFactory } from '../application-platform/source-runtime.js'
import type { ConnectorActionAudit } from '../connector-action-port.js'
import type { ConnectorTurnGrant } from '../context-scope/connector-exposure.js'
import { AuthorityChangedError } from '../context-scope/authority-lease.js'
import { retainInitialMailboxEvidence } from '../turn/mailbox-read-authority.js'
import { captureRetainedToolPolicy, instanceBindingFingerprint } from './activation.js'
import type { AssistantConnectorStore } from '../db/assistant-connector-store.js'
import type { ConnectorStore } from '../db/connector-store.js'
import type { KnowledgeCaptureRuleStore } from '../knowledge/capture-rules.js'
import type { ActorIdentity } from './auth-headers.js'
import {
  CapabilityActivationUnavailableError, restrictSources, surfaceProfile,
  type CapabilitySurface, type CatalogActionGrantReader, type CatalogPolicyReader, type SurfaceProfile,
} from './catalog.js'
import { dynamicCapabilityFamilies, prepareComposedCatalog, type ComposedCatalog } from './composition.js'
import type { DescriptorLifecycle } from './descriptors.js'
import type { ConfirmationEnricher } from './providers/google.js'
import { pluckGoogleMapsTools } from './providers/google-maps.js'
import { baseToolName } from './tool-names.js'

export type { ConfirmationEnricher } from './providers/google.js'

/** An entrypoint's capability parameters (the former injector options). */
export type SurfaceCapabilityOptions = {
  /** Credential owner and personal policy principal (the workspace owner for a workspace assistant). */
  userId: string
  assistantId: string
  /** The mutable tool map the surface registers into. */
  tools: Map<string, Tool>
  connectorStore: ConnectorStore
  settingsStore: McpSettingsStore
  assistantConnectorStore?: AssistantConnectorStore
  userTimezone?: string
  knowledgeStore?: KnowledgeStoreInterface
  /** KB repo write-back port; meaningful only with `allowKnowledgeWrites`. */
  knowledgeRepoWriter?: KnowledgeRepoWriter
  /**
   * Whether this surface may expose the KB WRITE tools. Set `true` ONLY on
   * interactive surfaces with a live Approve/Deny loop (web chat, channel
   * pipeline). Fail closed: absent means no write tools anywhere.
   */
  allowKnowledgeWrites?: boolean
  /** Interactive capture matching: the rule store and the newest human text. */
  knowledgeCaptureRuleStore?: KnowledgeCaptureRuleStore
  knowledgeCaptureText?: string
  /** Newest authored request for bounded read-only schema discovery. */
  discoveryQuery?: string
  /** Guarded first-party read adapters for interactive deferred selection. */
  exposeLocalReadTools?: boolean
  /** Explicit workflow tool_call steps are governed by their authored step + approval pause. */
  knowledgeWriteAuthorization?: 'capture' | 'workflow'
  gdriveFilesStore?: GDriveFilesStore
  connectorGrantStore?: import('../db/connector-grant-store.js').ConnectorGrantStore
  connectorInstanceStore?: import('../db/connector-instance-store.js').ConnectorInstanceStore
  /** Shared workspace tool policy (migration 312) for workspace-owned connectors. */
  workspaceToolPolicyStore?: import('../db/workspace-tool-policy-store.js').WorkspaceToolPolicyStore
  /** Workspace of the assistant; absent for a workspace-less personal assistant. */
  assistantTeamId?: string | null
  /** Connector-action audit (hosted): Gmail/Calendar writes emit a `connector_action` Episode. */
  connectorActionAudit?: ConnectorActionAudit
  /** Per-assistant capability grants; absent means no grant visibility filter (legacy call sites). */
  assistantConnectorGrantsStore?: import('../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore
  /** Primary email domain of the workspace (Calendar audit audience). */
  workspaceDomain?: string | null
  /** Built-ins as direct tools instead of folded behind the search pair (narrows the profile). */
  keepBuiltinsDirect?: boolean
  /** Canonical and legacy dynamic adapters for exact registry lookups (narrows the profile). */
  keepDynamicToolsDirect?: boolean
  /** Issued account/exposure ceiling, applied at the catalog listing. */
  bindingMaximum?: Readonly<Record<string, string>>
  /** Server-only observer of bindings admitted by current native policy. */
  onAdmittedBinding?: (key: string, fingerprint: string) => void
  /** Restrict searchable and dynamic-direct capabilities to these canonical or legacy names. */
  restrictSearchToToolNames?: readonly string[]
  /** Remote MCP tool-use interception (hosted). */
  engineHooks?: EngineHooks
  /** The acting user's server-resolved identity (actor headers, media token). */
  actorIdentity?: ActorIdentity
  /** Workspace-files byte layer (Gmail attachments). */
  filesApi?: FilesApi
  /** Upload-cache reader (chat and channel turns only). */
  readCachedFile?: (id: string, ctx: AccessContext) => Promise<CachedFile | null>
  /** On-demand introspection lane: an `introspection` search source on folded surfaces. */
  introspectionTools?: Tool[]
  /** Assistant Email vendor seam; the shared provider otherwise. */
  emailInboxProvider?: EmailInboxProvider | null
  /** Trusted turn grant used to withhold unbounded or cross-scope connectors. */
  contextScope?: ConnectorTurnGrant
  /** Host-only protected source adapter, current execution and exact turn accumulator. */
  connectorSourceRuntimeFactory?: ConnectorSourceRuntimeFactory
  executionContext?: ExecutionContext
  scopeAccumulator?: ContextScopeAccumulator
  /**
   * Hand the host routine read port the canonical Calendar read adapters
   * (`routineCalendarTools`). Web chat only. Late-activated: preparation
   * activates nothing and reads no credentials; the port activates exactly
   * the planned read through the catalog when the planner selects one.
   */
  routineCalendarRead?: boolean
  /** Test seams for the catalog's bulk reads and descriptor lifecycle. */
  policyReader?: CatalogPolicyReader
  actionGrantReader?: CatalogActionGrantReader | null
  descriptorLifecycle?: DescriptorLifecycle
}

/** What a surface hands its entrypoint. */
export type SurfaceCapabilities = {
  /** Connector types with an admitted current native account binding. */
  admittedConnectorIds?: ReadonlySet<string>
  enrichConfirmation: ConfirmationEnricher
  /** Capabilities that are unavailable (not connected, disabled, reconnect, scope), computed once. */
  unavailable: string[]
  /** Sources represented in `mcp_search`, with official display names for built-ins. */
  searchableSources: string[]
  /** Names from `restrictSearchToToolNames` that survived scoping and policy. */
  restrictedSearchToolNames?: string[]
  /** Trusted runtime block, present only when usable matched capture rules emitted write tools. */
  knowledgeCapturePrompt?: string
  /**
   * Exact built-in Calendar read adapters for optional host planning; never an
   * execution grant. Lazily certified: each activates its canonical read only
   * when the routine read port plans it (`activateRoutineCalendarRead`).
   */
  routineCalendarTools?: ReadonlyMap<string, Tool>
}

/** The surface's profile, narrowed (never widened) by the entrypoint's options. */
export function surfaceProfileFor(surface: CapabilitySurface, options: Pick<SurfaceCapabilityOptions,
  'keepBuiltinsDirect' | 'keepDynamicToolsDirect' | 'exposeLocalReadTools' | 'allowKnowledgeWrites' | 'restrictSearchToToolNames'>): SurfaceProfile {
  return surfaceProfile(surface, {
    ...(options.keepBuiltinsDirect ? { keepBuiltinsDirect: true } : {}),
    ...(options.keepDynamicToolsDirect ? { keepDynamicToolsDirect: true } : {}),
    ...(options.exposeLocalReadTools ? {} : { exposeLocalReadTools: false }),
    ...(options.allowKnowledgeWrites ? {} : { knowledgeWrites: 'none' }),
    ...(options.restrictSearchToToolNames ? { restrictSearchToToolNames: options.restrictSearchToToolNames } : {}),
  })
}

/** Prepare the composed catalog for one entrypoint surface. */
export function prepareSurfaceCatalog(surface: CapabilitySurface, options: SurfaceCapabilityOptions, onlyNativeConnector?: string): Promise<ComposedCatalog> {
  const profile = surfaceProfileFor(surface, options)
  const introspection = !onlyNativeConnector && options.introspectionTools?.length
    ? [{ kind: 'local' as const, serverName: 'introspection', tools: options.introspectionTools }] : undefined
  return prepareComposedCatalog({
    profile,
    onlyNativeConnector,
    assistant: { id: options.assistantId, workspaceId: options.assistantTeamId ?? null },
    connectorUserId: options.userId,
    actorUserId: options.actorIdentity?.userId,
    executionContext: options.executionContext,
    scopeAccumulator: options.scopeAccumulator,
    contextScope: options.contextScope,
    bindingMaximum: options.bindingMaximum,
    onAdmittedBinding: options.onAdmittedBinding,
    stores: {
      connectorStore: options.connectorStore,
      connectorInstanceStore: options.connectorInstanceStore,
      connectorGrantStore: options.connectorGrantStore,
      assistantConnectorStore: options.assistantConnectorStore,
    },
    ...(options.policyReader ? { policyReader: options.policyReader } : {}),
    // No grants store wired (legacy call sites, tests) ⇒ no grant visibility filter, as before.
    actionGrantReader: options.actionGrantReader !== undefined ? options.actionGrantReader
      : options.assistantConnectorGrantsStore ? undefined : null,
    ...(!onlyNativeConnector && options.knowledgeStore ? { knowledge: {
      store: options.knowledgeStore,
      repoWriter: options.knowledgeRepoWriter,
      captureRuleStore: options.knowledgeCaptureRuleStore,
      captureText: options.knowledgeCaptureText,
      requesterLabel: options.actorIdentity?.email ?? null,
    } } : {}),
    ...(introspection ? { localSources: introspection } : {}),
    ...(options.descriptorLifecycle ? { descriptorLifecycle: options.descriptorLifecycle } : {}),
    composition: {
      stores: {
        connectorStore: options.connectorStore,
        settingsStore: options.settingsStore,
        assistantConnectorStore: options.assistantConnectorStore,
        connectorGrantStore: options.connectorGrantStore,
        connectorInstanceStore: options.connectorInstanceStore,
        workspaceToolPolicyStore: options.workspaceToolPolicyStore,
        assistantConnectorGrantsStore: options.assistantConnectorGrantsStore,
        gdriveFilesStore: options.gdriveFilesStore,
        knowledgeStore: options.knowledgeStore,
        knowledgeRepoWriter: options.knowledgeRepoWriter,
      },
      knowledgeCaptureRuleStore: options.knowledgeCaptureRuleStore,
      knowledgeCaptureText: options.knowledgeCaptureText,
      userTimezone: options.userTimezone,
      workspaceDomain: options.workspaceDomain,
      attachments: { filesApi: options.filesApi, readCachedFile: options.readCachedFile },
      hosted: {
        engineHooks: options.engineHooks,
        connectorActionAudit: options.connectorActionAudit,
        emailInboxProvider: options.emailInboxProvider,
        actorIdentity: options.actorIdentity,
      },
      connectorSourceRuntimeFactory: options.connectorSourceRuntimeFactory,
      bootTools: options.tools,
    },
  })
}

/** Expose only the canonical dispatcher for the two initial mailbox reads.
 * Their source is catalogued and activated after the model requests mail. */
export async function prepareMailboxReadDispatcher(surface: 'web' | 'channel' | 'public', options: SurfaceCapabilityOptions,
  assertCurrent: () => Promise<void>): Promise<Tool | undefined> {
  const { catalog, composition } = await prepareSurfaceCatalog(surface, options, 'imap')
  const mailbox = catalog.sources.find((source): source is LocalSource => source.kind === 'local' && source.serverName === 'imap')
  const resolve = mailbox?.resolve
  if (!mailbox || !resolve) return undefined
  const index = buildToolIndex([{
    ...mailbox,
    async resolve(name) {
      const resolved = await resolve(name)
      if (!resolved || !('status' in resolved) || resolved.status !== 'ready') return resolved
      const tool = resolved.tool
      const descriptor = catalog.descriptors.find(item => item.name === name && item.serverName === 'imap')
      if (!descriptor?.instanceId) throw new AuthorityChangedError()
      const instanceId = descriptor.instanceId
      const readPersonalBinding = async () => {
        const current = await options.connectorInstanceStore?.getSystem(instanceId)
        if (!current?.connected || current.healthStatus === 'auth_failed' || current.provider !== 'imap'
          || current.scope !== 'user' || current.userId !== options.userId) throw new AuthorityChangedError()
        return instanceBindingFingerprint(current)
      }
      return { ...resolved, tool: {
        ...tool,
        async execute(input, context) {
          // An Ask decision may have paused this invocation after activation.
          // Recheck the original destination at the actual provider read.
          await assertCurrent()
          context.abortSignal.throwIfAborted()
          const execution = options.executionContext
          if (!execution || context.executionContext !== execution) throw new AuthorityChangedError()
          const personalBinding = descriptor.lane === 'personal' ? await readPersonalBinding() : undefined
          const policy = captureRetainedToolPolicy(tool, context, input)
          const result = await tool.execute(input, context)
          context.abortSignal.throwIfAborted()
          await assertCurrent()
          if (!result.isError) {
            const assertBindingCurrent = async () => {
              if (personalBinding === undefined) await composition.assertActivationCurrent(catalog.plan)
              else if (await readPersonalBinding() !== personalBinding) throw new AuthorityChangedError()
              if (options.assistantConnectorStore && !await options.assistantConnectorStore.isEnabled(
                catalog.plan.assistantId, descriptor.governanceId, 'imap')) throw new AuthorityChangedError()
            }
            await Promise.all([assertBindingCurrent(), policy.assertCurrent()])
            retainInitialMailboxEvidence(execution, instanceId, assertBindingCurrent)
            retainInitialMailboxEvidence(execution, JSON.stringify([instanceId, name, policy.alreadyConfirmed]), policy.assertCurrent)
          }
          return result
        },
      } }
    },
  }])
  const call = createMcpSearchTools({ index, settingsStore: options.settingsStore, assistantId: catalog.plan.assistantId,
    appLevelAssistantId: APP_LEVEL_ASSISTANT_ID, userId: catalog.plan.connectorUserId, hooks: options.engineHooks,
  }).find(tool => tool.name === 'mcp_call')
  if (!call) return undefined
  return (await unavailableAsEmpty(() => composition.wrapTools(catalog.plan, [call], index)))[0]
}

/** Prepare and register one entrypoint surface's capabilities into `options.tools`. */
export async function composeSurfaceCapabilities(surface: CapabilitySurface, options: SurfaceCapabilityOptions): Promise<SurfaceCapabilities> {
  const composed = await prepareSurfaceCatalog(surface, options)
  return applySurfaceCapabilities(options.tools, composed, {
    settingsStore: options.settingsStore,
    hooks: options.engineHooks,
    discoveryQuery: options.discoveryQuery,
    routineCalendarRead: options.routineCalendarRead,
  })
}

/**
 * Durable approval resume: the `resume` profile (built-ins direct) with
 * exactly the suspended tool activated into `options.tools`. A boot tool
 * needs no activation; a tool the catalog no longer admits stays absent, so
 * the resume reports it as no longer available.
 */
export async function composeResumeCapabilities(options: SurfaceCapabilityOptions & {
  suspendedToolName: string
  connectorTarget?: ConnectorResumeTarget
}): Promise<SurfaceCapabilities> {
  const { suspendedToolName: name, connectorTarget, tools } = options
  if (connectorTarget) tools.delete(name)
  const composed = await prepareSurfaceCatalog('resume', { ...options, keepBuiltinsDirect: true, keepDynamicToolsDirect: true,
    introspectionTools: undefined, allowKnowledgeWrites: false })
  const { catalog, composition } = composed
  const result = (): SurfaceCapabilities => ({
    admittedConnectorIds: catalog.admittedConnectorIds,
    enrichConfirmation: (toolName, input) => composition.enrichConfirmation(toolName, input),
    unavailable: [...new Set([...catalog.unavailable, ...composition.activationUnavailable()])],
    searchableSources: [],
  })
  if (!connectorTarget && !catalog.descriptors.some(descriptor => descriptor.name === name) && tools.has(name)) return result()
  const native = catalog.direct.descriptors.find(descriptor => descriptor.name === name
    && (!connectorTarget || descriptor.serverName === connectorTarget.serverName && descriptor.version === connectorTarget.version))
  if (native) {
    for (const tool of await unavailableAsEmpty(() => catalog.activate({ toolNames: [name] }))) if (tool.name === name) tools.set(name, tool)
    return result()
  }
  const knowledge = !connectorTarget ? catalog.direct.tools.filter(tool => tool.name === name) : []
  if (knowledge.length > 0) {
    for (const tool of await unavailableAsEmpty(() => composition.wrapTools(catalog.plan, knowledge))) tools.set(tool.name, tool)
    return result()
  }
  const dynamic = await catalog.resolveSuspendedDynamicTool(name, connectorTarget)
  if (dynamic) tools.set(name, dynamic)
  return result()
}

const PAIR = new Set(['mcp_search', 'mcp_call'])

/**
 * The routine read's late activation of exactly one canonical Calendar read,
 * from the routine read port after planning: the catalog's memoized
 * activation of that name (the same tool an `mcp_call` of it resolves),
 * inside the turn's runtime-authority wrapper for the invocation's context.
 * Unavailable activation is a result; authority loss and Stop propagate.
 */
async function activateRoutineCalendarRead(composed: ComposedCatalog, context: ToolContext, name: string): Promise<RoutineCalendarActivation> {
  const { catalog, composition } = composed
  let built: Tool[]
  try {
    built = await composition.runActivation(catalog.plan, context, () => catalog.activate({ toolNames: [name] }))
  } catch (error) {
    if (error instanceof CapabilityActivationUnavailableError) return { status: 'unavailable', reason: 'activation is not available on this surface' }
    throw error
  }
  const tool = built.find((candidate) => candidate.name === name)
  return tool ? { status: 'ready', tool } : { status: 'unavailable', reason: 'it is no longer available to this assistant' }
}
const officialName = new Map(OFFICIAL_CONNECTORS.map((connector) => [connector.id, connector.name]))

async function unavailableAsEmpty(work: () => Promise<Tool[]>): Promise<Tool[]> {
  try { return await work() } catch (error) {
    if (error instanceof CapabilityActivationUnavailableError) return []
    throw error
  }
}

/** A dynamic source an activation (or a search) can prove names for: discover it now. */
async function discovered(source: LocalSource): Promise<LocalSource> {
  if (!source.discover) return source
  const descriptors = await source.discover().catch(() => null)
  if (!descriptors) return source
  const { discover: _discover, summary: _summary, ...rest } = source
  return { ...rest, descriptors }
}

/**
 * Register a prepared surface into `tools`. Registration rules match the
 * former injector: direct built-ins land under their canonical or variant
 * names (replacing a same-named entry); dynamic direct adapters and read
 * adapters never replace an existing entry; the search pair always does.
 * Everything registered here runs inside the turn authority.
 */
export async function applySurfaceCapabilities(tools: Map<string, Tool>, composed: ComposedCatalog, options: {
  settingsStore: McpSettingsStore
  hooks?: EngineHooks
  discoveryQuery?: string
  routineCalendarRead?: boolean
}): Promise<SurfaceCapabilities> {
  const { catalog, composition } = composed
  const { profile, plan } = catalog
  const publicSafe = (list: Tool[]) => profile.excludeConfirmationRequired
    ? list.filter((tool) => !tool.requiresConfirmation && !tool.resolveConfirmation) : list
  const dynamic = dynamicCapabilityFamilies(plan)

  // 1. Built-ins: direct by name, or folded behind the search pair.
  const extraSources: LocalSource[] = []
  if (profile.keepBuiltinsDirect) {
    const names = catalog.direct.descriptors.map((descriptor) => descriptor.name)
    if (names.length > 0) {
      for (const tool of await unavailableAsEmpty(() => catalog.activate({ toolNames: names }))) tools.set(tool.name, tool)
    }
    for (const tool of await unavailableAsEmpty(() => composition.wrapTools(plan, catalog.direct.tools))) tools.set(tool.name, tool)
  } else {
    // Deployment-keyed Maps reads come from the boot map and fold into their own source.
    const maps = publicSafe(pluckGoogleMapsTools(tools))
    if (maps.length > 0) extraSources.push({ kind: 'local', serverName: 'google-maps', tools: maps })
  }

  // 2. Dynamic direct adapters (workflow-style exact lookups), from one activation per family.
  const dynamicAdapters = profile.keepDynamicToolsDirect && dynamic.length > 0
    ? await unavailableAsEmpty(() => catalog.activate({ families: dynamic })) : []

  // 3. Index sources. A surface that registers dynamic adapters or must prove
  // pinned names discovers its dynamic sources (memoized with the activation).
  const restrict = profile.restrictSearchToToolNames
  let sources: LocalSource[] = [...(restrict ? catalog.unrestrictedSources ?? catalog.sources : catalog.sources), ...extraSources]
  if (profile.keepDynamicToolsDirect || restrict) sources = await Promise.all(sources.map(discovered))
  let restrictedSearchToolNames: string[] = []
  if (restrict) ({ sources, restrictedNames: restrictedSearchToolNames } = restrictSources(sources, restrict))
  // A restricted surface keeps the canonical and legacy adapters of the kept entries only.
  const keptAdapterNames = restrict ? new Set(sources.flatMap((source) => [...source.tools.map((tool) => tool.name),
    ...(source.descriptors ?? []).map((descriptor) => descriptor.name)].flatMap((name) => [name, legacyMcpToolName(source.label ?? source.serverName, name)]))) : null
  for (const tool of dynamicAdapters) {
    if (keptAdapterNames && !keptAdapterNames.has(tool.name)) continue
    if (!tools.has(tool.name)) tools.set(tool.name, tool)
  }

  // 4. Routine Calendar read (web chat) is late-activated: the read adapters
  // of the still-lazy canonical Calendar entries are certified below with an
  // activator, and nothing is activated (no credential read) at preparation.
  const routineRead = Boolean(options.routineCalendarRead && profile.exposeLocalReadTools && !profile.keepDynamicToolsDirect)

  // 5. The search pair (and guarded read adapters) over the indexed sources.
  const routineCalendarTools = new Map<string, Tool>()
  if (sources.length > 0) {
    const index = buildToolIndex(sources)
    const searchTools = createMcpSearchTools({
      index,
      settingsStore: options.settingsStore,
      assistantId: plan.assistantId,
      appLevelAssistantId: APP_LEVEL_ASSISTANT_ID,
      userId: plan.connectorUserId,
      hooks: options.hooks,
      exposeLocalReadTools: profile.exposeLocalReadTools && !profile.keepDynamicToolsDirect,
      discoveryQuery: options.discoveryQuery,
    }).filter((tool) => PAIR.has(tool.name) || !tools.has(tool.name))
    const gcalEntries = new Set(index.entries.filter((entry) => entry.kind === 'local' && entry.server === 'gcal').map((entry) => entry.toolName))
    if (routineRead) {
      // The guarded read adapter of a lazy canonical Calendar read dispatches
      // through its index entry, which resolves to `catalog.activate` of
      // exactly that name (one memoized activation). Certify it before the
      // authority wrapper so every wrapper inherits the certification.
      const lazyReads = new Set(index.entries.filter((entry) => entry.kind === 'local' && entry.server === 'gcal' && entry.lazy
        && entry.tool.isReadOnly === true && baseToolName(entry.toolName) === 'googleCalendarListEvents').map((entry) => entry.toolName))
      for (const tool of searchTools) {
        if (PAIR.has(tool.name) || !lazyReads.has(tool.name) || !tool.isReadOnly || ownsRoutineCalendarRead(tool)) continue
        registerLazyCanonicalCalendarRead(tool, (context) => activateRoutineCalendarRead(composed, context, tool.name))
      }
    }
    const wrapped = await unavailableAsEmpty(() => composition.wrapTools(plan, searchTools, index))
    for (const tool of wrapped) {
      tools.set(tool.name, tool)
      if (tool.isReadOnly && !PAIR.has(tool.name) && ownsRoutineCalendarRead(tool)
        && baseToolName(tool.name) === 'googleCalendarListEvents' && gcalEntries.has(tool.name)) {
        routineCalendarTools.set(tool.name, tool)
      }
    }
  }

  return {
    admittedConnectorIds: catalog.admittedConnectorIds,
    enrichConfirmation: async (toolName, input) => {
      // A Calendar mutation awaiting approval has activated its family already;
      // a direct call path may not have, so activate exactly that tool.
      if (catalog.descriptors.some((descriptor) => descriptor.family === 'google' && descriptor.name === toolName)) {
        await catalog.activate({ toolNames: [toolName] }).catch(() => [])
      }
      return composition.enrichConfirmation(toolName, input)
    },
    unavailable: [...new Set([...catalog.unavailable, ...composition.activationUnavailable()])],
    searchableSources: [...new Set(sources.map((source) => source.label ?? officialName.get(source.serverName) ?? source.serverName))],
    restrictedSearchToolNames,
    ...(catalog.knowledgeCapturePrompt ? { knowledgeCapturePrompt: catalog.knowledgeCapturePrompt } : {}),
    routineCalendarTools,
  }
}
