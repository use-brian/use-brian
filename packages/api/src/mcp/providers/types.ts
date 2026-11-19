/**
 * Provider module contract (M3 WP2, capability routing).
 *
 * One module per connector family under `mcp/providers/`. A module answers two
 * questions and nothing else:
 *
 * - `describe()`: the family's tool descriptors, computed without credentials,
 *   network, child processes or per-tool policy reads. The catalog
 *   (`mcp/catalog.ts`, WP1) indexes these before the model runs.
 * - `activate(ctx, instances)`: build the family's executable `Tool[]` for the
 *   admitted instances. It returns tools instead of mutating a shared map;
 *   `mcp/activation.ts` owns policy, action-grant gating, health probes,
 *   instance variants, binding pins and the runtime-authority wrapper, and
 *   memoizes one activation promise per family per turn.
 *
 * Every port a provider may touch is on the activation context, captured once
 * per turn under the turn's original invocation (never a worker's).
 *
 * See docs/architecture/integrations/mcp.md → "Runtime" → "Provider modules".
 */
import type { CachedFile } from '@use-brian/core/files/types.js'
import type {
  KnowledgeRepoWriter,
  KnowledgeStoreInterface,
} from '@use-brian/core/knowledge/types.js'
import type { GDriveFilesStore } from '@use-brian/core/tools/base/gdrive-files.js'
import type { FilesApi } from '@use-brian/core/workspace-files/api.js'
import type { EngineHooks } from '@use-brian/agent-runtime/engine/hooks.js'
import type { McpSettingsStore } from '@use-brian/agent-runtime/mcp/types.js'
import type { AccessContext } from '@use-brian/agent-runtime/security/access-context.js'
import type { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import type { ExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import type {
  BuiltinToolClassification,
  BuiltinToolDefaultPolicy,
  BuiltinToolGroupId,
} from '@use-brian/shared'
import type { EmailInboxProvider } from '../../agentmail/provider.js'
import type { ConnectorActionAudit } from '../../connector-action-port.js'
import type { ConnectorContextBinding, ConnectorTurnGrant } from '../../context-scope/connector-exposure.js'
import type { AssistantConnectorGrantsStore } from '../../db/assistant-connector-grants-store.js'
import type { AssistantConnectorStore } from '../../db/assistant-connector-store.js'
import type { ConnectorGrantStore } from '../../db/connector-grant-store.js'
import type { ConnectorInstanceStore } from '../../db/connector-instance-store.js'
import type { ConnectorStore } from '../../db/connector-store.js'
import type { WorkspaceToolPolicyStore } from '../../db/workspace-tool-policy-store.js'
import type { ActorIdentity } from '../auth-headers.js'
import type { DescriptorRecord } from '../descriptors.js'

/** Connector families with one provider module each. */
export type ProviderFamily =
  | 'google'
  | 'github'
  | 'notion'
  | 'fathom'
  | 'shopify'
  | 'wordpress'
  | 'gsc'
  | 'msgraph'
  | 'mailbox'
  | 'agentmail'
  | 'remote-mcp'
  | 'cli'
  | 'knowledge'
  | 'google-maps'

export const PROVIDER_FAMILIES: readonly ProviderFamily[] = [
  'google', 'github', 'notion', 'fathom', 'shopify', 'wordpress', 'gsc', 'msgraph',
  'mailbox', 'agentmail', 'remote-mcp', 'cli', 'knowledge', 'google-maps',
]

/**
 * Where a descriptor's input schema comes from. Static families build their
 * schema in a core factory (`createGitHubTools` …) and are referenced by tool
 * name; `describe()` also carries the factory's JSON Schema (derived over inert
 * ports) so a search hit shows real parameters without an activation. Dynamic
 * families (remote MCP, CLI MCP) carry the discovered JSON Schema plus the
 * content-hash version the catalog computed for it.
 */
export type ToolInputSchemaRef =
  | { kind: 'static'; family: ProviderFamily; toolName: string; schema?: Record<string, unknown> }
  | { kind: 'json-schema'; schema: Record<string, unknown>; version?: string }

/** Catalog-time description of one tool. Never an execution grant. */
export type ToolDescriptor = {
  /** Canonical tool name as the model sees it (instance suffix included for variants). */
  name: string
  description: string
  family: ProviderFamily
  /** Governance connector id (`gcal`, `gmail`, `github`, custom connector id …). */
  connectorId: string
  classification: BuiltinToolClassification
  /**
   * Fallback policy before L1/L2 rows. Registry rows are `allow` or `ask`;
   * a discovered destructive tool defaults to `block` (classifier policy) and
   * says so instead of claiming `ask`.
   */
  defaultPolicy: BuiltinToolDefaultPolicy | 'block'
  /** Display group from `OFFICIAL_CONNECTOR_TOOLS`, when the connector uses groups. */
  group?: BuiltinToolGroupId
  /** Static confirmation flag before policy; policy may only make it stricter. */
  requiresConfirmation: boolean
  inputSchema: ToolInputSchemaRef
  /** `static`: built from code with no discovery. `dynamic`: from remote/CLI discovery. */
  origin: 'static' | 'dynamic'
}

/** Instance reference for multi-instance connectors (oldest = canonical names). */
export type ProviderInstanceRef = { instanceId: string; label: string }

/** Upload-cache reader threaded only on surfaces where a user can attach a file. */
export type ReadCachedFile = (id: string, ctx: AccessContext) => Promise<CachedFile | null>

/**
 * Captured authority for one turn. Built once by `mcp/activation.ts` from the
 * catalog-time runtime authority; providers pin what they bind and never
 * re-derive authority themselves.
 */
export interface ActivationAuthority {
  /** Original invocation the activation binds to. */
  readonly executionContext?: ExecutionContext
  /** Acting human for runtime-authority checks. */
  readonly runtimeActorId?: string
  /** Team owning the assistant; absent on personal assistants. */
  readonly assistantTeamId?: string | null
  /** Turn grant used to withhold unbounded or cross-scope connectors. */
  readonly contextScope?: ConnectorTurnGrant
  readonly scopeAccumulator?: ContextScopeAccumulator
  /** Exposure check: runtime authority, turn scope and `bindingMaximum`. */
  exposureAllowed(binding: ConnectorContextBinding): boolean
  /** Pin an instance or grant binding against its catalog-time fingerprint. */
  pinBinding(binding: ConnectorContextBinding): void
  /** Pin the auth headers resolved for an instance. */
  pinAuth(instanceId: string, headers: Record<string, string>): void
  /** Re-check every pin; throws `AuthorityChangedError` on any change. */
  assertBindingsCurrent(mayHaveExecuted?: boolean): Promise<void>
}

/** Stores a provider may read. All reads happen inside `activate`, never `describe`. */
export type ProviderStores = {
  connectorStore: ConnectorStore
  settingsStore: McpSettingsStore
  assistantConnectorStore?: AssistantConnectorStore
  connectorGrantStore?: ConnectorGrantStore
  connectorInstanceStore?: ConnectorInstanceStore
  workspaceToolPolicyStore?: WorkspaceToolPolicyStore
  assistantConnectorGrantsStore?: AssistantConnectorGrantsStore
  gdriveFilesStore?: GDriveFilesStore
  knowledgeStore?: KnowledgeStoreInterface
  knowledgeRepoWriter?: KnowledgeRepoWriter
}

/** Attachment ports, passed only on chat and channel turns today. */
export type ProviderAttachmentPorts = {
  filesApi?: FilesApi
  readCachedFile?: ReadCachedFile
}

/** Hosted-edition ports. The open build leaves them unset. */
export type ProviderHostedPorts = {
  engineHooks?: EngineHooks
  connectorActionAudit?: ConnectorActionAudit
  emailInboxProvider?: EmailInboxProvider | null
  /** Resolved actor; carries the media token for `sendMediaToken` connectors. */
  actorIdentity?: ActorIdentity
  /** Shortcut to `actorIdentity.mediaToken`. */
  mediaToken?: string
}

/** Everything a provider may use during `activate`. Captured once per turn. */
export type ProviderActivationContext = {
  userId: string
  assistantId: string
  assistantTeamId?: string | null
  userTimezone?: string
  workspaceDomain?: string | null
  authority: ActivationAuthority
  stores: ProviderStores
  attachments: ProviderAttachmentPorts
  hosted: ProviderHostedPorts
  /**
   * Turn-level unavailable sink. Providers append honest "not connected" /
   * "reconnect" notices here; the catalog renders them once.
   */
  unavailable: string[]
  /**
   * Turn-level confirmation enrichers, in lane order (Google Calendar previews
   * fetch the event an update or delete will change). The composition runs the
   * last one, the winning lane's, inside the turn authority.
   */
  confirmationEnrichers?: Array<(toolName: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>>
}

/**
 * A family activation that discovered descriptors on the way. Dynamic
 * families (remote MCP, CLI MCP) record every discovery in the descriptor
 * lifecycle and also return the records, because a protected source is never
 * stored there and its record must still reach the catalog's version check.
 */
export type ProviderActivationResult = {
  tools: Tool[]
  records?: readonly DescriptorRecord[]
  /**
   * Each dynamic source's own adapters, keyed by its stable source identity
   * (`connector:<instanceId>`). A lazy catalog entry resolves from its own
   * source even when two sources share a label and tool names, so no
   * cross-source alias is unique.
   */
  sourceTools?: Readonly<Record<string, readonly Tool[]>>
}

/**
 * One connector family. `Instances` is the family's admitted-instance input,
 * built by the composition's lane builder (`mcp/composition.ts`) from the
 * catalog's single exposure-gated listing.
 */
export interface ProviderModule<Instances = unknown> {
  readonly family: ProviderFamily
  describe(): ToolDescriptor[]
  activate(ctx: ProviderActivationContext, instances: Instances): Promise<Tool[] | ProviderActivationResult>
}
