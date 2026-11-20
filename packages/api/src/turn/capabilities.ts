/**
 * Capability roster preparation under the original turn owner (D9, M3 WP5).
 *
 * Every kernel turn prepares its connector capabilities through the M3
 * capability catalog: `composeSurfaceCapabilities` (`mcp/surface.ts`) runs
 * `prepareComposedCatalog` for the entrypoint's surface profile (catalog-only
 * metadata work) and registers the surface into the turn's tool map; tools
 * are built by activation only when a call needs them. Durable resume
 * activates exactly the suspended tool (`composeResumeCapabilities`).
 *
 * The request carries the entrypoint's own parameter block unchanged: web
 * and public pass the route parameter block (`kind: 'route-params'`,
 * `ApplyMcpInjectionParams`), channel and callee pass the surface options
 * directly (`kind: 'surface-options'`). The `kind` names the parameter shape.
 *
 * Web chat hands the routine read port its canonical Calendar read adapters
 * only when the route passes `routineCalendarRead: true`, that is when routine
 * planning can be eligible on this turn. They are late-activated: the port
 * activates exactly the planned read after planning, so preparation activates
 * no connector family on any web turn.
 *
 * The surface module is loaded lazily so the kernel's own import graph does
 * not pull connector assembly into turns that never prepare capabilities.
 *
 * Spec: docs/architecture/engine/turn-kernel.md "Capability roster
 * preparation". [COMP:api/turn-kernel]
 */
import { routeTurn, type CapabilityDescriptorRef, type TurnRoute, type TurnRoutingInput } from '@use-brian/core/workers/turn-routing.js'
import type { ConnectorResumeTarget, Tool } from '@use-brian/agent-runtime/tools/types.js'
import { isAuthorityChangedError } from '../context-scope/authority-lease.js'
import type { ApplyMcpInjectionParams } from '../routes/route-helpers.js'
import type { SurfaceCapabilities, SurfaceCapabilityOptions } from '../mcp/surface.js'
import { CONNECTOR_PREPARATION_UNAVAILABLE } from '../mcp/discovery-diagnostics.js'

export type TurnCapabilityProfile = 'web' | 'channel' | 'public' | 'callee' | 'workflow' | 'workspace-mcp' | 'home-app' | 'resume'

/** Resume: the entrypoint's stores and identity plus the exact suspended tool. */
export type ResumeCapabilityParams = SurfaceCapabilityOptions & {
  suspendedToolName: string
  connectorTarget?: ConnectorResumeTarget
}

/**
 * The web/public route parameter block. `routineCalendarRead` (web only) asks
 * for the late-activated canonical Calendar read adapters for the routine read
 * port; the route passes it only when routine planning can be eligible.
 */
export type RouteCapabilityParams = ApplyMcpInjectionParams & { routineCalendarRead?: boolean }

/** The entrypoint's capability parameters per profile. */
export type TurnCapabilityRequest =
  | { profile: 'web' | 'public'; composition: { kind: 'route-params'; params: RouteCapabilityParams } }
  | { profile: 'channel' | 'callee'; composition: { kind: 'surface-options'; params: SurfaceCapabilityOptions } }
  | { profile: 'resume'; composition: { kind: 'resume'; params: ResumeCapabilityParams } }

export type TurnCapabilityResult = SurfaceCapabilities

const identityEnricher: SurfaceCapabilities['enrichConfirmation'] = async (_toolName, input) => input

/** Route-helper parameters (web chat, public API) as surface options; `null` when no connector stores are wired. */
export function surfaceOptionsFromRoute(params: ApplyMcpInjectionParams): SurfaceCapabilityOptions | null {
  const { stores } = params
  if (!stores.connectorStore || !stores.mcpSettingsStore) return null
  return {
    userId: params.connectorUserId,
    assistantId: params.assistant.id,
    tools: params.tools,
    connectorStore: stores.connectorStore,
    settingsStore: stores.mcpSettingsStore,
    assistantConnectorStore: stores.assistantConnectorStore,
    userTimezone: params.userTimezone,
    knowledgeStore: stores.knowledgeStore,
    knowledgeRepoWriter: stores.knowledgeRepoWriter,
    allowKnowledgeWrites: params.allowKnowledgeWrites === true,
    knowledgeCaptureRuleStore: stores.knowledgeCaptureRuleStore,
    knowledgeCaptureText: params.knowledgeCaptureText,
    discoveryQuery: params.discoveryQuery,
    exposeLocalReadTools: params.exposeLocalReadTools,
    bindingMaximum: params.bindingMaximum,
    restrictSearchToToolNames: params.restrictSearchToToolNames,
    keepBuiltinsDirect: params.keepToolsDirect,
    keepDynamicToolsDirect: params.keepToolsDirect,
    knowledgeWriteAuthorization: 'capture',
    gdriveFilesStore: stores.gdriveFilesStore,
    connectorGrantStore: stores.connectorGrantStore,
    connectorInstanceStore: stores.connectorInstanceStore,
    workspaceToolPolicyStore: stores.workspaceToolPolicyStore,
    assistantTeamId: params.assistant.workspaceId ?? null,
    connectorActionAudit: params.connectorActionAudit,
    assistantConnectorGrantsStore: stores.assistantConnectorGrantsStore,
    workspaceDomain: params.workspaceDomain,
    engineHooks: params.engineHooks,
    actorIdentity: params.actorIdentity,
    filesApi: stores.filesApi,
    readCachedFile: stores.readCachedFile,
    introspectionTools: params.introspectionTools,
    contextScope: params.contextScope,
    connectorSourceRuntimeFactory: stores.connectorSourceRuntimeFactory,
    executionContext: params.executionContext,
    scopeAccumulator: params.scopeAccumulator,
  }
}

/** Captures the request synchronously; the returned operation composes. */
export function captureCapabilityComposition(request: TurnCapabilityRequest): {
  tools: Map<string, Tool>
  compose: () => Promise<TurnCapabilityResult>
} {
  const composition = request.composition
  if (composition.kind === 'resume') {
    const params = composition.params
    return { tools: params.tools, compose: async () => (await import('../mcp/surface.js')).composeResumeCapabilities(params) }
  }
  if (composition.kind === 'surface-options') {
    const params = composition.params
    const surface = request.profile as 'channel' | 'callee'
    return { tools: params.tools, compose: async () => (await import('../mcp/surface.js')).composeSurfaceCapabilities(surface, params) }
  }
  const params = composition.params
  const surface = request.profile as 'web' | 'public'
  const options = surfaceOptionsFromRoute(params)
  return {
    tools: params.tools,
    compose: async () => {
      // No connector stores on this deployment: nothing to prepare or announce.
      if (!options) return { enrichConfirmation: identityEnricher, unavailable: [], searchableSources: [] }
      try {
        return await (await import('../mcp/surface.js')).composeSurfaceCapabilities(surface, {
          ...options,
          // Web chat hands the late-activated Calendar read adapters to the
          // routine read port, only on a turn whose routine planning can be eligible.
          routineCalendarRead: surface === 'web' && params.routineCalendarRead === true,
        })
      } catch (error) {
        // Authority loss and Stop are never converted into a degraded turn.
        if (isAuthorityChangedError(error) || (error as { reason?: unknown } | null)?.reason === 'authority_changed'
          || params.executionContext?.lifecycle.abortSignal.aborted) throw error
        console.error(`[${params.scope}] capability preparation failed:`, error)
        return { enrichConfirmation: identityEnricher, unavailable: [CONNECTOR_PREPARATION_UNAVAILABLE], searchableSources: [] }
      }
    },
  }
}

/**
 * The capabilities turn routing may select research tools from: the prepared
 * roster exactly as the model sees it (capability-filtered by the caller,
 * hidden tools excluded), names and descriptions only. Folded connector tools
 * stay behind `mcp_search`, so routing preselects only what the loop can run
 * directly. Never an execution grant.
 */
export function routingCapabilities(roster: ReadonlyMap<string, Tool>): CapabilityDescriptorRef[] {
  return [...roster.values()].filter((tool) => !tool.hiddenFromModel).map((tool) => ({ name: tool.name, description: tool.description }))
}

/**
 * Turn routing over the prepared roster (M3 WP5, deletion rows D11-12/D11-13):
 * research, topic and split are decided once per turn by core `routeTurn`
 * over one captured input, with research tool selection drawn from the
 * prepared capabilities. The route reports its classifier invocations as
 * `modelCalls` and every completed call through `recordUsage` exactly once;
 * deterministic shortcuts make no call. Preflight and the coordinator consume
 * `route.split` instead of classifying again.
 */
export function routePreparedTurn(input: Omit<TurnRoutingInput, 'capabilities'> & { roster?: ReadonlyMap<string, Tool> }): Promise<TurnRoute> {
  const { roster, ...routing } = input
  return routeTurn({ ...routing, ...(roster ? { capabilities: routingCapabilities(roster) } : {}) })
}
