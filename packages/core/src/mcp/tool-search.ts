import {inheritRoutineCalendarRead,assertRoutineCalendarAdapterCurrent} from '../engine/routine-read-ownership.js'
import { missingToolCapability } from '@use-brian/agent-runtime/tools/capability-gate.js'
/**
 * MCP tool search — Pattern E adapted for Gemini.
 *
 * Instead of N gateway tools (one per connector), the entire MCP surface
 * is exposed via exactly 2 tools:
 *
 *   mcp_search  — keyword search across all connectors' tools
 *   mcp_call    — proxy a call to any discovered tool
 *
 * A progressive-discovery pattern adapted for Gemini, which lacks native
 * tool_reference blocks.
 *
 * Token cost: ~300 tokens (2 tool definitions) regardless of connector count.
 *
 * **Two kinds of sources feed the index** (PR #4 of token-cost reduction):
 *   - **Remote** — a discovered MCP server reachable over HTTP. `mcp_call`
 *     dispatches via the injected `callMcpTool(serverUrl, toolName, input)`.
 *   - **Local** — first-party connector tools (Google / GitHub / Notion /
 *     Fathom / KB). The `Tool` object travels intact through the index so
 *     `mcp_call` can fire its `requiresConfirmation` / `resolveConfirmation`
 *     / `describeConfirmation` hooks and the unified-approvals flow with the
 *     **canonical underlying tool name** (not "mcp_call"). Path B durability
 *     is preserved via `context.onInnerAwaitingApproval`.
 *
 * See docs/architecture/integrations/mcp.md.
 */

import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { buildTool, type Tool } from '@use-brian/agent-runtime/tools/types.js'
import { classifyTool, defaultPolicy } from '@use-brian/agent-runtime/mcp/classifier.js'
import { mcpResultToToolResult } from './tool-result.js'
import { jsonSchemaFromZod } from '@use-brian/agent-runtime/engine/query-loop.js'
import { createMcpInputSchema, getMcpInputJsonSchema, mcpArgumentError } from '@use-brian/agent-runtime/mcp/input-schema.js'
import { declinedToolResult, timedOutToolResult, blockedThisTurnToolResult, policyBlockedToolResult, alwaysDeniedToolResult } from '@use-brian/agent-runtime/engine/decline-copy.js'
import { describeMcpToolError } from './errors.js'
import type { EngineHooks, PreToolUseDirective } from '@use-brian/agent-runtime/engine/hooks.js'
import type { McpSettingsStore, McpServerConfig, McpToolInfo } from '@use-brian/agent-runtime/mcp/types.js'

// Host-only identity survives the shallow wrappers used by injection/workers.
// A same-named first-party tool is not an adapter for this indexed source.
const DIRECT_MCP_ENTRY = Symbol('directMcpEntry')

// ── Source types ──────────────────────────────────────────────

/**
 * Remote source — a discovered MCP server. `mcp_call` dispatches via
 * `callMcpTool(serverUrl, toolName, input)` and applies the classifier-
 * based policy gate (L1 + L2) since we have no first-party metadata on
 * unknown tools.
 */
export type RemoteSource = {
  kind: 'remote'
  server: McpServerConfig
  serverUrl: string
  /** Stable host-selected identity, separate from the human label. */
  sourceId?: string
  callMcpTool: (serverUrl: string, toolName: string, input: Record<string, unknown>, headerOverrides?: Record<string, string>) => Promise<unknown>
  /** Source-specific policy authority for workspace-owned/granted connectors. */
  policy?: {
    settingsStore: McpSettingsStore
    userId: string
    serverName?: string
    appLevelAssistantId?: string
  }
}

/**
 * Local source — first-party tools whose `Tool` objects carry their own
 * `requiresConfirmation` / `resolveConfirmation` / `describeConfirmation`
 * / `allowPersistentApproval` / capability-grant wrappers. `mcp_call`
 * defers to those hooks instead of the classifier-based policy gate, and
 * fires the unified `pending_approvals` + `session_resume_points` flow
 * with the **canonical underlying tool name**.
 *
 * `serverName` is the connector grouping (e.g. 'google', 'github',
 * 'notion', 'fathom', 'knowledge') — the model uses it as `server` in
 * `mcp_call({server, tool, args})`.
 */
export type LocalSource = {
  kind: 'local'
  serverName: string
  tools: Tool[]
  /**
   * Lazy entries: descriptor-only tools whose `Tool` is built on demand by
   * `resolve`. A descriptor whose name matches an eager `tools` entry is
   * ignored. See docs/architecture/integrations/mcp.md -> "Capability catalog".
   */
  descriptors?: LocalToolDescriptor[]
  /**
   * Build (activate) one tool by canonical name. Awaited before local
   * dispatch, before a direct adapter's confirmation hook and before an
   * interactive read adapter runs. A plain `Tool` is a ready resolution; a
   * resolution whose `version` differs from the indexed descriptor is stale.
   */
  resolve?: (toolName: string) => Promise<Tool | LocalToolResolution | null | undefined>
  /**
   * Undiscovered dynamic source: advertised by name only and discovered when
   * an `mcp_search` query names it. Returns the discovered descriptors.
   */
  discover?: () => Promise<LocalToolDescriptor[]>
  /** Human label shown beside a stable `serverName` identity. */
  label?: string
  /** Source summary for the search description; derived from names when absent. */
  summary?: string
}

/** Catalog-time description of one lazily built local tool. Never an execution grant. */
export type LocalToolDescriptor = {
  name: string
  description: string
  /** JSON Schema for search display and lazy adapters. Absent: shown once resolved. */
  inputSchema?: Record<string, unknown>
  /** Show the full discovered JSON Schema line in search results (dynamic sources). */
  externalInputSchema?: boolean
  isReadOnly?: boolean
  /** Static confirmation flag before activation. Defaults to true unless read-only. */
  requiresConfirmation?: boolean
  allowPersistentApproval?: boolean
  requiresCapability?: string
  hiddenFromModel?: boolean
  /** Content-hash descriptor version; a resolution with another version is stale. */
  version?: string
}

export type LocalToolResolution =
  /** `descriptor` (optional) supplies clean search metadata if the version changed. */
  | { status: 'ready'; tool: Tool; version?: string; descriptor?: LocalToolDescriptor }
  /** The descriptor changed. `tool`/`descriptor` (when known) replace the indexed schema. */
  | { status: 'stale'; tool?: Tool; descriptor?: LocalToolDescriptor; version?: string }
  | { status: 'unavailable'; reason?: string }

export type ToolSource = RemoteSource | LocalSource

// Opaque short id for a pending confirmation. Must stay short enough that
// `mcp_confirm:<id>:always_allow` fits in Telegram's 64-byte callback_data
// cap (16 hex chars → 41 bytes total, comfortably under). 64-bit entropy is
// enough — the id only needs to be unique among in-flight confirmations.
function mintConfirmId(): string {
  return randomBytes(8).toString('hex')
}

// ── Search index ──────────────────────────────────────────────

type IndexedToolBase = {
  /** Connector grouping name — `server` in `mcp_call` invocations. */
  server: string
  /** Canonical tool name as the model sees it after a `mcp_search` hit. */
  toolName: string
  description: string
  /** JSON-Schema shape used by the search result formatter. */
  inputSchema: Record<string, unknown>
  /** Lowercased tokens from name + description for matching. */
  tokens: string[]
}

type RemoteIndexedTool = IndexedToolBase & {
  kind: 'remote'
  argumentSchema: ReturnType<typeof createMcpInputSchema>
  serverUrl: string
  /** Host-only exact-source transport. Never serialize this into search/model output. */
  dispatch: RemoteSource['callMcpTool']
  displayName?: string
  /** Original MCP metadata (kept for any code that legacy-typed on `.tool`). */
  toolInfo: McpToolInfo
  policy?: RemoteSource['policy']
}

type LocalIndexedTool = IndexedToolBase & {
  kind: 'local'
  /**
   * The actual `Tool` object — execute, hooks, capability wrappers all intact.
   * For a lazy entry this is a descriptor placeholder used only for search
   * metadata and adapter flags; dispatch always runs the resolved tool.
   */
  tool: Tool
  label?: string
  lazy?: LazyLocalState
}

type LocalResolutionOutcome =
  | { status: 'ready'; tool: Tool }
  | { status: 'stale' }
  | { status: 'unavailable'; reason?: string }

type LazyLocalState = {
  resolve: NonNullable<LocalSource['resolve']>
  version?: string
  externalSchema: boolean
  /** False until a descriptor or resolved tool supplied a parameter schema. */
  schemaKnown: boolean
  pending?: Promise<LocalToolResolution>
  resolved?: Tool
}

type UndiscoveredSource = {
  server: string
  label?: string
  discover: NonNullable<LocalSource['discover']>
  resolve?: LocalSource['resolve']
  terms: string[]
  pending?: Promise<LocalToolDescriptor[] | null>
}

type IndexedTool = RemoteIndexedTool | LocalIndexedTool

export type McpToolIndex = {
  entries: IndexedTool[]
  /** Server name → connector summary (for the search tool description) */
  serverSummaries: Map<string, string>
  /** Dynamic sources advertised by name and discovered when a search names them. */
  undiscovered?: UndiscoveredSource[]
}

/** Tokenize a tool name + description for the keyword search index. */
function tokenize(name: string, description: string): string[] {
  const nameTokens = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/)
  const descTokens = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((t) => t.length > 2) // drop short words
  return [...new Set([...nameTokens, ...descTokens])]
}

/**
 * Build a searchable index from a mix of remote MCP servers and local
 * first-party tool sources. Called once per request after all sources
 * are resolved.
 */
export function buildToolIndex(sources: ToolSource[]): McpToolIndex {
  const entries: IndexedTool[] = []
  const serverSummaries = new Map<string, string>()
  const sourceIds = new Set<string>()
  let undiscovered: UndiscoveredSource[] | undefined

  for (const source of sources) {
    if (source.kind === 'remote') {
      const { server } = source
      const identity = source.sourceId ?? server.name
      if (!identity || identity.length > 256) throw new Error('Invalid remote source identity')
      if (source.sourceId && sourceIds.has(source.sourceId)) throw new Error('Duplicate remote source identity')
      if (source.sourceId) sourceIds.add(source.sourceId)
      serverSummaries.set(identity, `${source.sourceId ? `${server.name}: ` : ''}${summarizeCapabilities(server.tools.map((t) => t.name))}`)

      for (const tool of server.tools) {
        entries.push({
          kind: 'remote',
          argumentSchema: createMcpInputSchema(tool.inputSchema ?? {}),
          server: identity,
          ...(source.sourceId ? { displayName: server.name } : {}),
          serverUrl: source.serverUrl,
          dispatch: source.callMcpTool,
          toolName: tool.name,
          description: tool.description,
          inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
          toolInfo: tool,
          policy: source.policy,
          tokens: tokenize(tool.name, tool.description),
        })
      }
      continue
    }

    // Local source
    const eagerNames = new Set(source.tools.map((t) => t.name))
    const descriptors = source.resolve
      ? (source.descriptors ?? []).filter((descriptor) => !eagerNames.has(descriptor.name))
      : []
    if (source.discover && source.resolve && source.tools.length === 0 && descriptors.length === 0) {
      const label = source.label ?? source.serverName
      serverSummaries.set(source.serverName, source.summary
        ?? `${label}: tools not loaded yet; search for "${label}" to load them`)
      ;(undiscovered ??= []).push({
        server: source.serverName,
        label: source.label,
        discover: source.discover,
        resolve: source.resolve,
        terms: [...new Set([source.serverName, label].map((name) => name.toLowerCase().trim()).filter((name) => name.length > 2))],
      })
      continue
    }
    serverSummaries.set(source.serverName, source.summary
      ?? summarizeCapabilities([...source.tools.map((t) => t.name), ...descriptors.map((d) => d.name)]))

    for (const descriptor of descriptors) {
      entries.push(lazyLocalEntry(source.serverName, source.label, descriptor, source.resolve!))
    }

    for (const tool of source.tools) {
      // Derive JSON-Schema shape for the search result preview. Zod inputs
      // run through the in-tree converter (same one Gemini sees for direct-
      // injected tools, so the model's mental model is uniform across the
      // search pattern and the legacy direct-injection path).
      const inputSchema = tool.inputSchema?._def
        ? (jsonSchemaFromZod(tool.inputSchema) as unknown as Record<string, unknown>)
        : {}

      entries.push({
        kind: 'local',
        server: source.serverName,
        ...(source.label ? { label: source.label } : {}),
        toolName: tool.name,
        description: tool.description,
        inputSchema,
        tool,
        tokens: tokenize(tool.name, tool.description),
      })
    }
  }

  return { entries, serverSummaries, ...(undiscovered ? { undiscovered } : {}) }
}

/** Metadata-only stand-in for a lazy entry. Its execute never runs a capability. */
function descriptorPlaceholder(descriptor: LocalToolDescriptor): Tool {
  const readOnly = descriptor.isReadOnly === true
  return buildTool({
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: createMcpInputSchema(descriptor.inputSchema ?? { type: 'object' }),
    isReadOnly: readOnly,
    isConcurrencySafe: readOnly,
    requiresConfirmation: descriptor.requiresConfirmation ?? !readOnly,
    ...(descriptor.allowPersistentApproval !== undefined ? { allowPersistentApproval: descriptor.allowPersistentApproval } : {}),
    ...(descriptor.requiresCapability ? { requiresCapability: descriptor.requiresCapability } : {}),
    ...(descriptor.hiddenFromModel ? { hiddenFromModel: true } : {}),
    async execute() {
      return { data: `ERROR: "${descriptor.name}" has not been activated. Call it through mcp_call.`, isError: true }
    },
  })
}

function lazyLocalEntry(
  server: string,
  label: string | undefined,
  descriptor: LocalToolDescriptor,
  resolve: NonNullable<LocalSource['resolve']>,
): LocalIndexedTool {
  return {
    kind: 'local',
    server,
    ...(label ? { label } : {}),
    toolName: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema ?? {},
    tool: descriptorPlaceholder(descriptor),
    tokens: tokenize(descriptor.name, descriptor.description),
    lazy: {
      resolve,
      ...(descriptor.version !== undefined ? { version: descriptor.version } : {}),
      externalSchema: descriptor.externalInputSchema === true,
      schemaKnown: descriptor.inputSchema !== undefined,
    },
  }
}

function toolJsonSchema(tool: Tool): Record<string, unknown> {
  return tool.inputSchema?._def
    ? (jsonSchemaFromZod(tool.inputSchema) as unknown as Record<string, unknown>)
    : {}
}

/** Replace a lazy entry's indexed metadata with the current tool or descriptor. */
function refreshLazyMetadata(entry: LocalIndexedTool, current: Tool | LocalToolDescriptor): void {
  const lazy = entry.lazy!
  const isTool = typeof (current as Tool).execute === 'function'
  const schema = isTool ? toolJsonSchema(current as Tool) : (current as LocalToolDescriptor).inputSchema
  entry.description = current.description
  entry.tokens = tokenize(entry.toolName, current.description)
  if (schema !== undefined) {
    entry.inputSchema = schema
    lazy.schemaKnown = true
  }
  const tool = current as Tool
  entry.tool = descriptorPlaceholder(isTool
    ? {
        name: entry.toolName, description: tool.description, inputSchema: schema,
        isReadOnly: tool.isReadOnly, requiresConfirmation: tool.requiresConfirmation,
        allowPersistentApproval: tool.allowPersistentApproval, requiresCapability: tool.requiresCapability,
        hiddenFromModel: tool.hiddenFromModel,
      }
    : { ...(current as LocalToolDescriptor), name: entry.toolName })
}

function normalizeResolution(value: Tool | LocalToolResolution | null | undefined): LocalToolResolution {
  if (!value) return { status: 'unavailable' }
  if (typeof (value as { execute?: unknown }).execute === 'function') return { status: 'ready', tool: value as Tool }
  return value as LocalToolResolution
}

/**
 * Resolve a lazy entry once per index. `expectedVersion` is the version an
 * adapter was built against; a newer indexed version refuses that adapter.
 * Resolver failures propagate (authority changes must stay typed).
 */
async function resolveLocalEntry(entry: LocalIndexedTool, expectedVersion?: string): Promise<LocalResolutionOutcome> {
  const lazy = entry.lazy
  if (!lazy) return { status: 'ready', tool: entry.tool }
  const current = (): LocalResolutionOutcome => expectedVersion !== undefined && expectedVersion !== lazy.version
    ? { status: 'stale' }
    : { status: 'ready', tool: lazy.resolved! }
  if (lazy.resolved) return current()
  const pending = lazy.pending ??= lazy.resolve(entry.toolName).then(normalizeResolution)
  let resolution: LocalToolResolution
  try {
    resolution = await pending
  } catch (error) {
    if (lazy.pending === pending) lazy.pending = undefined
    throw error
  }
  if (lazy.resolved) return current()
  if (resolution.status === 'unavailable') {
    return { status: 'unavailable', ...(resolution.reason ? { reason: resolution.reason } : {}) }
  }
  if (resolution.status === 'ready') {
    const changed = resolution.version !== undefined && lazy.version !== undefined && resolution.version !== lazy.version
    if (resolution.version !== undefined) lazy.version = resolution.version
    lazy.resolved = resolution.tool
    if (changed || !lazy.schemaKnown) refreshLazyMetadata(entry, resolution.descriptor ?? resolution.tool)
    return changed ? { status: 'stale' } : current()
  }
  // Explicit stale: adopt the current metadata and resolve again on the next call.
  if (resolution.version !== undefined) lazy.version = resolution.version
  const replacement = resolution.tool ?? resolution.descriptor
  if (replacement) refreshLazyMetadata(entry, replacement)
  if (lazy.pending === pending) lazy.pending = undefined
  return { status: 'stale' }
}

function staleToolResult(server: string, tool: string): string {
  return `ERROR: "${tool}" on "${server}" changed since it was found, so it was NOT executed. Search again with mcp_search to get its current parameters, then retry.`
}

function unavailableToolResult(tool: string, reason?: string): string {
  return `ERROR: "${tool}" could not be prepared for this turn${reason ? ` (${reason})` : ''}, so it was NOT executed. Search again with mcp_search; if it is no longer listed, it is not available to this assistant right now.`
}

/**
 * Simple term-matching search. Scores each tool by how many query terms
 * appear in its token set. Name matches are weighted 2x over description.
 */
function searchIndex(
  index: McpToolIndex,
  query: string,
  limit: number = 8,
  include: (entry: IndexedTool) => boolean = () => true,
): IndexedTool[] {
  const entries = index.entries.filter(include)
  const queryTerms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((t) => t.length > 1)

  if (queryTerms.length === 0) {
    // Empty query — return a sample from each server
    const seen = new Set<string>()
    const results: IndexedTool[] = []
    for (const entry of entries) {
      if (!seen.has(entry.server)) {
        seen.add(entry.server)
        results.push(...entries.filter((e) => e.server === entry.server).slice(0, 3))
      }
      if (results.length >= limit) break
    }
    return results.slice(0, limit)
  }

  const scored = entries.map((entry) => {
    let score = 0
    const nameStr = entry.toolName.toLowerCase().replace(/_/g, ' ')
    const descStr = entry.description.toLowerCase()

    for (const term of queryTerms) {
      // Name match: 3 points (exact substring match)
      if (nameStr.includes(term)) score += 3
      // Description match: 1 point
      else if (descStr.includes(term)) score += 1
      // Token overlap: 0.5 points
      else if (entry.tokens.some((t) => t.includes(term) || term.includes(t))) score += 0.5
    }
    return { entry, score }
  })

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.entry)
}

/** Summarize a connector's capabilities by grouping tool names into verb categories. */
function summarizeCapabilities(toolNames: string[]): string {
  const groups = new Map<string, string[]>()
  for (const name of toolNames) {
    // Take the leading lowercase prefix as the verb (works for both
    // snake_case `search_repositories` and camelCase `googleCalendarCreateEvent`).
    const verb = name.split(/[_A-Z]/)[0]?.toLowerCase() || 'other'
    const existing = groups.get(verb) ?? []
    existing.push(name)
    groups.set(verb, existing)
  }

  const parts: string[] = []
  for (const [verb, names] of groups) {
    if (names.length <= 3) {
      parts.push(names.join(', '))
    } else {
      parts.push(`${verb}_* (${names.length} tools)`)
    }
  }
  return parts.join(', ')
}

/** Format a tool entry for the search result (includes schema). */
function compactSchemaType(definition: Record<string, unknown>, depth = 0): string {
  const enumValues = definition.enum
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return enumValues.map((value) => JSON.stringify(value)).join(' | ')
  }

  if (definition.type === 'array') {
    const items = definition.items
    const itemType = items && typeof items === 'object'
      ? compactSchemaType(items as Record<string, unknown>, depth + 1)
      : 'any'
    return `Array<${itemType}>`
  }

  if (definition.type === 'object') {
    const properties = definition.properties
    if (depth >= 3 || !properties || typeof properties !== 'object') return 'object'

    const required = new Set(Array.isArray(definition.required) ? definition.required : [])
    const fields = Object.entries(properties as Record<string, unknown>).map(([name, field]) => {
      const fieldType = field && typeof field === 'object'
        ? compactSchemaType(field as Record<string, unknown>, depth + 1)
        : 'any'
      return `${name}${required.has(name) ? '' : '?'}: ${fieldType}`
    })
    return `{ ${fields.join('; ')} }`
  }

  return typeof definition.type === 'string' ? definition.type : 'any'
}

function formatToolResult(entry: IndexedTool): string {
  const schema = entry.inputSchema
  const hasParams = schema && typeof schema === 'object' && Object.keys(schema).length > 0

  let schemaStr = ''
  if (hasParams) {
    // Extract just the properties for a compact display
    const props = (schema as Record<string, unknown>).properties as Record<string, unknown> | undefined
    const required = (schema as Record<string, unknown>).required as string[] | undefined
    if (props) {
      const paramParts = Object.entries(props).map(([name, def]) => {
        const typeDef = def as Record<string, unknown>
        const type = compactSchemaType(typeDef)
        const desc = typeDef.description ? ` — ${typeDef.description}` : ''
        const req = required?.includes(name) ? '' : '?'
        return `    ${name}${req}: ${type}${desc}`
      })
      schemaStr = `\n  Parameters:\n${paramParts.join('\n')}`
    }
  }

  const labelText = entry.kind === 'remote' ? entry.displayName : entry.label
  const label = labelText ? ` (${labelText})` : ''
  const external = entry.kind === 'remote'
    || (entry.lazy ? entry.lazy.externalSchema : getMcpInputJsonSchema(entry.tool.inputSchema))
  const externalSchema = external ? `\n  Input JSON Schema: ${JSON.stringify(schema)}` : ''
  return `[${entry.server}]${label} ${entry.toolName}: ${entry.description}${schemaStr}${externalSchema}`
}

// ── Tool factories ────────────────────────────────────────────

/**
 * Create the two MCP tools (search + call) from a built tool index.
 *
 * These two tools replace all per-connector gateways:
 * - `mcp_search`: keyword search across all connectors
 * - `mcp_call`: proxy execution with policy enforcement
 */
export function createMcpSearchTools(params: {
  index: McpToolIndex
  settingsStore: McpSettingsStore
  assistantId: string
  appLevelAssistantId?: string
  userId: string
  /** @deprecated Bind transport on each RemoteSource. Missing indexed dispatch refuses; this legacy option cannot replace it. */
  callMcpTool?: RemoteSource['callMcpTool']
  /**
   * Optional tool-use interception (remote MCP only). `preToolUse` fires
   * right before the wire call (inject/overwrite headers, rewrite args, or
   * block); `postToolUse` observes the result. Unset in the open build.
   * See `docs/architecture/engine/tool-hooks.md`.
   */
  hooks?: EngineHooks
  /**
   * Add direct aliases for deterministic workflow `tool_call` registry
   * lookups. Other surfaces keep the token-saving search/call pair only.
   */
  keepDynamicToolsDirect?: boolean
  /** Canonical read schemas for interactive deferred selection; execution stays in mcp_call. */
  exposeLocalReadTools?: boolean
  /** Newest authored request, used only for bounded read-only schema discovery. */
  discoveryQuery?: string
}): Tool[] {
  const {
    index, settingsStore, assistantId, appLevelAssistantId, userId,
    hooks, keepDynamicToolsDirect = false, exposeLocalReadTools = false, discoveryQuery,
  } = params

  // ── Lookup: server:toolName → IndexedTool ─────────────────────
  const entryByKey = new Map<string, IndexedTool>()
  const ambiguousEntryKeys = new Set<string>()
  const registerEntry = (entry: IndexedTool) => {
    const key = `${entry.server}:${entry.toolName}`
    if (entryByKey.has(key)) {
      entryByKey.delete(key)
      ambiguousEntryKeys.add(key)
    } else if (!ambiguousEntryKeys.has(key)) {
      entryByKey.set(key, entry)
    }
  }
  for (const entry of index.entries) registerEntry(entry)

  // Undiscovered dynamic sources load only when a search names them. Each
  // source is discovered at most once per index; a failure stays honest.
  const discoveryNotes = new Map<string, string>()
  async function discoverNamedSources(query: string): Promise<void> {
    const normalized = query.toLowerCase()
    const targeted = (index.undiscovered ?? []).filter((source) =>
      source.terms.some((term) => normalized.includes(term)))
    await Promise.all(targeted.map(async (source) => {
      const pending = source.pending ??= source.discover().catch((error) => {
        console.warn(`[mcp_search] discovery failed for ${source.label ?? source.server}:`, error)
        return null
      })
      const descriptors = await pending
      if (!index.undiscovered?.includes(source)) return
      index.undiscovered.splice(index.undiscovered.indexOf(source), 1)
      const label = source.label ?? source.server
      if (!descriptors || !source.resolve) {
        index.serverSummaries.set(source.server, `${label}: tools could not be loaded right now`)
        discoveryNotes.set(source.server, `Could not load the tools from ${label} right now.`)
        return
      }
      for (const descriptor of descriptors) {
        const entry = lazyLocalEntry(source.server, source.label, descriptor, source.resolve)
        index.entries.push(entry)
        registerEntry(entry)
        const legacyKey = `${label}:${entry.toolName}`
        if (source.label && source.label !== source.server && !legacyEntryByKey.has(legacyKey) && !ambiguousLegacyKeys.has(legacyKey)) {
          legacyEntryByKey.set(legacyKey, entry)
        }
      }
      index.serverSummaries.set(source.server, `${source.label ? `${source.label}: ` : ''}${summarizeCapabilities(descriptors.map((d) => d.name))}`)
    }))
  }
  // Older saved calls may name a label, but an ambiguous label never picks an instance.
  const legacyEntryByKey = new Map<string, IndexedTool>()
  const ambiguousLegacyKeys = new Set<string>()
  const entryLabel = (entry: IndexedTool) => entry.kind === 'remote' ? entry.displayName : entry.label
  for (const entry of index.entries) {
    const label = entryLabel(entry)
    if (!label || label === entry.server
      || ambiguousEntryKeys.has(`${entry.server}:${entry.toolName}`)) continue
    const key = `${label}:${entry.toolName}`
    if (legacyEntryByKey.has(key)) { legacyEntryByKey.delete(key); ambiguousLegacyKeys.add(key) }
    else if (!ambiguousLegacyKeys.has(key)) legacyEntryByKey.set(key, entry)
  }

  // ── Session-level policy tracking ─────────────────────────────
  // Once a tool is blocked by policy or denied by user, it's added to
  // blockedTools. mcp_search filters these out so the model never sees
  // them again — deny = permanent, don't retry.
  // Once a tool is approved (allow or always_allow), it's added to
  // allowedTools so we skip confirmation for the rest of the session.
  const blockedTools = new Set<string>() // "server:toolName"
  const allowedTools = new Set<string>() // "server:toolName"

  // Build the connector summary for the search tool description
  const connectorList = Array.from(index.serverSummaries.entries())
    .map(([name, caps]) => `${name} (${caps})`)
    .join('; ')

  const totalTools = index.entries.length
  const hasKnowledgeSource = index.serverSummaries.has('knowledge')
  const searchScope = hasKnowledgeSource
    ? 'connected services and the workspace knowledge base (KB)'
    : 'connected services'
  const queryGuidance = hasKnowledgeSource
    ? 'Search for the capability you need, not the underlying entry name (e.g. "search knowledge base", "browse knowledge base", "search proposals").'
    : 'Search for the capability you need, not the underlying data (e.g. "get DRep voting history", "search proposals").'

  const searchTool = buildTool({
    name: 'mcp_search',
    description: `Search across ${totalTools} tools from ${searchScope}. This searches available tool capabilities, not the underlying user data. Returns matching tools with descriptions and parameter schemas. Set limit=1 for one exact capability so unrelated schemas stay out of context. Available sources: ${connectorList}.`,
    inputSchema: z.object({
      query: z.string().describe(queryGuidance),
      limit: z.number().int().min(1).max(8).optional().describe('Maximum matching tools to return (1-8, default 8). Use 1 for an exact capability.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    requiresConfirmation: false,

    async execute(input, context) {
      const { query, limit } = input as { query: string; limit?: number }
      const directOnly = context.requestTools != null && !context.requestTools.has('mcp_call')
      if (!directOnly && index.undiscovered?.length) await discoverNamedSources(query)
      const results = searchIndex(
        index,
        query,
        limit,
        (entry) => {
          const key = `${entry.server}:${entry.toolName}`
          const direct = context.requestTools?.get(entry.toolName) as
            (Tool & { [DIRECT_MCP_ENTRY]?: IndexedTool }) | undefined
          return !blockedTools.has(key) && !ambiguousEntryKeys.has(key)
            && (!directOnly || direct?.isReadOnly === true && direct[DIRECT_MCP_ENTRY] === entry)
            && (entry.kind !== 'local' || !missingToolCapability(entry.tool, context.activeCapabilities))
        },
      )

      const notes = [...discoveryNotes.values()]
      discoveryNotes.clear()
      const noteText = notes.length > 0 ? `\n\n${notes.join(' ')}` : ''
      if (results.length === 0) {
        return {
          data: `No tools found matching "${query}". Try broader terms or different keywords.\n\nAvailable connectors: ${Array.from(index.serverSummaries.keys()).join(', ')}${noteText}`,
        }
      }

      // A lazy hit with no catalog schema resolves once so its real
      // parameters are shown. A failure leaves the descriptor as indexed.
      await Promise.all(results.map(async (entry) => {
        if (entry.kind !== 'local' || !entry.lazy || entry.lazy.schemaKnown) return
        try { await resolveLocalEntry(entry) } catch (error) {
          console.debug(`[mcp_search] schema resolution failed for ${entry.toolName}:`, error)
        }
      }))

      const formatted = results.map(formatToolResult).join('\n\n')
      return {
        data: `Found ${results.length} matching tools:\n\n${formatted}\n\n${directOnly
          ? 'Call the matching tool directly by its name with the listed parameters.'
          : 'Use mcp_call with server, tool, and args to execute.'}${noteText}`,
      }
    },
  })

  // Metadata discovery only. Capability-dependent tools still use context-aware search.
  const conversationalWords = new Set([
    'can', 'could', 'would', 'you', 'please', 'help', 'check', 'now', 'the', 'and',
    'for', 'with', 'this', 'that', 'have', 'does', 'what', 'are', 'show', 'tell',
  ])
  const discoveryTerms = (discoveryQuery ?? '').slice(0, 500).toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(term => term.length > 2 && !conversationalWords.has(term)).join(' ')
  const preloadedSchemas = discoveryTerms ? searchIndex(index, discoveryTerms, 4, entry =>
    entry.kind === 'local' && entry.tool.isReadOnly === true && !entry.tool.hiddenFromModel
    && !missingToolCapability(entry.tool)
    && !ambiguousEntryKeys.has(`${entry.server}:${entry.toolName}`),
  ).map(formatToolResult).reduce<string[]>((schemas, schema) =>
    schemas.join('\n\n').length + (schemas.length ? 2 : 0) + schema.length <= 12_000 ? [...schemas, schema] : schemas, []).join('\n\n') : ''

  const callTool = buildTool({
    name: 'mcp_call',
    description: 'Execute a tool on a connected service. Use a schema already provided here or by mcp_search; search only when the needed schema is missing.'
      + (preloadedSchemas ? `\n\nMatching read-only tools already discovered for this request (metadata, not user data). For a matching data request, call the tool directly; no connector inventory or additional search is needed:\n\n${preloadedSchemas}` : ''),
    inputSchema: z.object({
      server: z.string().describe('Server name (from mcp_search results, e.g. "google", "github", "Cardano Onchain Governance")'),
      tool: z.string().describe('Tool name (from mcp_search results, e.g. "googleCalendarCreateEvent", "get_drep_profile")'),
      // Gemini Flash variants occasionally emit `args` as a JSON-encoded
      // string instead of a structured object. Preprocess attempts a
      // single JSON.parse before validation so the model self-recovers
      // instead of looping on "Expected object, received string".
      args: z.preprocess(
        (v) => {
          if (typeof v !== 'string') return v
          try { return JSON.parse(v) } catch { return v }
        },
        z.record(z.unknown()).optional(),
      ).describe('Arguments matching the tool\'s parameter schema'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: false,

    async execute(input, context) {
      const { server, tool, args } = input as {
        server: string
        tool: string
        args?: Record<string, unknown>
      }

      // Resolve entry
      const requestedKey = `${server}:${tool}`
      const toolEntry = entryByKey.get(requestedKey) ?? (ambiguousEntryKeys.has(requestedKey) ? undefined : legacyEntryByKey.get(requestedKey))
      if (!toolEntry) {
        const available = Array.from(index.serverSummaries.keys()).join(', ')
        return {
          data: `ERROR: unknown tool "${tool}" on server "${server}". Available servers: ${available}. Use mcp_search to discover tools.`,
          isError: true,
        }
      }

      const toolKey = `${toolEntry.server}:${tool}`

      // Fast-reject tools already blocked in this session — no need
      // to re-evaluate policy (deny-first).
      if (blockedTools.has(toolKey)) {
        return {
          data: blockedThisTurnToolResult(tool),
          isError: true,
        }
      }

      // ── Dispatch by source kind ───────────────────────────────
      if (toolEntry.kind === 'local') {
        return dispatchLocal({
          entry: toolEntry,
          server,
          tool,
          toolKey,
          args: args ?? {},
          context,
          blockedTools,
          allowedTools,
        })
      }

      return dispatchRemote({
        entry: toolEntry,
        server: toolEntry.server,
        tool,
        toolKey,
        args: args ?? {},
        context,
        blockedTools,
        allowedTools,
        settingsStore,
        assistantId,
        appLevelAssistantId,
        userId,
        hooks,
      })
    },
  })

  if (!keepDynamicToolsDirect) {
    if (!exposeLocalReadTools) return [searchTool, callTool]
    const counts = new Map<string, number>()
    for (const entry of index.entries) counts.set(entry.toolName, (counts.get(entry.toolName) ?? 0) + 1)
    const reads: Tool[] = []
    for (const entry of index.entries) {
      if (entry.kind !== 'local' || entry.tool.isReadOnly !== true || entry.tool.hiddenFromModel
        || counts.get(entry.toolName) !== 1 || ['mcp_search', 'mcp_call'].includes(entry.toolName)
        || ambiguousEntryKeys.has(`${entry.server}:${entry.toolName}`)) continue
      reads.push(Object.assign(inheritRoutineCalendarRead(entry.tool,{
        ...entry.tool,
        deferredSchemaOnly: true,
        // One dispatcher owns approval and denied-call state across both names.
        requiresConfirmation: false,
        resolveConfirmation: undefined,
        execute: (input, context) => callTool.execute({ server: entry.server, tool: entry.toolName, args: input }, context),
      }), { [DIRECT_MCP_ENTRY]: entry }))
    }
    return [searchTool, callTool, ...reads]
  }

  // A workflow tool_call performs one exact registry lookup and cannot run a
  // model-driven mcp_search -> mcp_call sequence. Expose adapters under both
  // canonical names and the legacy wrapMcpTools name persisted by older
  // workflow definitions. The adapters reuse the dispatchers below so policy,
  // hooks, result conversion, and local capability wrappers remain intact.
  const directTools: Tool[] = []
  const claimedNames = new Set(['mcp_search', 'mcp_call'])
  const aliasCounts = new Map<string, number>()
  for (const entry of index.entries) {
    const legacyName = legacyMcpToolName(entryLabel(entry) ?? entry.server, entry.toolName)
    for (const alias of new Set([entry.toolName, legacyName])) {
      aliasCounts.set(alias, (aliasCounts.get(alias) ?? 0) + 1)
    }
  }
  for (const entry of index.entries) {
    const legacyName = legacyMcpToolName(entryLabel(entry) ?? entry.server, entry.toolName)
    const aliases = [...new Set([entry.toolName, legacyName])]
      .filter((alias) => aliasCounts.get(alias) === 1)
    for (const name of aliases) {
      if (claimedNames.has(name)) continue
      claimedNames.add(name)
      const toolKey = `${entry.server}:${entry.toolName}`

      if (entry.kind === 'local') {
        // A lazy adapter is built against the indexed descriptor version. Its
        // confirmation hooks await the resolved tool; a newer version refuses.
        const adapterVersion = entry.lazy?.version
        const lazyHooks: Partial<Tool> = entry.lazy ? {
          async resolveConfirmation(context, input) {
            const outcome = await resolveLocalEntry(entry, adapterVersion)
            // Not ready: execute refuses on the same memoized outcome.
            if (outcome.status !== 'ready') return false
            return outcome.tool.resolveConfirmation
              ? outcome.tool.resolveConfirmation(context, input)
              : outcome.tool.requiresConfirmation
          },
          async describeConfirmation(input, context) {
            const outcome = await resolveLocalEntry(entry, adapterVersion)
            return outcome.status === 'ready' && outcome.tool.describeConfirmation
              ? outcome.tool.describeConfirmation(input, context)
              : undefined
          },
        } : {}
        directTools.push(Object.assign({
          ...entry.tool,
          ...lazyHooks,
          name,
          async execute(input, context) {
            return dispatchLocal({
              entry,
              server: entry.server,
              tool: entry.toolName,
              toolKey,
              args: input as Record<string, unknown>,
              context,
              blockedTools,
              allowedTools,
              skipConfirmation: true,
              ...(adapterVersion !== undefined ? { expectedVersion: adapterVersion } : {}),
            })
          },
        } satisfies Tool, { [DIRECT_MCP_ENTRY]: entry }))
        continue
      }

      const classification = classifyTool(entry.toolName, entry.description)
      const fallbackPolicy = defaultPolicy(classification)
      directTools.push(Object.assign(buildTool({
        name,
        description: `[${entry.displayName ?? entry.server}] ${entry.description}`,
        inputSchema: entry.argumentSchema,
        isConcurrencySafe: classification === 'read',
        isReadOnly: classification === 'read',
        requiresConfirmation: fallbackPolicy === 'ask',
        allowPersistentApproval: true,
        async resolveConfirmation() {
          return await resolveRemoteEffectivePolicy({
            server: entry.displayName ?? entry.server,
            tool: entry.toolName,
            description: entry.description,
            settingsStore,
            assistantId,
            appLevelAssistantId,
            userId,
            policy: entry.policy,
          }) === 'ask'
        },
        async execute(input, context) {
          return dispatchRemote({
            entry,
            server: entry.server,
            tool: entry.toolName,
            toolKey,
            args: input as Record<string, unknown>,
            context,
            blockedTools,
            allowedTools,
            settingsStore,
            assistantId,
            appLevelAssistantId,
            userId,
            hooks,
            skipConfirmation: true,
          })
        },
      }), { [DIRECT_MCP_ENTRY]: entry }))
    }
  }

  return [searchTool, callTool, ...directTools]
}

// ── Dispatch: remote source ───────────────────────────────────

export function legacyMcpToolName(serverName: string, toolName: string): string {
  return `mcp_${serverName}_${toolName}`.replace(/[^a-zA-Z0-9_.\-:]/g, '_').slice(0, 128)
}

async function resolveRemoteEffectivePolicy(params: {
  server: string
  tool: string
  description: string
  settingsStore: McpSettingsStore
  assistantId: string
  appLevelAssistantId?: string
  userId: string
  policy?: RemoteSource['policy']
}): Promise<'allow' | 'ask' | 'block'> {
  const {
    server, tool, description, settingsStore, assistantId,
    appLevelAssistantId, userId, policy,
  } = params
  const effectiveStore = policy?.settingsStore ?? settingsStore
  const effectiveUserId = policy?.userId ?? userId
  const effectiveServer = policy?.serverName ?? server
  const effectiveAppLevelAssistantId = policy?.appLevelAssistantId ?? appLevelAssistantId
  const fallbackPolicy = defaultPolicy(classifyTool(tool, description))

  if (effectiveAppLevelAssistantId) {
    const l1 = await effectiveStore.getPolicy({
      assistantId: effectiveAppLevelAssistantId,
      userId: effectiveUserId,
      serverName: effectiveServer,
      toolName: tool,
    })
    const l2 = await effectiveStore.getPolicy({
      assistantId,
      userId: effectiveUserId,
      serverName: effectiveServer,
      toolName: tool,
    })
    const appPolicy = l1?.policy ?? fallbackPolicy
    const asstPolicy = l2?.policy ?? fallbackPolicy
    const strictness: Record<string, number> = { allow: 0, ask: 1, block: 2 }
    return (strictness[appPolicy] ?? 0) >= (strictness[asstPolicy] ?? 0)
      ? appPolicy
      : asstPolicy
  }

  const setting = await effectiveStore.getPolicy({
    assistantId,
    userId: effectiveUserId,
    serverName: effectiveServer,
    toolName: tool,
  })
  return setting?.policy ?? fallbackPolicy
}

async function dispatchRemote(params: {
  entry: RemoteIndexedTool
  server: string
  tool: string
  toolKey: string
  args: Record<string, unknown>
  context: import('@use-brian/agent-runtime/tools/types.js').ToolContext
  blockedTools: Set<string>
  allowedTools: Set<string>
  settingsStore: McpSettingsStore
  assistantId: string
  appLevelAssistantId?: string
  userId: string
  hooks?: EngineHooks
  skipConfirmation?: boolean
}) {
  const {
    entry, server, tool, toolKey, args, context,
    blockedTools, allowedTools,
    settingsStore, assistantId, appLevelAssistantId, userId, hooks,
    skipConfirmation = false,
  } = params

  // Check classification + policy (strictest of L1 app-level + L2 assistant-level)
  const classification = classifyTool(tool, entry.description)
  const effectivePolicy = await resolveRemoteEffectivePolicy({
    server: entry.displayName ?? server, tool, description: entry.description, settingsStore,
    assistantId, appLevelAssistantId, userId, policy: entry.policy,
  })
  const policyStore = entry.policy?.settingsStore ?? settingsStore
  const policyUserId = entry.policy?.userId ?? userId
  const policyServerName = entry.policy?.serverName ?? entry.displayName ?? server

  if (effectivePolicy === 'block') {
    blockedTools.add(toolKey)
    return {
      data: policyBlockedToolResult(tool),
      isError: true,
    }
  }

  const parsed = entry.argumentSchema.safeParse(args)
  if (!parsed.success) return { data: mcpArgumentError(tool, parsed.error), isError: true }

  // ── Confirmation gate for 'ask' policy ──────────────────────
  // 'ask' = pause, show user the
  // tool details, wait for decision. Uses confirmationResolver and
  // notifyConfirmationRequired from ToolContext (threaded from query
  // loop → tool executor → execute()). Decisions persist for the
  // session (allow/deny) or permanently (always_allow/always_deny).
  if (effectivePolicy === 'ask' && !skipConfirmation && !allowedTools.has(toolKey)) {
    const resolver = context?.confirmationResolver
    const notify = context?.notifyConfirmationRequired
    if (resolver && notify) {
      const confirmId = mintConfirmId()

      notify({
        toolCallId: confirmId,
        toolName: tool,
        serverName: entry.displayName ?? server,
        input: args,
        classification,
        description: entry.description,
        allowPersistentApproval: true,
      })

      try {
        const timeoutMs = context?.confirmationTimeoutMs ?? 300_000
        // Wait outside the executor's exclusive slot so sibling mcp_calls in
        // the same turn can start and raise their own prompts. See
        // ToolContext.parkForConfirmation.
        const awaitDecision = () => resolver.waitForDecision(confirmId, timeoutMs)
        const { decision, comment } = context.parkForConfirmation
          ? await context.parkForConfirmation(awaitDecision)
          : await awaitDecision()

        if (decision === 'deny') {
          blockedTools.add(toolKey)
          return {
            data: declinedToolResult(tool, comment),
            isError: true,
          }
        }

        if (decision === 'always_deny') {
          blockedTools.add(toolKey)
          policyStore.setPolicy({
            assistantId, userId: policyUserId,
            serverName: policyServerName, toolName: tool,
            policy: 'block', classification,
          }).catch((err) => console.debug('Failed to persist always_deny:', err))
          return {
            data: alwaysDeniedToolResult(tool),
            isError: true,
          }
        }

        if (decision === 'always_allow') {
          allowedTools.add(toolKey)
          policyStore.setPolicy({
            assistantId, userId: policyUserId,
            serverName: policyServerName, toolName: tool,
            policy: 'allow', classification,
          }).catch((err) => console.debug('Failed to persist always_allow:', err))
          // Fall through to execution
        }

        if (decision === 'allow') {
          allowedTools.add(toolKey)
          // Fall through to execution
        }
      } catch {
        // Timeout — treat as deny for this session
        blockedTools.add(toolKey)
        return {
          data: timedOutToolResult(tool),
          isError: true,
        }
      }
    } else {
      // No confirmation infrastructure available (e.g. cron/scheduled jobs).
      // Reject execution — 'ask' policy must not be silently bypassed.
      return {
        data: `ERROR: "${tool}" requires user confirmation (policy: ask) but no confirmation channel is available in this context. The tool was NOT executed. If this is a scheduled job, the user must pre-approve this tool (set policy to 'allow') before it can run unattended.`,
        isError: true,
      }
    }
  }

  // ── Preflight hook (remote MCP only) ────────────────────────
  // Fires AFTER the policy/confirmation gate, immediately before the wire
  // call — so it sees only authorized calls and can still inject/overwrite
  // outbound headers, rewrite args, or block. Fail-closed: a throwing
  // preToolUse skips the call (a gate that errors must not fail open). The
  // override (if any) is the only thing that threads a 4th arg into
  // callMcpTool, so the no-hook path stays a 3-arg call byte-for-byte.
  // See docs/architecture/engine/tool-hooks.md.
  let effInput = args
  let headerOverride: Record<string, string> | undefined
  if (hooks?.preToolUse) {
    let directive: PreToolUseDirective | void
    try {
      directive = await hooks.preToolUse({
        source: 'remote_mcp',
        serverUrl: entry.serverUrl,
        serverName: entry.displayName ?? server,
        ...(entry.displayName ? { sourceId: entry.server } : {}),
        toolName: tool,
        input: args,
        userId: context.userId,
        assistantId,
        sessionId: context.sessionId,
        workspaceId: context.workspaceId,
      })
    } catch (err) {
      return {
        data: `ERROR: preflight hook errored for "${tool}"; call not executed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
    if (directive?.action === 'block') {
      return {
        data: `ERROR: "${tool}" was blocked by a preflight hook: ${directive.reason}`,
        isError: true,
      }
    }
    if (directive?.action === 'modify') {
      if (directive.input) effInput = directive.input
      if (directive.headers) headerOverride = directive.headers
    }
  }

  // Hooks may rewrite the input, so validate the actual outbound arguments too.
  const outbound = entry.argumentSchema.safeParse(effInput)
  if (!outbound.success) return { data: mcpArgumentError(tool, outbound.error), isError: true }

  const startedAt = Date.now()
  try {
    if (typeof entry.dispatch !== 'function') {
      return { data: 'ERROR: this source transport is unavailable. Refresh the connector before retrying.', isError: true }
    }
    const result = headerOverride
      ? await entry.dispatch(entry.serverUrl, tool, effInput, headerOverride)
      : await entry.dispatch(entry.serverUrl, tool, effInput)

    // Track usage
    policyStore.recordUsage({
      assistantId, userId: policyUserId,
      serverName: policyServerName,
      toolName: tool,
      allowed: true,
    }).catch((err) => console.debug('MCP usage tracking failed:', err))

    // Post-call observation hook. Swallow its errors — the call already ran.
    if (hooks?.postToolUse) {
      try {
        await hooks.postToolUse({
          source: 'remote_mcp',
          serverUrl: entry.serverUrl,
          serverName: entry.displayName ?? server,
          ...(entry.displayName ? { sourceId: entry.server } : {}),
          toolName: tool,
          input: effInput,
          userId: context.userId,
          assistantId,
          sessionId: context.sessionId,
          workspaceId: context.workspaceId,
          result: { data: result, isError: false },
          elapsedMs: Date.now() - startedAt,
        })
      } catch (err) {
        console.warn(`[mcp_call:dispatchRemote] postToolUse hook failed for ${tool}:`, err)
      }
    }

    // Lift any inline image content onto ToolResult.images so the model sees it.
    return mcpResultToToolResult(result)
  } catch (err) {
    return {
      data: describeMcpToolError(server, tool, err),
      isError: true,
    }
  }
}

// ── Dispatch: local source ────────────────────────────────────

/**
 * Route a `mcp_call` invocation to a first-party `Tool` object. Defers
 * to the underlying tool's own `requiresConfirmation` / `resolveConfirmation`
 * / `describeConfirmation` hooks instead of the classifier-based policy
 * gate — these tools already encode their own safety semantics (capability
 * grants, audit wrappers, sensitivity gates).
 *
 * When the tool needs confirmation, fires the unified-approvals flow with
 * the **canonical underlying tool name** so:
 *   - the `pending_approvals` row reads `tool_name='googleCalendarCreateEvent'`
 *     (not 'mcp_call'),
 *   - the chat UI's `enrichConfirmation(toolName, input)` lookup hits the
 *     right enricher (Gmail/GCal pre-fetch their summaries by canonical
 *     name in the inject layer),
 *   - Path B's `session_resume_points` captures the canonical name +
 *     frozen input via `context.onInnerAwaitingApproval`, so a Cloud Run
 *     restart replays the right tool.
 */
async function dispatchLocal(params: {
  entry: LocalIndexedTool
  server: string
  tool: string
  toolKey: string
  args: Record<string, unknown>
  context: import('@use-brian/agent-runtime/tools/types.js').ToolContext
  blockedTools: Set<string>
  allowedTools: Set<string>
  skipConfirmation?: boolean
  /** Descriptor version a direct adapter was built against. */
  expectedVersion?: string
}) {
  const { entry, server, tool, toolKey, context, blockedTools, allowedTools } = params
  // A lazy entry builds its tool before anything else, including the
  // confirmation path, so the resolved tool's own hooks govern the call.
  let targetTool = entry.tool
  if (entry.lazy) {
    const outcome = await resolveLocalEntry(entry, params.expectedVersion)
    if (outcome.status === 'stale') {
      // A changed capability needs a fresh approval.
      allowedTools.delete(toolKey)
      return { data: staleToolResult(server, tool), isError: true }
    }
    if (outcome.status === 'unavailable') return { data: unavailableToolResult(tool, outcome.reason), isError: true }
    targetTool = outcome.tool
  }
  const missing = missingToolCapability(targetTool, context.activeCapabilities)
  if (missing) return { data: { error: `This assistant does not have the '${missing}' tool capability.` }, isError: true }

  // Validate against the tool's own schema before anything else. Direct-
  // injected tools get shape-correct input by construction — the provider's
  // function-calling is constrained by the declared schema — but mcp_call's
  // provider-facing schema only says `args: object`, so nothing upstream
  // guarantees the inner shape. Without this, a misnamed argument reaches
  // execute() as `undefined` and surfaces as a deep TypeError the model
  // cannot act on (imapGetMessage called with `id` instead of `messageId`);
  // a zod issue list names the right parameters, so the model self-corrects.
  // Parsed output replaces `args` so defaults and preprocessing apply the
  // same as on the direct path.
  // (Guarded: every buildTool() tool carries a zod schema, but test doubles
  // and gateway shims may not — those dispatch unvalidated as before.)
  let args = params.args
  const parsedArgs =
    typeof targetTool.inputSchema?.safeParse === 'function'
      ? targetTool.inputSchema.safeParse(args)
      : { success: true as const, data: args }
  if (!parsedArgs.success) {
    const issues = parsedArgs.error.issues
      .map((i) => `${i.path.join('.') || '(args)'}: ${i.message}`)
      .join('; ')
    return {
      data: `ERROR: invalid arguments for "${tool}": ${issues}. Re-check this tool's parameter names and types in its mcp_search entry, then retry.`,
      isError: true,
    }
  }
  args = parsedArgs.data as Record<string, unknown>

  // Resolve confirmation requirement — same logic the executor uses for
  // direct-injected tools (`resolveConfirmation` overrides `requiresConfirmation`).
  let needsConfirmation = targetTool.resolveConfirmation
    ? await targetTool.resolveConfirmation(context, args)
    : targetTool.requiresConfirmation

  if (needsConfirmation && allowedTools.has(toolKey)) {
    // User said "always allow" earlier in this session — bypass.
    needsConfirmation = false
  }

  if (needsConfirmation && !params.skipConfirmation) {
    const resolver = context?.confirmationResolver
    const notify = context?.notifyConfirmationRequired

    if (!resolver || !notify) {
      // No confirmation channel — fail closed. Matches the tool-executor
      // direct-injection behavior for `requiresConfirmation` tools.
      return {
        data: `ERROR: "${tool}" requires user confirmation but no confirmation channel is available in this context. The tool was NOT executed. If this is a scheduled job, pre-approve via the appropriate per-action grant before it can run unattended.`,
        isError: true,
      }
    }

    // Producer-side describe — pre-resolves friendly text now so the
    // unified-approvals row / Path B checkpoint carry the rendered view.
    let displayLines: string[] | undefined
    if (targetTool.describeConfirmation) {
      try {
        const lines = await targetTool.describeConfirmation(args, context)
        if (lines && lines.length > 0) displayLines = lines
      } catch (err) {
        console.debug(`[mcp_call:dispatchLocal] describeConfirmation failed for ${tool}:`, err)
      }
    }

    const confirmId = mintConfirmId()
    const timeoutMs = context?.confirmationTimeoutMs ?? 300_000

    // Q10 unification — persist a `kind='tool_invocation'` row with the
    // **canonical underlying tool name**. Fail-OPEN so a DB blip doesn't
    // block the user; Path A in-memory resolver still works.
    let approvalId: string | undefined
    if (context.createToolInvocationApproval) {
      const expiresAt = new Date(Date.now() + timeoutMs)
      try {
        approvalId = await context.createToolInvocationApproval({
          toolName: tool,
          toolInput: args,
          description: targetTool.description,
          displayLines,
          allowPersistentApproval: targetTool.allowPersistentApproval ?? false,
          expiresAt,
        })
      } catch (err) {
        console.warn(
          `[mcp_call:dispatchLocal] approval row creation failed for ${tool}; continuing with in-memory confirmation only:`,
          err,
        )
      }

      // Path B durability — chat route writes session_resume_points off
      // this so a Cloud Run restart mid-confirmation replays the right
      // tool with its canonical name. Mirrors `options.onAwaitingApproval`
      // in the tool-executor for direct-injected tools.
      if (approvalId && context.onInnerAwaitingApproval) {
        context.onInnerAwaitingApproval({
          approvalId,
          toolCallId: confirmId,
          toolName: tool,
          toolInput: args,
          describeText:
            displayLines && displayLines.length > 0
              ? displayLines.join('\n')
              : targetTool.description,
          expiresAt,
        })
      }
    }

    notify({
      toolCallId: confirmId,
      toolName: tool,
      serverName: server,
      input: args,
      classification: null,
      description: targetTool.description,
      displayLines,
      allowPersistentApproval: targetTool.allowPersistentApproval ?? false,
      approvalId,
    })

    try {
      // Wait outside the executor's exclusive slot so sibling mcp_calls in
      // the same turn can start and raise their own prompts. This is the path
      // every first-party built-in write takes (googleCalendarCreateEvent and
      // friends), so without it a multi-write turn shows exactly one card.
      // See ToolContext.parkForConfirmation.
      const awaitDecision = () => resolver.waitForDecision(confirmId, timeoutMs)
      const { decision, comment } = context.parkForConfirmation
        ? await context.parkForConfirmation(awaitDecision)
        : await awaitDecision()

      if (decision === 'deny' || decision === 'always_deny') {
        blockedTools.add(toolKey)
        return {
          data: declinedToolResult(tool, comment),
          isError: true,
        }
      }

      if (decision === 'always_allow') {
        // Built-in tools default to `allowPersistentApproval: false` —
        // each call targets a distinct entity and "always allow" would
        // be misleading. The channel UI surfaces Always Allow only when
        // `allowPersistentApproval=true`, so seeing it here means the
        // user explicitly opted in. Honor for the session only; durable
        // persistence is the per-tool job (e.g. `assistant_connector_grants`).
        allowedTools.add(toolKey)
      }
      // 'allow' or 'always_allow' — fall through to execution
    } catch {
      blockedTools.add(toolKey)
      return {
        data: timedOutToolResult(tool),
        isError: true,
      }
    }
  }

  // Execute the underlying tool. All capability gates, audit wrappers,
  // and sensitivity checks live inside its `execute()` — `mcp_call` is a
  // transparent dispatcher at this point.
  assertRoutineCalendarAdapterCurrent(context,targetTool)
  return targetTool.execute(args, context)
}
