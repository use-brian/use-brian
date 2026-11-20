import { OFFICIAL_CONNECTORS } from '@use-brian/shared/connector-registry'
/**
 * Capability composition (M3 WP3): the catalog wired to provider activation.
 *
 * `prepareComposedCatalog(input)` runs `prepareCapabilityCatalog` with an
 * activator built over `createActivation` (`mcp/activation.ts`) and the
 * provider modules. Nothing is built at preparation time. On the first
 * activation of a turn the composition opens one turn authority over the
 * catalog's runtime authority (no second runtime-authority read) and builds
 * each selected family's provider input with the lane builder
 * (`createLaneBuilder`, the `instancesFor(family, plan, selection)` port of
 * `createCatalogActivator`).
 *
 * The lane builder derives every lane from the plan's admitted bindings, in
 * the historical precedence order per family: the owner's personal rows
 * (workspace-less assistants only), then member-exposure grants (one winning
 * grantor per provider, the exact exposed instance's credentials), then
 * workspace-owned rows (workspace policy, superseding the provider's
 * lower-precedence tools, `auth_failed` rows included). Every binding a lane
 * uses is pinned with the row the catalog admitted, so the pin carries the
 * catalog-time fingerprint and activation re-checks it before and after each
 * effect. Notices are computed once by the catalog; activation-time notices
 * (expired credentials on the personal lane, protected source restrictions,
 * Assistant Email reassignment) land in the turn sink.
 *
 * `applyDirectCapabilities(tools, composed, options)` is the direct-surface
 * consumer (workflow `tool_call`, home apps): it activates the catalog's
 * direct descriptors by name plus the dynamic families,
 * then registers them with the injector's collision rules.
 *
 * [COMP:api/mcp-catalog]
 * See docs/architecture/integrations/mcp.md → "Capability composition".
 */
import { buildToolIndex, createMcpSearchTools, type McpToolIndex } from '@use-brian/core/mcp/tool-search.js'
import type { Tool, ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import { z } from 'zod'
import { APP_LEVEL_ASSISTANT_ID, MULTI_INSTANCE_CONNECTOR_IDS } from '@use-brian/shared'
import { getGlobalEmailInboxProvider } from '../agentmail/provider.js'
import type { ConnectorSourceRuntimeFactory } from '../application-platform/source-runtime.js'
import { listAgentmailConnectorInstanceIdsForAssistantSystem } from '../db/channels-store.js'
import type { GrantWithInstance } from '../db/connector-grant-store.js'
import { connectorInstanceGovernanceId, type ConnectorInstance } from '../db/connector-instance-store.js'
import { workspacePolicyAsSettingsStore } from '../db/workspace-tool-policy-store.js'
import type { KnowledgeCaptureRuleStore } from '../knowledge/capture-rules.js'
import { createActivation, createTurnAuthority, type ProviderRegistry, type TurnAuthority } from './activation.js'
import { isImplementationUnavailable } from '@use-brian/agent-runtime/tools/lazy-implementation.js'
import { preflightHeadersToRecord } from './auth-headers.js'
import {
  CapabilityActivationUnavailableError, createCatalogActivator, prepareCapabilityCatalog,
  type AdmittedConnector, type CapabilityCatalog, type CatalogActivationPlan, type CatalogActivator,
  type CapabilitySelection, type PrepareCapabilityCatalogInput,
} from './catalog.js'
import { createHealthReporter } from './connector-health.js'
import { cliDescriptorSourceKey, remoteDescriptorSourceKey } from './descriptors.js'
import { PROVIDER_MODULES } from './providers/index.js'
import type { CliInstance } from './providers/cli.js'
import type { GitHubLane } from './providers/github.js'
import type { GoogleLane } from './providers/google.js'
import type { MailboxLane } from './providers/mailbox.js'
import { matchTurnCaptureRules, type KnowledgeLane } from './providers/knowledge.js'
import type { GrantedRemoteMcp, RemoteMcpInstance, RemoteMcpInstances } from './providers/remote-mcp.js'
import type {
  ProviderActivationContext, ProviderAttachmentPorts, ProviderFamily, ProviderHostedPorts, ProviderStores,
} from './providers/types.js'
import type { ConnectorInstanceRef } from './tool-names.js'

/** Provider modules handed to the catalog; one stable array so its static records memoize. */
const DESCRIBED_PROVIDERS = Object.values(PROVIDER_MODULES)

/** Registry connector ids each built-in family serves. */
const FAMILY_PROVIDERS: Partial<Record<ProviderFamily, readonly string[]>> = {
  google: OFFICIAL_CONNECTORS.filter(connector => connector.tags.includes('google')).map(connector => connector.id),
  github: ['github'], notion: ['notion'], fathom: ['fathom'], shopify: ['shopify'],
  wordpress: ['wordpress'], gsc: ['gsc'], msgraph: ['msgraph'], mailbox: ['imap'],
}

export type CompositionPorts = {
  /** Stores activation reads (credentials, policy, enablement, grants). */
  stores: ProviderStores
  knowledgeCaptureRuleStore?: KnowledgeCaptureRuleStore
  userTimezone?: string
  workspaceDomain?: string | null
  attachments?: ProviderAttachmentPorts
  hosted?: Omit<ProviderHostedPorts, 'mediaToken'>
  connectorSourceRuntimeFactory?: ConnectorSourceRuntimeFactory
  /** Newest authored human text: capture-rule matching for the knowledge family (capture surfaces only). */
  knowledgeCaptureText?: string
  /** Boot-built tool map the deployment-keyed Google Maps reads come from. */
  bootTools?: ReadonlyMap<string, Tool>
  /** Test seam; the production registry otherwise. */
  providers?: ProviderRegistry
}

/** One opened turn: authority, activation context and the activator over them. */
type OpenTurn = {
  authority: TurnAuthority
  ctx: ProviderActivationContext
  activator: CatalogActivator
}

export type CompositionHandle = {
  activator: CatalogActivator
  /** Notices activation recorded this turn (empty until a family activates). */
  activationUnavailable(): readonly string[]
  /** The runtime-authority wrapper of the turn (opens it when needed). */
  wrapTools(plan: CatalogActivationPlan, tools: readonly Tool[], searchIndex?: McpToolIndex): Promise<Tool[]>
  /**
   * Run a late activation from a tool invocation inside the same
   * runtime-authority wrapper a tool call gets: the invocation's actor and
   * execution, binding pins before and after, Stop. Used by the routine read's
   * late Calendar activation (`mcp/surface.ts`).
   */
  runActivation<T>(plan: CatalogActivationPlan, context: ToolContext, operation: () => Promise<T>): Promise<T>
  /**
   * The winning Google lane's confirmation enricher, inside the turn
   * authority. Identity until a family that supplies one has activated.
   */
  enrichConfirmation(toolName: string, input: Record<string, unknown>): Promise<Record<string, unknown>>
}

/** Build the composition activator. The turn opens lazily, on the first activation or wrap. */
function createComposition(ports: CompositionPorts): CompositionHandle {
  const providers = ports.providers ?? PROVIDER_MODULES
  const unavailable: string[] = []
  let opened: Promise<OpenTurn> | undefined

  function open(plan: CatalogActivationPlan): Promise<OpenTurn> {
    opened ??= (async () => {
      const authority = await createTurnAuthority({
        assistantId: plan.assistantId,
        assistantTeamId: plan.assistantTeamId,
        actorIdentity: ports.hosted?.actorIdentity,
        contextScope: plan.contextScope,
        executionContext: plan.executionContext,
        scopeAccumulator: plan.scopeAccumulator,
        connectorSourceRuntimeFactory: ports.connectorSourceRuntimeFactory,
        connectorInstanceStore: ports.stores.connectorInstanceStore,
        connectorGrantStore: ports.stores.connectorGrantStore,
        // The catalog applied `bindingMaximum` and reported `onAdmittedBinding`;
        // the lanes pin the admitted rows themselves.
        unavailable,
        runtimeAuthority: plan.runtimeAuthority,
      })
      if (!authority) throw new CapabilityActivationUnavailableError()
      const ctx: ProviderActivationContext = {
        userId: plan.connectorUserId,
        assistantId: plan.assistantId,
        assistantTeamId: plan.assistantTeamId,
        userTimezone: ports.userTimezone,
        workspaceDomain: ports.workspaceDomain,
        authority,
        stores: ports.stores,
        attachments: ports.attachments ?? {},
        hosted: { ...ports.hosted, mediaToken: ports.hosted?.actorIdentity?.mediaToken },
        unavailable,
        confirmationEnrichers: [],
      }
      const activation = createActivation({ ctx, authority, providers })
      const instancesFor = createLaneBuilder({ ctx, authority, ports })
      return { authority, ctx, activator: createCatalogActivator({ activation, instancesFor }) }
    })()
    return opened
  }

  return {
    activator: async (plan, selection) => (await open(plan)).activator(plan, selection),
    activationUnavailable: () => unavailable,
    async wrapTools(plan, tools, searchIndex) {
      if (tools.length === 0) return []
      const { authority } = await open(plan)
      const indexedNames = new Set(searchIndex?.entries.map(entry => `${entry.server}:${entry.toolName}`))
      const indexedOwners = new Set(plan.descriptors
        .filter(descriptor => descriptor.instanceId && indexedNames.has(`${descriptor.serverName}:${descriptor.name}`))
        .map(descriptor => `${descriptor.lane}:${descriptor.instanceId}`))
      const discoveryBindings = plan.admitted.flatMap(row =>
        row.binding && indexedOwners.has(`${row.lane}:${row.instanceId}`) ? [row.binding] : [])
      const wrapped = tools.map((tool) => authority.wrapTool(tool, tool.name === 'mcp_search' ? discoveryBindings : undefined))
      await authority.assertActivationCurrent()
      return wrapped
    },
    async runActivation<T>(plan: CatalogActivationPlan, context: ToolContext, operation: () => Promise<T>): Promise<T> {
      const { authority } = await open(plan)
      let value: T | undefined
      const carrier = authority.wrapTool({
        name: 'late-activation', description: 'Late capability activation', inputSchema: z.object({}).strict(),
        isReadOnly: true, isConcurrencySafe: true, requiresConfirmation: false, hiddenFromModel: true,
        async execute() { value = await operation(); return { data: null } },
      })
      await carrier.execute({}, context)
      return value as T
    },
    async enrichConfirmation(toolName, input) {
      const turn = opened ? await opened.catch(() => undefined) : undefined
      const enricher = turn?.ctx.confirmationEnrichers?.at(-1)
      return enricher ? turn!.authority.wrapEnricher(enricher)(toolName, input) : input
    },
  }
}

export type ComposedCatalog = { catalog: CapabilityCatalog; composition: CompositionHandle }

/**
 * Prepare the capability catalog with activation wired. Static descriptors
 * come from the provider modules' `describe()` (with JSON Schemas).
 */
export async function prepareComposedCatalog(
  input: Omit<PrepareCapabilityCatalogInput, 'activator' | 'providers'> & { composition: CompositionPorts },
): Promise<ComposedCatalog> {
  const { composition: ports, ...catalogInput } = input
  const composition = createComposition(ports)
  const catalog = await prepareCapabilityCatalog({
    ...catalogInput,
    providers: DESCRIBED_PROVIDERS,
    activator: composition.activator,
    ...((ports.hosted?.emailInboxProvider ?? getGlobalEmailInboxProvider())
      ? { listAssignedAgentmailInboxIds: listAgentmailConnectorInstanceIdsForAssistantSystem } : {}),
    ...(ports.connectorSourceRuntimeFactory && !catalogInput.isProtectedSource
      ? { isProtectedSource: (row: AdmittedConnector) => row.lane !== 'personal' }
      : {}),
  })
  return { catalog, composition }
}

// ── Lane builder ─────────────────────────────────────────────

type SyntheticConnector = {
  id?: string
  connectorId: string
  connected: boolean
  name?: string
  connectedEmail?: string | null
  url?: string | null
  config?: Record<string, unknown>
  createdAt?: Date
}

/**
 * `instancesFor(family, plan, selection)`: each family's provider input built
 * from the plan's admitted bindings. Native selections build their full
 * family once. Dynamic selections can instead build one source.
 */
export function createLaneBuilder(deps: {
  ctx: ProviderActivationContext
  authority: TurnAuthority
  ports: CompositionPorts
}): (family: ProviderFamily, plan: CatalogActivationPlan, selection: CapabilitySelection) => Promise<unknown> {
  const { ctx, authority, ports } = deps
  const { stores } = ctx
  const { settingsStore, connectorStore, connectorInstanceStore, assistantConnectorStore, workspaceToolPolicyStore } = stores
  const reportHealth = createHealthReporter(connectorInstanceStore)
  const pin = (row: AdmittedConnector) => { if (row.binding) authority.pinBinding(row.binding) }
  const isEnabled = async (governanceId: string, provider: string) => !assistantConnectorStore
    || await assistantConnectorStore.isEnabled(ctx.assistantId, governanceId, provider)

  const resolveSystemCreds = async (instanceId: string): Promise<string | null> => {
    if (!connectorInstanceStore) return null
    return (await connectorInstanceStore.getCredentialsSystem(instanceId))?.client_secret ?? null
  }
  const persistSystemCreds = async (instanceId: string, clientId: string, secret: string): Promise<void> => {
    if (!connectorInstanceStore) throw new Error(`Token rotation for ${instanceId} needs the instance store`)
    await connectorInstanceStore.updateCredentialsSystem(instanceId, { client_id: clientId, client_secret: secret })
  }
  const instanceRef = (instance: Pick<ConnectorInstance, 'id' | 'label' | 'connectedEmail' | 'config'>): ConnectorInstanceRef => ({
    id: instance.id,
    label: instance.label,
    connectedEmail: instance.connectedEmail,
    driveAccessMode: instance.config?.driveAccessMode === 'full_drive_readonly' ? 'full_drive_readonly' : 'picked_files',
  })

  return async (family, plan, selection) => {
    const selectedSource = selection.sourceKeys?.[0]
    const hasRemoteSource = (id: string) => !selectedSource || selectedSource === remoteDescriptorSourceKey(id)
    const hasCliSource = (id: string) => !selectedSource || selectedSource === cliDescriptorSourceKey(id)
    const userId = plan.connectorUserId
    const teamId = plan.assistantTeamId
    const teamPolicyStore = teamId && workspaceToolPolicyStore ? workspacePolicyAsSettingsStore(workspaceToolPolicyStore, teamId) : settingsStore
    const personal = plan.admitted.filter((row) => row.lane === 'personal')
    const personalRows = personal.flatMap((row) => row.personalRow ? [row.personalRow] : [])
    const grantRows = plan.admitted.filter((row) => row.lane === 'grant' && row.binding)
    const grants = grantRows.map((row) => ({ row, grant: row.binding as unknown as GrantWithInstance }))
    const workspaceRows = plan.admitted.filter((row) => row.lane === 'workspace' && row.binding)
      .map((row) => ({ row, instance: row.binding as unknown as ConnectorInstance }))
      .sort((a, b) => (a.instance.createdAt?.getTime() ?? 0) - (b.instance.createdAt?.getTime() ?? 0)
        || String(a.instance.id).localeCompare(String(b.instance.id)))

    switch (family) {
      case 'knowledge': {
        const writes = plan.profile.knowledgeWrites
        const lane: KnowledgeLane = {
          allowKnowledgeWrites: writes !== 'none',
          knowledgeWriteAuthorization: writes === 'workflow' ? 'workflow' : 'capture',
          matchedCaptureRules: await matchTurnCaptureRules({
            allowKnowledgeWrites: writes !== 'none', knowledgeWriteAuthorization: writes === 'workflow' ? 'workflow' : 'capture',
            assistantTeamId: teamId, knowledgeCaptureRuleStore: ports.knowledgeCaptureRuleStore,
            knowledgeCaptureText: ports.knowledgeCaptureText,
          }),
        }
        return lane
      }
      case 'google-maps':
        return { bootTools: ports.bootTools ?? new Map() }
      case 'remote-mcp':
        return remoteMcpInstances()
      case 'cli':
        return { instances: cliInstances(), descriptorLifecycle: plan.descriptorLifecycle, refreshDescriptors: plan.profile.surface === 'resume' }
      case 'agentmail':
        return agentmailLanes()
      default:
        return nativeLanes(family)
    }

    // ── Remote MCP ──
    async function remoteMcpInstances(): Promise<RemoteMcpInstances> {
      const connected: RemoteMcpInstance[] = personalRows
        .filter((row) => row.connected && row.url && hasRemoteSource(row.id))
        .map((row) => ({ connectorId: row.connectorId, name: row.name, url: row.url!, instanceId: row.id, updatedAt: row.updatedAt,
          preflightHeaders: preflightHeadersToRecord(row.config), sendActorIdentity: row.config?.sendActorIdentity === true,
          sendMediaToken: row.config?.sendMediaToken === true, policyStore: settingsStore, policyUserId: userId, governanceId: row.connectorId }))
      for (const { row, instance } of workspaceRows) {
        if (!instance.custom || !instance.connected || !instance.url || !hasRemoteSource(instance.id)) continue
        pin(row)
        connected.push({ connectorId: instance.provider, name: instance.label, url: instance.url, instanceId: instance.id,
          updatedAt: instance.updatedAt, preflightHeaders: preflightHeadersToRecord(instance.config),
          sendActorIdentity: instance.config?.sendActorIdentity === true, sendMediaToken: instance.config?.sendMediaToken === true,
          policyStore: teamPolicyStore, policyUserId: userId, policyServerName: instance.provider,
          governanceId: connectorInstanceGovernanceId(instance.provider, instance.id) })
      }
      const enabled = await Promise.all(connected.map((source) => isEnabled(source.governanceId, source.connectorId)))
      const granted: GrantedRemoteMcp[] = []
      for (const { row, grant } of winningGrants()) {
        const instance = grant.instance
        if (!instance.custom || !instance.url || instance.healthStatus === 'auth_failed' || !hasRemoteSource(instance.id)) continue
        if (!await isEnabled(connectorInstanceGovernanceId(instance.provider, instance.id), instance.provider)) continue
        pin(row)
        granted.push({ url: instance.url, name: instance.label ?? instance.provider, cacheUserId: grant.grantedByUserId,
          instanceId: instance.id, updatedAt: instance.updatedAt, config: instance.config, connectorId: instance.provider })
      }
      return { instances: connected.filter((_, index) => enabled[index]), granted, authority,
        descriptorLifecycle: plan.descriptorLifecycle, refreshDescriptors: plan.profile.surface === 'resume' }
    }

    // ── CLI MCP ──
    function cliInstances(): CliInstance[] {
      const out: CliInstance[] = personalRows.filter((row) => row.connectorId === 'cli' && row.connected && hasCliSource(row.id))
        .map((row) => ({ id: row.id, name: row.name, updatedAt: row.updatedAt, config: row.config, policyStore: settingsStore, policyUserId: userId }))
      const seen = new Set(out.map((instance) => instance.id))
      for (const { row, instance } of workspaceRows) {
        if (instance.provider !== 'cli' || !instance.connected || seen.has(instance.id) || !hasCliSource(instance.id)) continue
        seen.add(instance.id)
        pin(row)
        out.push({ id: instance.id, name: instance.label, updatedAt: instance.updatedAt, config: instance.config,
          policyStore: teamPolicyStore, policyUserId: userId, policyServerName: connectorInstanceGovernanceId('cli', instance.id) })
      }
      for (const { row, grant } of grants) {
        const instance = grant.instance
        if (instance.provider !== 'cli' || !instance.connected || seen.has(instance.id) || !hasCliSource(instance.id)) continue
        seen.add(instance.id)
        pin(row)
        out.push({ id: instance.id, name: instance.label, updatedAt: instance.updatedAt, config: instance.config,
          policyStore: settingsStore, policyUserId: grant.grantedByUserId })
      }
      return out
    }

    // ── Assistant Email ──
    async function agentmailLanes() {
      const provider = ports.hosted?.emailInboxProvider ?? getGlobalEmailInboxProvider()
      if (!teamId || !provider) return []
      const handled = new Set(await listAgentmailConnectorInstanceIdsForAssistantSystem(teamId, ctx.assistantId))
      const inboxes = workspaceRows
        .filter(({ instance }) => instance.provider === 'agentmail' && instance.connected && instance.healthStatus !== 'auth_failed' && handled.has(instance.id))
        .sort((a, b) => a.instance.createdAt.getTime() - b.instance.createdAt.getTime())
      if (inboxes.length === 0 || inboxes.length !== plan.agentmailInboxIds?.length
        || inboxes.some(({ instance }) => !plan.agentmailInboxIds?.includes(instance.id))) {
        if (!ctx.unavailable.some((line) => line.startsWith('Assistant Email ('))) {
          ctx.unavailable.push('Assistant Email (this assistant does not handle an inbox) - assign an inbox to it in Studio → Channels, or create one with Add channel → Email.')
        }
        return []
      }
      for (const { row } of inboxes) pin(row)
      return [{
        provider,
        inboxes: inboxes.map(({ instance }) => ({ instanceId: instance.id, address: (instance.connectedEmail ?? instance.label).toLowerCase(),
          governanceId: connectorInstanceGovernanceId('agentmail', instance.id) })),
        currentInboxIds: () => listAgentmailConnectorInstanceIdsForAssistantSystem(teamId, ctx.assistantId),
        settingsStore: workspaceToolPolicyStore ? workspacePolicyAsSettingsStore(workspaceToolPolicyStore, teamId) : settingsStore,
        userId,
        reportUnavailable: true,
      }]
    }

    /** Grants of the winning (first, oldest) grantor per provider, connected only, in catalog order. */
    function winningGrants() {
      const winner = new Map<string, string>()
      for (const { grant } of grants) {
        if (grant.instance.connected && !winner.has(grant.instance.provider)) winner.set(grant.instance.provider, grant.grantedByUserId)
      }
      return grants.filter(({ grant }) => grant.instance.connected && winner.get(grant.instance.provider) === grant.grantedByUserId)
    }

    // ── Built-in families ──
    async function nativeLanes(target: ProviderFamily): Promise<unknown[]> {
      const providerIds = FAMILY_PROVIDERS[target] ?? []
      const lanes: unknown[] = []

      // 1. Personal base load (workspace-less assistants only).
      if (personalRows.length > 0) {
        const extrasByProvider = new Map<string, ConnectorInstanceRef[]>()
        if (connectorInstanceStore) {
          for (const provider of MULTI_INSTANCE_CONNECTOR_IDS) {
            const rows = personalRows.filter((row) => row.connectorId === provider && row.connected)
              .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            if (rows.length > 1) {
              extrasByProvider.set(provider, rows.slice(1).map((row) => ({ id: row.id, label: row.name, connectedEmail: row.connectedEmail,
                driveAccessMode: row.config?.driveAccessMode === 'full_drive_readonly' ? 'full_drive_readonly' : 'picked_files' })))
            }
          }
        }
        const resolveInstanceCreds = connectorInstanceStore ? resolveSystemCreds : undefined
        const persistInstanceCreds = connectorInstanceStore ? persistSystemCreds : undefined
        // The personal lane reports what only activation can know (expired
        // credentials), as the base load always did; its not-connected and
        // blocked lines repeat the catalog's own and are deduplicated.
        const base = { connectors: personalRows, settingsStore, userId, reportUnavailable: true }
        const healthProbe = { report: reportHealth }
        const p = providerIds[0]!
        if (target === 'google') {
          lanes.push({ ...base, extrasByProvider, resolveInstanceCreds, healthReport: reportHealth,
            driveEnrichmentContext: teamId ? { workspaceId: teamId, actingUserId: userId } : undefined } satisfies GoogleLane)
        } else if (target === 'fathom') {
          lanes.push({ ...base, extraInstances: extrasByProvider.get(p), resolveInstanceCreds, persistInstanceCreds })
        } else if (target === 'shopify') {
          lanes.push({ ...base, extraInstances: extrasByProvider.get(p), resolveInstanceCreds, persistInstanceCreds, healthProbe })
        } else if (target === 'wordpress') {
          lanes.push({ ...base, extraInstances: extrasByProvider.get(p), resolveInstanceCreds, healthProbe })
        } else if (target === 'msgraph' || target === 'mailbox') {
          lanes.push({ ...base, healthProbe })
        } else {
          lanes.push({ ...base, extraInstances: extrasByProvider.get(p), resolveInstanceCreds, healthProbe } satisfies GitHubLane)
        }
      }

      // 2. Member-exposure grants: one winning grantor per provider.
      const overlaid = new Set<string>()
      const winning = winningGrants()
      for (const { row, grant } of winning) {
        const p = grant.instance.provider
        if (!providerIds.includes(p)) continue
        if (p === 'imap') {
          if (overlaid.has(p)) continue
          overlaid.add(p)
          const usable = winning.filter((candidate) => candidate.grant.instance.provider === 'imap'
            && candidate.grant.grantedByUserId === grant.grantedByUserId && candidate.grant.instance.healthStatus !== 'auth_failed')
          for (const mailbox of usable) pin(mailbox.row)
          if (usable.length > 0) {
            lanes.push({
              connectors: usable.map(({ grant: mailbox }) => ({ connectorId: 'imap', connected: true, id: mailbox.instance.id,
                name: mailbox.instance.label, createdAt: mailbox.instance.createdAt })),
              settingsStore, userId: grant.grantedByUserId, deliveryUserId: userId, healthProbe: { report: reportHealth },
            } satisfies MailboxLane)
          }
          continue
        }
        if (grant.instance.healthStatus === 'auth_failed' || overlaid.has(p)) continue
        overlaid.add(p)
        const siblings = winning.filter((candidate) => candidate.grant !== grant && candidate.grant.instance.provider === p
          && candidate.grant.instance.healthStatus !== 'auth_failed')
        pin(row)
        for (const sibling of siblings) pin(sibling.row)
        const extraInstances = siblings.map(({ grant: sibling }) => instanceRef(sibling.instance))
        const exposedId = grant.instance.id
        const boundGrantCreds = () => resolveSystemCreds(exposedId)
        const healthProbe = { report: reportHealth, instanceId: exposedId }
        const grantor = grant.grantedByUserId
        if (target === 'google') {
          lanes.push({
            connectors: [{ id: exposedId, connectorId: p, connected: true, name: grant.instance.label,
              connectedEmail: grant.instance.connectedEmail, config: grant.instance.config }],
            settingsStore, userId: grantor, credsOverridePerConnector: { [p]: boundGrantCreds },
            extrasByProvider: new Map([[p, extraInstances]]), resolveInstanceCreds: resolveSystemCreds, healthReport: reportHealth,
            driveEnrichmentContext: { workspaceId: teamId!, actingUserId: userId },
          } satisfies GoogleLane)
          continue
        }
        if (target === 'msgraph') {
          lanes.push({ connectors: [{ connectorId: 'msgraph', connected: true }], settingsStore, userId: grantor, healthProbe,
            credsOverride: boundGrantCreds, persistOverride: (encoded: string) => persistSystemCreds(exposedId, 'msgraph_oauth', encoded) })
          continue
        }
        const grantorConnectors = await connectorStore.list(grantor).catch(() => [])
        const base = { connectors: grantorConnectors, settingsStore, userId: grantor, credsOverride: boundGrantCreds, extraInstances,
          resolveInstanceCreds: resolveSystemCreds }
        if (target === 'fathom') {
          lanes.push({ ...base, persistOverride: (encoded: string) => persistSystemCreds(exposedId, 'fathom_oauth', encoded), persistInstanceCreds: persistSystemCreds })
        } else if (target === 'shopify') {
          lanes.push({ ...base, persistOverride: (encoded: string) => persistSystemCreds(exposedId, 'shopify_oauth', encoded),
            persistInstanceCreds: persistSystemCreds, healthProbe })
        } else {
          lanes.push({ ...base, healthProbe })
        }
      }

      // 3. Workspace-owned rows: workspace policy, superseding the provider.
      const overlaidByTeam = new Set<string>()
      const synthetic: SyntheticConnector[] = []
      const googleOverrides: Partial<Record<string, () => Promise<string | null>>> = {}
      const teamExtras = new Map<string, ConnectorInstanceRef[]>()
      const googleSupersedes: string[] = []
      for (const { row, instance } of workspaceRows) {
        const p = instance.provider
        if (!instance.connected || !providerIds.includes(p)) continue
        if (p === 'imap') {
          if (overlaidByTeam.has(p)) continue
          overlaidByTeam.add(p)
          const usable = workspaceRows.filter((candidate) => candidate.instance.provider === 'imap' && candidate.instance.connected
            && candidate.instance.healthStatus !== 'auth_failed')
          for (const mailbox of usable) pin(mailbox.row)
          lanes.push({
            connectors: usable.map(({ instance: mailbox }) => ({ connectorId: 'imap', connected: true, id: mailbox.id, name: mailbox.label, createdAt: mailbox.createdAt })),
            settingsStore: teamPolicyStore, userId, healthProbe: { report: reportHealth }, workspacePolicyScoped: true, supersedes: ['imap'],
          } satisfies MailboxLane)
          continue
        }
        if (overlaidByTeam.has(p)) continue
        if (target === 'google') { if (!googleSupersedes.includes(p)) googleSupersedes.push(p) }
        if (instance.healthStatus === 'auth_failed') {
          // Workspace precedence still removes the provider's lower-precedence tools.
          if (target !== 'google') lanes.push({ connectors: [], settingsStore: teamPolicyStore, userId, supersedes: [p] })
          continue
        }
        overlaidByTeam.add(p)
        const siblings = workspaceRows.filter((candidate) => candidate.instance !== instance && candidate.instance.provider === p
          && candidate.instance.connected && candidate.instance.healthStatus !== 'auth_failed')
        pin(row)
        for (const sibling of siblings) pin(sibling.row)
        const extraInstances = siblings.map(({ instance: sibling }) => instanceRef(sibling))
        synthetic.push({ id: instance.id, connectorId: p, connected: true, name: instance.label, connectedEmail: instance.connectedEmail,
          url: instance.url ?? null, config: instance.config })
        const instanceId = instance.id
        const credsOverride = () => resolveSystemCreds(instanceId)
        const healthProbe = { report: reportHealth, instanceId }
        const base = { connectors: synthetic, settingsStore: teamPolicyStore, userId, supersedes: [p] }
        if (target === 'google') {
          googleOverrides[p] = credsOverride
          if (extraInstances.length > 0) teamExtras.set(p, extraInstances)
        } else if (target === 'fathom') {
          lanes.push({ ...base, credsOverride, persistOverride: (encoded: string) => persistSystemCreds(instanceId, 'fathom_oauth', encoded),
            extraInstances, resolveInstanceCreds: resolveSystemCreds, persistInstanceCreds: persistSystemCreds })
        } else if (target === 'shopify') {
          lanes.push({ ...base, credsOverride, persistOverride: (encoded: string) => persistSystemCreds(instanceId, 'shopify_oauth', encoded),
            extraInstances, resolveInstanceCreds: resolveSystemCreds, persistInstanceCreds: persistSystemCreds, healthProbe })
        } else if (target === 'msgraph') {
          lanes.push({ ...base, healthProbe, credsOverride, persistOverride: (encoded: string) => persistSystemCreds(instanceId, 'msgraph_oauth', encoded) })
        } else {
          lanes.push({ ...base, credsOverride, extraInstances, resolveInstanceCreds: resolveSystemCreds, healthProbe })
        }
      }
      if (target === 'google' && googleSupersedes.length > 0) {
        lanes.push(Object.keys(googleOverrides).length > 0
          ? {
              connectors: synthetic, settingsStore: teamPolicyStore, userId, credsOverridePerConnector: googleOverrides,
              extrasByProvider: teamExtras, resolveInstanceCreds: resolveSystemCreds, healthReport: reportHealth,
              driveEnrichmentContext: { workspaceId: teamId!, actingUserId: userId }, supersedes: googleSupersedes,
            } satisfies GoogleLane
          : { connectors: [], settingsStore: teamPolicyStore, userId, supersedes: googleSupersedes } satisfies GoogleLane)
      }
      return lanes
    }
  }
}

// ── Direct surfaces ──────────────────────────────────────────

/**
 * Activate and register a direct-profile catalog (workflow `tool_call`, home
 * apps) into `tools`, with the injector's rules: built-ins land under their
 * canonical or variant names with their own `requiresConfirmation` /
 * `resolveConfirmation` (so the workflow executor still sees approval flags);
 * knowledge tools from the catalog are wrapped by the turn authority; dynamic
 * direct adapters and the search pair are added without replacing an existing
 * registry entry (the pair always is). `families` narrows the activation
 * (home apps activate only their store connectors). Returns the turn's
 * capability notices (catalog plus activation).
 */
export async function applyDirectCapabilities(
  tools: Map<string, Tool>,
  composed: ComposedCatalog,
  options: { connectorIds?: readonly string[]; settingsStore: ProviderStores['settingsStore']; hooks?: ProviderHostedPorts['engineHooks'] },
): Promise<string[]> {
  const { catalog, composition } = composed
  const narrowed = options.connectorIds
  const implementationNotices: string[] = []
  const unavailableOnly = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await work() } catch (error) {
      if (error instanceof CapabilityActivationUnavailableError) return fallback
      // An implementation that failed to load is the same honest outcome,
      // reported as a capability notice instead of an empty registry.
      if (isImplementationUnavailable(error)) {
        implementationNotices.push(`${error.implementation} (unavailable on this server right now)`)
        return fallback
      }
      throw error
    }
  }
  // Built-ins by name replace same-named registry entries.
  const nativeNames = catalog.direct.descriptors
    .filter((descriptor) => !narrowed || narrowed.includes(descriptor.connectorId))
    .map((descriptor) => descriptor.name)
  const dynamic = dynamicCapabilityFamilies(catalog.plan)
  if (nativeNames.length > 0) {
    for (const tool of await unavailableOnly(() => catalog.activate({ toolNames: nativeNames }), [] as Tool[])) {
      tools.set(tool.name, tool)
    }
  }
  if (narrowed) return [...new Set([...catalog.unavailable, ...composition.activationUnavailable(), ...implementationNotices])]

  for (const tool of await unavailableOnly(() => composition.wrapTools(catalog.plan, catalog.direct.tools), [] as Tool[])) {
    tools.set(tool.name, tool)
  }
  // Dynamic direct adapters (canonical and legacy names) never replace an
  // existing registry entry; a dynamic MCP may pick a generic name.
  if (dynamic.length > 0) {
    for (const tool of await unavailableOnly(() => catalog.activate({ families: dynamic }), [] as Tool[])) {
      if (!tools.has(tool.name)) tools.set(tool.name, tool)
    }
  }
  // The search pair over the catalog's (dynamic) sources, as the injector
  // registered it on direct surfaces. Sources the activation above just
  // discovered are indexed with their descriptors (no second discovery: the
  // family activation is memoized), so the pair describes real tools.
  if (catalog.sources.length > 0) {
    const sources = await Promise.all(catalog.sources.map(async (source) => {
      if (!source.discover) return source
      const discovered = await source.discover().catch(() => null)
      if (!discovered) return source
      const { discover: _discover, summary: _summary, ...rest } = source
      return { ...rest, descriptors: discovered }
    }))
    const index = buildToolIndex(sources)
    const pair = createMcpSearchTools({
      index,
      settingsStore: options.settingsStore,
      assistantId: catalog.plan.assistantId,
      appLevelAssistantId: APP_LEVEL_ASSISTANT_ID,
      userId: catalog.plan.connectorUserId,
      hooks: options.hooks,
    }).filter((tool) => tool.name === 'mcp_search' || tool.name === 'mcp_call')
    for (const tool of await unavailableOnly(() => composition.wrapTools(catalog.plan, pair, index), [] as Tool[])) tools.set(tool.name, tool)
  }
  return [...new Set([...catalog.unavailable, ...composition.activationUnavailable(), ...implementationNotices])]
}

/** Dynamic families a registry surface can activate to build a complete roster. */
export function dynamicCapabilityFamilies(plan: CatalogActivationPlan): ProviderFamily[] {
  const dynamic: ProviderFamily[] = []
  if (plan.admitted.some((row) => row.connected && row.provider !== 'cli' && !!row.url && (row.lane === 'personal' || row.custom))) dynamic.push('remote-mcp')
  if (plan.admitted.some((row) => row.connected && row.provider === 'cli')) dynamic.push('cli')
  return dynamic
}
