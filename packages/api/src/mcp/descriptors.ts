/**
 * Descriptor records and their lifecycle for the capability catalog (M3 WP1).
 *
 * A descriptor record says what one source can do without building it:
 * static native records come from `OFFICIAL_CONNECTOR_TOOLS` (or a provider
 * module's `describe()`), dynamic records (custom remote MCP, CLI MCP) come
 * only from discovery. Every record carries `version = sha256(normalized
 * tools)`, `discoveredAt` and an availability:
 *
 * - `fresh`: static, or discovered under the current binding key within TTL;
 * - `stale`: TTL expired or the binding key changed; still advertised from the
 *   last record, re-discovered at activation, refused on a version change;
 * - `undiscovered`: never discovered, invalidated, or protected;
 * - `unavailable`: the last discovery failed or the source was disconnected.
 *
 * A protected source (behind the connector source runtime) is never
 * positively cached: recording it stores nothing and it always reads as
 * `undiscovered`, so a permission-bearing catalog cannot outlive its grant.
 *
 * [COMP:api/mcp-catalog]
 * See docs/architecture/integrations/mcp.md → "Discovery cache".
 */
import { createHash } from 'node:crypto'
import { classifyTool, defaultPolicy } from '@use-brian/agent-runtime/mcp/classifier.js'
import { OFFICIAL_CONNECTOR_TOOLS } from '@use-brian/shared'
import type { ProviderFamily, ProviderModule, ToolDescriptor } from './providers/types.js'

export type DescriptorAvailability = 'fresh' | 'stale' | 'undiscovered' | 'unavailable'

export type DescriptorRecord = {
  /** `native:<connectorId>`, `remote:<instanceId>` or `cli:<instanceId>`. */
  sourceKey: string
  family: ProviderFamily
  connectorId: string
  origin: 'static' | 'dynamic'
  tools: readonly ToolDescriptor[]
  /** Null while nothing is known about the source's tools. */
  version: string | null
  /** Null for static records and undiscovered sources. */
  discoveredAt: Date | null
  availability: DescriptorAvailability
  /** Honest reason for `unavailable`. */
  reason?: string
}

/** Identity and binding of one dynamic source, as known at catalog time. */
export type DynamicSourceRef = {
  sourceKey: string
  family: Extract<ProviderFamily, 'remote-mcp' | 'cli'>
  connectorId: string
  /**
   * Everything a discovery depends on (URL, `updatedAt`, binding fingerprint).
   * A record discovered under another key reads as `stale`.
   */
  bindingKey: string
  /** Behind the protected connector source runtime: never positively cached. */
  protected?: boolean
}

export type DescriptorLifecycle = {
  /** Current record for a source. Never discovers, never mutates. */
  read(ref: DynamicSourceRef): DescriptorRecord
  /** Record a discovery result. Returns the record and whether the version changed. */
  record(ref: DynamicSourceRef, tools: readonly ToolDescriptor[]): {
    record: DescriptorRecord
    previousVersion: string | null
    changed: boolean
    stored: boolean
  }
  /** The last discovery failed or the source was disconnected. */
  markUnavailable(ref: Pick<DynamicSourceRef, 'sourceKey' | 'family' | 'connectorId'>, reason: string): void
  /** Forget a source (for example after an edit); it reads `undiscovered` until rediscovered. */
  invalidate(sourceKey: string): void
  /** True when `version` is the version currently recorded for the source. */
  isCurrent(sourceKey: string, version: string): boolean
  size(): number
}

export const DESCRIPTOR_TTL_MS = 5 * 60 * 1000
const DESCRIPTOR_MAX_ENTRIES = 1000

/** Discovery timeout for one remote or CLI MCP server (activation-time discovery). */
export const DISCOVERY_TIMEOUT_MS = 8_000

// ── Normalization and version ────────────────────────────────

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
  }
  return value
}

/** Order-independent, version-free view of a tool list (the hash input). */
export function normalizeDescriptorTools(tools: readonly ToolDescriptor[]): unknown[] {
  return [...tools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => canonical({
      name: tool.name,
      description: tool.description,
      classification: tool.classification,
      defaultPolicy: tool.defaultPolicy,
      requiresConfirmation: tool.requiresConfirmation,
      inputSchema: tool.inputSchema.kind === 'json-schema'
        ? { kind: 'json-schema', schema: tool.inputSchema.schema }
        : { kind: 'static', family: tool.inputSchema.family, toolName: tool.inputSchema.toolName },
    }))
}

export function descriptorVersion(tools: readonly ToolDescriptor[]): string {
  return createHash('sha256').update(JSON.stringify(normalizeDescriptorTools(tools))).digest('hex')
}

// ── Static native descriptors ────────────────────────────────

/**
 * Registry connector id → provider family, where the two differ. Every other
 * registry connector whose id is itself a family maps to that family.
 */
const FAMILY_ALIASES: Readonly<Record<string, ProviderFamily>> = {
  gcal: 'google',
  gmail: 'google',
  gdrive: 'google',
  imap: 'mailbox',
}

const NATIVE_FAMILIES: ReadonlySet<ProviderFamily> = new Set<ProviderFamily>([
  'google', 'github', 'notion', 'fathom', 'shopify', 'wordpress', 'gsc', 'msgraph', 'mailbox', 'agentmail',
])

/** Family that activates a registry connector, or null for primitives and tool-less bindings. */
export function nativeFamilyForConnector(connectorId: string): ProviderFamily | null {
  const family = FAMILY_ALIASES[connectorId] ?? connectorId
  return NATIVE_FAMILIES.has(family as ProviderFamily) && (OFFICIAL_CONNECTOR_TOOLS[connectorId]?.length ?? 0) > 0
    ? family as ProviderFamily
    : null
}

function registryDescriptors(connectorId: string, family: ProviderFamily): ToolDescriptor[] {
  return (OFFICIAL_CONNECTOR_TOOLS[connectorId] ?? []).map((row) => ({
    name: row.name,
    description: row.description,
    family,
    connectorId,
    classification: row.classification,
    defaultPolicy: row.defaultPolicy,
    ...(row.group ? { group: row.group } : {}),
    requiresConfirmation: row.defaultPolicy === 'ask',
    inputSchema: { kind: 'static', family, toolName: row.name },
    origin: 'static',
  }))
}

let registryRecords: DescriptorRecord[] | undefined
const providerRecords = new WeakMap<readonly Pick<ProviderModule, 'family' | 'describe'>[], DescriptorRecord[]>()

/**
 * One fresh record per native registry connector. A provider module's
 * `describe()` replaces the registry rows for its family's connectors.
 */
export function staticNativeDescriptorRecords(providers: readonly Pick<ProviderModule, 'family' | 'describe'>[] = []): DescriptorRecord[] {
  if (providers.length === 0 && registryRecords) return registryRecords
  const memoized = providers.length > 0 ? providerRecords.get(providers) : undefined
  if (memoized) return memoized
  const described = new Map<ProviderFamily, ToolDescriptor[]>()
  for (const provider of providers) described.set(provider.family, provider.describe())
  const records: DescriptorRecord[] = []
  for (const connectorId of Object.keys(OFFICIAL_CONNECTOR_TOOLS)) {
    const family = nativeFamilyForConnector(connectorId)
    if (!family) continue
    const tools = described.has(family)
      ? described.get(family)!.filter((tool) => tool.connectorId === connectorId)
      : registryDescriptors(connectorId, family)
    records.push({
      sourceKey: `native:${connectorId}`,
      family,
      connectorId,
      origin: 'static',
      tools,
      version: descriptorVersion(tools),
      discoveredAt: null,
      availability: 'fresh',
    })
  }
  if (providers.length === 0) registryRecords = records
  else providerRecords.set(providers, records)
  return records
}

// ── Dynamic descriptors ──────────────────────────────────────

/**
 * Descriptors for discovered MCP tools. Classification uses the same keyword
 * classifier the remote dispatcher applies; an unknown verb fails closed.
 */
export function dynamicToolDescriptors(input: {
  family: DynamicSourceRef['family']
  connectorId: string
  tools: ReadonlyArray<{ name: string; description: string; inputSchema?: Record<string, unknown> }>
}): ToolDescriptor[] {
  return input.tools.map((tool) => {
    const classified = classifyTool(tool.name, tool.description)
    const classification = classified === 'unknown' ? 'write' : classified
    // Classifier policy: read allows, write and unknown ask, destructive blocks.
    const fallback = defaultPolicy(classified)
    return {
      name: tool.name,
      description: tool.description,
      family: input.family,
      connectorId: input.connectorId,
      classification,
      defaultPolicy: fallback,
      requiresConfirmation: fallback !== 'allow',
      inputSchema: { kind: 'json-schema', schema: tool.inputSchema ?? { type: 'object' } },
      origin: 'dynamic',
    }
  })
}

type StoredRecord = {
  family: DynamicSourceRef['family']
  connectorId: string
  tools: readonly ToolDescriptor[]
  version: string | null
  discoveredAt: Date | null
  bindingKey: string | null
  reason?: string
}

export function createDescriptorLifecycle(options: {
  ttlMs?: number
  maxEntries?: number
  now?: () => number
} = {}): DescriptorLifecycle {
  const ttlMs = options.ttlMs ?? DESCRIPTOR_TTL_MS
  const maxEntries = options.maxEntries ?? DESCRIPTOR_MAX_ENTRIES
  const now = options.now ?? Date.now
  const records = new Map<string, StoredRecord>()

  function store(sourceKey: string, value: StoredRecord) {
    records.delete(sourceKey)
    records.set(sourceKey, value)
    while (records.size > maxEntries) records.delete(records.keys().next().value!)
  }

  function undiscovered(ref: Pick<DynamicSourceRef, 'sourceKey' | 'family' | 'connectorId'>): DescriptorRecord {
    return { sourceKey: ref.sourceKey, family: ref.family, connectorId: ref.connectorId, origin: 'dynamic',
      tools: [], version: null, discoveredAt: null, availability: 'undiscovered' }
  }

  return {
    read(ref) {
      const stored = ref.protected ? undefined : records.get(ref.sourceKey)
      if (!stored) return undiscovered(ref)
      const base = { sourceKey: ref.sourceKey, family: stored.family, connectorId: stored.connectorId, origin: 'dynamic' as const }
      if (stored.reason !== undefined) {
        return { ...base, tools: [], version: null, discoveredAt: stored.discoveredAt, availability: 'unavailable', reason: stored.reason }
      }
      const expired = stored.discoveredAt === null || now() - stored.discoveredAt.getTime() > ttlMs
      return { ...base, tools: stored.tools, version: stored.version, discoveredAt: stored.discoveredAt,
        availability: expired || stored.bindingKey !== ref.bindingKey ? 'stale' : 'fresh' }
    },

    record(ref, tools) {
      const previous = records.get(ref.sourceKey)
      const previousVersion = previous?.version ?? null
      const version = descriptorVersion(tools)
      const discoveredAt = new Date(now())
      const record: DescriptorRecord = { sourceKey: ref.sourceKey, family: ref.family, connectorId: ref.connectorId,
        origin: 'dynamic', tools, version, discoveredAt, availability: 'fresh' }
      if (ref.protected) {
        // Never positively cache a permission-bearing catalog.
        records.delete(ref.sourceKey)
        return { record, previousVersion, changed: previousVersion !== null && previousVersion !== version, stored: false }
      }
      store(ref.sourceKey, { family: ref.family, connectorId: ref.connectorId, tools, version, discoveredAt, bindingKey: ref.bindingKey })
      return { record, previousVersion, changed: previousVersion !== null && previousVersion !== version, stored: true }
    },

    markUnavailable(ref, reason) {
      store(ref.sourceKey, { family: ref.family, connectorId: ref.connectorId, tools: [], version: null,
        discoveredAt: new Date(now()), bindingKey: null, reason })
    },

    invalidate(sourceKey) {
      records.delete(sourceKey)
    },

    isCurrent(sourceKey, version) {
      return records.get(sourceKey)?.version === version
    },

    size() {
      return records.size
    },
  }
}

let shared: DescriptorLifecycle | undefined

/** Process-wide lifecycle shared by the catalog, activation and connector lifecycle. */
export function getSharedDescriptorLifecycle(): DescriptorLifecycle {
  shared ??= createDescriptorLifecycle()
  return shared
}

/**
 * Memory metric: records held by the shared lifecycle (the activation-time
 * discovery cache since M3 WP3; hosted `apps/api` reports it).
 */
export function descriptorLifecycleSize(): number {
  return shared?.size() ?? 0
}

/**
 * What a dynamic tool list depends on: endpoint, last credential/URL edit and,
 * for a source that receives the actor's identity or media-token headers, the
 * actor. The catalog reads and activation records under this same key, so a
 * record discovered for one actor never reads `fresh` for another.
 */
export function dynamicSourceBindingKey(source: {
  url: string | null
  updatedAt: Date | null
  config?: Record<string, unknown> | null
}, actorId?: string | null): string {
  const actorBound = source.config?.sendActorIdentity === true || source.config?.sendMediaToken === true
  return createHash('sha256').update(JSON.stringify([source.url, source.updatedAt?.getTime() ?? 0,
    actorBound ? actorId ?? null : null])).digest('hex')
}

export function remoteDescriptorSourceKey(instanceId: string): string {
  return `remote:${instanceId}`
}

export function cliDescriptorSourceKey(instanceId: string): string {
  return `cli:${instanceId}`
}
