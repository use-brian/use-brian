/**
 * Capability catalog (M3 WP1): what a turn may search for, prepared before
 * the model runs, with no connector built.
 *
 * `prepareCapabilityCatalog(input)` performs only bounded metadata work: one
 * runtime authority, one exposure-gated instance and grant listing, one
 * assistant-enablement read, one bulk policy read, one bulk action-grant read,
 * static native descriptors, cached dynamic descriptors, and knowledge-base
 * presence plus capture-rule matching (the latter only with capture text). It
 * performs zero network discovery, zero credential reads and zero child-process
 * spawns. Every native and dynamic source is a lazy `LocalSource`; the tool is
 * built by `activate(selection)` (WP2's `mcp/activation.ts`) only when a call
 * needs it.
 *
 * The catalog is a visibility snapshot, never an allow receipt: activation
 * re-applies policy, action grants, binding pins and runtime authority.
 *
 * [COMP:api/mcp-catalog]
 * See docs/architecture/integrations/mcp.md → "Capability catalog".
 */
import { createHash } from 'node:crypto'
import type { KnowledgeRepoWriter, KnowledgeStoreInterface } from '@use-brian/core/knowledge/types.js'
import {
  legacyMcpToolName,
  type LocalSource,
  type LocalToolDescriptor,
  type LocalToolResolution,
} from '@use-brian/core/mcp/tool-search.js'
import { createKnowledgeTools, type KnowledgeWriteCaptureRule } from '@use-brian/core/tools/base/knowledge.js'
import { resolveToolPolicy, type ToolPolicy as Policy } from '@use-brian/agent-runtime/mcp/policy.js'
import { classifyTool, defaultPolicy } from '@use-brian/agent-runtime/mcp/classifier.js'
import type { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import type { ExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import type { ConnectorResumeTarget, Tool } from '@use-brian/agent-runtime/tools/types.js'
import {
  ALL_EXACT_INSTANCE_GOVERNANCE_CONNECTOR_IDS,
  APP_LEVEL_ASSISTANT_ID,
  MULTI_INSTANCE_CONNECTOR_IDS,
  OFFICIAL_CONNECTORS,
  OFFICIAL_CONNECTOR_TOOLS,
  defaultGrantedConnectorActions,
} from '@use-brian/shared'
import { getSharedConnectorSourceRuntimeFactory } from '../application-platform/source-runtime.js'
import { isImplementationUnavailable } from '@use-brian/agent-runtime/tools/lazy-implementation.js'
import { createConnectorRuntimeAuthority } from '../application-platform/connector-runtime-authority.js'
import { connectorExposureAllowed, type ConnectorContextBinding, type ConnectorTurnGrant } from '../context-scope/connector-exposure.js'
import type { AssistantConnectorStore } from '../db/assistant-connector-store.js'
import { query } from '../db/client.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'
import type { ConnectorInstance, ConnectorInstanceStore } from '../db/connector-instance-store.js'
import type { ConnectorStore } from '../db/connector-store.js'
import {
  buildKnowledgeCapturePrompt,
  matchKnowledgeCaptureRules,
  type KnowledgeCaptureRuleStore,
} from '../knowledge/capture-rules.js'
import { connectorBindingFingerprint, connectorBindingKey, type Activation, type FamilySelection } from './activation.js'
import { connectorReconnectNotice } from './connector-health.js'
import {
  cliDescriptorSourceKey,
  descriptorVersion,
  dynamicSourceBindingKey,
  getSharedDescriptorLifecycle,
  remoteDescriptorSourceKey,
  staticNativeDescriptorRecords,
  type DescriptorLifecycle,
  type DescriptorRecord,
  type DynamicSourceRef,
} from './descriptors.js'
import { getConnectorConfig } from '../connector-config.js'
import { CONNECTOR_SCOPE_RESTRICTION } from './discovery-diagnostics.js'
import type { ProviderFamily, ProviderModule, ToolDescriptor } from './providers/types.js'
import { NOT_CONNECTED_CAPABILITIES, notConnectedNotice } from './providers/notices.js'
import { instanceToolSuffix, NOT_CONNECTED_DISPLAY_NAME } from './tool-names.js'

// ── Surface profiles ─────────────────────────────────────────

export type CapabilitySurface =
  | 'web' | 'channel' | 'public' | 'callee' | 'workflow' | 'workspace-mcp' | 'home-app' | 'resume'

/** Per-entrypoint capability shape. Replaces the loose injection options. */
export type SurfaceProfile = Readonly<{
  surface: CapabilitySurface
  /** Built-ins are activated as direct tools instead of indexed behind search. */
  keepBuiltinsDirect: boolean
  /** Dynamic entries also get canonical/legacy direct adapters (workflow `tool_call`). */
  keepDynamicToolsDirect: boolean
  /** Interactive deferred read adapters (web chat). */
  exposeLocalReadTools: boolean
  knowledgeWrites: 'none' | 'capture' | 'workflow'
  /** The public API cannot pause for approval: confirmation-required tools are never indexed. */
  excludeConfirmationRequired: boolean
  /** Folded sources keep only these canonical or legacy names (pinned callee). */
  restrictSearchToToolNames?: readonly string[]
}>

const folded = { keepBuiltinsDirect: false, keepDynamicToolsDirect: false, exposeLocalReadTools: false, excludeConfirmationRequired: false } as const
const direct = { keepBuiltinsDirect: true, keepDynamicToolsDirect: true, exposeLocalReadTools: false, excludeConfirmationRequired: false } as const

export const SURFACE_PROFILES: Readonly<Record<CapabilitySurface, SurfaceProfile>> = {
  web: { surface: 'web', ...folded, exposeLocalReadTools: true, knowledgeWrites: 'capture' },
  // Channel turns keep the guarded first-party read schemas they had under the injector.
  channel: { surface: 'channel', ...folded, exposeLocalReadTools: true, knowledgeWrites: 'capture' },
  public: { surface: 'public', ...folded, knowledgeWrites: 'none', excludeConfirmationRequired: true },
  callee: { surface: 'callee', ...folded, knowledgeWrites: 'none' },
  workflow: { surface: 'workflow', ...direct, knowledgeWrites: 'workflow' },
  'workspace-mcp': { surface: 'workspace-mcp', ...direct, knowledgeWrites: 'none' },
  'home-app': { surface: 'home-app', ...direct, knowledgeWrites: 'none' },
  resume: { surface: 'resume', ...direct, knowledgeWrites: 'none' },
}

/** A surface profile, optionally narrowed. A narrowing can never widen the surface. */
export function surfaceProfile(surface: CapabilitySurface, narrow: {
  keepBuiltinsDirect?: true
  /** Direct dynamic adapters (a consented or external-client callee, programmatic web chat). */
  keepDynamicToolsDirect?: true
  restrictSearchToToolNames?: readonly string[]
  exposeLocalReadTools?: false
  knowledgeWrites?: 'none'
} = {}): SurfaceProfile {
  const base = SURFACE_PROFILES[surface]
  const restrict = narrow.restrictSearchToToolNames
    ? base.restrictSearchToToolNames
      ? narrow.restrictSearchToToolNames.filter((name) => base.restrictSearchToToolNames!.includes(name))
      : narrow.restrictSearchToToolNames
    : base.restrictSearchToToolNames
  return {
    ...base,
    ...(narrow.keepBuiltinsDirect ? { keepBuiltinsDirect: true } : {}),
    ...(narrow.keepDynamicToolsDirect ? { keepDynamicToolsDirect: true } : {}),
    ...(narrow.exposeLocalReadTools === false ? { exposeLocalReadTools: false } : {}),
    ...(narrow.knowledgeWrites === 'none' ? { knowledgeWrites: 'none' } : {}),
    ...(restrict ? { restrictSearchToToolNames: restrict } : {}),
  }
}

// Binding keys and fingerprints are owned by `activation.ts` (one digest
// vocabulary for `bindingMaximum`, `onAdmittedBinding` and activation pins).

// ── Bulk reads ───────────────────────────────────────────────


export type CatalogPolicyRow =
  | { scope: 'user'; assistantId: string; userId: string; serverName: string; toolName: string; policy: Policy }
  | { scope: 'workspace'; workspaceId: string; serverName: string; toolName: string; policy: Policy }

/** One read covering L1 + L2 rows for every policy principal and the workspace policy table. */
export type CatalogPolicyReader = (input: {
  assistantIds: readonly string[]
  userIds: readonly string[]
  workspaceId: string | null
}) => Promise<CatalogPolicyRow[]>

/** One system-level read of an assistant's explicit capability-grant rows. */
export type CatalogActionGrantReader = (assistantId: string) => Promise<Array<{ connectorId: string; allowedActions: readonly string[] }>>

const readPoliciesSystem: CatalogPolicyReader = async ({ assistantIds, userIds, workspaceId }) => {
  const result = await query<{ scope: 'user' | 'workspace'; assistantId: string | null; userId: string | null;
    workspaceId: string | null; serverName: string; toolName: string; policy: Policy }>(
    `SELECT 'user' AS scope, assistant_id::text AS "assistantId", user_id::text AS "userId", NULL::text AS "workspaceId",
            server_name AS "serverName", tool_name AS "toolName", policy
       FROM mcp_tool_settings
      WHERE assistant_id::text = ANY($1::text[]) AND user_id::text = ANY($2::text[])
     UNION ALL
     SELECT 'workspace', NULL::text, NULL::text, workspace_id::text, server_name, tool_name, policy
       FROM workspace_tool_policy
      WHERE $3::text IS NOT NULL AND workspace_id::text = $3::text`,
    [[...assistantIds], [...userIds], workspaceId],
  )
  return result.rows.map((row) => row.scope === 'workspace'
    ? { scope: 'workspace', workspaceId: row.workspaceId!, serverName: row.serverName, toolName: row.toolName, policy: row.policy }
    : { scope: 'user', assistantId: row.assistantId!, userId: row.userId!, serverName: row.serverName, toolName: row.toolName, policy: row.policy })
}

const readActionGrantsSystem: CatalogActionGrantReader = async (assistantId) => {
  const result = await query<{ connectorId: string; allowedActions: string[] }>(
    `SELECT connector_id AS "connectorId", allowed_actions AS "allowedActions"
       FROM assistant_connector_grants WHERE assistant_id = $1`,
    [assistantId],
  )
  return result.rows
}

// ── Catalog types ────────────────────────────────────────────

export type CatalogLane = 'workspace' | 'grant' | 'personal'

const AGENTMAIL_ASSIGNMENT_NOTICE = 'Assistant Email (this assistant does not handle an inbox) - assign an inbox to it in Studio → Channels, or create one with Add channel → Email.'

/** One admitted connector binding, as handed to activation. */
export type AdmittedConnector = {
  lane: CatalogLane
  instanceId: string
  provider: string
  label: string
  url: string | null
  custom: boolean
  connected: boolean
  config: Record<string, unknown>
  updatedAt: Date | null
  createdAt: Date | null
  healthStatus?: string
  connectedEmail?: string | null
  /** Grant owner for an exposure lane. */
  grantedByUserId?: string
  /** `instance:<id>` / `grant:<id>`; absent for personal rows (no exposure binding). */
  bindingKey?: string
  fingerprint?: string
  /**
   * The exact listed row (instance, or grant with its instance) this binding
   * was admitted from. Activation pins it, so the pin carries the catalog-time
   * fingerprint and any later change raises `AuthorityChangedError`.
   */
  binding?: ConnectorContextBinding
  /** Full connector row for a personal binding (credential reads stay in activation). */
  personalRow?: Awaited<ReturnType<ConnectorStore['list']>>[number]
}

/** One indexed (or direct) capability. */
export type CatalogDescriptor = ToolDescriptor & {
  /** Canonical tool name before an instance suffix. */
  canonicalName: string
  /** `mcp_search` server identity this descriptor is indexed under. */
  serverName: string
  sourceKey: string
  instanceId?: string
  /** Enablement, policy and action-grant identity (`gcal`, `imap:<id>`, custom id ...). */
  governanceId: string
  lane: CatalogLane
  /** Effective visibility policy at catalog time (`block` is never listed). */
  effectivePolicy: 'allow' | 'ask'
  /** Per-tool content hash for dynamic descriptors; activation refuses on change. */
  version?: string
}

/** What to build. Names may be instance-suffixed variants. */
export type CapabilitySelection = {
  toolNames?: readonly string[]
  families?: readonly ProviderFamily[]
  /** Dynamic sources to (re)discover, by descriptor source key. */
  sourceKeys?: readonly string[]
}

/** Everything activation needs, captured once at catalog time. */
export type CatalogActivationPlan = Readonly<{
  profile: SurfaceProfile
  assistantId: string
  assistantTeamId: string | null
  connectorUserId: string
  runtimeActorId?: string
  executionContext?: ExecutionContext
  scopeAccumulator?: ContextScopeAccumulator
  contextScope?: ConnectorTurnGrant
  runtimeAuthority?: Awaited<ReturnType<typeof createConnectorRuntimeAuthority>>
  admitted: readonly AdmittedConnector[]
  /** Catalog-time binding fingerprints; activation re-pins against these. */
  bindingFingerprints: ReadonlyMap<string, string>
  descriptors: readonly CatalogDescriptor[]
  descriptorLifecycle: DescriptorLifecycle
  agentmailInboxIds?: readonly string[]
}>

/**
 * Activation result: the built tools, plus any descriptor records discovered
 * on the way (required for protected sources, which are never cached).
 */
export type CatalogActivationResult = Tool[] | { tools: Tool[]; records?: readonly DescriptorRecord[]; sourceTools?: Readonly<Record<string, readonly Tool[]>> }

/**
 * Activation port. Build it over WP2's per-turn `Activation`
 * (`mcp/activation.ts`) with {@link createCatalogActivator}; the composition
 * (`mcp/composition.ts`) wires both. A catalog without one refuses activation
 * honestly ("not available on this surface").
 */
export type CatalogActivator = (plan: CatalogActivationPlan, selection: CapabilitySelection) => Promise<CatalogActivationResult>

/**
 * Delegate catalog selections to WP2's activation. Families and source keys
 * select whole families; a tool name selects its descriptor's family in the
 * tool-name form (only the named tools come back). The composition supplies
 * each family's admitted lanes from the captured plan (`instancesFor`, which
 * may read activation-time state such as a grantor's connector list).
 * Activation memoizes per family; the descriptor records dynamic families
 * discovered are returned with the tools.
 */
export function createCatalogActivator(params: {
  activation: Pick<Activation, 'activateWithRecords'>
  /** Composition-owned: the family's provider `instances` input, built from `plan.admitted`. */
  instancesFor: (family: ProviderFamily, plan: CatalogActivationPlan, selection: CapabilitySelection) => unknown | Promise<unknown>
}): CatalogActivator {
  return async (plan, selection) => {
    const whole = new Set<ProviderFamily>(selection.families ?? [])
    const bySource = new Map<ProviderFamily, string[]>()
    for (const key of new Set(selection.sourceKeys ?? [])) {
      const family = key.startsWith('cli:') ? 'cli' : 'remote-mcp'
      if (!whole.has(family)) bySource.set(family, [...(bySource.get(family) ?? []), key])
    }
    const named = new Map<ProviderFamily, Set<string>>()
    const namesToActivate = bySource.size === 0 ? selection.toolNames : undefined
    for (const name of namesToActivate ?? []) {
      for (const descriptor of plan.descriptors) {
        if (descriptor.name !== name || descriptor.origin === 'dynamic' || whole.has(descriptor.family)) continue
        let names = named.get(descriptor.family)
        if (!names) named.set(descriptor.family, names = new Set())
        names.add(name)
      }
    }
    const families: Array<Omit<FamilySelection, 'instances'>> = [
      ...Array.from(whole, family => ({ family })),
      ...Array.from(named, ([family, names]) => ({ family, toolNames: [...names] })),
      ...Array.from(bySource, ([family, keys]) => keys.map(sourceKey => ({ family, sourceKey }))).flat(),
    ]
    if (families.length === 0) return []
    const entries = await Promise.all(families.map(async entry => ({
      ...entry,
      instances: await params.instancesFor(entry.family, plan,
        entry.sourceKey ? { sourceKeys: [entry.sourceKey] } : {}),
    })))
    const outcome = await params.activation.activateWithRecords({ families: entries })
    return { tools: outcome.tools, records: outcome.records, ...(outcome.sourceTools ? { sourceTools: outcome.sourceTools } : {}) }
  }
}

/**
 * The `unavailable` reason when activation needed an implementation module
 * that could not be loaded (`ImplementationUnavailableError` from
 * `@use-brian/agent-runtime/tools/lazy-implementation.js`): the call is refused honestly, nothing ran,
 * and the memoized activation is dropped so a later call retries the load.
 */
export const IMPLEMENTATION_UNAVAILABLE_REASON = 'its implementation could not be loaded on this server right now; nothing ran'

export class CapabilityActivationUnavailableError extends Error {
  constructor() {
    super('Capability activation is not wired for this catalog')
    this.name = 'CapabilityActivationUnavailableError'
  }
}

export type PrepareCapabilityCatalogInput = {
  profile: SurfaceProfile
  /** Narrow metadata and activation to one native connector for a requested operation. */
  onlyNativeConnector?: string
  assistant: { id: string; workspaceId: string | null }
  /** Credential owner and personal policy principal (the workspace owner for a workspace assistant). */
  connectorUserId: string
  /** Actual authenticated host actor when emitted separately from `contextScope`. */
  actorUserId?: string
  executionContext?: ExecutionContext
  scopeAccumulator?: ContextScopeAccumulator
  contextScope?: ConnectorTurnGrant
  bindingMaximum?: Readonly<Record<string, string>>
  onAdmittedBinding?: (key: string, fingerprint: string) => void
  stores: {
    connectorStore: Pick<ConnectorStore, 'list'>
    connectorInstanceStore?: Pick<ConnectorInstanceStore, 'listByWorkspaceSystem'>
    connectorGrantStore?: Pick<ConnectorGrantStore, 'listForTargetSystem'>
    assistantConnectorStore?: Pick<AssistantConnectorStore, 'listForAssistant'>
  }
  /** Bulk policy read; defaults to one system SQL statement. */
  policyReader?: CatalogPolicyReader
  /** Bulk action-grant read; `null` mirrors an unwired grants store (no visibility filter). */
  actionGrantReader?: CatalogActionGrantReader | null
  knowledge?: {
    store: KnowledgeStoreInterface
    repoWriter?: KnowledgeRepoWriter
    captureRuleStore?: KnowledgeCaptureRuleStore
    /** Newest authored human text; capture rules are read only when present. */
    captureText?: string
    requesterLabel?: string | null
  }
  /** Already-built first-party lanes (introspection, deployment-keyed reads). Folded surfaces only. */
  localSources?: readonly LocalSource[]
  /** Provider modules whose `describe()` replaces registry rows for their family. */
  providers?: readonly Pick<ProviderModule, 'family' | 'describe'>[]
  descriptorLifecycle?: DescriptorLifecycle
  listAssignedAgentmailInboxIds?: (workspaceId: string, assistantId: string) => Promise<string[]>
  activator?: CatalogActivator
  /** Test seam for the runtime authority; production uses the canonical reader. */
  createRuntimeAuthority?: typeof createConnectorRuntimeAuthority
  /**
   * Whether a workspace dynamic source runs behind the protected source
   * runtime. Defaults to "every workspace dynamic source" while a shared
   * source-runtime factory is installed (conservative: never cached).
   */
  isProtectedSource?: (connector: AdmittedConnector) => boolean
  /**
   * Whether this deployment can serve a built-in connector at all. A family
   * whose activation needs a deployment OAuth app (Notion, Fathom) builds
   * nothing without one, so the catalog neither advertises it nor reports it
   * as "not connected". Defaults to {@link deploymentServesConnector}.
   */
  isConnectorConfigured?: (connectorId: string) => boolean
}

/** Built-ins whose activation needs the deployment's own OAuth app (no BYO path). */
const DEPLOYMENT_APP_CONNECTORS: Readonly<Record<string, 'notion' | 'fathom'>> = { notion: 'notion', fathom: 'fathom' }

/** Catalog-time config check: false only for a built-in that cannot activate on this deployment. */
export function deploymentServesConnector(connectorId: string): boolean {
  const provider = DEPLOYMENT_APP_CONNECTORS[connectorId]
  return !provider || !!getConnectorConfig(provider)
}

/**
 * Microsoft Teams can run on a workspace-owned app, so it stays catalogued
 * without a deployment app; a connector-less install just never announces it.
 */
function announcesNotConnected(connectorId: string): boolean {
  return connectorId !== 'msgraph' || !!getConnectorConfig('msgraph')
}

export type CapabilityCatalog = {
  profile: SurfaceProfile
  /** Sources for `buildToolIndex`. Native and dynamic sources are lazy. */
  sources: LocalSource[]
  /** Options the search pair must be built with for this surface. */
  searchOptions: { keepDynamicToolsDirect: boolean; exposeLocalReadTools: boolean }
  /** Every admitted capability, indexed or direct. Feeds routing (`toolNames`). */
  descriptors: readonly CatalogDescriptor[]
  /** Direct-surface capabilities (`keepBuiltinsDirect`): activate by name, then register. */
  direct: { descriptors: readonly CatalogDescriptor[]; tools: readonly Tool[] }
  /** Computed once: not connected, reconnect, scope restriction, read-only KB destinations. */
  unavailable: string[]
  searchableSources: string[]
  admittedConnectorIds: ReadonlySet<string>
  admittedBindings: ReadonlyMap<string, string>
  restrictedSearchToolNames?: string[]
  /**
   * A restricted profile's sources before the restriction, undiscovered ones
   * included. A surface that must prove pinned names discovers these and
   * restricts again with {@link restrictSources}.
   */
  unrestrictedSources?: LocalSource[]
  knowledgeCapturePrompt?: string
  activate(selection: CapabilitySelection): Promise<Tool[]>
  plan: CatalogActivationPlan
  resolveSuspendedDynamicTool(name: string, target?: ConnectorResumeTarget): Promise<Tool | undefined>
}

// ── Helpers ──────────────────────────────────────────────────

const officialName = new Map(OFFICIAL_CONNECTORS.map((connector) => [connector.id, connector.name]))
const officialEnabled = new Set(OFFICIAL_CONNECTORS.filter((connector) => connector.enabled).map((connector) => connector.id))

function catalogNotConnectedNotice(connectorId: string): string {
  const curated = NOT_CONNECTED_CAPABILITIES[connectorId]
  if (curated) return notConnectedNotice(NOT_CONNECTED_DISPLAY_NAME[connectorId] ?? officialName.get(connectorId) ?? connectorId, curated)
  const capabilities = (OFFICIAL_CONNECTOR_TOOLS[connectorId] ?? []).slice(0, 3)
    .map((tool) => tool.description.charAt(0).toLowerCase() + tool.description.slice(1)).join(', ')
  return notConnectedNotice(officialName.get(connectorId) ?? connectorId, capabilities)
}

function toInstanceRow(instance: ConnectorInstance, lane: CatalogLane, grant?: { id: string; grantedByUserId: string }): AdmittedConnector {
  return {
    lane, instanceId: instance.id, provider: instance.provider, label: instance.label, url: instance.url,
    custom: instance.custom, connected: instance.connected, config: instance.config ?? {},
    updatedAt: instance.updatedAt ?? null, createdAt: instance.createdAt ?? null,
    healthStatus: instance.healthStatus, connectedEmail: instance.connectedEmail,
    ...(grant ? { grantedByUserId: grant.grantedByUserId } : {}),
  }
}

function localDescriptor(descriptor: CatalogDescriptor): LocalToolDescriptor {
  const dynamic = descriptor.origin === 'dynamic'
  return {
    name: descriptor.name,
    description: descriptor.description,
    // Static descriptors carry the factory's JSON Schema, so a search hit shows
    // real parameters without activating the family.
    ...(descriptor.inputSchema.schema ? { inputSchema: descriptor.inputSchema.schema } : {}),
    ...(dynamic ? { externalInputSchema: true, allowPersistentApproval: true } : {}),
    isReadOnly: descriptor.classification === 'read',
    requiresConfirmation: descriptor.requiresConfirmation || descriptor.effectivePolicy === 'ask',
    ...(descriptor.version ? { version: descriptor.version } : {}),
  }
}

function toolVersion(descriptor: ToolDescriptor): string {
  return descriptorVersion([descriptor])
}

function nativeToolVersion(version: string | null, binding: unknown): string {
  return createHash('sha256').update(JSON.stringify([version, binding])).digest('hex')
}

// ── Catalog ──────────────────────────────────────────────────

export async function prepareCapabilityCatalog(input: PrepareCapabilityCatalogInput): Promise<CapabilityCatalog> {
  const { profile, assistant, connectorUserId, contextScope, bindingMaximum, onAdmittedBinding, stores, onlyNativeConnector } = input
  const includesConnector = (id: string) => onlyNativeConnector === undefined || onlyNativeConnector === id
  const assistantId = assistant.id
  const workspaceId = assistant.workspaceId
  const lifecycle = input.descriptorLifecycle ?? getSharedDescriptorLifecycle()
  const runtimeActorId = contextScope?.access?.userId ?? input.actorUserId
  const unavailable: string[] = []
  const note = (line: string) => { if (!unavailable.includes(line)) unavailable.push(line) }

  const empty = (): CapabilityCatalog => {
    const plan: CatalogActivationPlan = { profile, assistantId, assistantTeamId: workspaceId, connectorUserId,
      admitted: [], bindingFingerprints: new Map(), descriptors: [], descriptorLifecycle: lifecycle }
    return { profile, sources: [], searchOptions: { keepDynamicToolsDirect: profile.keepDynamicToolsDirect, exposeLocalReadTools: profile.exposeLocalReadTools },
      descriptors: [], direct: { descriptors: [], tools: [] }, unavailable, searchableSources: [],
      admittedConnectorIds: new Set(), admittedBindings: new Map(), plan,
      activate: async () => { throw new CapabilityActivationUnavailableError() },
      resolveSuspendedDynamicTool: async () => undefined }
  }

  // 1. One runtime authority (workspace assistants only).
  let runtimeAuthority: CatalogActivationPlan['runtimeAuthority']
  if (workspaceId) {
    try {
      runtimeAuthority = await (input.createRuntimeAuthority ?? createConnectorRuntimeAuthority)({
        workspaceId, assistantId, initiatingUserId: runtimeActorId, identityUserId: input.actorUserId,
      })
    } catch {
      note(CONNECTOR_SCOPE_RESTRICTION)
      return empty()
    }
  }

  // 2. One exposure-gated instance and grant listing.
  const admittedBindings = new Map<string, string>()
  const admittedConnectorIds = new Set<string>()
  const exposureAllowed = (binding: ConnectorContextBinding): boolean => {
    const key = connectorBindingKey(binding)
    const fingerprint = connectorBindingFingerprint(binding)
    const row = binding as unknown as Record<string, unknown>
    const instance = (row.instance ?? row) as Record<string, unknown>
    const allowed = (runtimeAuthority?.allows(binding) ?? true) && connectorExposureAllowed(contextScope, binding)
      && (bindingMaximum === undefined || bindingMaximum[key] === fingerprint)
    if (!allowed) {
      // Report once per turn, without connector identity, scope values or counts.
      if (!unavailable.includes(CONNECTOR_SCOPE_RESTRICTION)) {
        console.info('[mcp-catalog] connector discovery scope restriction', {
          assistantId, workspaceId, reason: 'connector_exposure_outside_execution_scope',
        })
      }
      note(CONNECTOR_SCOPE_RESTRICTION)
      return false
    }
    if (!admittedBindings.has(key)) {
      admittedBindings.set(key, fingerprint)
      onAdmittedBinding?.(key, fingerprint)
    }
    if (typeof instance.provider === 'string' && instance.connected === true && instance.healthStatus !== 'auth_failed') {
      admittedConnectorIds.add(instance.provider)
    }
    return true
  }

  const admitted: AdmittedConnector[] = []
  let listingFailed = false
  if (!workspaceId) {
    try {
      for (const row of await stores.connectorStore.list(connectorUserId)) {
        if (!includesConnector(row.connectorId)) continue
        admitted.push({ lane: 'personal', instanceId: row.id, provider: row.connectorId, label: row.name, url: row.url,
          custom: row.custom, connected: row.connected, config: row.config ?? {}, updatedAt: row.updatedAt ?? null,
          createdAt: row.createdAt ?? null, connectedEmail: row.connectedEmail, personalRow: row })
        if (row.connected) admittedConnectorIds.add(row.connectorId)
      }
    } catch (error) {
      console.error('[mcp-catalog] failed to list connectors:', error)
      listingFailed = true
    }
  } else {
    const [instances, grants] = await Promise.all([
      stores.connectorInstanceStore
        ? stores.connectorInstanceStore.listByWorkspaceSystem(workspaceId).catch((error) => {
          console.error('[mcp-catalog] workspace connector listing failed:', error); return null })
        : Promise.resolve([]),
      stores.connectorGrantStore
        ? stores.connectorGrantStore.listForTargetSystem('workspace', workspaceId).catch((error) => {
          console.error('[mcp-catalog] exposure listing failed:', error); return null })
        : Promise.resolve([]),
    ])
    if (instances === null || grants === null) listingFailed = true
    for (const instance of instances ?? []) {
      if (!includesConnector(instance.provider) || !exposureAllowed(instance)) continue
      // A snapshot: activation pins exactly what was admitted, whatever later happens to the listed object.
      admitted.push({ ...toInstanceRow(instance, 'workspace'), bindingKey: connectorBindingKey(instance), fingerprint: connectorBindingFingerprint(instance), binding: structuredClone(instance) })
    }
    const orderedGrants = [...(grants ?? [])].sort((a, b) => (a.instance.createdAt?.getTime() ?? 0) - (b.instance.createdAt?.getTime() ?? 0)
      || String(a.instance.id).localeCompare(String(b.instance.id)))
    for (const grant of orderedGrants) {
      if (!includesConnector(grant.instance.provider) || !exposureAllowed(grant)) continue
      admitted.push({ ...toInstanceRow(grant.instance, 'grant', grant), bindingKey: connectorBindingKey(grant), fingerprint: connectorBindingFingerprint(grant), binding: structuredClone(grant) })
    }
  }

  // 3-5. One enablement read, one bulk policy read, one bulk action-grant read.
  const policyUsers = [...new Set([connectorUserId, ...admitted.flatMap((row) => row.grantedByUserId ? [row.grantedByUserId] : [])])]
  const hasAgentmailInbox = admitted.some(row => row.lane === 'workspace' && row.provider === 'agentmail'
    && row.connected && row.healthStatus !== 'auth_failed')
  const [enablementRows, policyRows, grantRows, assignedAgentmailIds] = await Promise.all([
    stores.assistantConnectorStore
      ? stores.assistantConnectorStore.listForAssistant(assistantId).catch((error) => {
        // Fail closed: an unknown enablement state hides connector tools this turn.
        console.error('[mcp-catalog] enablement read failed:', error); return null })
      : Promise.resolve([]),
    (input.policyReader ?? readPoliciesSystem)({ assistantIds: [APP_LEVEL_ASSISTANT_ID, assistantId], userIds: policyUsers, workspaceId })
      .catch((error) => { console.error('[mcp-catalog] policy read failed:', error); return null }),
    input.actionGrantReader === null
      ? Promise.resolve(null)
      : (input.actionGrantReader ?? readActionGrantsSystem)(assistantId)
        .catch((error) => { console.error('[mcp-catalog] action-grant read failed:', error); return 'failed' as const }),
    workspaceId && hasAgentmailInbox && input.listAssignedAgentmailInboxIds
      ? input.listAssignedAgentmailInboxIds(workspaceId, assistantId).catch(error => {
        console.error('[mcp-catalog] Assistant Email assignment read failed:', error)
        return null
      })
      : Promise.resolve([]),
  ])
  const enablement = new Map((enablementRows ?? []).map((row) => [row.connectorId, row.enabled]))
  const isEnabled = (governanceId: string, fallback?: string) => enablementRows !== null
    && (enablement.get(governanceId) ?? (fallback ? enablement.get(fallback) : undefined) ?? true)
  const userPolicy = new Map<string, Policy>()
  const workspacePolicy = new Map<string, Policy>()
  for (const row of policyRows ?? []) {
    if (row.scope === 'workspace') workspacePolicy.set(`${row.serverName}\u0000${row.toolName}`, row.policy)
    else userPolicy.set(`${row.assistantId}\u0000${row.userId}\u0000${row.serverName}\u0000${row.toolName}`, row.policy)
  }
  const policyFor = (principal: { kind: 'workspace' } | { kind: 'user'; userId: string }, opts: {
    appServer: string; assistantServer: string; assistantFallback?: string; toolName: string; fallback: Policy
  }): Policy => {
    // A failed policy read fails closed: nothing is listed as auto-allowed.
    if (policyRows === null) return opts.fallback === 'allow' ? 'ask' : opts.fallback
    const read = (assistant: string, server: string) => principal.kind === 'workspace'
      ? workspacePolicy.get(`${server}\u0000${opts.toolName}`)
      : userPolicy.get(`${assistant}\u0000${principal.userId}\u0000${server}\u0000${opts.toolName}`)
    return resolveToolPolicy({
      assistantId, serverName: opts.assistantServer, appServerName: opts.appServer,
      assistantFallbackServerName: opts.assistantFallback,
    }, opts.fallback, read).effectivePolicy
  }
  const grants = grantRows === null || grantRows === 'failed' ? null : new Map(grantRows.map((row) => [row.connectorId, row.allowedActions]))
  const actionGranted = (governanceId: string, toolName: string) => grantRows === null
    || (grantRows !== 'failed' && (grants!.get(governanceId) ?? defaultGrantedConnectorActions(governanceId)).includes(toolName))
  const principalOf = (row: AdmittedConnector) => row.lane === 'workspace'
    ? { kind: 'workspace' as const }
    : { kind: 'user' as const, userId: row.grantedByUserId ?? connectorUserId }

  const descriptors: CatalogDescriptor[] = []
  const visible = (descriptor: CatalogDescriptor) => !(profile.excludeConfirmationRequired
    && (descriptor.requiresConfirmation || descriptor.effectivePolicy === 'ask'))

  // 6a. Static native descriptors, by winning lane per provider.
  const nativeRecords = new Map(staticNativeDescriptorRecords(input.providers ?? [], onlyNativeConnector).map((record) => [record.connectorId, record]))
  const nativeSources: Array<{ connectorId: string; descriptors: CatalogDescriptor[] }> = []
  let agentmailInboxIds: string[] | undefined
  const configured = input.isConnectorConfigured ?? deploymentServesConnector
  for (const [connectorId, record] of nativeRecords) {
    // Assistant Email registers one schema across every inbox assigned to the assistant.
    if (record.family === 'agentmail') {
      if (!workspaceId || !input.listAssignedAgentmailInboxIds) continue
      const assigned = new Set(assignedAgentmailIds ?? [])
      const inboxes = admitted.filter(row => row.lane === 'workspace' && row.provider === 'agentmail'
        && row.connected && row.healthStatus !== 'auth_failed' && assigned.has(row.instanceId))
      if (inboxes.length === 0) {
        note(assignedAgentmailIds ? AGENTMAIL_ASSIGNMENT_NOTICE : 'Assistant Email (assignment could not be verified)')
        continue
      }
      if (!isEnabled(connectorId)) continue
      agentmailInboxIds = inboxes.map(row => row.instanceId).sort()
      const bindings = inboxes.map(row => [row.instanceId, row.connectedEmail ?? row.label, row.createdAt?.getTime()])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      const version = nativeToolVersion(record.version, bindings)
      const tools = record.tools.flatMap((tool): CatalogDescriptor[] => {
        const effective = policyFor({ kind: 'workspace' }, { appServer: connectorId, assistantServer: connectorId,
          toolName: tool.name, fallback: tool.requiresConfirmation ? 'ask' : 'allow' })
        if (effective === 'block') return []
        if ((tool.classification === 'write' || tool.classification === 'destructive')
          && !inboxes.some(row => actionGranted(`${connectorId}:${row.instanceId}`, tool.name))) return []
        const descriptor: CatalogDescriptor = { ...tool, canonicalName: tool.name, serverName: connectorId,
          sourceKey: record.sourceKey, governanceId: connectorId, lane: 'workspace', effectivePolicy: effective,
          version }
        return visible(descriptor) ? [descriptor] : []
      })
      if (tools.length > 0) {
        descriptors.push(...tools)
        nativeSources.push({ connectorId, descriptors: tools })
      }
      continue
    }
    // A built-in this deployment cannot activate is neither indexed nor announced.
    if (!configured(connectorId)) continue
    const lanes: CatalogLane[] = workspaceId ? ['workspace', 'grant'] : ['personal']
    let chosen: AdmittedConnector[] = []
    for (const lane of lanes) {
      let candidates = admitted.filter((row) => row.lane === lane && row.provider === connectorId && row.connected && !row.custom)
      if (lane === 'grant' && candidates.length > 0) {
        const grantor = candidates[0]!.grantedByUserId
        candidates = candidates.filter((row) => row.grantedByUserId === grantor)
      }
      if (lane === 'personal') candidates = [...candidates].sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
      if (candidates.length > 0) { chosen = candidates; break }
    }
    for (const row of chosen) if (row.healthStatus === 'auth_failed') note(connectorReconnectNotice(connectorId, row.label))
    const healthy = chosen.filter((row) => row.healthStatus !== 'auth_failed')
    const bound = MULTI_INSTANCE_CONNECTOR_IDS.has(connectorId) ? healthy : healthy.slice(0, 1)
    if (bound.length === 0) {
      if (chosen.length === 0 && officialEnabled.has(connectorId) && !listingFailed && announcesNotConnected(connectorId)) note(catalogNotConnectedNotice(connectorId))
      continue
    }
    const sourceDescriptors: CatalogDescriptor[] = []
    bound.forEach((row, position) => {
      const primary = position === 0
      const governanceId = primary && !ALL_EXACT_INSTANCE_GOVERNANCE_CONNECTOR_IDS.has(connectorId)
        ? connectorId : `${connectorId}:${row.instanceId}`
      if (!isEnabled(governanceId, connectorId)) return
      const suffix = primary ? '' : instanceToolSuffix(row.instanceId, row.label)
      const version = nativeToolVersion(record.version, [row.lane, row.instanceId, row.bindingKey])
      for (const tool of record.tools) {
        const fallback: Policy = tool.requiresConfirmation ? 'ask' : 'allow'
        // A workspace-owned mailbox is governed per instance at both levels (as its activation does).
        const appServer = connectorId === 'imap' && row.lane === 'workspace' ? governanceId : connectorId
        const effective = policyFor(principalOf(row), { appServer, assistantServer: governanceId,
          assistantFallback: connectorId, toolName: tool.name, fallback })
        if (effective === 'block') {
          // The personal base load always named the tools a policy blocks.
          if (row.lane === 'personal') note(`${tool.name}${suffix} (blocked by policy)`)
          continue
        }
        if ((tool.classification === 'write' || tool.classification === 'destructive') && !actionGranted(governanceId, tool.name)) continue
        const descriptor: CatalogDescriptor = {
          ...tool,
          name: `${tool.name}${suffix}`,
          // Mailbox tools name their account on every row, the primary's included.
          description: primary && connectorId !== 'imap' ? tool.description : `[${row.label}] ${tool.description}`,
          canonicalName: tool.name,
          serverName: connectorId,
          sourceKey: record.sourceKey,
          instanceId: row.instanceId,
          governanceId,
          lane: row.lane,
          effectivePolicy: effective,
          version,
        }
        if (visible(descriptor)) sourceDescriptors.push(descriptor)
      }
    })
    if (sourceDescriptors.length > 0) {
      descriptors.push(...sourceDescriptors)
      nativeSources.push({ connectorId, descriptors: sourceDescriptors })
    }
  }

  // 6b. Cached dynamic descriptors (custom remote MCP and CLI). Never discovered here.
  const protectedSource = input.isProtectedSource
    ?? ((row: AdmittedConnector) => row.lane !== 'personal' && !!getSharedConnectorSourceRuntimeFactory())
  type DynamicSource = { ref: DynamicSourceRef; row: AdmittedConnector; serverName: string; label: string
    governanceId: string; policyServer: string; record: DescriptorRecord }
  const dynamicSources: DynamicSource[] = []
  const seenDynamic = new Set<string>()
  for (const row of onlyNativeConnector ? [] : admitted) {
    const isCli = row.provider === 'cli'
    const isRemote = !isCli && row.connected && !!row.url && (row.lane === 'personal' || row.custom)
    if (!row.connected || (!isCli && !isRemote) || seenDynamic.has(row.instanceId)) continue
    seenDynamic.add(row.instanceId)
    const governanceId = row.lane === 'personal' && !isCli ? row.provider : `${row.provider}:${row.instanceId}`
    if (!isEnabled(governanceId, row.provider)) continue
    const ref: DynamicSourceRef = {
      sourceKey: isCli ? cliDescriptorSourceKey(row.instanceId) : remoteDescriptorSourceKey(row.instanceId),
      family: isCli ? 'cli' : 'remote-mcp',
      connectorId: row.provider,
      bindingKey: dynamicSourceBindingKey(row, runtimeActorId),
      protected: !isCli && protectedSource(row),
    }
    const policyServer = row.lane === 'workspace' ? (isCli ? `cli:${row.instanceId}` : row.provider) : row.label
    dynamicSources.push({ ref, row, serverName: `connector:${row.instanceId}`, label: row.label, governanceId, policyServer, record: lifecycle.read(ref) })
  }
  const dynamicDescriptors = (source: DynamicSource, tools: readonly ToolDescriptor[]): CatalogDescriptor[] => tools.flatMap((tool) => {
    const effective = policyFor(principalOf(source.row), { appServer: source.policyServer, assistantServer: source.policyServer,
      toolName: tool.name, fallback: defaultPolicy(classifyTool(tool.name, tool.description)) })
    if (effective === 'block') return []
    const descriptor: CatalogDescriptor = { ...tool, canonicalName: tool.name, serverName: source.serverName,
      sourceKey: source.ref.sourceKey, instanceId: source.row.instanceId, governanceId: source.governanceId,
      lane: source.row.lane, effectivePolicy: effective, version: toolVersion(tool) }
    return visible(descriptor) ? [descriptor] : []
  })

  // 7. Knowledge base presence; capture rules only with capture text.
  let knowledgeTools: Tool[] = []
  let knowledgeCapturePrompt: string | undefined
  if (!onlyNativeConnector && input.knowledge) {
    const { store, repoWriter, captureRuleStore, captureText, requesterLabel } = input.knowledge
    const captureMode = profile.knowledgeWrites === 'capture'
    try {
      const [hasEntries, sources, enabledRules] = await Promise.all([
        store.hasEntriesForAssistant(assistantId),
        store.listSourcesForAssistant(assistantId),
        captureMode && workspaceId && captureRuleStore && captureText?.trim()
          ? captureRuleStore.listEnabledForWorkspace(workspaceId).catch((error) => {
            console.error('[mcp-catalog] knowledge capture-rule lookup failed:', error); return [] })
          : Promise.resolve([]),
      ])
      const matchedRules = captureText?.trim() ? matchKnowledgeCaptureRules(enabledRules, captureText) : []
      if (hasEntries || sources.length > 0 || matchedRules.some((rule) => rule.targetSourceId === null)) {
        const repoConnected = sources.length > 0
        const writableSources = sources.filter((source) => source.sourceType === 'local' || source.writeAccess === true)
          .map((source) => ({ id: source.id, repo: source.repo, sourceType: source.sourceType }))
        const captureAuthorizations: KnowledgeWriteCaptureRule[] = []
        for (const rule of matchedRules) {
          const target = rule.targetSourceId === null ? null : sources.find((source) => source.id === rule.targetSourceId)
          const writable = rule.targetSourceId === null || (!!target && !!repoWriter && writableSources.some((source) => source.id === rule.targetSourceId))
          if (writable) {
            captureAuthorizations.push({ id: rule.id, name: rule.name, instructions: rule.instructions,
              targetSourceId: rule.targetSourceId, targetLabel: target?.repo ?? 'Manual entries',
              pathPrefix: rule.pathPrefix, defaultSensitivity: rule.defaultSensitivity })
          } else {
            note(target
              ? `knowledge capture category "${rule.name}" (its destination ${target.repo} is currently read-only)`
              : `knowledge capture category "${rule.name}" (its configured destination is not enabled for this assistant)`)
          }
        }
        const workflowWrites = profile.knowledgeWrites === 'workflow' && (!repoConnected || (!!repoWriter && writableSources.length > 0))
        const captureWrites = captureMode && captureAuthorizations.length > 0
        const writeEnabled = workflowWrites || captureWrites
        knowledgeTools = createKnowledgeTools(store, {
          repoConnected,
          allowWrites: writeEnabled,
          repoWriter: writeEnabled ? repoWriter : undefined,
          writableSources: writeEnabled ? writableSources : [],
          captureRules: captureWrites ? captureAuthorizations : [],
          requesterLabel: requesterLabel ?? null,
        })
        if (profile.knowledgeWrites === 'workflow' && repoConnected && !writeEnabled) {
          note(!repoWriter
            ? 'knowledge base editing (source write-back is not configured on this server)'
            : 'knowledge base editing (no writable source is available)')
        }
        if (captureWrites) {
          knowledgeCapturePrompt = buildKnowledgeCapturePrompt(matchedRules
            .filter((rule) => captureAuthorizations.some((authorization) => authorization.id === rule.id))
            .map((rule) => ({ ...rule, targetLabel: captureAuthorizations.find((authorization) => authorization.id === rule.id)!.targetLabel })))
        }
      }
    } catch (error) {
      console.error('[mcp-catalog] knowledge presence read failed:', error)
    }
  }
  if (profile.excludeConfirmationRequired) {
    knowledgeTools = knowledgeTools.filter((tool) => !tool.requiresConfirmation && !tool.resolveConfirmation)
  }

  // ── Activation port (lazy) ──
  const plan: CatalogActivationPlan = {
    profile, assistantId, assistantTeamId: workspaceId, connectorUserId, runtimeActorId,
    executionContext: input.executionContext, scopeAccumulator: input.scopeAccumulator, contextScope, runtimeAuthority,
    admitted, bindingFingerprints: admittedBindings, descriptors, descriptorLifecycle: lifecycle,
    agentmailInboxIds,
  }
  type Activated = { tools: Tool[]; records: readonly DescriptorRecord[]; sourceTools?: Readonly<Record<string, readonly Tool[]>> }
  const activations = new Map<string, Promise<Activated>>()
  const activateWithRecords = (selection: CapabilitySelection) => {
    if (!input.activator) return Promise.reject(new CapabilityActivationUnavailableError())
    const key = JSON.stringify([selection.toolNames ?? [], selection.families ?? [], selection.sourceKeys ?? []])
    let pending = activations.get(key)
    if (!pending) {
      pending = input.activator(plan, selection).then((result): Activated => Array.isArray(result)
        ? { tools: result, records: [] }
        : { tools: result.tools, records: result.records ?? [], ...(result.sourceTools ? { sourceTools: result.sourceTools } : {}) })
      pending.catch(() => { if (activations.get(key) === pending) activations.delete(key) })
      activations.set(key, pending)
    }
    return pending
  }
  const currentRecord = (source: DynamicSource, records: readonly DescriptorRecord[]) =>
    records.find((record) => record.sourceKey === source.ref.sourceKey) ?? lifecycle.read(source.ref)

  const resolveNative = async (name: string): Promise<LocalToolResolution> => {
    let result
    try {
      if (onlyNativeConnector) {
        // The direct first-frame read uses the admitted primary's exact
        // binding. A failed primary activation must never select a sibling.
        const target = descriptors.find(descriptor => descriptor.name === name && descriptor.canonicalName === name)
        const exact = plan.admitted.filter(row => row.instanceId === target?.instanceId && row.lane === target?.lane)
        if (!input.activator || exact.length !== 1) throw new CapabilityActivationUnavailableError()
        const outcome = await input.activator({ ...plan, admitted: exact }, { toolNames: [name] })
        result = { tools: Array.isArray(outcome) ? outcome : outcome.tools }
      } else result = await activateWithRecords({ toolNames: [name] })
    } catch (error) {
      if (error instanceof CapabilityActivationUnavailableError) return { status: 'unavailable', reason: 'activation is not available on this surface' }
      if (isImplementationUnavailable(error)) return { status: 'unavailable', reason: IMPLEMENTATION_UNAVAILABLE_REASON }
      throw error
    }
    const tool = result.tools.find((candidate) => candidate.name === name)
    return tool ? { status: 'ready', tool } : { status: 'unavailable', reason: 'it is no longer available to this assistant' }
  }
  const resolveDynamic = (source: DynamicSource) => async (name: string): Promise<LocalToolResolution> => {
    let result
    try { result = await activateWithRecords({ sourceKeys: [source.ref.sourceKey], toolNames: [name] }) } catch (error) {
      if (error instanceof CapabilityActivationUnavailableError) return { status: 'unavailable', reason: 'activation is not available on this surface' }
      if (isImplementationUnavailable(error)) return { status: 'unavailable', reason: IMPLEMENTATION_UNAVAILABLE_REASON }
      throw error
    }
    // Dynamic families return direct adapters; the legacy `mcp_<label>_<tool>`
    // alias names exactly this source, the canonical alias only when unique.
    // The source's own adapters first (unambiguous across colliding labels), then the shared aliases.
    const legacy = legacyMcpToolName(source.label, name)
    const own = result.sourceTools?.[source.serverName]
    const candidates = result.sourceTools ? own ?? [] : result.tools
    const tool = candidates.find(candidate => candidate.name === name) ?? candidates.find(candidate => candidate.name === legacy)
    const record = currentRecord(source, result.records)
    const current = record.version ? dynamicDescriptors(source, record.tools).find((descriptor) => descriptor.name === name) : undefined
    if (record.version && !current) return { status: 'unavailable', reason: `${source.label} no longer offers it to this assistant` }
    if (!tool) return { status: 'unavailable', reason: `${source.label} could not be reached` }
    return current
      ? { status: 'ready', tool, version: current.version, descriptor: localDescriptor(current) }
      : { status: 'ready', tool }
  }
  async function resolveSuspendedDynamicTool(name: string, target?: ConnectorResumeTarget): Promise<Tool | undefined> {
    if (target) {
      const source = dynamicSources.find(candidate => candidate.serverName === target.serverName)
      if (!source) return undefined
      const resolved = await resolveDynamic(source)(name)
      return resolved.status === 'ready' && resolved.version === target.version ? resolved.tool : undefined
    }
    // Older checkpoints contain only the canonical name (or the old direct
    // alias). Use it only when the available metadata establishes one source.
    const candidates = dynamicSources.flatMap(source => dynamicDescriptors(source, source.record.tools)
      .filter(tool => name === tool.name || name === legacyMcpToolName(source.label, tool.name))
      .map(tool => ({ source, tool })))
    if (candidates.length !== 1 || dynamicSources.some(source => !source.record.version)) return undefined
    const { source, tool } = candidates[0]!
    const resolved = await resolveDynamic(source)(tool.name)
    return resolved.status === 'ready' && resolved.version === tool.version ? resolved.tool : undefined
  }

  const discoverDynamic = (source: DynamicSource) => async (): Promise<LocalToolDescriptor[]> => {
    const result = await activateWithRecords({ sourceKeys: [source.ref.sourceKey] })
    const record = currentRecord(source, result.records)
    if (!record.version) throw new Error(`${source.label}: discovery returned no descriptors`)
    const found = dynamicDescriptors(source, record.tools)
    descriptors.push(...found.filter((descriptor) => !descriptors.some((existing) =>
      existing.sourceKey === descriptor.sourceKey && existing.name === descriptor.name)))
    return found.map(localDescriptor)
  }

  // ── Index sources ──
  const sources: LocalSource[] = []
  const directDescriptors: CatalogDescriptor[] = []
  const directTools: Tool[] = []
  if (profile.keepBuiltinsDirect) {
    for (const source of nativeSources) directDescriptors.push(...source.descriptors)
    directTools.push(...knowledgeTools)
  } else {
    for (const source of nativeSources) {
      sources.push({ kind: 'local', serverName: source.connectorId, tools: [],
        descriptors: source.descriptors.map(localDescriptor),
        resolve: resolveNative })
    }
    if (knowledgeTools.length > 0) sources.push({ kind: 'local', serverName: 'knowledge', tools: knowledgeTools })
    for (const local of onlyNativeConnector ? [] : input.localSources ?? []) {
      const tools = profile.excludeConfirmationRequired
        ? local.tools.filter((tool) => !tool.requiresConfirmation && !tool.resolveConfirmation)
        : local.tools
      if (tools.length > 0 || local.descriptors?.length) sources.push({ ...local, tools })
    }
  }
  for (const source of dynamicSources) {
    const usable = source.record.availability === 'fresh' || source.record.availability === 'stale'
    const known = usable ? dynamicDescriptors(source, source.record.tools) : []
    descriptors.push(...known)
    if (usable && known.length === 0) continue
    sources.push({
      kind: 'local', serverName: source.serverName, label: source.label, tools: [],
      descriptors: known.map(localDescriptor),
      resolve: resolveDynamic(source),
      ...(usable ? {} : {
        discover: discoverDynamic(source),
        summary: source.record.availability === 'unavailable'
          ? `${source.label}: unavailable at the last check; search for "${source.label}" to retry`
          : `${source.label}: tools not loaded yet; search for "${source.label}" to load them`,
      }),
    })
  }

  // Pinned callee: keep only the requested canonical or legacy names.
  let restrictedSearchToolNames: string[] | undefined
  let indexed = sources
  if (profile.restrictSearchToToolNames) {
    ({ sources: indexed, restrictedNames: restrictedSearchToolNames } = restrictSources(sources, profile.restrictSearchToToolNames))
  }

  const searchableSources = [...new Set(indexed.map((source) => source.label ?? officialName.get(source.serverName) ?? source.serverName))]
  return {
    profile,
    sources: indexed,
    searchOptions: { keepDynamicToolsDirect: profile.keepDynamicToolsDirect, exposeLocalReadTools: profile.exposeLocalReadTools },
    descriptors,
    direct: { descriptors: directDescriptors, tools: directTools },
    unavailable,
    searchableSources,
    admittedConnectorIds,
    admittedBindings,
    ...(restrictedSearchToolNames ? { restrictedSearchToolNames, unrestrictedSources: sources } : {}),
    ...(knowledgeCapturePrompt ? { knowledgeCapturePrompt } : {}),
    plan,
    activate: async (selection) => (await activateWithRecords(selection)).tools,
    resolveSuspendedDynamicTool,
  }
}

/**
 * Keep only the sources' tools named by `allow` (canonical, or the legacy
 * `mcp_<label>_<tool>` alias), and only names that identify one tool across
 * every source. An undiscovered source cannot prove a pinned name and stays
 * out. Returns the kept sources and the names that matched.
 */
export function restrictSources(sources: readonly LocalSource[], allowList: readonly string[]): { sources: LocalSource[]; restrictedNames: string[] } {
  const allow = new Set(allowList)
  const counts = new Map<string, number>()
  const namesOf = (source: LocalSource) => [...source.tools.map((tool) => tool.name), ...(source.descriptors ?? []).map((d) => d.name)]
  for (const source of sources) {
    for (const name of new Set(namesOf(source))) {
      for (const alias of new Set([name, legacyMcpToolName(source.label ?? source.serverName, name)])) counts.set(alias, (counts.get(alias) ?? 0) + 1)
    }
  }
  const restricted = new Set<string>()
  const keep = (source: LocalSource, name: string) => {
    const legacy = legacyMcpToolName(source.label ?? source.serverName, name)
    const canonical = allow.has(name) && counts.get(name) === 1
    const legacyMatch = allow.has(legacy) && counts.get(legacy) === 1
    if (canonical) restricted.add(name)
    if (legacyMatch) restricted.add(legacy)
    return canonical || legacyMatch
  }
  const kept = sources.flatMap((source) => {
    const tools = source.tools.filter((tool) => keep(source, tool.name))
    const descriptors = (source.descriptors ?? []).filter((descriptor) => !tools.some((tool) => tool.name === descriptor.name) && keep(source, descriptor.name))
    if (tools.length === 0 && descriptors.length === 0) return []
    const { discover: _discover, summary: _summary, ...rest } = source
    return [{ ...rest, tools, descriptors }]
  })
  return { sources: kept, restrictedNames: [...restricted] }
}
